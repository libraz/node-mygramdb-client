/**
 * MygramDB Client (pure JavaScript transport).
 *
 * Thin wrapper that combines:
 *   - {@link Connection} - socket lifecycle, FIFO command queue, framing
 *   - {@link ./command-builder} - protocol command construction
 *   - {@link ./response-parser} - response payload parsing
 */

import {
  buildCountCommand,
  buildFacetCommand,
  buildGetCommand,
  buildSearchCommand,
  buildSearchRawCommand,
  buildSetVariableCommand,
  buildShowVariablesCommand,
  buildSyncCommand,
  buildSyncStopCommand
} from './command-builder.js';
import { DEFAULT_MAX_QUERY_LENGTH, ensureSafeIdentifier, quoteCommandArgument } from './command-utils.js';
import { Connection } from './connection.js';
import { ProtocolError } from './errors.js';
import {
  parseCacheStatsResponse,
  parseCountResponse,
  parseDocumentResponse,
  parseDumpStatusResponse,
  parseFacetResponse,
  parseInfoResponse,
  parseReplicationStatusResponse,
  parseSearchResponse
} from './response-parser.js';
import type {
  CacheStats,
  ClientConfig,
  CountOptions,
  CountResponse,
  Document,
  DumpStatus,
  FacetOptions,
  FacetResponse,
  ReplicationStatus,
  SearchOptions,
  SearchRawOptions,
  SearchResponse,
  ServerInfo
} from './types.js';

const DEFAULT_CONFIG: Required<ClientConfig> = {
  host: '127.0.0.1',
  port: 11016,
  socketPath: '',
  timeout: 5000,
  recvBufferSize: 65536,
  maxQueryLength: DEFAULT_MAX_QUERY_LENGTH,
  autoReconnect: false
};

/**
 * MygramDB client for Node.js.
 *
 * Provides a high-level interface for connecting to and querying
 * MygramDB servers using pure JavaScript (no C++ bindings).
 *
 * @example
 * ```typescript
 * const client = new MygramClient({ host: 'localhost', port: 11016 });
 * await client.connect();
 *
 * const result = await client.search('articles', 'hello world', { limit: 100 });
 * console.log(`Found ${result.totalCount} results`);
 *
 * await client.disconnect();
 * ```
 */
export class MygramClient {
  private readonly config: Required<ClientConfig>;
  private readonly connection: Connection;

  /**
   * Create a new MygramDB client.
   *
   * @param {ClientConfig} [config={}] - Client configuration
   */
  constructor(config: ClientConfig = {}) {
    const merged: Required<ClientConfig> = { ...DEFAULT_CONFIG, ...config };
    if (typeof merged.maxQueryLength !== 'number' || Number.isNaN(merged.maxQueryLength)) {
      merged.maxQueryLength = DEFAULT_MAX_QUERY_LENGTH;
    }
    this.config = merged;
    this.connection = new Connection({
      host: merged.host,
      port: merged.port,
      socketPath: merged.socketPath,
      timeout: merged.timeout,
      autoReconnect: merged.autoReconnect
    });
  }

  /**
   * Connect to MygramDB server.
   *
   * @returns {Promise<void>} Resolves when connected
   * @throws {ConnectionError} On connection failure
   * @throws {TimeoutError} When the connect handshake exceeds the timeout
   */
  connect(): Promise<void> {
    return this.connection.connect();
  }

  /**
   * Disconnect from server.
   *
   * @returns {void}
   */
  disconnect(): void {
    this.connection.disconnect();
  }

  /**
   * Whether the client is currently connected.
   *
   * @returns {boolean} True if connected, false otherwise
   */
  isConnected(): boolean {
    return this.connection.isConnected();
  }

  /**
   * Search for documents in a table.
   *
   * The query is sent as a single token: multi-word phrases are quoted
   * automatically so `client.search('articles', 'machine learning')` performs
   * a phrase search. To use boolean `AND`/`OR`/`NOT`/grouping semantics, build
   * the expression with {@link convertSearchExpression} and pass it to
   * {@link searchRaw}.
   *
   * @param {string} table - Table name to search in. In a MygramDB v1.7+
   *   multi-database deployment use a `database.table` identity (e.g.
   *   `app_db.articles`); a bare name still works for single-database servers.
   * @param {string} query - Search query text
   * @param {SearchOptions} [options={}] - Search options
   * @returns {Promise<SearchResponse>} Search response
   * @throws {ConnectionError} If not connected
   * @throws {TimeoutError} On command timeout
   * @throws {ProtocolError} On server error or invalid response
   */
  async search(table: string, query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const command = buildSearchCommand(table, query, options, this.config.maxQueryLength);
    const response = await this.connection.sendCommand(command);
    return parseSearchResponse(response);
  }

