/**
 * Wire-command builders shared between the JavaScript and native clients.
 *
 * Each builder validates inputs and returns the assembled command string
 * (without trailing CRLF). This keeps protocol-formatting concerns in one
 * place so both transports stay in sync.
 */

import {
  ensureQueryLengthWithinLimit,
  ensureSafeFilterIdentifiers,
  ensureSafeIdentifier,
  ensureSafeStringArray,
  escapeQueryString,
  quoteCommandArgument,
  validateFacetColumn,
  validateFuzzy,
  validateHighlight
} from './command-utils.js';
import { InputValidationError } from './errors.js';
import type { CountOptions, FacetOptions, SearchOptions, SearchRawOptions } from './types.js';

/**
 * Append the LIMIT / OFFSET clause to a command's token list, matching the
 * C++ client's `AppendLimitOffset`:
 *
 * - `limit > 0` and `offset > 0` emits the atomic `LIMIT <offset>,<limit>`.
 * - `limit > 0` and `offset === 0` emits `LIMIT <limit>`.
 * - `limit === 0` and `offset > 0` emits a bare `OFFSET <offset>` so the
 *   server still skips the first `<offset>` results.
 *
 * @param {string[]} parts - Command token list to append to
 * @param {number} limit - Result limit (0 = server default)
 * @param {number} offset - Result offset
 * @returns {void}
 */
function appendLimitOffset(parts: string[], limit: number, offset: number): void {
  if (limit > 0 && offset > 0) {
    parts.push('LIMIT', `${offset},${limit}`);
  } else if (limit > 0) {
    parts.push('LIMIT', `${limit}`);
  } else if (offset > 0) {
    parts.push('OFFSET', `${offset}`);
  }
}

/**
 * Build a `SEARCH` command line.
 *
 * - `offset > 0` and `limit > 0` emits `LIMIT <offset>,<limit>`.
 * - `offset > 0` and `limit === 0` emits a bare `OFFSET <offset>` so the
 *   server does not silently drop the offset (matches the C++ client fix).
 * - `offset === 0` emits `LIMIT <limit>`.
 *
 * @param {string} table - Table name
 * @param {string} query - Search query text
 * @param {SearchOptions} options - Search options
 * @param {number} maxQueryLength - Configured query length limit
 * @returns {string} Wire command (no trailing CRLF)
 */
export function buildSearchCommand(
  table: string,
  query: string,
  options: SearchOptions,
  maxQueryLength: number
): string {
  const {
    limit = 1000,
    offset = 0,
    andTerms = [],
    notTerms = [],
    filters = {},
    sortColumn = '',
    sortDesc = true,
    fuzzy = 0,
    highlight
  } = options;

  const safeTable = ensureSafeIdentifier(table, 'table');
  const safeQuery = escapeQueryString(query, 'query');
  ensureSafeStringArray(andTerms, 'andTerms');
  ensureSafeStringArray(notTerms, 'notTerms');
  const safeFilters = ensureSafeFilterIdentifiers(filters);
  const safeSortColumn = sortColumn ? ensureSafeIdentifier(sortColumn, 'sortColumn') : '';
  validateFuzzy(fuzzy);
  validateHighlight(highlight);

  ensureQueryLengthWithinLimit(
    {
      query,
      andTerms,
      notTerms,
      filters: safeFilters,
      sortColumn: safeSortColumn
    },
    maxQueryLength
  );

  const parts: string[] = ['SEARCH', safeTable, safeQuery];

  andTerms.forEach((term) => {
    parts.push('AND', escapeQueryString(term, 'andTerms'));
  });
  notTerms.forEach((term) => {
    parts.push('NOT', escapeQueryString(term, 'notTerms'));
  });
  Object.entries(safeFilters).forEach(([key, value]) => {
    parts.push('FILTER', key, '=', escapeQueryString(value, `filters.${key}.value`));
  });

  if (safeSortColumn) {
    parts.push('SORT', safeSortColumn, sortDesc ? 'DESC' : 'ASC');
  }

  if (fuzzy > 0) {
    parts.push('FUZZY', `${fuzzy}`);
  }

  appendHighlightClause(parts, highlight);
  appendLimitOffset(parts, limit, offset);

  return parts.join(' ');
}

