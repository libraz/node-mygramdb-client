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

// createRequire accepts either an absolute path or a file URL string, so the
// CJS bundle can base it on __filename and the ESM bundle on import.meta.url.
const nativeRequire = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url);

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

  const tokens = new Tokenizer(expression).tokenize();
  const result: SearchExpression = {
    requiredTerms: [],
    excludedTerms: [],
    optionalTerms: [],
    rawExpression: ''
  };

  let index = 0;
  const peek = (offset = 0): Token => tokens[Math.min(index + offset, tokens.length - 1)];
  const quoted = (token: Token): string => (token.type === TokenType.QUOTED ? `"${token.value}"` : token.value);
  const appendRaw = (fragment: string): void => {
    result.rawExpression = result.rawExpression === '' ? fragment : `${result.rawExpression} ${fragment}`;
  };

  /**
   * Consume a balanced parenthesized group and render it back as a query
   * sub-expression. `+` and `-` inside the group are kept verbatim, matching
   * the reference implementation.
   */
  const captureParenExpression = (): string => {
    let depth = 0;
    let out = '';
    let previous: TokenType = TokenType.EOF;
    do {
      const token = peek();
      switch (token.type) {
        case TokenType.LPAREN:
          depth += 1;
          out += '(';
          break;
        case TokenType.RPAREN:
          depth -= 1;
          out += ')';
          break;
        case TokenType.WORD:
        case TokenType.QUOTED:
          if (previous === TokenType.WORD || previous === TokenType.QUOTED || previous === TokenType.RPAREN) {
            out += ' ';
          }
          out += quoted(token);
          break;
        case TokenType.OR:
          out += ' OR ';
          break;
        case TokenType.PLUS:
          out += '+';
          break;
        case TokenType.MINUS:
          out += '-';
          break;
        default:
          throw new Error(`Unbalanced parentheses at position ${token.position}`);
      }
      previous = token.type;
      if (depth > 0) index += 1;
    } while (depth > 0);
    index += 1; // Skip the closing paren
    return out;
  };

  /** Consume a term and every `OR <term>` that follows it. */
  const captureOrExpression = (): string => {
    let out = quoted(peek());
    index += 1;
    while (peek().type === TokenType.OR) {
      out += ' OR ';
      index += 1;
      const token = peek();
      if (token.type === TokenType.WORD || token.type === TokenType.QUOTED) {
        out += quoted(token);
        index += 1;
      } else if (token.type === TokenType.LPAREN) {
        out += captureParenExpression();
      } else {
        throw new Error(`Expected term after 'OR' at position ${token.position}`);
      }
    }
    return out;
  };

  /** Consume the operand of a `+` / `-` prefix, which may be a whole group. */
  const parsePrefixedTerm = (prefix: string): string => {
    const token = peek();
    if (token.type === TokenType.LPAREN) {
      return captureParenExpression();
    }
    if (token.type === TokenType.WORD || token.type === TokenType.QUOTED) {
      index += 1;
      return quoted(token);
    }
    throw new Error(`Expected term after '${prefix}' at position ${token.position}`);
  };

  while (peek().type !== TokenType.EOF) {
    const token = peek();
    switch (token.type) {
      case TokenType.PLUS:
        index += 1;
        result.requiredTerms.push(parsePrefixedTerm('+'));
        break;
      case TokenType.MINUS:
        index += 1;
        result.excludedTerms.push(parsePrefixedTerm('-'));
        break;
      case TokenType.LPAREN:
        appendRaw(captureParenExpression());
        break;
      case TokenType.WORD:
      case TokenType.QUOTED:
        // A term followed by OR opens a raw sub-expression; anything else is a
        // plain term, and plain terms combine with implicit AND.
        if (peek(1).type === TokenType.OR) {
          appendRaw(captureOrExpression());
        } else {
          result.requiredTerms.push(quoted(token));
          index += 1;
        }
        break;
      case TokenType.OR:
        throw new Error(`Unexpected 'OR' operator at position ${token.position}`);
      case TokenType.RPAREN:
        throw new Error(`Unexpected ')' at position ${token.position}`);
      default:
        index += 1;
        break;
    }
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
  if (expr.rawExpression.length > 0) {
    return true;
  }
  // A parenthesized group after a unary +/- is retained as one term. Detect
  // that structural form rather than an "OR" substring inside a token, which
  // would misclassify ordinary words such as ORDER and ORANGE.
  const isParenthesized = (term: string): boolean => term.length >= 2 && term.startsWith('(') && term.endsWith(')');
  return expr.requiredTerms.some(isParenthesized) || expr.excludedTerms.some(isParenthesized);
}

