/**
 * Web-style search expression parser (+/- syntax)
 *
 * Converts web-style search expressions into MygramDB query format.
 *
 * Syntax:
 * - `+term` - Required term (must appear)
 * - `-term` - Excluded term (must not appear)
 * - `term1 term2` - Multiple terms (implicit AND)
 * - `"phrase"` - Quoted phrase (exact match with spaces)
 * - `(expr)` - Grouping
 * - `OR` - Logical OR between terms
 *
 * Examples:
 * - `golang tutorial` → `golang AND tutorial` (implicit AND)
 * - `"machine learning" tutorial` → `"machine learning" AND tutorial` (phrase search)
 * - `golang -old` → `golang AND NOT old`
 * - `python OR ruby` → `(python OR ruby)`
 * - `golang +(tutorial OR guide)` → `golang AND (tutorial OR guide)`
 * - `hello world` → `hello AND world` (full-width space supported)
 */

/**
 * Parsed search expression components
 */
export interface SearchExpression {
  /** Terms with + prefix (AND) */
  requiredTerms: string[];
  /** Terms with - prefix (NOT) */
  excludedTerms: string[];
  /** Terms without prefix */
  optionalTerms: string[];
  /** Original expression for OR/grouping */
  rawExpression: string;
}

// ESM-compatible require for loading native .node bindings
import { createRequire } from 'node:module';

const nativeRequire = createRequire(import.meta.url);

/**
 * Token types for expression parsing
 */
enum TokenType {
  WORD = 'WORD',
  QUOTED = 'QUOTED',
  PLUS = 'PLUS',
  MINUS = 'MINUS',
  OR = 'OR',
  LPAREN = 'LPAREN',
  RPAREN = 'RPAREN',
  EOF = 'EOF'
}

interface Token {
  type: TokenType;
  value: string;
  position: number;
}

/**
 * Tokenizer for search expressions
 */
class Tokenizer {
  private input: string;
  private position: number;
  private tokens: Token[];

  constructor(input: string) {
    // Normalize full-width spaces to half-width (U+3000)

    this.input = input.replace(/　/g, ' ');
    this.position = 0;
    this.tokens = [];
  }

  tokenize(): Token[] {
    while (this.position < this.input.length) {
      this.skipWhitespace();
      if (this.position >= this.input.length) break;

      const char = this.input[this.position];

      if (char === '+') {
        this.tokens.push({ type: TokenType.PLUS, value: '+', position: this.position });
        this.position += 1;
      } else if (char === '-') {
        this.tokens.push({ type: TokenType.MINUS, value: '-', position: this.position });
        this.position += 1;
      } else if (char === '(') {
        this.tokens.push({ type: TokenType.LPAREN, value: '(', position: this.position });
        this.position += 1;
      } else if (char === ')') {
        this.tokens.push({ type: TokenType.RPAREN, value: ')', position: this.position });
        this.position += 1;
      } else if (char === '"') {
        this.tokenizeQuoted();
      } else {
        this.tokenizeWord();
      }
    }

    this.tokens.push({ type: TokenType.EOF, value: '', position: this.position });
    return this.tokens;
  }

  private skipWhitespace(): void {
    while (this.position < this.input.length && /\s/.test(this.input[this.position])) {
      this.position += 1;
    }
  }

  private tokenizeQuoted(): void {
    const start = this.position;
    this.position += 1; // Skip opening quote

    let value = '';
    while (this.position < this.input.length && this.input[this.position] !== '"') {
      value += this.input[this.position];
      this.position += 1;
    }

    if (this.position >= this.input.length) {
      throw new Error(`Unterminated quoted string at position ${start}`);
    }

    this.position += 1; // Skip closing quote
    this.tokens.push({ type: TokenType.QUOTED, value, position: start });
  }

