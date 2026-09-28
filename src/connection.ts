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
import { buildAuthCommand } from './command-builder.js';
import { ConnectionError, ProtocolError, ServerError, TimeoutError } from './errors.js';
import { parseErrorFrame } from './response-parser.js';

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
   * Mirrors the server's per-connection `DEBUG ON`/`OFF` flag so a SEARCH/
   * COUNT reply's completion check knows a trailing debug block is coming
   * before any bytes of it have arrived. Reset on disconnect since the flag
   * does not survive a new server-side connection.
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
    const completionOptions = responseCompletionOptionsFor(this.inflight.command, this.debugMode);
    if (!isResponseComplete(this.responseBuffer, completionOptions)) {
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

    const errorFrame = parseErrorFrame(response);
    if (errorFrame !== null) {
      pending.reject(new ServerError(errorFrame.message, errorFrame.code, response));
    } else {
      // A raw "DEBUG ON"/"DEBUG OFF" command that the server accepted:
      // track the flag so the next SEARCH/COUNT on this connection knows to
      // expect a trailing debug block.
      const upperCommand = pending.command.trim().toUpperCase();
      if (upperCommand === 'DEBUG ON') {
        this.debugMode = true;
      } else if (upperCommand === 'DEBUG OFF') {
        this.debugMode = false;
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

const END_MARKER_FIRST_LINES = new Set<string>([
  'OK INFO',
  'OK REPLICATION',
  'OK CACHE_STATS',
  'OK DUMP_STATUS',
  'OK SYNC_STATUS'
]);

const BLANK_LINE_FIRST_LINE_PREFIXES = ['+OK', 'OK CONFIG', 'OK FACET'];

/** `SHOW VARIABLES`'s bare ASCII table border, with no `OK`/`+OK` status prefix. */
const TABLE_BORDER_PREFIX = '+-';

/**
 * Context {@link isResponseComplete} cannot derive from the buffered bytes
 * alone: what command produced this response, and whether the connection's
 * `DEBUG` flag is on.
 */
export interface ResponseCompletionOptions {
  /**
   * True when the in-flight command is `SEARCH`/`COUNT` and either `DEBUG`
   * is on or the command requested `HIGHLIGHT`, so its reply cannot end at
   * the header line even when a chunk boundary happens to land right after
   * it. Mirrors the C++ client's `ResponseCompletionState::expect_multiline_tail`.
   */
  expectMultilineTail?: boolean;
  /**
   * True alongside `expectMultilineTail` when a `# DEBUG` block can actually
   * appear (`DEBUG` is on). The block's own opening (`\r\n\r\n# DEBUG\r\n`)
   * is itself a blank-line-terminated buffer, so a chunk boundary landing
   * right after that blank line -- before "# DEBUG" itself has arrived --
   * must not be trusted as the frame's end. Mirrors the C++ client's
   * `ResponseCompletionState::expect_debug_marker`.
   */
  expectDebugMarker?: boolean;
}

/** A `# DEBUG` block's fixed opening line, once its own leading blank line has arrived. */
const DEBUG_BLOCK_MARKER = '# DEBUG';

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
 *   - `SHOW VARIABLES`'s bare `+-...-+` table (no status prefix) also ends
 *     with `\r\n\r\n`; every border and row line ends in `\r\n` on its own,
 *     so it can never be trusted to be the whole response after just one line.
 *   - Other responses (`OK RESULTS`, `OK COUNT`, `OK DOC`, `OK`,
 *     `OK DUMP_*`, `ERROR ...`) are single-line when the first `\r\n` is
 *     at the end -- unless {@link ResponseCompletionOptions.expectMultilineTail}
 *     says this SEARCH/COUNT reply's header only looks single-line because a
 *     debug block or highlight rows haven't arrived yet. If there is content
 *     after the first line (DEBUG block or HIGHLIGHT rows), they end with `\r\n\r\n`.
 *
 * The function also accepts LF-only terminators (`\nEND\n`, `\n\n`) so
 * unit tests written before the protocol fix continue to validate
 * payload-level behaviour without re-emitting CRLF.
 *
 * @param {string} buffer - Accumulated response bytes
 * @param {ResponseCompletionOptions} [options] - Command context (defaults preserve
 *   the single-line shortcut, matching every caller that has no command in hand)
 * @returns {boolean} True when the buffer contains a complete response
 */
export function isResponseComplete(buffer: string, options: ResponseCompletionOptions = {}): boolean {
  if (buffer.length === 0) return false;

  const firstNewline = buffer.indexOf('\n');
  if (firstNewline === -1) {
    return false;
  }
  const firstLine = stripTrailingCarriageReturn(buffer.slice(0, firstNewline));

  if (isEndMarkerResponse(firstLine)) {
    return endsWithEndMarker(buffer);
  }

  if (isBlankLineResponse(firstLine) || firstLine.startsWith(TABLE_BORDER_PREFIX)) {
    return endsWithBlankLine(buffer);
  }

  // SEARCH/COUNT/GET/DUMP_SAVE/etc. - single-line unless followed by
  // a DEBUG block or HIGHLIGHT rows.
  const rest = buffer.slice(firstNewline + 1);
  if (rest.length === 0 && !options.expectMultilineTail) {
    // First line ended at the end of buffer - complete.
    return true;
  }

  if (options.expectDebugMarker && !buffer.includes(DEBUG_BLOCK_MARKER)) {
    // The blank line before "# DEBUG" can itself look like the frame's
    // terminator; wait for the marker itself before trusting one.
    return false;
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

/**
 * Check whether a command is `SEARCH` or `COUNT`.
 *
 * Only these two produce an `OK RESULTS`/`OK COUNT` header that a trailing
 * `DEBUG` block or `HIGHLIGHT` rows can follow; every other command's
 * single-line reply is genuinely done at its first `\r\n` regardless of the
 * connection's debug flag. Mirrors the C++ client's `IsSearchOrCountCommand`.
 */
function isSearchOrCountCommand(command: string): boolean {
  const verbEnd = command.search(/[ \t]/);
  const verb = (verbEnd === -1 ? command : command.slice(0, verbEnd)).toUpperCase();
  return verb === 'SEARCH' || verb === 'COUNT';
}

/**
 * Check whether a command's `HIGHLIGHT` clause, if any, is real.
 *
 * `HIGHLIGHT` is a case-insensitive clause keyword recognized as a bare,
 * whitespace-delimited token; {@link escapeQueryString} quotes any query/
 * AND/NOT/FILTER value that collides with it, so an unquoted `HIGHLIGHT`
 * token in the command text can only be the real clause. Mirrors the C++
 * client's `CommandRequestsHighlight`.
 */
function commandRequestsHighlight(command: string): boolean {
  return command.split(/[ \t]+/).some((token) => token.toUpperCase() === 'HIGHLIGHT');
}

/**
 * Derive {@link ResponseCompletionOptions} for a command about to be sent,
 * from the command text and the connection's current `DEBUG` flag.
 */
function responseCompletionOptionsFor(command: string, debugMode: boolean): ResponseCompletionOptions {
  const isSearchOrCount = isSearchOrCountCommand(command);
  return {
    expectMultilineTail: isSearchOrCount && (debugMode || commandRequestsHighlight(command)),
    expectDebugMarker: isSearchOrCount && debugMode
  };
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
