/**
 * TCP/Unix-socket connection layer for the pure-JavaScript client.
 *
 * Responsibilities:
 *   1. Own the {@link Socket} lifecycle (connect, disconnect, error/close
 *      propagation) including a connect-specific timeout that fires
 *      independently of the socket's idle timeout.
 *   2. Serialize outgoing commands behind a FIFO queue so that concurrent
 *      callers cannot interleave bytes on the wire and corrupt the
 *      protocol stream.
 *   3. Detect the boundary of every protocol response (see
 *      {@link ./response-frame}) so each `sendCommand` resolves with exactly
 *      one response.
 *
 * The class is intentionally focused on transport and framing -
 * response payload parsing lives in {@link ./response-parser}.
 */

import { Socket } from 'node:net';
import { buildAuthCommand } from './command-builder.js';
import { ConnectionError, ProtocolError, ServerError, TimeoutError } from './errors.js';
import { beginResponseFrame, isResponseComplete, type ResponseFrameState } from './response-frame.js';
import { parseErrorFrame } from './response-parser.js';

export { beginResponseFrame, isResponseComplete, type ResponseFrameState };

/** Replies that confirm the connection's `DEBUG` flag changed. */
const DEBUG_ON_REPLY = 'OK DEBUG_ON';
const DEBUG_OFF_REPLY = 'OK DEBUG_OFF';

/**
 * Configuration consumed by {@link Connection}. Mirrors the resolved
 * (post-defaults) subset of {@link ./types.ClientConfig} that the
 * transport actually uses.
 */
export interface ConnectionConfig {
  /** Server hostname (ignored when {@link socketPath} is set) */
  host: string;
  /** Server TCP port (ignored when {@link socketPath} is set) */
  port: number;
  /** Unix domain socket path; empty string means use TCP */
  socketPath: string;
  /**
   * Default per-command timeout in milliseconds, bounded from when a command
   * leaves the queue rather than from when it was enqueued. A caller may pass
   * a longer deadline to {@link Connection.sendCommand} for an operation that
   * legitimately outruns an ordinary request.
   *
   * The socket's own `setTimeout` is also configured to this value so
   * the underlying socket reports idle peers via the `timeout` event.
   */
  timeout: number;
  /**
   * Timeout for establishing the socket and completing `AUTH`, in
   * milliseconds. Separated from {@link timeout} because reaching a server is
   * a different kind of wait from running a query on it.
   */
  connectTimeout: number;
  /**
   * Largest single response frame accepted, in bytes. A frame that grows past
   * this is not a frame the client can trust, so the connection is dropped
   * rather than buffered further.
   */
  maxResponseBytes: number;
  /**
   * Reconnect once and resend a command when the socket is found dead before
   * the command is written. A failure after the write is surfaced as a
   * {@link ConnectionError} without resending. Default behaviour when false is
   * to reject immediately with {@link ConnectionError}.
   */
  autoReconnect: boolean;
  /**
   * Administrative token sent as `AUTH <token>` on every successful connect,
   * including a reconnect (MygramDB v1.10+). An empty string skips the step.
   */
  adminToken: string;
}

interface PendingCommand {
  command: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  /** Overrides {@link ConnectionConfig.timeout} for this command only */
  timeout?: number;
  /** Reply framing context, set when the command is written */
  frame?: ResponseFrameState;
}

/**
 * Pure-JavaScript transport for the MygramDB protocol.
 *
 * Concurrency model: all `sendCommand` calls go through a single FIFO
 * queue. Only one command is on the wire at a time; the next command is
 * dispatched after the previous response (or its terminal error) is
 * delivered.
 */
export class Connection {
  private readonly config: ConnectionConfig;
  private socket: Socket | null = null;
  private connected = false;
  private responseBuffer = '';

