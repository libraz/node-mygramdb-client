import { describe, expect, it } from 'vitest';
import { ConnectionError, InputValidationError, MygramError, ProtocolError, TimeoutError } from '../src/errors';

describe('Error classes', () => {
  it('MygramError should have correct name and message', () => {
    const error = new MygramError('test');
    expect(error.name).toBe('MygramError');
    expect(error.message).toBe('test');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(MygramError);
  });

  it('ConnectionError should have correct prototype chain', () => {
    const error = new ConnectionError('connection failed');
    expect(error.name).toBe('ConnectionError');
    expect(error.message).toBe('connection failed');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(MygramError);
    expect(error).toBeInstanceOf(ConnectionError);
  });

  it('ProtocolError should have correct prototype chain', () => {
    const error = new ProtocolError('bad response');
    expect(error.name).toBe('ProtocolError');
    expect(error.message).toBe('bad response');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(MygramError);
    expect(error).toBeInstanceOf(ProtocolError);
  });

  it('TimeoutError should have correct prototype chain', () => {
    const error = new TimeoutError('timed out');
    expect(error.name).toBe('TimeoutError');
    expect(error.message).toBe('timed out');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(MygramError);
    expect(error).toBeInstanceOf(TimeoutError);
  });

  it('InputValidationError should have correct prototype chain', () => {
    const error = new InputValidationError('invalid input');
    expect(error.name).toBe('InputValidationError');
    expect(error.message).toBe('invalid input');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(MygramError);
    expect(error).toBeInstanceOf(InputValidationError);
  });
});
