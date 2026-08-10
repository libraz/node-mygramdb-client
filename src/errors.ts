/**
 * MygramDB client error classes
 */

/**
 * Base MygramDB client error
 *
 * @class
 * @extends Error
 */
export class MygramError extends Error {
  /**
   * Create a MygramDB error
   *
   * @param {string} message - Error message
   */
  constructor(message: string) {
    super(message);
    this.name = 'MygramError';
    Object.setPrototypeOf(this, MygramError.prototype);
  }
}

/**
 * Connection error thrown when connection to MygramDB server fails
 *
 * @class
 * @extends MygramError
 */
export class ConnectionError extends MygramError {
  /**
   * Create a connection error
   *
   * @param {string} message - Error message
   */
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
    Object.setPrototypeOf(this, ConnectionError.prototype);
  }
}

/**
 * Protocol error thrown when server returns an invalid response
 *
 * @class
 * @extends MygramError
 */
export class ProtocolError extends MygramError {
  /**
   * Create a protocol error
   *
   * @param {string} message - Error message
   */
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
    Object.setPrototypeOf(this, ProtocolError.prototype);
  }
}

/**
 * Error returned by the server in an `ERROR` frame.
 *
 * Extends {@link ProtocolError} so code written against earlier releases, which
 * saw every server-side rejection as a `ProtocolError`, keeps working. New code
 * should branch on {@link ServerError.code} rather than on the message text.
 *
 * MygramDB v1.10+ prefixes the frame payload with a numeric code
 * (`ERROR 4007 Table not found`); `code` carries that value and `message` holds
 * only the human-readable remainder. Against an older server the frame has no
 * code, so `code` is `undefined` and `message` is the whole payload.
 *
 * @class
 * @extends ProtocolError
 *
 * @example
 * ```typescript
 * import { ErrorCode, ServerError } from 'mygramdb-client';
 *
 * try {
 *   await client.search('missing_table', 'hello');
 * } catch (error) {
 *   if (error instanceof ServerError && error.code === ErrorCode.TableNotFound) {
 *     // handle the unknown table
 *   }
 * }
 * ```
 */
export class ServerError extends ProtocolError {
  /**
   * Numeric error code from the `ERROR` frame, or `undefined` when the server
   * sent an untyped frame (pre-v1.10). Typed as `number` rather than the
   * {@link ../error-codes.ErrorCode} union because a newer server may send a
   * code this client does not know yet.
   */
  readonly code: number | undefined;

  /** The complete `ERROR` frame as received, including the code prefix. */
  readonly rawFrame: string;

  /**
   * Create a server error
   *
   * @param {string} message - Human-readable message (code prefix removed)
   * @param {number | undefined} code - Numeric error code, if the server sent one
   * @param {string} rawFrame - The complete `ERROR` frame as received
   */
  constructor(message: string, code: number | undefined, rawFrame: string) {
    super(message);
    this.name = 'ServerError';
    this.code = code;
    this.rawFrame = rawFrame;
    Object.setPrototypeOf(this, ServerError.prototype);
  }
}

/**
 * Timeout error thrown when request times out
 *
 * @class
 * @extends MygramError
 */
export class TimeoutError extends MygramError {
  /**
   * Create a timeout error
   *
   * @param {string} message - Error message
   */
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/**
 * Input validation error thrown when client-side validation fails
 *
 * @class
 * @extends MygramError
 */
export class InputValidationError extends MygramError {
  /**
   * Create an input validation error
   *
   * @param {string} message - Error message
   */
  constructor(message: string) {
    super(message);
    this.name = 'InputValidationError';
    Object.setPrototypeOf(this, InputValidationError.prototype);
  }
}

/**
 * Load-shedding error thrown by the connection pool when the wait queue is
 * full. Signals that the client should back off (e.g. return HTTP 503) rather
 * than keep enqueuing work the pool cannot absorb.
 *
 * @class
 * @extends MygramError
 */
export class PoolOverloadError extends MygramError {
  /**
   * Create a pool-overload error
   *
   * @param {string} message - Error message
   */
  constructor(message: string) {
    super(message);
    this.name = 'PoolOverloadError';
    Object.setPrototypeOf(this, PoolOverloadError.prototype);
  }
}

/**
 * Circuit-open error thrown by the connection pool when its circuit breaker is
 * open (or half-open with a trial already in flight). Signals that the pool is
 * failing fast to protect an unreachable server, rather than acquiring a slot.
 *
 * @class
 * @extends MygramError
 */
export class CircuitOpenError extends MygramError {
  /**
   * Create a circuit-open error
   *
   * @param {string} message - Error message
   */
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
    Object.setPrototypeOf(this, CircuitOpenError.prototype);
  }
}