  /**
   * {@link search} variant that requests highlighted snippets.
   *
   * Convenience wrapper that enables the `HIGHLIGHT` clause: any highlight
   * options passed in `options` are preserved, otherwise server defaults are
   * used. Snippets are returned in {@link SearchResult.snippet}.
   *
   * @param {string} table - Table name (bare or `database.table`)
   * @param {string} query - Search query text
   * @param {SearchOptions} [options={}] - Search options
   * @returns {Promise<SearchResponse>} Search response with snippets
   */
  async searchWithHighlights(table: string, query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    return this.search(table, query, { ...options, highlight: options.highlight ?? {} });
  }

  /**
   * Search using a pre-built boolean expression (MygramDB v1.7+).
   *
   * The expression is sent verbatim (unquoted) so the server's AST parser can
   * interpret `AND` / `OR` / `NOT` / parentheses; a quoted phrase would be
   * treated as a literal. Pair this with {@link convertSearchExpression} to
   * preserve OR / grouping semantics that {@link search}'s AND/NOT
   * decomposition cannot express.
   *
   * @param {string} table - Table name (bare or `database.table`)
   * @param {string} rawQuery - Pre-built boolean expression
   * @param {SearchRawOptions} [options={}] - Limit/offset/highlight options
   * @returns {Promise<SearchResponse>} Search response
   * @throws {ConnectionError} If not connected
   * @throws {ProtocolError} On server error or invalid response
   *
   * @example
   * ```typescript
   * const raw = convertSearchExpression('python OR (ruby AND rails)');
   * const res = await client.searchRaw('articles', raw, { limit: 50 });
   * ```
   */
  async searchRaw(table: string, rawQuery: string, options: SearchRawOptions = {}): Promise<SearchResponse> {
    const command = buildSearchRawCommand(table, rawQuery, options);
    const response = await this.connection.sendCommand(command);
    return parseSearchResponse(response);
  }

  /**
   * {@link searchRaw} variant that requests highlighted snippets.
   *
   * Equivalent to calling {@link searchRaw} with a `highlight` option; any
   * highlight options passed in `options` are preserved, otherwise server
   * defaults are used.
   *
   * @param {string} table - Table name (bare or `database.table`)
   * @param {string} rawQuery - Pre-built boolean expression
   * @param {SearchRawOptions} [options={}] - Limit/offset/highlight options
   * @returns {Promise<SearchResponse>} Search response with snippets
   */
  async searchRawWithHighlights(
    table: string,
    rawQuery: string,
    options: SearchRawOptions = {}
  ): Promise<SearchResponse> {
    return this.searchRaw(table, rawQuery, { ...options, highlight: options.highlight ?? {} });
  }

  /**
   * Count matching documents in a table.
   *
   * @param {string} table - Table name to count documents in
   * @param {string} query - Search query text
   * @param {CountOptions} [options={}] - Count options
   * @returns {Promise<CountResponse>} Count response
   * @throws {ConnectionError} If not connected
   * @throws {TimeoutError} On command timeout
   * @throws {ProtocolError} On server error or invalid response
   */
  async count(table: string, query: string, options: CountOptions = {}): Promise<CountResponse> {
    const command = buildCountCommand(table, query, options, this.config.maxQueryLength);
    const response = await this.connection.sendCommand(command);
    return parseCountResponse(response);
  }

  /**
   * Get a document by its primary key.
   *
   * @param {string} table - Table name
   * @param {string} primaryKey - Primary key value
   * @returns {Promise<Document>} Document object
   * @throws {ConnectionError} If not connected
   * @throws {ProtocolError} On server error or invalid response
   */
  async get(table: string, primaryKey: string): Promise<Document> {
    const response = await this.connection.sendCommand(buildGetCommand(table, primaryKey));
    return parseDocumentResponse(response);
  }

  /**
   * Get server information including version, uptime, and statistics.
   *
   * @returns {Promise<ServerInfo>} Server information
   */
  async info(): Promise<ServerInfo> {
    const response = await this.connection.sendCommand('INFO');
    return parseInfoResponse(response);
  }

  /**
   * Get server configuration in YAML format.
   *
   * @returns {Promise<string>} Configuration string in YAML
   * @throws {ProtocolError} When the response is not a CONFIG response
   */
  async getConfig(): Promise<string> {
    const response = await this.connection.sendCommand('CONFIG');
    if (response.startsWith('+OK\n')) {
      return response.substring('+OK\n'.length);
    }
    if (response.startsWith('OK CONFIG\n')) {
      return response.substring('OK CONFIG\n'.length);
    }
    throw new ProtocolError(`Invalid CONFIG response: ${response}`);
  }

