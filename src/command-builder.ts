/**
 * Wire-command builders shared between the JavaScript and native clients.
 *
 * Each builder validates inputs and returns the assembled command string
 * (without trailing CRLF). This keeps protocol-formatting concerns in one
 * place so both transports stay in sync.
 */

import {
  ensureQueryLengthWithinLimit,
  ensureSafeCommandValue,
  ensureSafeFilterIdentifiers,
  ensureSafeIdentifier,
  ensureSafeStringArray,
  escapeQueryString,
  validateFacetColumn,
  validateFuzzy,
  validateHighlight
} from './command-utils.js';
import type { CountOptions, FacetOptions, SearchOptions } from './types.js';

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
    parts.push('AND', term);
  });
  notTerms.forEach((term) => {
    parts.push('NOT', term);
  });
  Object.entries(safeFilters).forEach(([key, value]) => {
    parts.push('FILTER', key, '=', value);
  });

  if (safeSortColumn) {
    parts.push('SORT', safeSortColumn, sortDesc ? 'DESC' : 'ASC');
  }

  if (fuzzy > 0) {
    parts.push('FUZZY', `${fuzzy}`);
  }

  if (highlight) {
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

  if (offset > 0 && limit > 0) {
    parts.push('LIMIT', `${offset},${limit}`);
  } else if (offset > 0) {
    // limit == 0: surface the offset instead of silently dropping it.
    parts.push('OFFSET', `${offset}`);
  } else if (limit > 0) {
    parts.push('LIMIT', `${limit}`);
  }

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
    parts.push('AND', term);
  });
  notTerms.forEach((term) => {
    parts.push('NOT', term);
  });
  Object.entries(safeFilters).forEach(([key, value]) => {
    parts.push('FILTER', key, '=', value);
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
  const safeQuery = query ? ensureSafeCommandValue(query, 'query') : '';
  ensureSafeStringArray(andTerms, 'andTerms');
  ensureSafeStringArray(notTerms, 'notTerms');
  const safeFilters = ensureSafeFilterIdentifiers(filters);
  ensureQueryLengthWithinLimit(
    {
      query: safeQuery,
      andTerms,
      notTerms,
      filters: safeFilters,
      sortColumn: ''
    },
    maxQueryLength
  );

  const parts: string[] = ['FACET', safeTable, column];

  if (safeQuery !== '') {
    parts.push('QUERY', safeQuery);
    andTerms.forEach((term) => {
      parts.push('AND', term);
    });
    notTerms.forEach((term) => {
      parts.push('NOT', term);
    });
    Object.entries(safeFilters).forEach(([key, value]) => {
      parts.push('FILTER', key, '=', value);
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