  private tokenizeWord(): void {
    const start = this.position;
    let value = '';

    while (this.position < this.input.length && !/[\s+\-()"]/.test(this.input[this.position])) {
      value += this.input[this.position];
      this.position += 1;
    }

    if (value.toUpperCase() === 'OR') {
      this.tokens.push({ type: TokenType.OR, value: 'OR', position: start });
    } else {
      this.tokens.push({ type: TokenType.WORD, value, position: start });
    }
  }
}

/**
 * Parse web-style search expression
 *
 * Converts expressions like "+golang -old (tutorial OR guide)" into
 * structured format that can be converted to QueryAST.
 *
 * @param {string} expression - Web-style search expression
 * @returns {SearchExpression} Parsed expression components
 * @throws {Error} If expression is invalid
 */
export function parseSearchExpression(expression: string): SearchExpression {
  if (!expression || expression.trim().length === 0) {
    throw new Error('Search expression cannot be empty');
  }

  const tokenizer = new Tokenizer(expression);
  const tokens = tokenizer.tokenize();

  const result: SearchExpression = {
    requiredTerms: [],
    excludedTerms: [],
    optionalTerms: [],
    rawExpression: expression
  };

  let hasComplexExpr = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token.type === TokenType.EOF) break;

    if (token.type === TokenType.PLUS) {
      // Required term or grouped expression
      const nextToken = tokens[i + 1];
      if (!nextToken) {
        throw new Error(`Expected term after '+' at position ${token.position}`);
      }

      if (nextToken.type === TokenType.LPAREN) {
        // Grouped expression - mark as complex
        hasComplexExpr = true;
        i += 1; // Skip the opening paren
      } else if (nextToken.type === TokenType.WORD || nextToken.type === TokenType.QUOTED) {
        // Add quotes back for quoted terms (phrase search)
        const term = nextToken.type === TokenType.QUOTED ? `"${nextToken.value}"` : nextToken.value;
        result.requiredTerms.push(term);
        i += 1; // Skip the term we just processed
      } else {
        throw new Error(`Expected term after '+' at position ${token.position}`);
      }
    } else if (token.type === TokenType.MINUS) {
      // Excluded term
      const nextToken = tokens[i + 1];
      if (!nextToken || (nextToken.type !== TokenType.WORD && nextToken.type !== TokenType.QUOTED)) {
        throw new Error(`Expected term after '-' at position ${token.position}`);
      }
      // Add quotes back for quoted terms (phrase search)
      const term = nextToken.type === TokenType.QUOTED ? `"${nextToken.value}"` : nextToken.value;
      result.excludedTerms.push(term);
      i += 1; // Skip the term we just processed
    } else if (token.type === TokenType.WORD || token.type === TokenType.QUOTED) {
      // Optional term (no prefix) - add quotes back for quoted terms
      const term = token.type === TokenType.QUOTED ? `"${token.value}"` : token.value;
      result.optionalTerms.push(term);
    } else if (token.type === TokenType.OR || token.type === TokenType.LPAREN || token.type === TokenType.RPAREN) {
      hasComplexExpr = true;
    }
  }

  // If we have complex expressions (OR, grouping), we keep the raw expression
  // Otherwise, we can simplify
  if (!hasComplexExpr) {
    result.rawExpression = '';
  }

  return result;
}

/**
 * Check if expression has OR operators or grouping
 *
 * @param {SearchExpression} expr - Parsed search expression
 * @returns {boolean} True if expression has OR operators or grouping
 */
export function hasComplexExpression(expr: SearchExpression): boolean {
  return expr.rawExpression.length > 0 && (expr.rawExpression.includes('OR') || expr.rawExpression.includes('('));
}

/**
 * Convert search expression to query string for QueryASTParser
 *
 * Generates proper boolean query string:
 * - Required terms: joined with AND
 * - Excluded terms: prefixed with NOT
 * - Optional terms: joined with OR (if no required terms)
 *
 * @param {SearchExpression} expr - Parsed search expression
 * @returns {string} Query string compatible with QueryASTParser
 */
export function toQueryString(expr: SearchExpression): string {
  const parts: string[] = [];

  // Add required terms
  if (expr.requiredTerms.length > 0) {
    parts.push(expr.requiredTerms.join(' AND '));
  }

  // Add optional terms
  if (expr.optionalTerms.length > 0) {
    if (expr.requiredTerms.length === 0) {
      // No required terms, treat optional as OR
      parts.push(expr.optionalTerms.join(' OR '));
    } else {
      // Has required terms, treat optional as AND
      parts.push(expr.optionalTerms.join(' AND '));
    }
  }

  // Add excluded terms
  if (expr.excludedTerms.length > 0) {
    parts.push(expr.excludedTerms.map((term) => `NOT ${term}`).join(' AND '));
  }

  return parts.join(' AND ');
}

