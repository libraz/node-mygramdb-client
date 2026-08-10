import { describe, expect, it } from 'vitest';
import {
  convertSearchExpression,
  hasComplexExpression,
  parseSearchExpression,
  parseSearchExpressionNative,
  simplifySearchExpression,
  toQueryString
} from '../src/search-expression';

describe('parseSearchExpression', () => {
  it('should parse simple term', () => {
    const expr = parseSearchExpression('golang');
    expect(expr.requiredTerms).toEqual(['golang']);
    expect(expr.excludedTerms).toEqual([]);
    expect(expr.optionalTerms).toEqual([]);
  });

  it('should parse required term with + prefix', () => {
    const expr = parseSearchExpression('+golang');
    expect(expr.requiredTerms).toEqual(['golang']);
    expect(expr.excludedTerms).toEqual([]);
    expect(expr.optionalTerms).toEqual([]);
  });

  it('should parse excluded term with - prefix', () => {
    const expr = parseSearchExpression('-old');
    expect(expr.requiredTerms).toEqual([]);
    expect(expr.excludedTerms).toEqual(['old']);
    expect(expr.optionalTerms).toEqual([]);
  });

  it('should parse multiple terms with implicit AND', () => {
    const expr = parseSearchExpression('golang tutorial');
    expect(expr.requiredTerms).toEqual(['golang', 'tutorial']);
    expect(expr.excludedTerms).toEqual([]);
    expect(expr.optionalTerms).toEqual([]);
  });

  it('should treat an unprefixed term as required, like a + prefixed one', () => {
    const expr = parseSearchExpression('+golang tutorial');
    expect(expr.requiredTerms).toEqual(['golang', 'tutorial']);
    expect(expr.excludedTerms).toEqual([]);
    expect(expr.optionalTerms).toEqual([]);
  });

  it('should parse mixed required and excluded terms', () => {
    const expr = parseSearchExpression('+golang -old');
    expect(expr.requiredTerms).toEqual(['golang']);
    expect(expr.excludedTerms).toEqual(['old']);
    expect(expr.optionalTerms).toEqual([]);
  });

  it('should parse quoted phrases', () => {
    const expr = parseSearchExpression('"machine learning" tutorial');
    // Quoted phrases preserve quotes for phrase search semantics
    expect(expr.requiredTerms).toEqual(['"machine learning"', 'tutorial']);
    expect(expr.excludedTerms).toEqual([]);
    expect(expr.optionalTerms).toEqual([]);
  });

  it('should parse full-width spaces', () => {
    const expr = parseSearchExpression('機械学習　チュートリアル');
    expect(expr.requiredTerms).toEqual(['機械学習', 'チュートリアル']);
    expect(expr.excludedTerms).toEqual([]);
    expect(expr.optionalTerms).toEqual([]);
  });

  it('should detect OR operator as complex expression', () => {
    const expr = parseSearchExpression('python OR ruby');
    expect(expr.rawExpression).toBe('python OR ruby');
  });

  it('should keep a group after + as a single required term', () => {
    const expr = parseSearchExpression('+golang +(tutorial OR guide)');
    expect(expr.requiredTerms).toEqual(['golang', '(tutorial OR guide)']);
    expect(expr.rawExpression).toBe('');
  });

  it('should capture only the OR sub-expression as the raw expression', () => {
    const expr = parseSearchExpression('golang python OR ruby');
    expect(expr.requiredTerms).toEqual(['golang']);
    expect(expr.rawExpression).toBe('python OR ruby');
  });

  it('should throw on empty expression', () => {
    expect(() => parseSearchExpression('')).toThrow('Search expression cannot be empty');
  });

  it('should throw on unterminated quote', () => {
    expect(() => parseSearchExpression('"unterminated')).toThrow('Unterminated quoted string');
  });

  it('should throw on + without following term', () => {
    expect(() => parseSearchExpression('+')).toThrow('Expected term after');
  });

  it('should throw on - without following term', () => {
    expect(() => parseSearchExpression('-')).toThrow('Expected term after');
  });
});

describe('hasComplexExpression', () => {
  it('should return false for simple expressions', () => {
    const expr = parseSearchExpression('golang tutorial');
    expect(hasComplexExpression(expr)).toBe(false);
  });

  it('should return true for OR expressions', () => {
    const expr = parseSearchExpression('python OR ruby');
    expect(hasComplexExpression(expr)).toBe(true);
  });

  it('should return true for grouped expressions', () => {
    const expr = parseSearchExpression('+golang +(tutorial OR guide)');
    expect(hasComplexExpression(expr)).toBe(true);
  });
});