/**
 * Append the HIGHLIGHT clause (and its TAG / SNIPPET_LEN / MAX_FRAGMENTS
 * sub-options) when highlight options are present.
 *
 * @param {string[]} parts - Command token list to append to
 * @param {SearchOptions['highlight']} highlight - Highlight options (no-op when undefined)
 * @returns {void}
 */
function appendHighlightClause(parts: string[], highlight: SearchOptions['highlight']): void {
  if (!highlight) return;
  parts.push('HIGHLIGHT');
  const openTag = highlight.openTag ?? '';
  const closeTag = highlight.closeTag ?? '';
  if (openTag !== '' && closeTag !== '') {
    parts.push('TAG', openTag, closeTag);
  }
  if (highlight.snippetLen && highlight.snippetLen > 0) {
    parts.push('SNIPPET_LEN', `${highlight.snippetLen}`);
  }
  if (highlight.maxFragments && highlight.maxFragments > 0) {
    parts.push('MAX_FRAGMENTS', `${highlight.maxFragments}`);
  }
}

/**
 * Build a `SEARCH` command line that sends a pre-built boolean expression as a
 * single search token (MygramDB v1.7+).
 *
 * The raw expression (e.g. `python OR (ruby AND rails)`) is escaped with the
 * same quoting rules as a normal query so the server's AST parser receives one
 * token and can interpret `AND` / `OR` / `NOT` / parentheses. Use this with the
 * output of {@link ../search-expression.convertSearchExpression} when boolean
 * grouping semantics must be preserved rather than decomposed into AND/NOT
 * clauses.
 *
 * @param {string} table - Table name (bare or `database.table`)
 * @param {string} rawQuery - Pre-built boolean expression
 * @param {SearchRawOptions} options - Limit/offset/highlight options
 * @returns {string} Wire command (no trailing CRLF)
 * @throws {InputValidationError} When the table or expression is invalid
 */
export function buildSearchRawCommand(table: string, rawQuery: string, options: SearchRawOptions): string {
  const { limit = 0, offset = 0, highlight } = options;

  const safeTable = ensureSafeIdentifier(table, 'table');
  if (rawQuery === '') {
    throw new InputValidationError('Input for rawQuery must not be empty');
  }
  const safeQuery = escapeQueryString(rawQuery, 'rawQuery');
  validateHighlight(highlight);

  const parts: string[] = ['SEARCH', safeTable, safeQuery];
  appendHighlightClause(parts, highlight);
  appendLimitOffset(parts, limit, offset);
  return parts.join(' ');
}

/**
 * Build a `COUNT` command line.
 *
 * @param {string} table - Table name
 * @param {string} query - Search query text
 * @param {CountOptions} options - Count options
 * @param {number} maxQueryLength - Configured query length limit
 * @returns {string} Wire command (no trailing CRLF)
 */
export function buildCountCommand(table: string, query: string, options: CountOptions, maxQueryLength: number): string {
  const { andTerms = [], notTerms = [], filters = {} } = options;

  const safeTable = ensureSafeIdentifier(table, 'table');
  const safeQuery = escapeQueryString(query, 'query');
  ensureSafeStringArray(andTerms, 'andTerms');
  ensureSafeStringArray(notTerms, 'notTerms');
  const safeFilters = ensureSafeFilterIdentifiers(filters);

  ensureQueryLengthWithinLimit(
    {
      query,
      andTerms,
      notTerms,
      filters: safeFilters,
      sortColumn: ''
    },
    maxQueryLength
  );

  const parts: string[] = ['COUNT', safeTable, safeQuery];
  andTerms.forEach((term) => {
    parts.push('AND', escapeQueryString(term, 'andTerms'));
  });
  notTerms.forEach((term) => {
    parts.push('NOT', escapeQueryString(term, 'notTerms'));
  });
  Object.entries(safeFilters).forEach(([key, value]) => {
    parts.push('FILTER', key, '=', escapeQueryString(value, `filters.${key}.value`));
  });
  return parts.join(' ');
}

/**
 * Build a `FACET` command line.
 *
 * When `options.query` is empty, the FACET command is emitted without a
 * `QUERY` clause, returning facet values across the entire table.
 *
 * @param {string} table - Table name
 * @param {string} column - Column name to aggregate
 * @param {FacetOptions} options - Facet options
 * @param {number} maxQueryLength - Configured query length limit
 * @returns {string} Wire command (no trailing CRLF)
 */
