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
import { quoteWireToken } from './command-utils.js';

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

    // '+' and '-' are unary operators only when tokenize()'s dispatch sees
    // them at a token boundary. Once a word has started they are ordinary
    // text, as in "COVID-19", "e-mail", and "C++".
    while (this.position < this.input.length && !/[\s()"]/.test(this.input[this.position])) {
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
  // A term destined for requiredTerms/excludedTerms is stored as plain text
  // regardless of whether it was quoted -- toQueryString/simplifySearchExpression
  // re-apply wire quoting exactly once, at whichever destination the term is
  // serialized onto. A term destined for rawExpression (an OR/grouped
  // sub-expression, already formatted AST-syntax text) needs that quoting
  // applied here instead, so a plain word colliding with a reserved keyword
  // (e.g. "order") is quoted before it can reach the AST parser as a bare
  // operator.
  const wireTerm = (token: Token): string => quoteWireToken(token.value);
  const appendRaw = (fragment: string): void => {
    result.rawExpression = result.rawExpression === '' ? fragment : `${result.rawExpression} ${fragment}`;
  };

  /**
   * Consume a balanced parenthesized group and render it back as a query
   * sub-expression. Adjacent terms are AND'ed by adjacency already, so `+`
   * carries no operator meaning inside a group and is dropped; a bare `-`
   * has no keyword the AST parser recognizes (only the literal word NOT
   * does), so it is deferred and emitted as "NOT " before the term it
   * prefixes.
   */
  const captureParenExpression = (): string => {
    let depth = 0;
    let out = '';
    // Tracks the last *content* token (word/quoted/paren/OR) so the spacing
    // decision below is unaffected by a +/- prefix in between -- otherwise
    // "tutorial -video" would see previous===MINUS and skip the space it
    // needs before the "NOT" it is about to emit.
    let previous: TokenType = TokenType.EOF;
    let pendingNot = false;
    do {
      const token = peek();
      switch (token.type) {
        case TokenType.LPAREN:
          depth += 1;
          out += '(';
          previous = token.type;
          break;
        case TokenType.RPAREN:
          depth -= 1;
          out += ')';
          previous = token.type;
          break;
        case TokenType.WORD:
        case TokenType.QUOTED:
          if (previous === TokenType.WORD || previous === TokenType.QUOTED || previous === TokenType.RPAREN) {
            out += ' ';
          }
          if (pendingNot) {
            out += 'NOT ';
            pendingNot = false;
          }
          out += wireTerm(token);
          previous = token.type;
          break;
        case TokenType.OR:
          out += ' OR ';
          previous = token.type;
          break;
        case TokenType.PLUS:
          // No operator meaning inside a group; previous is left unchanged.
          break;
        case TokenType.MINUS:
          pendingNot = true;
          break;
        default:
          throw new Error(`Unbalanced parentheses at position ${token.position}`);
      }
      if (depth > 0) index += 1;
    } while (depth > 0);
    index += 1; // Skip the closing paren
    return out;
  };

  /** Consume a term and every `OR <term>` that follows it. */
  const captureOrExpression = (): string => {
    let out = wireTerm(peek());
    index += 1;
    while (peek().type === TokenType.OR) {
      out += ' OR ';
      index += 1;
      const token = peek();
      if (token.type === TokenType.WORD || token.type === TokenType.QUOTED) {
        out += wireTerm(token);
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
      return token.value;
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
          result.requiredTerms.push(token.value);
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
 * Check whether a required/excluded term is a parenthesized sub-expression
 * (a group captured after a unary `+`/`-`), already formatted AST-syntax
 * text rather than a plain term still needing {@link quoteWireToken}.
 * Detected structurally, never by scanning for an "OR" substring inside a
 * token, which would misclassify ordinary words such as ORDER and ORANGE.
 */
function isParenthesizedSubexpression(term: string): boolean {
  return term.length >= 2 && term.startsWith('(') && term.endsWith(')');
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
  return expr.requiredTerms.some(isParenthesizedSubexpression) || expr.excludedTerms.some(isParenthesizedSubexpression);
}

/**
 * Convert search expression to query string for QueryASTParser
 *
 * Every positive term is required, so the parts compose with AND:
 * - Required terms joined with AND
 * - Excluded terms prefixed with NOT
 * - The raw OR/grouped sub-expression parenthesized and appended
 *
 * `requiredTerms`/`excludedTerms` mix plain term text with entries that are
 * already a fully-formatted parenthesized sub-expression (see
 * {@link isParenthesizedSubexpression}); only the former still needs
 * {@link quoteWireToken} applied here, mirroring the C++ client's
 * `ToQueryString`.
 *
 * @param {SearchExpression} expr - Parsed search expression
 * @returns {string} Query string compatible with QueryASTParser
 */
export function toQueryString(expr: SearchExpression): string {
  const emitTerm = (term: string): string => (isParenthesizedSubexpression(term) ? term : quoteWireToken(term));

  // `optionalTerms` is never populated by the parser and is kept only so an
  // externally built expression object still round-trips. Terms placed there
  // are required, exactly like the parser's own output.
  const parts: string[] = [...expr.requiredTerms, ...expr.optionalTerms].map(emitTerm);
  parts.push(...expr.excludedTerms.map((term) => `NOT ${emitTerm(term)}`));

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
 * rest plus any plain implicit-AND terms become `andTerms`. An expression
 * containing an OR / parenthesized sub-expression (e.g. `python OR ruby`,
 * `golang +(a OR b)`) throws instead: `mainTerm`/`andTerms`/`notTerms` are
 * each re-quoted by every consumer (`client.search`'s `andTerms`/`notTerms`
 * options), which would wrap an already-formatted `(a OR b)` as one opaque
 * literal-phrase term instead of parsing it as boolean OR. Use
 * {@link convertSearchExpression} with `client.searchRaw` instead when the
 * expression may contain OR/grouping.
 *
 * @param {string} expression - Web-style search expression
 * @returns {{ mainTerm: string, andTerms: string[], notTerms: string[] }} Simplified terms object
 * @throws {Error} If expression is invalid, has no positive terms, or contains OR/grouping
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
  // The simplified API has no way to represent an OR or parenthesized
  // sub-expression: every consumer of mainTerm/andTerms/notTerms re-applies
  // wire quoting to each field, which would wrap an already-formatted
  // "(a OR b)" as one opaque literal-phrase term instead of parsing it as
  // boolean OR. Refuse rather than silently changing the expression's
  // meaning.
  if (hasComplexExpression(expr)) {
    throw new Error('Expression cannot be represented by the simplified client API');
  }

  // hasComplexExpression already ruled out a non-empty rawExpression above,
  // so any positive term here is plain text in requiredTerms/optionalTerms.
  const allPositive = [...expr.requiredTerms, ...expr.optionalTerms];
  if (allPositive.length > 0) {
    return { mainTerm: allPositive[0], andTerms: allPositive.slice(1) };
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
