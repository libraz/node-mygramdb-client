import { describe, it, expect } from 'vitest';
import {
  ensureSafeCommandValue,
  ensureQueryLengthWithinLimit,
  calculateQueryExpressionLength
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
        filters: { status: 'ok' },
        sortColumn: 'published_at'
      };
      const limit = calculateQueryExpressionLength(
        payload.query,
        payload.andTerms,
        payload.notTerms,
        payload.filters,
        payload.sortColumn
      );
      expect(() =>
        ensureQueryLengthWithinLimit(
          payload,
          limit
        )
      ).not.toThrow();
    });

    it('should throw when expression exceeds limit', () => {
      expect(() =>
        ensureQueryLengthWithinLimit(
          {
            query: 'a'.repeat(10),
            andTerms: [],
            notTerms: [],
            filters: {},
            sortColumn: ''
          },
          5
        )
      ).toThrow(InputValidationError);
    });

    it('should count filters and terms in expression length', () => {
      const length = calculateQueryExpressionLength('base', ['foo'], ['bar'], { status: 'ok' }, 'id');
      expect(length).toBe('base'.length + 'foo'.length + 'bar'.length + 'status'.length + 'ok'.length + 'id'.length);
    });
  });
});