describe('toQueryString', () => {
  it('should join unprefixed terms with AND', () => {
    const expr = parseSearchExpression('golang tutorial');
    const query = toQueryString(expr);
    expect(query).toBe('golang AND tutorial');
  });

  it('should convert required terms to AND', () => {
    const expr = parseSearchExpression('+golang +tutorial');
    const query = toQueryString(expr);
    expect(query).toBe('golang AND tutorial');
  });

  it('should convert excluded terms to NOT', () => {
    const expr = parseSearchExpression('-old -deprecated');
    const query = toQueryString(expr);
    expect(query).toBe('NOT old AND NOT deprecated');
  });

  it('should combine required and optional terms', () => {
    const expr = parseSearchExpression('+golang tutorial');
    const query = toQueryString(expr);
    expect(query).toBe('golang AND tutorial');
  });

  it('should combine required and excluded terms', () => {
    const expr = parseSearchExpression('+golang -old');
    const query = toQueryString(expr);
    expect(query).toBe('golang AND NOT old');
  });

  it('should combine all term types', () => {
    const expr = parseSearchExpression('+golang tutorial -old');
    const query = toQueryString(expr);
    expect(query).toBe('golang AND tutorial AND NOT old');
  });
});

describe('convertSearchExpression', () => {
  it('should convert simple AND expression', () => {
    const query = convertSearchExpression('golang tutorial');
    expect(query).toBe('golang AND tutorial');
  });

  it('should convert required terms', () => {
    const query = convertSearchExpression('+golang +tutorial');
    expect(query).toBe('golang AND tutorial');
  });

  it('should convert excluded terms', () => {
    const query = convertSearchExpression('+golang -old');
    expect(query).toBe('golang AND NOT old');
  });

  it('should preserve OR expressions', () => {
    const query = convertSearchExpression('python OR ruby');
    expect(query).toBe('(python OR ruby)');
  });

  it('should AND a term with an OR sub-expression instead of dropping it', () => {
    const query = convertSearchExpression('golang python OR ruby');
    expect(query).toBe('golang AND (python OR ruby)');
  });

  it('should preserve grouped expressions', () => {
    const query = convertSearchExpression('+golang +(tutorial OR guide)');
    expect(query).toBe('golang AND (tutorial OR guide)');
  });

  it('should handle quoted phrases', () => {
    const query = convertSearchExpression('"machine learning" tutorial');
    // Quotes preserved for phrase search
    expect(query).toBe('"machine learning" AND tutorial');
  });
});

describe('simplifySearchExpression', () => {
  it('should extract main term and AND terms', () => {
    const result = simplifySearchExpression('golang tutorial guide');
    expect(result.mainTerm).toBe('golang');
    expect(result.andTerms).toEqual(['tutorial', 'guide']);
    expect(result.notTerms).toEqual([]);
  });

  it('should extract required terms', () => {
    const result = simplifySearchExpression('+golang +tutorial');
    expect(result.mainTerm).toBe('golang');
    expect(result.andTerms).toEqual(['tutorial']);
    expect(result.notTerms).toEqual([]);
  });

  it('should extract excluded terms', () => {
    const result = simplifySearchExpression('+golang -old -deprecated');
    expect(result.mainTerm).toBe('golang');
    expect(result.andTerms).toEqual([]);
    expect(result.notTerms).toEqual(['old', 'deprecated']);
  });

  it('should combine required and optional terms', () => {
    const result = simplifySearchExpression('+golang tutorial');
    expect(result.mainTerm).toBe('golang');
    expect(result.andTerms).toEqual(['tutorial']);
    expect(result.notTerms).toEqual([]);
  });

  it('should throw on expression with only excluded terms', () => {
    expect(() => simplifySearchExpression('-old -deprecated')).toThrow(
      'Search expression must have at least one positive term'
    );
  });

  it('should wrap an OR-only expression as a parenthesized main term', () => {
    const result = simplifySearchExpression('python OR ruby');
    expect(result.mainTerm).toBe('(python OR ruby)');
    expect(result.andTerms).toEqual([]);
    expect(result.notTerms).toEqual([]);
  });

  it('should not double-wrap an already parenthesized OR expression', () => {
    const result = simplifySearchExpression('(a OR b)');
    expect(result.mainTerm).toBe('(a OR b)');
    expect(result.andTerms).toEqual([]);
    expect(result.notTerms).toEqual([]);
  });

  it('should give precedence to required terms over OR sub-expressions', () => {
    const result = simplifySearchExpression('+golang tutorial');
    expect(result.mainTerm).toBe('golang');
    expect(result.andTerms).toEqual(['tutorial']);
    expect(result.notTerms).toEqual([]);
  });

  it('should preserve excluded terms alongside an OR-only main term', () => {
    const result = simplifySearchExpression('python OR ruby -old');
    expect(result.mainTerm).toBe('(python OR ruby)');
    expect(result.andTerms).toEqual([]);
    expect(result.notTerms).toEqual(['old']);
  });

  it('should refuse a term combined with an OR sub-expression', () => {
    expect(() => simplifySearchExpression('golang python OR ruby')).toThrow(
      'Expression cannot be represented by the simplified client API'
    );
  });
});