  /**
   * Aggregate distinct filter-column values with document counts (MygramDB v1.6+).
   *
   * @param {string} table - Table name
   * @param {string} column - Filter column to aggregate
   * @param {FacetOptions} [options={}] - Optional refinements and limit
   * @returns {Promise<FacetResponse>} Facet values with document counts
   */
  async facet(table: string, column: string, options: FacetOptions = {}): Promise<FacetResponse> {
    const command = buildFacetCommand(table, column, options, this.config.maxQueryLength);
    const response = await this.connection.sendCommand(command);
    return parseFacetResponse(response);
  }

  /**
   * Get current replication status including running state and GTID position.
   *
   * @returns {Promise<ReplicationStatus>} Replication status
   */
  async getReplicationStatus(): Promise<ReplicationStatus> {
    const response = await this.connection.sendCommand('REPLICATION STATUS');
    return parseReplicationStatusResponse(response);
  }

  /**
   * Stop binlog replication (index becomes read-only).
   *
   * @returns {Promise<void>}
   */
  async stopReplication(): Promise<void> {
    const response = await this.connection.sendCommand('REPLICATION STOP');
    expectOk(response, 'Failed to stop replication');
  }

  /**
   * Start binlog replication.
   *
   * @returns {Promise<void>}
   */
  async startReplication(): Promise<void> {
    const response = await this.connection.sendCommand('REPLICATION START');
    expectOk(response, 'Failed to start replication');
  }

  /**
   * Enable debug mode for this connection.
   *
   * @returns {Promise<void>}
   */
  async enableDebug(): Promise<void> {
    const response = await this.connection.sendCommand('DEBUG ON');
    expectOk(response, 'Failed to enable debug');
  }

  /**
   * Disable debug mode for this connection.
   *
   * @returns {Promise<void>}
   */
  async disableDebug(): Promise<void> {
    const response = await this.connection.sendCommand('DEBUG OFF');
    expectOk(response, 'Failed to disable debug');
  }

  /**
   * Save a dump of the index to the specified file path. Use {@link dumpStatus}
   * to monitor progress.
   *
   * @param {string} filepath - File path on the server to save the dump
   * @returns {Promise<string>} The filepath where the dump is being saved
   */
  async dumpSave(filepath: string): Promise<string> {
    const safeFilepath = quoteCommandArgument(filepath, 'filepath');
    const response = await this.connection.sendCommand(`DUMP SAVE ${safeFilepath}`);
    if (response.startsWith('OK DUMP_STARTED ')) {
      return response.substring('OK DUMP_STARTED '.length);
    }
    if (response.startsWith('OK DUMP_SAVED ')) {
      return response.substring('OK DUMP_SAVED '.length);
    }
    throw new ProtocolError(`Invalid DUMP SAVE response: ${response}`);
  }

  /**
   * Load a dump from the specified file path.
   *
   * @param {string} filepath - File path on the server to load the dump from
   * @returns {Promise<void>}
   */
  async dumpLoad(filepath: string): Promise<void> {
    const safeFilepath = quoteCommandArgument(filepath, 'filepath');
    const response = await this.connection.sendCommand(`DUMP LOAD ${safeFilepath}`);
    expectOk(response, 'Failed to load dump');
  }

  /**
   * Get the status of an ongoing dump operation.
   *
   * @returns {Promise<DumpStatus>} Current dump operation status
   */
  async dumpStatus(): Promise<DumpStatus> {
    const response = await this.connection.sendCommand('DUMP STATUS');
    return parseDumpStatusResponse(response);
  }

  /**
   * Verify the integrity of a dump file.
   *
   * @param {string} filepath - File path of the dump to verify
   * @returns {Promise<string>} Verification result message
   */
  async dumpVerify(filepath: string): Promise<string> {
    const safeFilepath = quoteCommandArgument(filepath, 'filepath');
    const response = await this.connection.sendCommand(`DUMP VERIFY ${safeFilepath}`);
    expectOk(response, 'Failed to verify dump');
    return response;
  }

  /**
   * Get metadata information about a dump file.
   *
   * @param {string} filepath - File path of the dump to inspect
   * @returns {Promise<string>} Dump metadata as a string
   */
  async dumpInfo(filepath: string): Promise<string> {
    const safeFilepath = quoteCommandArgument(filepath, 'filepath');
    const response = await this.connection.sendCommand(`DUMP INFO ${safeFilepath}`);
    expectOk(response, 'Failed to get dump info');
    return response;
  }

  /**
   * Get cache statistics.
   *
   * @returns {Promise<CacheStats>} Cache statistics
   */
  async cacheStats(): Promise<CacheStats> {
    const response = await this.connection.sendCommand('CACHE STATS');
    return parseCacheStatsResponse(response);
  }