  private readonly queue: PendingCommand[] = [];
  private inflight: PendingCommand | null = null;
  private inflightTimeout: NodeJS.Timeout | null = null;
  private reconnecting = false;
  /**
   * Mirrors the server's per-connection `DEBUG ON`/`OFF` flag, read from the
   * server's reply, so a SEARCH/COUNT reply's completion check knows a trailing
   * debug block is coming before any bytes of it have arrived. Reset whenever
   * the socket goes away since the flag does not survive a new server-side
   * connection.
   */
  private debugMode = false;
  /**
   * Set from the moment a connect starts until its `AUTH` has been answered.
   * The socket becomes writable one microtask before {@link connect} resumes to
   * send the AUTH, so without this gate a caller that issues a command without
   * awaiting `connect()` would have it dispatched ahead of the authentication.
   */
  private authPending = false;

  /**
   * Build a connection bound to a given configuration.
   *
   * @param {ConnectionConfig} config - Resolved transport configuration
   */
  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  /**
   * Establish the socket and, when {@link ConnectionConfig.adminToken} is set,
   * authenticate on it before reporting success.
   *
   * Calling `connect()` after a successful connection is a no-op.
   *
   * @returns {Promise<void>} Resolves once the socket is open and authenticated
   * @throws {ConnectionError} On socket error or close before open
   * @throws {TimeoutError} When the handshake exceeds the configured timeout
   * @throws {ServerError} When the server rejects the administrative token
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    // Armed before the socket opens so no command can slip in ahead of the
    // AUTH during the microtask between the `connect` event and this method
    // resuming.
    this.authPending = this.config.adminToken !== '';

    try {
      await this.openSocket();
    } catch (error) {
      this.authPending = false;
      throw error;
    }

    if (!this.authPending) {
      return;
    }

    try {
      await this.sendAuthCommand();
      this.authPending = false;
    } catch (error) {
      this.authPending = false;
      // A rejected token leaves a socket that cannot run administrative
      // commands. Failing the connect outright is clearer than handing back a
      // half-usable connection, and lets the pool discard the slot.
      this.disconnect();
      throw error;
    }

    this.dispatchNext();
  }

  /**
   * Open the socket. Resolves on the `connect` event, rejects on `error` or
   * after {@link ConnectionConfig.connectTimeout} milliseconds.
   *
   * @returns {Promise<void>} Resolves once the socket is open
   */
  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      this.socket = socket;
      this.debugMode = false;
      socket.setEncoding('utf8');
      socket.setTimeout(this.config.timeout);

      let connectTimer: NodeJS.Timeout | null = null;
      let settled = false;

      const finishHandshake = (handler: () => void): void => {
        if (settled) return;
        settled = true;
        if (connectTimer !== null) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        handler();
      };

      socket.on('connect', () => {
        finishHandshake(() => {
          this.connected = true;
          resolve();
        });
      });

      socket.on('data', (data: string | Buffer) => {
        const chunk = typeof data === 'string' ? data : data.toString('utf8');
        this.handleData(chunk);
      });

      socket.on('error', (err: Error) => {
        // Always mark the transport as down so callers see isConnected()
        // === false even if the error fires after the handshake completed.
        this.connected = false;
        finishHandshake(() => {
          reject(new ConnectionError(err.message));
        });
        // After the initial handshake, report errors to the in-flight
        // command and any queued commands.
        this.failPending(new ConnectionError(err.message));
      });

      socket.on('timeout', () => {
        // Idle timeout from the socket - treat the in-flight command as
        // timed out and tear down (matches existing behaviour).
        this.failPending(new TimeoutError('Request timeout'));
        this.disconnect();
      });

      socket.on('close', () => {
        this.connected = false;
        this.debugMode = false;
        finishHandshake(() => {
          reject(new ConnectionError('Connection closed'));
        });
        this.failPending(new ConnectionError('Connection closed'));
      });

