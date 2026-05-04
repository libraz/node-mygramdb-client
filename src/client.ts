/**
 * MygramDB Client (pure JavaScript transport).
 *
 * Thin wrapper that combines:
 *   - {@link Connection} - socket lifecycle, FIFO command queue, framing
 *   - {@link ./command-builder} - protocol command construction
 *   - {@link ./response-parser} - response payload parsing
 */

import { buildCountCommand, buildFacetCommand, buildGetCommand, buildSearchCommand } from './command-builder.js';
import { DEFAULT_MAX_QUERY_LENGTH, ensureSafeIdentifier } from './command-utils.js';
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
  SearchResponse,
  ServerInfo
} from './types.js';

const DEFAULT_CONFIG: Required<ClientConfig> = {
  host: '127.0.0.1',
  port: 11016,
  socketPath: '',
  timeout: 5000,
  recvBufferSize: 65536,
  maxQueryLength: DEFAULT_MAX_QUERY_LENGTH
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
      timeout: merged.timeout
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
   * @param {string} table - Table name to search in
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
    const safeFilepath = ensureSafeIdentifier(filepath, 'filepath');
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
    const safeFilepath = ensureSafeIdentifier(filepath, 'filepath');
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
    const safeFilepath = ensureSafeIdentifier(filepath, 'filepath');
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
    const safeFilepath = ensureSafeIdentifier(filepath, 'filepath');
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