  /**
   * Clear the query cache.
   *
   * @param {string} [table] - Optional table to clear; clears all if omitted
   * @returns {Promise<void>}
   */
  async cacheClear(table?: string): Promise<void> {
    const command = table ? `CACHE CLEAR ${ensureSafeIdentifier(table, 'table')}` : 'CACHE CLEAR';
    const response = await this.connection.sendCommand(command);
    expectOk(response, 'Failed to clear cache');
  }

  /**
   * Enable the query cache.
   *
   * @returns {Promise<void>}
   */
  async cacheEnable(): Promise<void> {
    const response = await this.connection.sendCommand('CACHE ENABLE');
    expectOk(response, 'Failed to enable cache');
  }

  /**
   * Disable the query cache.
   *
   * @returns {Promise<void>}
   */
  async cacheDisable(): Promise<void> {
    const response = await this.connection.sendCommand('CACHE DISABLE');
    expectOk(response, 'Failed to disable cache');
  }

  /**
   * Optimize (rebuild) the index for a table or all tables.
   *
   * @param {string} [table] - Optional table to optimize; all if omitted
   * @returns {Promise<void>}
   */
  async optimize(table?: string): Promise<void> {
    const command = table ? `OPTIMIZE ${ensureSafeIdentifier(table, 'table')}` : 'OPTIMIZE';
    const response = await this.connection.sendCommand(command);
    expectOk(response, 'Failed to optimize');
  }

  /**
   * Set a runtime variable (MygramDB v1.7+, MySQL-compatible `SET`).
   *
   * @param {string} name - Runtime variable name (e.g. `logging.level`)
   * @param {string} value - New value
   * @returns {Promise<void>}
   * @throws {ProtocolError} When the server rejects the assignment
   */
  async setVariable(name: string, value: string): Promise<void> {
    const response = await this.connection.sendCommand(buildSetVariableCommand(name, value));
    expectAck(response, 'Failed to set variable');
  }

  /**
   * Show runtime variables (MygramDB v1.7+, MySQL-compatible `SHOW VARIABLES`).
   *
   * @param {string} [likePattern] - Optional MySQL LIKE pattern (e.g. `logging%`)
   * @returns {Promise<string>} Raw variables table / `+OK` response from the server
   */
  async showVariables(likePattern?: string): Promise<string> {
    return this.connection.sendCommand(buildShowVariablesCommand(likePattern));
  }

  /**
   * Start an on-demand sync (full reload) of a table (MygramDB v1.7+).
   *
   * @param {string} table - Table name (bare or `database.table`)
   * @returns {Promise<string>} Server acknowledgement (e.g. `OK SYNC STARTED ...`)
   * @throws {ProtocolError} When the server rejects the request
   */
  async sync(table: string): Promise<string> {
    const response = await this.connection.sendCommand(buildSyncCommand(table));
    expectOk(response, 'Failed to start sync');
    return response;
  }

  /**
   * Get the status of in-flight / recent sync operations (MygramDB v1.7+).
   *
   * @returns {Promise<string>} Raw `SYNC_STATUS` report from the server
   * @throws {ProtocolError} When the response is not a SYNC status response
   */
  async syncStatus(): Promise<string> {
    const response = await this.connection.sendCommand('SYNC STATUS');
    expectOk(response, 'Failed to get sync status');
    return response;
  }

  /**
   * Stop a running sync (MygramDB v1.7+). With no table, stops every in-flight
   * sync; with a table, stops only that table's sync.
   *
   * @param {string} [table] - Optional table name (bare or `database.table`)
   * @returns {Promise<string>} Server acknowledgement
   * @throws {ProtocolError} When the server rejects the request
   */
  async syncStop(table?: string): Promise<string> {
    const response = await this.connection.sendCommand(buildSyncStopCommand(table));
    expectOk(response, 'Failed to stop sync');
    return response;
  }

  /**
   * Send a raw command to the server.
   *
   * Low-level escape hatch for custom commands. Most users should use the
   * higher-level methods instead.
   *
   * @param {string} command - Command string (without trailing CRLF)
   * @returns {Promise<string>} Response string from the server
   */
  sendCommand(command: string): Promise<string> {
    return this.connection.sendCommand(command);
  }
}

function expectOk(response: string, errorMessage: string): void {
  if (!response.startsWith('OK')) {
    throw new ProtocolError(`${errorMessage}: ${response}`);
  }
}

/**
 * Accept either a result-style `OK ...` reply or a Redis-style `+OK ...`
 * acknowledgement, throwing a {@link ProtocolError} otherwise.
 *
 * @param {string} response - Normalized server response
 * @param {string} errorMessage - Prefix for the thrown error
 * @returns {void}
 */
function expectAck(response: string, errorMessage: string): void {
  if (!response.startsWith('OK') && !response.startsWith('+OK')) {
    throw new ProtocolError(`${errorMessage}: ${response}`);
  }
}
