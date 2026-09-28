import { InputValidationError } from './errors.js';
import type { FilterCondition, FilterOperator, FilterSpec, HighlightOptions } from './types.js';

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

/** Comparison operators the server accepts in a FILTER clause. */
const FILTER_OPERATORS: readonly FilterOperator[] = ['=', '!=', '<>', '>', '>=', '<', '<='];

/**
 * Normalize either accepted {@link FilterSpec} shape into a validated,
 * canonical list of conditions with an explicit operator.
 *
 * Column names are sent unquoted so they are validated as identifiers (no
 * whitespace); values may contain spaces and are only checked for control
 * characters, since the caller quotes them. An omitted operator becomes `=`,
 * which is what every MygramDB version supports.
 *
 * @param {FilterSpec | undefined} filters - Record or array form (undefined yields an empty list)
 * @returns {FilterCondition[]} Validated conditions with a resolved operator
 * @throws {InputValidationError} When a column, operator or value is unsafe
 */
export function normalizeFilters(filters: FilterSpec | undefined): FilterCondition[] {
  if (filters === undefined) {
    return [];
  }

  const raw: FilterCondition[] = Array.isArray(filters)
    ? filters
    : Object.entries(filters).map(([column, spec]) =>
        typeof spec === 'string' ? { column, value: spec } : { column, op: spec.op, value: spec.value }
      );

  return raw.map((condition) => {
    const { column } = condition;
    ensureSafeIdentifier(column, `filters.${column}.key`);
    const op = condition.op ?? '=';
    if (!FILTER_OPERATORS.includes(op)) {
      throw new InputValidationError(
        `Invalid filter operator "${op}" for ${column}: must be one of ${FILTER_OPERATORS.join(', ')}`
      );
    }
    ensureSafeCommandValue(condition.value, `filters.${column}.value`);
    return { column, op, value: condition.value };
  });
}

/**
 * Protocol clause keywords. A term equal to one of these must be quoted or
 * the server's parser would read it as the start of a clause instead of as
 * text to match. Mirrors the keyword set in the C++ client's
 * `wire_quoting.h::IsReservedKeyword`.
 */
const QUERY_RESERVED_WORDS: ReadonlySet<string> = new Set([
  'AND',
  'OR',
  'NOT',
  'FILTER',
  'SORT',
  'LIMIT',
  'OFFSET',
  'HIGHLIGHT',
  'FUZZY',
  'FACET',
  'ORDER'
]);

/**
 * Non-ASCII whitespace code points the server's tokenizer splits on outside
 * quotes, beyond ASCII space/tab/CR/LF: U+00A0, U+1680, U+2000-U+200B,
 * U+2028, U+2029, U+202F, U+205F, U+3000. Mirrors `wire_quoting.h::IsUnicodeWhitespace`.
 */
const UNICODE_WHITESPACE = /[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000]/;

/**
 * Check whether `value` must be quoted to survive the wire tokenizer intact:
 * empty, a reserved clause keyword (case-insensitive), or containing
 * ASCII/Unicode whitespace, a control character, a quote, a backslash or a
 * parenthesis. Mirrors the C++ client's `wire_quoting.h::NeedsWireQuoting`,
 * the single decision every wire-bound string in that client shares.
 *
 * @param {string} value - Value to test
 * @returns {boolean} True when {@link quoteWireToken} would wrap it
 */