/**
 * Convert search expression to query string for QueryASTParser
 *
 * Every positive term is required, so the parts compose with AND:
 * - Required terms joined with AND
 * - Excluded terms prefixed with NOT
 * - The raw OR/grouped sub-expression parenthesized and appended
 *
 * @param {SearchExpression} expr - Parsed search expression
 * @returns {string} Query string compatible with QueryASTParser
 */
export function toQueryString(expr: SearchExpression): string {
  const parts: string[] = [...expr.requiredTerms];

  // `optionalTerms` is never populated by the parser and is kept only so an
  // externally built expression object still round-trips. Terms placed there
  // are required, exactly like the parser's own output.
  parts.push(...expr.optionalTerms);
  parts.push(...expr.excludedTerms.map((term) => `NOT ${term}`));

  if (expr.rawExpression !== '') {
    parts.push(`(${expr.rawExpression})`);
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
 * - `+golang tutorial` → `golang AND tutorial`
 * - `+golang -old` → `golang AND NOT old`
 * - `python OR ruby` → `(python OR ruby)`
 * - `+golang +(tutorial OR guide)` → `golang AND (tutorial OR guide)`
 *
 * @param {string} expression - Web-style search expression
 * @returns {string} QueryAST-compatible query string
 * @throws {Error} If expression is invalid
 */
export function convertSearchExpression(expression: string): string {
  return toQueryString(parseSearchExpression(expression));
}

/**
 * Simplify search expression to basic terms (for backward compatibility)
 *
 * For clients that don't support QueryAST, this extracts simple term lists.
 *
 * Required terms (`+term`) take priority: the first becomes `mainTerm`, the
 * rest plus any plain implicit-AND terms become `andTerms`. When no required
 * terms are present but the expression contains an OR / parenthesized
 * sub-expression (e.g. `python OR ruby`, `(a OR b)`), the raw expression is
 * surfaced as a single parenthesized `mainTerm` so callers preserve OR
 * semantics instead of silently AND-composing the parts.
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
  const simplified = simplifyParsedExpression(expr);
  return {
    mainTerm: simplified.mainTerm,
    andTerms: simplified.andTerms,
    notTerms: expr.excludedTerms
  };
}

/**
 * Shared simplification logic used by `simplifySearchExpression` and the
 * JavaScript fallback path of `parseSearchExpressionNative`. Mirrors the
 * upstream C++ `SimplifySearchExpression`.
 */
function simplifyParsedExpression(expr: SearchExpression): {
  mainTerm: string;
  andTerms: string[];
} {
  // Only one of them can become `mainTerm`, so a positive term next to an
  // OR/grouped sub-expression has no simplified form. Refuse rather than
  // silently drop one. Excluded terms are fine: they have their own slot.
  if (expr.rawExpression.length > 0 && expr.requiredTerms.length > 0) {
    throw new Error('Expression cannot be represented by the simplified client API');
  }

  if (expr.requiredTerms.length > 0) {
    const allPositive = [...expr.requiredTerms, ...expr.optionalTerms];
    return { mainTerm: allPositive[0], andTerms: allPositive.slice(1) };
  }

  if (expr.rawExpression.length > 0) {
    const raw = expr.rawExpression;
    const mainTerm = raw.startsWith('(') && raw.endsWith(')') ? raw : `(${raw})`;
    return { mainTerm, andTerms: [] };
  }

  if (expr.optionalTerms.length > 0) {
    return { mainTerm: expr.optionalTerms[0], andTerms: expr.optionalTerms.slice(1) };
  }

  throw new Error('Search expression must have at least one positive term');
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
  const simplified = simplifyParsedExpression(expr);

  return {
    mainTerm: simplified.mainTerm,
    andTerms: simplified.andTerms,
    notTerms: expr.excludedTerms,
    optionalTerms: expr.optionalTerms
  };
}