/**
 * Convert search expression directly to QueryAST-compatible string
 *
 * This is a convenience function that combines parseSearchExpression
 * and toQueryString() in one call.
 *
 * Examples:
 * - `+golang tutorial` → `golang AND (tutorial)`
 * - `+golang -old` → `golang AND NOT old`
 * - `python OR ruby` → `python OR ruby`
 * - `+golang +(tutorial OR guide)` → `golang AND (tutorial OR guide)`
 *
 * @param {string} expression - Web-style search expression
 * @returns {string} QueryAST-compatible query string
 * @throws {Error} If expression is invalid
 */
export function convertSearchExpression(expression: string): string {
  const expr = parseSearchExpression(expression);

  // If has complex expression with OR/grouping, return as-is
  if (hasComplexExpression(expr)) {
    return expr.rawExpression;
  }

  return toQueryString(expr);
}

/**
 * Simplify search expression to basic terms (for backward compatibility)
 *
 * For clients that don't support QueryAST, this extracts simple term lists.
 * Complex expressions with OR/grouping will lose semantic meaning.
 *
 * @param {string} expression - Web-style search expression
 * @returns {{ mainTerm: string, andTerms: string[], notTerms: string[] }} Simplified terms object
 * @throws {Error} If expression is invalid or has no positive terms
 */
export function simplifySearchExpression(expression: string): {
  mainTerm: string;
  andTerms: string[];
  notTerms: string[];
} {
  const expr = parseSearchExpression(expression);

  const allPositiveTerms = [...expr.requiredTerms, ...expr.optionalTerms];

  if (allPositiveTerms.length === 0) {
    throw new Error('Search expression must have at least one positive term');
  }

  return {
    mainTerm: allPositiveTerms[0],
    andTerms: allPositiveTerms.slice(1),
    notTerms: expr.excludedTerms
  };
}

/**
 * Native binding interface for search expression parser
 */
interface NativeBinding {
  parseSearchExpression(expression: string): {
    mainTerm: string;
    andTerms: string[];
    notTerms: string[];
    optionalTerms: string[];
  };
}

/**
 * Type guard to check if native binding is valid
 */
function isNativeBinding(binding: unknown): binding is NativeBinding {
  return (
    typeof binding === 'object' &&
    binding !== null &&
    'parseSearchExpression' in binding &&
    typeof (binding as NativeBinding).parseSearchExpression === 'function'
  );
}

/**
 * Parse search expression using native binding if available
 *
 * This function attempts to use the native C++ parser for better performance.
 * Falls back to JavaScript implementation if native binding is not available.
 *
 * @param {string} expression - Web-style search expression
 * @returns {{ mainTerm: string, andTerms: string[], notTerms: string[], optionalTerms: string[] }} Parsed expression
 * @throws {Error} If expression is invalid
 */
export function parseSearchExpressionNative(expression: string): {
  mainTerm: string;
  andTerms: string[];
  notTerms: string[];
  optionalTerms: string[];
} {
  try {
    // Try to load native binding
    const binding: unknown = nativeRequire('../build/Release/mygram_native.node');
    if (isNativeBinding(binding)) {
      return binding.parseSearchExpression(expression);
    }
  } catch {
    // Native binding not available, fall through to JS implementation
  }

  // Fallback to JavaScript implementation
  const expr = parseSearchExpression(expression);
  const allPositiveTerms = [...expr.requiredTerms, ...expr.optionalTerms];

  if (allPositiveTerms.length === 0) {
    throw new Error('Search expression must have at least one positive term');
  }

  return {
    mainTerm: allPositiveTerms[0],
    andTerms: allPositiveTerms.slice(1),
    notTerms: expr.excludedTerms,
    optionalTerms: expr.optionalTerms
  };
}
