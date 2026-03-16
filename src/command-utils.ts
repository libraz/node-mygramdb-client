import { InputValidationError } from './errors.js';

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
