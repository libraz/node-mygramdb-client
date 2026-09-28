import { describe, expect, it } from 'vitest';
import {
  calculateQueryExpressionLength,
  ensureQueryLengthWithinLimit,
  ensureSafeCommandValue,
  escapeQueryString,
  needsWireQuoting,
  quoteCommandArgument,
  quoteWireToken
} from '../src/command-utils';
import { InputValidationError } from '../src/errors';

describe('command utils', () => {
  describe('ensureSafeCommandValue', () => {
    it('should allow safe values', () => {
      const result = ensureSafeCommandValue('安全な文字列', 'query');
      expect(result).toBe('安全な文字列');
    });

    it('should reject newline characters', () => {
      expect(() => ensureSafeCommandValue('foo\nbar', 'query')).toThrow(InputValidationError);
    });

    it('should reject carriage returns', () => {
      expect(() => ensureSafeCommandValue('foo\rbar', 'query')).toThrow(InputValidationError);
    });

    it('should reject null bytes', () => {
      expect(() => ensureSafeCommandValue('foo\u0000bar', 'query')).toThrow(InputValidationError);
    });

    it('should reject tab characters', () => {
      expect(() => ensureSafeCommandValue('foo\tbar', 'query')).toThrow(InputValidationError);
      expect(() => ensureSafeCommandValue('foo\tbar', 'query')).toThrow(/tab \(\\t\)/);
    });

    it('should reject delete character (0x7F)', () => {
      expect(() => ensureSafeCommandValue('foo\u007Fbar', 'query')).toThrow(InputValidationError);
      expect(() => ensureSafeCommandValue('foo\u007Fbar', 'query')).toThrow(/delete \(DEL\)/);
    });

    it('should reject other control characters (0x01-0x1F)', () => {
      expect(() => ensureSafeCommandValue('foo\u0001bar', 'query')).toThrow(InputValidationError);
      expect(() => ensureSafeCommandValue('foo\u001Fbar', 'query')).toThrow(InputValidationError);
    });
  });

  describe('ensureQueryLengthWithinLimit', () => {
    it('should allow expressions within limit', () => {
      const payload = {
        query: 'hello',
        andTerms: ['world'],
        notTerms: [],
        filters: [{ column: 'status', op: '=' as const, value: 'ok' }],
        sortColumn: 'published_at'
      };
      const limit = calculateQueryExpressionLength(
        payload.query,
        payload.andTerms,
        payload.notTerms,
        payload.filters,
        payload.sortColumn
      );
      expect(() => ensureQueryLengthWithinLimit(payload, limit)).not.toThrow();
    });

    it('should throw when expression exceeds limit', () => {
      expect(() =>
        ensureQueryLengthWithinLimit(
          {
            query: 'a'.repeat(10),
            andTerms: [],
            notTerms: [],
            filters: [],
            sortColumn: ''
          },
          5
        )
      ).toThrow(InputValidationError);
    });

    it('should count filters and terms in expression length', () => {
      const length = calculateQueryExpressionLength(
        'base',
        ['foo'],
        ['bar'],
        [{ column: 'status', op: '=', value: 'ok' }],
        'id'
      );
      expect(length).toBe('base'.length + 'foo'.length + 'bar'.length + 'status'.length + 'ok'.length + 'id'.length);
    });
  });

  describe('quoteWireToken / needsWireQuoting (mirrors the C++ client wire_quoting.h)', () => {
    it('quotes an empty value', () => {
      expect(needsWireQuoting('')).toBe(true);
      expect(quoteWireToken('')).toBe('""');
    });

    it('quotes every reserved clause keyword, case-insensitively', () => {
      const keywords = [
        'AND',
        'or',
        'Not',
        'FILTER',
        'sort',
        'Limit',
        'OFFSET',
        'highlight',
        'Fuzzy',
        'FACET',
        'order'
      ];
      for (const word of keywords) {
        expect(needsWireQuoting(word)).toBe(true);
        expect(quoteWireToken(word)).toBe(`"${word}"`);
      }
    });

    it('leaves a word merely containing a reserved keyword unquoted', () => {
      expect(needsWireQuoting('order_id')).toBe(false);
      expect(quoteWireToken('order_id')).toBe('order_id');
    });

    it('quotes a term containing a full-width space (U+3000)', () => {
      expect(needsWireQuoting('a　b')).toBe(true);
      expect(quoteWireToken('a　b')).toBe('"a　b"');
    });

    it('quotes a term containing a no-break space (U+00A0)', () => {
      expect(needsWireQuoting('a b')).toBe(true);
    });

    it('quotes a term containing a zero-width space (U+200B)', () => {
      // U+200B is outside Unicode's own whitespace category but is one of the
      // separators the server's tokenizer splits query text on.
      expect(needsWireQuoting('a​b')).toBe(true);
    });

    it('does not quote a codepoint just past the Unicode whitespace range (U+200C)', () => {
      expect(needsWireQuoting('a‌b')).toBe(false);
    });

    it('quotes parentheses so grouping characters are matched literally', () => {
      expect(quoteWireToken('(term)')).toBe('"(term)"');
    });

    it('escapes backslash and double quote inside a quoted token', () => {
      expect(quoteWireToken('a\\b')).toBe('"a\\\\b"');
      expect(quoteWireToken('say "hi"')).toBe('"say \\"hi\\""');
    });

    it('escapes an unnamed control byte as \\xHH', () => {
      expect(quoteWireToken('bell\x07')).toBe('"bell\\x07"');
    });

    it('leaves an ordinary word unquoted', () => {
      expect(quoteWireToken('golang')).toBe('golang');
      expect(needsWireQuoting('golang')).toBe(false);
    });
  });

  describe('escapeQueryString and quoteCommandArgument share one quoting rule', () => {
    it('quote a reserved keyword identically', () => {
      expect(escapeQueryString('AND', 'query')).toBe('"AND"');
      expect(quoteCommandArgument('AND', 'value')).toBe('"AND"');
    });

    it('quote a value with a parenthesis identically', () => {
      expect(escapeQueryString('(x)', 'query')).toBe('"(x)"');
      expect(quoteCommandArgument('(x)', 'value')).toBe('"(x)"');
    });

    it('quote a Unicode-whitespace value identically', () => {
      expect(escapeQueryString('a　b', 'query')).toBe('"a　b"');
      expect(quoteCommandArgument('a　b', 'value')).toBe('"a　b"');
    });
  });
});