      // Connect-specific timeout: socket.setTimeout governs idle reads,
      // not the connect() handshake. Fire our own timer so unreachable
      // hosts don't block for the OS default (~75s on Linux).
      connectTimer = setTimeout(() => {
        connectTimer = null;
        finishHandshake(() => {
          this.connected = false;
          reject(new TimeoutError('Connect timeout'));
        });
        // Drop the half-opened socket so subsequent `data`/`close`
        // events don't surface to callers.
        socket.destroy();
        this.socket = null;
      }, this.config.connectTimeout);

      if (this.config.socketPath) {
        socket.connect({ path: this.config.socketPath });
      } else {
        socket.connect(this.config.port, this.config.host);
      }
    });
  }

  /**
   * Tear down the socket and reject any queued or in-flight commands.
   *
   * @returns {void}
   */
  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.debugMode = false;
    // Never leave the dispatcher parked behind an authentication that can no
    // longer complete.
    this.authPending = false;
    if (socket) {
      socket.destroy();
    }
    this.failPending(new ConnectionError('Connection closed'));
  }

  /**
   * Whether the underlying socket is currently open.
   *
   * @returns {boolean} True when connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Enqueue a command and resolve with the matching response.
   *
   * Commands are dispatched FIFO: even if multiple callers invoke
   * `sendCommand` concurrently, exactly one command is on the wire at a
   * time. Each command has its own per-command timeout that starts when
   * it leaves the queue, not when it was enqueued.
   *
   * The returned promise rejects with:
   *   - {@link ConnectionError} if not connected, or the socket fails
   *   - {@link TimeoutError} on per-command timeout
   *   - {@link ServerError} if the server returns an `ERROR` frame, carrying the
   *     numeric code when the server is MygramDB v1.10+
   *
   * @param {string} command - Command text without trailing CRLF
   * @param {number} [timeout] - Deadline for this command in milliseconds,
   *   overriding {@link ConnectionConfig.timeout}
   * @returns {Promise<string>} Server response (CRLF-normalized, trimmed)
   */
  sendCommand(command: string, timeout?: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (!this.connected || this.socket === null) {
        // A dead socket discovered before the command is written is recovered
        // by dispatchNext (reconnect + resend) when auto-reconnect is enabled;
        // otherwise the dead connection is reported immediately.
        if (!this.config.autoReconnect) {
          reject(new ConnectionError('Not connected to server'));
          return;
        }
      }
      const pending: PendingCommand = { command, resolve, reject };
      if (timeout !== undefined) {
        pending.timeout = timeout;
      }
      this.queue.push(pending);
      this.dispatchNext();
    });
  }

  private dispatchNext(): void {
    if (this.inflight !== null || this.reconnecting || this.authPending) return;
    const next = this.queue.shift();
    if (!next) return;
    if (!this.connected || this.socket === null) {
      if (this.config.autoReconnect) {
        // Dead before send: reconnect once and resend this command. A single
        // reconnect attempt is made per command; failure rejects it.
        this.reconnectAndSend(next);
        return;
      }
      next.reject(new ConnectionError('Not connected to server'));
      this.failPending(new ConnectionError('Not connected to server'));
      return;
    }

    this.beginInflight(next);
  }

  /**
   * Send `AUTH <token>` ahead of anything waiting in the queue.
   *
   * The command is handed straight to {@link beginInflight} rather than to
   * {@link sendCommand}: during a reconnect the dispatcher is deliberately
   * parked, so a queued AUTH would never be written and the reconnect would
   * never finish. Going direct is safe because the queue is idle at this point
   * — a fresh socket has no in-flight command — and any commands queued
   * meanwhile stay behind the AUTH, since the dispatcher will not start one
   * while a command is in flight.
   *
   * @returns {Promise<string>} The `OK AUTHENTICATED` response
   */
  private sendAuthCommand(): Promise<string> {
    const command = buildAuthCommand(this.config.adminToken);
    return new Promise<string>((resolve, reject) => {
      if (this.inflight !== null) {
        // Unreachable on a freshly opened socket, which has no in-flight
        // command. Fail loudly rather than clobber the entry or park the AUTH
        // behind a gate that only the AUTH itself can lift.
        reject(new ConnectionError('Cannot authenticate while another command is in flight'));
        return;
      }
      // AUTH is part of establishing the connection, so it is bounded by the
      // connect deadline rather than the ordinary command one.
      this.beginInflight({ command, resolve, reject, timeout: this.config.connectTimeout });
    });
  }

  private reconnectAndSend(command: PendingCommand): void {
    this.reconnecting = true;
    this.connect()
      .then(() => {
        this.reconnecting = false;
        this.beginInflight(command);
      })
      .catch((error: unknown) => {
        this.reconnecting = false;
        const failure =
          error instanceof Error ? new ConnectionError(error.message) : new ConnectionError('Reconnect failed');
        command.reject(failure);
        this.failPending(failure);
      });
  }

  private beginInflight(command: PendingCommand): void {
    const socket = this.socket;
    if (!this.connected || socket === null) {
      command.reject(new ConnectionError('Not connected to server'));
      this.failPending(new ConnectionError('Not connected to server'));
      return;
    }

    command.frame = beginResponseFrame(command.command, this.debugMode);
    this.inflight = command;
    this.inflightTimeout = setTimeout(() => {
      this.inflightTimeout = null;
      const pending = this.inflight;
      this.inflight = null;
      if (pending) {
        pending.reject(new TimeoutError('Command timeout'));
      }
      this.dispatchNext();
    }, command.timeout ?? this.config.timeout);

    socket.write(`${command.command}\r\n`);
  }

  private handleData(data: string): void {
    if (this.inflight === null) {
      // Stray data with no pending command; discard to avoid corrupting
      // the next response.
      this.responseBuffer = '';
      return;
    }
    this.responseBuffer += data;
    if (this.responseBuffer.length > this.config.maxResponseBytes) {
      // The frame boundary is now past whatever the client is willing to hold,
      // so the rest of this stream cannot be resynchronized. Drop the
      // connection rather than keep buffering.
      const overflow = new ProtocolError(
        `Response exceeds maxResponseBytes (${this.config.maxResponseBytes} bytes); connection closed`
      );
      this.responseBuffer = '';
      const socket = this.socket;
      this.socket = null;
      this.connected = false;
      this.authPending = false;
      if (socket) {
        socket.destroy();
      }
      this.failPending(overflow);
      return;
    }
    const { frame } = this.inflight;
    if (frame === undefined || !isResponseComplete(this.responseBuffer, frame)) {
      return;
    }
    this.completeResponse();
  }

  private completeResponse(): void {
    const pending = this.inflight;
    if (pending === null) {
      this.responseBuffer = '';
      return;
    }
    const raw = this.responseBuffer.slice(pending.frame?.frameStart ?? 0);
    this.responseBuffer = '';
    this.inflight = null;
    if (this.inflightTimeout !== null) {
      clearTimeout(this.inflightTimeout);
      this.inflightTimeout = null;
    }

    const response = raw.replace(/\r\n/g, '\n').trim();

    const errorFrame = parseErrorFrame(response);
    if (errorFrame !== null) {
      pending.reject(new ServerError(errorFrame.message, errorFrame.code, response));
    } else {
      // Follow the server's own confirmation, so DEBUG ON/OFF sent in any
      // spelling frames the next SEARCH/COUNT correctly.
      if (response === DEBUG_ON_REPLY || response === DEBUG_OFF_REPLY) {
        this.debugMode = response === DEBUG_ON_REPLY;
      }
      pending.resolve(response);
    }

    this.dispatchNext();
  }

  private failPending(error: Error): void {
    const inflight = this.inflight;
    this.inflight = null;
    if (this.inflightTimeout !== null) {
      clearTimeout(this.inflightTimeout);
      this.inflightTimeout = null;
    }
    if (inflight) {
      inflight.reject(error);
    }
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next.reject(error);
    }
    this.responseBuffer = '';
  }
}
