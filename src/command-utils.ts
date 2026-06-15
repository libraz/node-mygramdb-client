import { InputValidationError } from './errors.js';
import type { HighlightOptions } from './types.js';

export const DEFAULT_MAX_QUERY_LENGTH = 128;

/**
 * Check if a character is a control character (0x00-0x1F, 0x7F)
 * This matches the C++ std::iscntrl behavior
 *
 * @param {string} char - Single character to check
 * @returns {boolean} True if character is a control character
 */
function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 0x00 && code <= 0x1f) || code === 0x7f;
}

/**
 * Get a description of a control character for error messages
 *
 * @param {string} char - Control character
 * @returns {string} Human-readable description
 */
function getControlCharDescription(char: string): string {
  const code = char.charCodeAt(0);
  const specialChars: Record<number, string> = {
    0: 'null byte (\\0)',
    9: 'tab (\\t)',
    10: 'line feed (\\n)',
    13: 'carriage return (\\r)',
    127: 'delete (DEL)'
  };
  return specialChars[code] || `control character 0x${code.toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * Ensure a command token does not contain characters that would break
 * the Mygram text protocol (like CR/LF that terminate commands).
 * This validates against all control characters (0x00-0x1F, 0x7F)
 * to match the C++ client implementation.
 *
 * @param {string} value - Token value to validate
 * @param {string} fieldName - Field name for clearer error messages
 * @returns {string} The original value when it is safe
 * @throws {InputValidationError} When the value contains unsafe characters
 */
export function ensureSafeCommandValue(value: string, fieldName: string): string {
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (isControlCharacter(char)) {
      const description = getControlCharDescription(char);
      throw new InputValidationError(`Input for ${fieldName} contains ${description}, which is not allowed`);
    }
  }
  return value;
}

/**
 * Ensure a value is usable as a single, unquoted identifier in the protocol.
 *
 * Identifiers (table names, primary keys, sort columns, filter keys,
 * dump filepaths) are sent unquoted on the wire, so any embedded whitespace
 * would split a single identifier into multiple tokens and break the
 * command. This validator additionally rejects empty strings and the
 * full set of control characters covered by {@link ensureSafeCommandValue}.
 *
 * @param {string} value - Identifier value to validate
 * @param {string} fieldName - Field name for clearer error messages
 * @returns {string} The original value when it is safe
 * @throws {InputValidationError} When the value is empty or contains
 *   whitespace/control characters
 */
export function ensureSafeIdentifier(value: string, fieldName: string): string {
  if (value === '') {
    throw new InputValidationError(`Input for ${fieldName} must not be empty`);
  }
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (isControlCharacter(char)) {
      const description = getControlCharDescription(char);
      throw new InputValidationError(`Input for ${fieldName} contains ${description}, which is not allowed`);
    }
    if (char === ' ' || char === '\t') {
      throw new InputValidationError(`Input for ${fieldName} must not contain whitespace`);
    }
  }
  return value;
}

/**
 * Validate every key in a filters record as an identifier and every value
 * as a safe command token. Keys are sent unquoted (so cannot contain
 * whitespace), but values may contain spaces.
 *
 * @param {Record<string, string>} filters - Filter map
 * @returns {Record<string, string>} The original filters when safe
 */
export function ensureSafeFilterIdentifiers(filters: Record<string, string>): Record<string, string> {
  Object.entries(filters).forEach(([key, value]) => {
    ensureSafeIdentifier(key, `filters.${key}.key`);
    ensureSafeCommandValue(value, `filters.${key}.value`);
  });
  return filters;
}

/**
 * Wrap a value in double quotes when it would otherwise split into multiple
 * protocol tokens, escaping the characters that are special inside a quoted
 * token.
 *
 * This mirrors the C++ client's `EscapeQueryString` /
 * `QuoteCommandArgumentIfNeeded`: a value is quoted when it is empty or
 * contains whitespace or a quote character. Inside the quotes, `"` and `\`
 * are backslash-escaped and any remaining control characters (code < 0x20)
 * are dropped. Values that need no quoting are returned verbatim so simple
 * single-token queries stay byte-identical on the wire.
 *
 * `quoteOnBackslash` selects which upstream helper is mirrored: query strings
 * follow `EscapeQueryString` (a lone backslash does NOT force quoting), while
 * command arguments follow `QuoteCommandArgumentIfNeeded` (a backslash does).
 *
 * @param {string} value - Value to quote (already control-char validated)
 * @param {boolean} quoteOnBackslash - Whether a lone `\` forces quoting
 * @returns {string} Wire-safe single token
 */
function quoteTokenIfNeeded(value: string, quoteOnBackslash: boolean): string {
  if (value === '') {
    return '""';
  }

  let needsQuotes = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (
      char === ' ' ||
      char === '\t' ||
      char === '\n' ||
      char === '\r' ||
      char === '"' ||
      char === "'" ||
      (quoteOnBackslash && char === '\\')
    ) {
      needsQuotes = true;
      break;
    }
  }

  if (!needsQuotes) {
    return value;
  }

  let result = '"';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char.charCodeAt(0) < 0x20) {
      // Drop control characters to prevent command injection.
      continue;
    }
    if (char === '"' || char === '\\') {
      result += '\\';
    }
    result += char;
  }
  result += '"';
  return result;
}

/**
 * Escape a query string for transmission. Empty strings are surfaced as
 * the explicit token `""` so the server receives a well-formed empty
 * argument. Non-empty strings are validated for control characters and then
 * quoted when they contain whitespace or quote characters, matching the C++
 * client's `EscapeQueryString` so multi-word phrases and boolean expressions
 * reach the server as a single token.
 *
 * @param {string} value - Query string value
 * @param {string} fieldName - Field name for clearer error messages
 * @returns {string} Wire-safe representation of the query string
 * @throws {InputValidationError} When the value contains control characters
 */
export function escapeQueryString(value: string, fieldName: string): string {
  if (value === '') {
    return '""';
  }
  ensureSafeCommandValue(value, fieldName);
  return quoteTokenIfNeeded(value, false);
}

/**
 * Quote a free-form command argument (e.g. a `SET` value or `SHOW VARIABLES
 * LIKE` pattern) when it contains whitespace or quote characters. Mirrors the
 * C++ client's `QuoteCommandArgumentIfNeeded`.
 *
 * Unlike {@link escapeQueryString}, an empty value is allowed and surfaced as
 * the explicit empty token `""`.
 *
 * @param {string} value - Argument value
 * @param {string} fieldName - Field name for clearer error messages
 * @returns {string} Wire-safe single token
 * @throws {InputValidationError} When the value contains control characters
 */
export function quoteCommandArgument(value: string, fieldName: string): string {
  if (value !== '') {
    ensureSafeCommandValue(value, fieldName);
  }
  return quoteTokenIfNeeded(value, true);
}

/**
 * Build a database-qualified table identity (`database.table`) for MygramDB
 * v1.7+ multi-database deployments.
 *
 * A single-database deployment continues to accept a bare table name, so an
 * empty/omitted `database` returns just the validated table name. When a
 * database is supplied, both parts are validated as identifiers and must not
 * themselves contain a `.` separator; they are then joined as
 * `database.table`.
 *
 * @param {string} table - Bare table name
 * @param {string} [database] - Owning database (empty/omitted for single-db)
 * @returns {string} `database.table`, or `table` when no database is given
 * @throws {InputValidationError} When either part is empty, contains
 *   whitespace/control characters, or embeds a `.` separator
 *
 * @example
 * ```typescript
 * qualifyTableIdentity('articles');             // 'articles'
 * qualifyTableIdentity('articles', 'app_db');   // 'app_db.articles'
 * ```
 */
export function qualifyTableIdentity(table: string, database?: string): string {
  const safeTable = ensureSafeIdentifier(table, 'table');
  if (database === undefined || database === '') {
    return safeTable;
  }
  const safeDatabase = ensureSafeIdentifier(database, 'database');
  if (safeDatabase.includes('.')) {
    throw new InputValidationError("Input for database must not contain a '.' separator");
  }
  if (safeTable.includes('.')) {
    throw new InputValidationError("Input for table must not contain a '.' when a database is supplied separately");
  }
  return `${safeDatabase}.${safeTable}`;
}

/**
 * Split a (possibly database-qualified) table identity into its parts.
 *
 * Bare names return `{ database: null, table }`; qualified names are split on
 * the first `.` so `app_db.articles` yields `{ database: 'app_db', table:
 * 'articles' }`. The identity is validated as a protocol identifier first.
 *
 * @param {string} identity - `database.table` or a bare `table`
 * @returns {{ database: string | null; table: string }} Parsed parts
 * @throws {InputValidationError} When the identity is empty/unsafe or has an
 *   empty database or table half
 */
export function parseTableIdentity(identity: string): { database: string | null; table: string } {
  ensureSafeIdentifier(identity, 'table');
  const dot = identity.indexOf('.');
  if (dot === -1) {
    return { database: null, table: identity };
  }
  const database = identity.slice(0, dot);
  const table = identity.slice(dot + 1);
  if (database === '' || table === '') {
    throw new InputValidationError(`Invalid table identity "${identity}": expected <database>.<table>`);
  }
  return { database, table };
}

/**
 * Validates every entry of a string array.
 *
 * @param {string[]} values - Values to validate
 * @param {string} fieldName - Field name prefix for error context
 * @returns {string[]} Validated values (same references)
 */
export function ensureSafeStringArray(values: string[], fieldName: string): string[] {
  values.forEach((value, idx) => {
    ensureSafeCommandValue(value, `${fieldName}[${idx}]`);
  });
  return values;
}

/**
 * Validates a filters record by ensuring both keys and values are safe.
 *
 * @param {Record<string, string>} filters - Filter map
 * @returns {Record<string, string>} The original filters when safe
 */
export function ensureSafeFilters(filters: Record<string, string>): Record<string, string> {
  Object.entries(filters).forEach(([key, value]) => {
    ensureSafeCommandValue(key, `filters.${key}.key`);
    ensureSafeCommandValue(value, `filters.${key}.value`);
  });
  return filters;
}

/**
 * Calculate the query expression length using the same logic as the server.
 *
 * @param {string} query - Base search text
 * @param {string[]} andTerms - Additional AND terms
 * @param {string[]} notTerms - NOT terms
 * @param {Record<string, string>} filters - Filters map
 * @param {string} sortColumn - Sort column if specified
 * @returns {number} Total expression length
 */
export function calculateQueryExpressionLength(
  query: string,
  andTerms: string[],
  notTerms: string[],
  filters: Record<string, string>,
  sortColumn: string
): number {
  let { length } = query;

  const accumulateTerms = (terms: string[]): void => {
    terms.forEach((term) => {
      length += term.length;
    });
  };

  accumulateTerms(andTerms);
  accumulateTerms(notTerms);

  Object.entries(filters).forEach(([key, value]) => {
    length += key.length;
    length += value.length;
  });

  if (sortColumn) {
    length += sortColumn.length;
  }

  return length;
}

/**
 * Ensure the query expression respects the configured length limit.
 *
 * @param {object} params - Query components
 * @param {string} params.query - Search text
 * @param {string[]} params.andTerms - Additional AND terms
 * @param {string[]} params.notTerms - NOT terms
 * @param {Record<string, string>} params.filters - Filters map
 * @param {string} params.sortColumn - Sort column
 * @param {number} maxLength - Maximum allowed length (0 disables check)
 * @throws {InputValidationError} When the query exceeds the limit
 */
export function ensureQueryLengthWithinLimit(
  {
    query,
    andTerms,
    notTerms,
    filters,
    sortColumn
  }: {
    query: string;
    andTerms: string[];
    notTerms: string[];
    filters: Record<string, string>;
    sortColumn: string;
  },
  maxLength: number
): void {
  if (maxLength <= 0) {
    return;
  }

  const expressionLength = calculateQueryExpressionLength(query, andTerms, notTerms, filters, sortColumn);
  if (expressionLength > maxLength) {
    throw new InputValidationError(
      `Query expression length (${expressionLength}) exceeds maximum allowed length of ${maxLength} characters.`
    );
  }
}

/**
 * Validate a FUZZY edit distance. The server accepts 1 or 2; 0 disables the clause.
 *
 * @param {number} distance - Fuzzy edit distance
 * @throws {InputValidationError} When the distance is outside 0..2
 */
export function validateFuzzy(distance: number): void {
  if (distance === 0 || distance === 1 || distance === 2) {
    return;
  }
  throw new InputValidationError(`Invalid fuzzy distance ${distance}: must be 0, 1, or 2`);
}

/**
 * Validate HIGHLIGHT clause options.
 *
 * `openTag`/`closeTag` must both be empty or both be set, contain no
 * control or whitespace characters, and `snippetLen`/`maxFragments` must
 * fall within the documented ranges.
 *
 * @param {HighlightOptions | undefined} highlight - Highlight options to validate (no-op when undefined)
 * @throws {InputValidationError} When options are invalid
 */
export function validateHighlight(highlight: HighlightOptions | undefined): void {
  if (!highlight) return;

  const openTag = highlight.openTag ?? '';
  const closeTag = highlight.closeTag ?? '';
  if ((openTag === '') !== (closeTag === '')) {
    throw new InputValidationError('highlight openTag and closeTag must be set together');
  }

  for (const [name, value] of [
    ['highlight.openTag', openTag],
    ['highlight.closeTag', closeTag]
  ] as const) {
    if (value === '') continue;
    ensureSafeCommandValue(value, name);
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (ch === ' ' || ch === '\t') {
        throw new InputValidationError(`${name} must not contain whitespace: ${JSON.stringify(value)}`);
      }
    }
  }

  const snippetLen = highlight.snippetLen ?? 0;
  if (snippetLen < 0 || snippetLen > 10000) {
    throw new InputValidationError(`highlight.snippetLen out of range (0..10000): ${snippetLen}`);
  }

  const maxFragments = highlight.maxFragments ?? 0;
  if (maxFragments < 0 || maxFragments > 100) {
    throw new InputValidationError(`highlight.maxFragments out of range (0..100): ${maxFragments}`);
  }
}

/**
 * Validate a FACET column name. Same rules as table names: must be non-empty
 * and contain no control or whitespace characters.
 *
 * @param {string} column - Column name
 * @throws {InputValidationError} When the column name is invalid
 */
export function validateFacetColumn(column: string): void {
  if (column === '') {
    throw new InputValidationError('facet column must not be empty');
  }
  for (let i = 0; i < column.length; i += 1) {
    const ch = column[i];
    const code = ch.charCodeAt(0);
    if ((code >= 0x00 && code <= 0x1f) || code === 0x7f || ch === ' ' || ch === '\t') {
      throw new InputValidationError(`facet column contains invalid character: ${JSON.stringify(ch)}`);
    }
  }
}