describe('parseSearchExpressionNative', () => {
  it('should parse simple terms using native parser', () => {
    const result = parseSearchExpressionNative('golang tutorial');
    expect(result.mainTerm).toBe('golang');
    expect(result.andTerms).toEqual(['tutorial']);
    expect(result.notTerms).toEqual([]);
  });

  it('should parse required and excluded terms using native parser', () => {
    const result = parseSearchExpressionNative('+golang +tutorial -old -deprecated');
    expect(result.mainTerm).toBe('golang');
    expect(result.andTerms).toEqual(['tutorial']);
    expect(result.notTerms).toEqual(['old', 'deprecated']);
    expect(result.optionalTerms).toEqual([]);
  });

  it('should parse quoted phrases using native parser', () => {
    const result = parseSearchExpressionNative('"machine learning" tutorial');
    // Native parser includes quotes in the term
    expect(result.mainTerm).toBe('"machine learning"');
    expect(result.andTerms).toEqual(['tutorial']);
    expect(result.notTerms).toEqual([]);
  });

  it('should parse full-width spaces using native parser', () => {
    const result = parseSearchExpressionNative('機械学習　チュートリアル');
    expect(result.mainTerm).toBe('機械学習');
    expect(result.andTerms).toEqual(['チュートリアル']);
    expect(result.notTerms).toEqual([]);
  });

  it('should parse complex expression with required, optional, and excluded terms', () => {
    const result = parseSearchExpressionNative('+golang tutorial -old');
    expect(result.mainTerm).toBe('golang');
    expect(result.andTerms).toEqual(['tutorial']);
    expect(result.notTerms).toEqual(['old']);
  });

  it('should handle single required term', () => {
    const result = parseSearchExpressionNative('+golang');
    expect(result.mainTerm).toBe('golang');
    expect(result.andTerms).toEqual([]);
    expect(result.notTerms).toEqual([]);
  });

  it('should parse multiple AND terms', () => {
    const result = parseSearchExpressionNative('+golang +tutorial +guide');
    expect(result.mainTerm).toBe('golang');
    expect(result.andTerms).toEqual(['tutorial', 'guide']);
    expect(result.notTerms).toEqual([]);
  });

  it('should parse mixed terms with quoted phrases', () => {
    const result = parseSearchExpressionNative('+golang "best practices" -deprecated');
    expect(result.mainTerm).toBe('golang');
    // Native parser includes quotes in the term
    expect(result.andTerms).toContain('"best practices"');
    expect(result.notTerms).toEqual(['deprecated']);
  });

  it('should throw on empty expression', () => {
    expect(() => parseSearchExpressionNative('')).toThrow();
  });

  it('should throw on expression with only excluded terms', () => {
    expect(() => parseSearchExpressionNative('-old -deprecated')).toThrow(
      'Search expression must have at least one positive term'
    );
  });

  it('should wrap an OR-only expression as a parenthesized main term', () => {
    const result = parseSearchExpressionNative('python OR ruby');
    expect(result.mainTerm).toBe('(python OR ruby)');
    expect(result.andTerms).toEqual([]);
    expect(result.notTerms).toEqual([]);
  });

  it('should not double-wrap an already parenthesized OR expression', () => {
    const result = parseSearchExpressionNative('(a OR b)');
    expect(result.mainTerm).toBe('(a OR b)');
    expect(result.andTerms).toEqual([]);
    expect(result.notTerms).toEqual([]);
  });
});