export function buildFacetCommand(
  table: string,
  column: string,
  options: FacetOptions,
  maxQueryLength: number
): string {
  const { query = '', andTerms = [], notTerms = [], filters = {}, limit = 0 } = options;

  const safeTable = ensureSafeIdentifier(table, 'table');
  validateFacetColumn(column);
  ensureSafeStringArray(andTerms, 'andTerms');
  ensureSafeStringArray(notTerms, 'notTerms');
  const safeFilters = ensureSafeFilterIdentifiers(filters);
  ensureQueryLengthWithinLimit(
    {
      query,
      andTerms,
      notTerms,
      filters: safeFilters,
      sortColumn: ''
    },
    maxQueryLength
  );

  const parts: string[] = ['FACET', safeTable, column];

  if (query !== '') {
    parts.push('QUERY', escapeQueryString(query, 'query'));
    andTerms.forEach((term) => {
      parts.push('AND', escapeQueryString(term, 'andTerms'));
    });
    notTerms.forEach((term) => {
      parts.push('NOT', escapeQueryString(term, 'notTerms'));
    });
    Object.entries(safeFilters).forEach(([key, value]) => {
      parts.push('FILTER', key, '=', escapeQueryString(value, `filters.${key}.value`));
    });
  }

  if (limit > 0) {
    parts.push('LIMIT', `${limit}`);
  }

  return parts.join(' ');
}

/**
 * Build a `GET <table> <primaryKey>` command line.
 *
 * @param {string} table - Table name
 * @param {string} primaryKey - Document primary key
 * @returns {string} Wire command (no trailing CRLF)
 */
export function buildGetCommand(table: string, primaryKey: string): string {
  const safeTable = ensureSafeIdentifier(table, 'table');
  const safePrimaryKey = ensureSafeIdentifier(primaryKey, 'primaryKey');
  return `GET ${safeTable} ${safePrimaryKey}`;
}

/**
 * Build a `SET <name> = <value>` runtime-variable command line (MygramDB v1.7+).
 *
 * The variable name is sent unquoted (validated as an identifier); the value
 * is quoted when it contains whitespace or quote characters.
 *
 * @param {string} name - Runtime variable name
 * @param {string} value - New value
 * @returns {string} Wire command (no trailing CRLF)
 * @throws {InputValidationError} When the name is empty/unsafe or the value
 *   contains control characters
 */
export function buildSetVariableCommand(name: string, value: string): string {
  const safeName = ensureSafeIdentifier(name, 'name');
  const safeValue = quoteCommandArgument(value, 'value');
  return `SET ${safeName} = ${safeValue}`;
}

/**
 * Build a `SHOW VARIABLES [LIKE <pattern>]` command line (MygramDB v1.7+).
 *
 * @param {string} [likePattern] - Optional MySQL-style LIKE pattern
 * @returns {string} Wire command (no trailing CRLF)
 * @throws {InputValidationError} When the pattern contains control characters
 */
export function buildShowVariablesCommand(likePattern?: string): string {
  if (likePattern === undefined || likePattern === '') {
    return 'SHOW VARIABLES';
  }
  return `SHOW VARIABLES LIKE ${quoteCommandArgument(likePattern, 'likePattern')}`;
}

/**
 * Build a `SYNC <table>` command line (MygramDB v1.7+).
 *
 * @param {string} table - Table name (bare or `database.table`)
 * @returns {string} Wire command (no trailing CRLF)
 * @throws {InputValidationError} When the table name is empty/unsafe
 */
export function buildSyncCommand(table: string): string {
  return `SYNC ${ensureSafeIdentifier(table, 'table')}`;
}

/**
 * Build a `SYNC STOP [table]` command line (MygramDB v1.7+).
 *
 * An empty/omitted table stops every in-flight sync; a named table validates
 * as an identifier and stops only that table.
 *
 * @param {string} [table] - Optional table name (bare or `database.table`)
 * @returns {string} Wire command (no trailing CRLF)
 * @throws {InputValidationError} When a non-empty table name is unsafe
 */
export function buildSyncStopCommand(table?: string): string {
  if (table === undefined || table === '') {
    return 'SYNC STOP';
  }
  return `SYNC STOP ${ensureSafeIdentifier(table, 'table')}`;
}
