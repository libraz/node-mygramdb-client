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
 *   3. Detect the boundary of every protocol response (single-line,
 *      `\r\n\r\n`-terminated multi-line, and `END\r\n`-terminated
 *      multi-line) so each `sendCommand` resolves with exactly one
 *      response.
 *
 * The class is intentionally focused on transport and framing -
 * response payload parsing lives in {@link ./response-parser}.
 */

import { Socket } from 'node:net';
import { ConnectionError, ProtocolError, TimeoutError } from './errors.js';

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
   * Per-operation timeout in milliseconds.
   *
   * Applied to:
   *   - the `connect()` handshake (independently of socket idle timeout)
   *   - each individual `sendCommand` (bounded from when it leaves the
   *     queue, not from the moment it was enqueued)
   *
   * The socket's own `setTimeout` is also configured to this value so
   * the underlying socket reports idle peers via the `timeout` event.
   */
  timeout: number;
  /**
   * Reconnect once and resend a command when the socket is found dead before
   * the command is written. A failure after the write is surfaced as a
   * {@link ConnectionError} without resending. Default behaviour when false is
   * to reject immediately with {@link ConnectionError}.
   */
  autoReconnect: boolean;
}

interface PendingCommand {
  command: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
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
   * Build a connection bound to a given configuration.
   *
   * @param {ConnectionConfig} config - Resolved transport configuration
   */
  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  /**
   * Establish the socket. Resolves on the `connect` event, rejects on
   * `error` or after {@link ConnectionConfig.timeout} milliseconds.
   *
   * Calling `connect()` after a successful connection is a no-op.
   *
   * @returns {Promise<void>} Resolves once the socket is open
   * @throws {ConnectionError} On socket error or close before open
   * @throws {TimeoutError} When the handshake exceeds the configured timeout
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      this.socket = socket;
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
      }, this.config.timeout);

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
   *   - {@link ProtocolError} if the server returns `ERROR <message>`
   *
   * @param {string} command - Command text without trailing CRLF
   * @returns {Promise<string>} Server response (CRLF-normalized, trimmed)
   */
  sendCommand(command: string): Promise<string> {
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
      this.queue.push({ command, resolve, reject });
      this.dispatchNext();
    });
  }

  private dispatchNext(): void {
    if (this.inflight !== null || this.reconnecting) return;
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

    this.inflight = command;
    this.inflightTimeout = setTimeout(() => {
      this.inflightTimeout = null;
      const pending = this.inflight;
      this.inflight = null;
      if (pending) {
        pending.reject(new TimeoutError('Command timeout'));
      }
      this.dispatchNext();
    }, this.config.timeout);

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
    if (!isResponseComplete(this.responseBuffer)) {
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
    const raw = this.responseBuffer;
    this.responseBuffer = '';
    this.inflight = null;
    if (this.inflightTimeout !== null) {
      clearTimeout(this.inflightTimeout);
      this.inflightTimeout = null;
    }

    const response = raw.replace(/\r\n/g, '\n').trim();

    if (response.startsWith('ERROR ')) {
      pending.reject(new ProtocolError(response.substring(6)));
    } else {
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

const END_MARKER_FIRST_LINES = new Set<string>([
  'OK INFO',
  'OK REPLICATION',
  'OK CACHE_STATS',
  'OK DUMP_STATUS',
  'OK SYNC_STATUS'
]);

const BLANK_LINE_FIRST_LINE_PREFIXES = ['+OK', 'OK CONFIG', 'OK FACET'];

/**
 * Detect whether the buffered response is complete.
 *
 * Authoritative protocol framing - mirrors the C++ client's
 * `protocol_detection.h::IsResponseComplete`:
 *
 *   - `OK INFO`, `OK REPLICATION`, `OK CACHE_STATS`, `OK DUMP_INFO`,
 *     `OK DUMP_STATUS`, `OK SYNC_STATUS` end with `END\r\n`. These
 *     responses contain internal blank lines, so `\r\n\r\n` is NOT accepted.
 *   - `+OK`, `OK CONFIG`, `OK FACET` end with `\r\n\r\n`.
 *   - Other responses (`OK RESULTS`, `OK COUNT`, `OK DOC`, `OK`,
 *     `OK DUMP_*`, `ERROR ...`) are single-line when the first `\r\n` is
 *     at the end. If there is content after the first line (DEBUG block
 *     or HIGHLIGHT rows), they end with `\r\n\r\n`.
 *
 * The function also accepts LF-only terminators (`\nEND\n`, `\n\n`) so
 * unit tests written before the protocol fix continue to validate
 * payload-level behaviour without re-emitting CRLF.
 *
 * @param {string} buffer - Accumulated response bytes
 * @returns {boolean} True when the buffer contains a complete response
 */
export function isResponseComplete(buffer: string): boolean {
  if (buffer.length === 0) return false;

  const firstNewline = buffer.indexOf('\n');
  if (firstNewline === -1) {
    return false;
  }
  const firstLine = stripTrailingCarriageReturn(buffer.slice(0, firstNewline));

  if (isEndMarkerResponse(firstLine)) {
    return endsWithEndMarker(buffer);
  }

  if (isBlankLineResponse(firstLine)) {
    return endsWithBlankLine(buffer);
  }

  // SEARCH/COUNT/GET/DUMP_SAVE/etc. - single-line unless followed by
  // a DEBUG block or HIGHLIGHT rows.
  const rest = buffer.slice(firstNewline + 1);
  if (rest.length === 0) {
    // First line ended at the end of buffer - complete.
    return true;
  }
  // Anything after the first line means the response is multi-line and
  // ends with a blank line.
  return endsWithBlankLine(buffer);
}

function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function isEndMarkerResponse(firstLine: string): boolean {
  if (END_MARKER_FIRST_LINES.has(firstLine)) return true;
  // DUMP_INFO carries an optional filepath suffix on the first line.
  if (firstLine.startsWith('OK DUMP_INFO ') || firstLine.startsWith('OK DUMP_INFO\t')) return true;
  return false;
}

function isBlankLineResponse(firstLine: string): boolean {
  for (const prefix of BLANK_LINE_FIRST_LINE_PREFIXES) {
    if (firstLine === prefix || firstLine.startsWith(`${prefix} `) || firstLine.startsWith(`${prefix}\t`)) {
      return true;
    }
  }
  return false;
}

function endsWithEndMarker(buffer: string): boolean {
  // The `END` terminator sits on its own line. Most multi-line responses end
  // with `...\r\nEND\r\n`, but some (e.g. SYNC_STATUS) append an extra blank
  // line and end with `...\r\nEND\r\n\r\n`. Accept `END` as the final
  // non-empty line regardless of how many trailing CRLFs follow.
  return /(?:\r?\n)END(?:\r?\n)*$/.test(buffer);
}

function endsWithBlankLine(buffer: string): boolean {
  return buffer.endsWith('\r\n\r\n') || buffer.endsWith('\n\n') || buffer.endsWith('\n\r\n');
}