export function needsWireQuoting(value: string): boolean {
  if (value === '') {
    return true;
  }
  if (QUERY_RESERVED_WORDS.has(value.toUpperCase())) {
    return true;
  }
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const code = char.charCodeAt(0);
    if (
      char === ' ' ||
      char === '\t' ||
      char === '\n' ||
      char === '\r' ||
      char === '"' ||
      char === "'" ||
      char === '\\' ||
      char === '(' ||
      char === ')' ||
      code <= 0x1f ||
      code === 0x7f ||
      UNICODE_WHITESPACE.test(char)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Wrap a value in double quotes when {@link needsWireQuoting} says the wire
 * tokenizer would otherwise split it into multiple protocol tokens or
 * misread it as a clause keyword, escaping the characters that are special
 * inside a quoted token. Values that need no quoting are returned verbatim
 * so a simple single-token query stays byte-identical on the wire.
 *
 * This is the one quoting decision every wire-bound string in this client
 * shares -- search terms, filter values, AND/NOT terms, highlight tags,
 * primary keys and command arguments -- mirroring the C++ client's
 * `wire_quoting.h::QuoteWireToken`, which every one of its escaping
 * functions (`EscapeQueryString`, `QuoteCommandArgumentIfNeeded`,
 * `EscapeProtocolToken`) now delegates to.
 *
 * @param {string} value - Value to quote (already control-char validated by
 *   the caller; a stray control byte is still escaped as `\xHH` here as a
 *   second line of defense)
 * @returns {string} Wire-safe single token
 */
export function quoteWireToken(value: string): string {
  if (!needsWireQuoting(value)) {
    return value;
  }

  let result = '"';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const code = char.charCodeAt(0);
    if (char === '\\') {
      result += '\\\\';
    } else if (char === '"') {
      result += '\\"';
    } else if (char === '\r') {
      result += '\\r';
    } else if (char === '\n') {
      result += '\\n';
    } else if (char === '\t') {
      result += '\\t';
    } else if (code <= 0x1f || code === 0x7f) {
      result += `\\x${code.toString(16).toUpperCase().padStart(2, '0')}`;
    } else {
      result += char;
    }
  }
  result += '"';
  return result;
}

/**
 * Escape a literal query string for transmission. Empty strings are surfaced as
 * the explicit token `""` so the server receives a well-formed empty argument.
 * Non-empty strings are validated for control characters and then quoted when
 * they contain whitespace, quote characters, a backslash or a parenthesis, or
 * when the whole value is a protocol keyword such as `AND`.
 *
 * This matches the C++ client's `EscapeQueryString`, so literal user text keeps
 * its meaning: `search('articles', 'alpha AND beta')` looks for the phrase, and
 * only {@link ./command-builder.buildSearchRawCommand} or a `boolean` query mode
 * hands `AND` to the server's expression parser.
 *
 * @param {string} value - Query string value
 * @param {string} fieldName - Field name for clearer error messages
 * @returns {string} Wire-safe representation of the query string
 * @throws {InputValidationError} When the value contains control characters
 */
export function escapeQueryString(value: string, fieldName: string): string {
  if (value !== '') {
    ensureSafeCommandValue(value, fieldName);
  }
  return quoteWireToken(value);
}

/**
 * Quote a free-form command argument (e.g. a `SET` value, an `AUTH` token, a
 * `SHOW VARIABLES LIKE` pattern or a `DUMP` filepath). Mirrors the C++
 * client's `QuoteCommandArgumentIfNeeded`, which -- like `EscapeQueryString`
 * -- now delegates to the same shared `QuoteWireToken`, so this is
 * identical to {@link escapeQueryString} beyond the field name used in error
 * messages; the two names stay separate to match the distinct wire
 * positions their callers write.
 *
 * An empty value is allowed and surfaced as the explicit empty token `""`.
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
  return quoteWireToken(value);
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
 * Calculate the query expression length using the same logic as the server.
 *
 * The server counts the search text, every AND/NOT term, each filter's column
 * and value, and the sort column. Filter operators and clause keywords are not
 * counted, so `>=` costs the same as `=`.
 *
 * @param {string} query - Base search text
 * @param {string[]} andTerms - Additional AND terms
 * @param {string[]} notTerms - NOT terms
 * @param {FilterCondition[]} filters - Normalized filter conditions
 * @param {string} sortColumn - Sort column if specified
 * @returns {number} Total expression length
 */
export function calculateQueryExpressionLength(
  query: string,
  andTerms: string[],
  notTerms: string[],
  filters: FilterCondition[],
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

  filters.forEach(({ column, value }) => {
    length += column.length;
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
 * @param {FilterCondition[]} params.filters - Normalized filter conditions
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
    filters: FilterCondition[];
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
