/**
 * Native C++ client wrapper for MygramDB.
 *
 * Same public surface as {@link MygramClient} but routed through the
 * native binding for transport. Validation, command construction, and
 * response parsing are shared with the pure-JavaScript client via the
 * `command-builder` and `response-parser` modules.
 */

import { buildCountCommand, buildFacetCommand, buildGetCommand, buildSearchCommand } from './command-builder.js';
import { DEFAULT_MAX_QUERY_LENGTH } from './command-utils.js';
import { ConnectionError, ProtocolError } from './errors.js';
import {
  parseCountResponse,
  parseDocumentResponse,
  parseFacetResponse,
  parseInfoResponse,
  parseReplicationStatusResponse,
  parseSearchResponse
} from './response-parser.js';
import type {
  ClientConfig,
  CountOptions,
  CountResponse,
  Document,
  FacetOptions,
  FacetResponse,
  ReplicationStatus,
  SearchOptions,
  SearchResponse,
  ServerInfo
} from './types.js';

/**
 * Result of parsing a web-style search expression.
 */
export interface SimplifiedExpression {
  mainTerm: string;
  andTerms: string[];
  notTerms: string[];
}

interface NativeBinding {
  createClient(config: { host: string; port: number; timeout: number }): unknown;
  connect(client: unknown): boolean;
  disconnect(client: unknown): void;
  destroyClient(client: unknown): void;
  isConnected(client: unknown): boolean;
  search(client: unknown, table: string, query: string, limit: number, offset: number): string;
  sendCommand(client: unknown, command: string): string;
  getLastError(client: unknown): string;
  simplifySearchExpression(expression: string): SimplifiedExpression;
}

const DEFAULT_CONFIG: Required<ClientConfig> = {
  host: '127.0.0.1',
  port: 11016,
  socketPath: '',
  timeout: 5000,
  recvBufferSize: 65536,
  maxQueryLength: DEFAULT_MAX_QUERY_LENGTH
};

/**
 * Native MygramDB client using C++ bindings.
 *
 * Provides the same interface as {@link MygramClient} but routes
 * transport through the native binding.
 */
export class NativeMygramClient {
  private readonly config: Required<ClientConfig>;
  private readonly native: NativeBinding;
  private clientHandle: unknown = null;
  private connected = false;

  /**
   * Create a new native MygramDB client.
   *
   * @param {NativeBinding} native - Native binding object
   * @param {ClientConfig} [config={}] - Client configuration
   */
  constructor(native: NativeBinding, config: ClientConfig = {}) {
    this.native = native;
    const merged: Required<ClientConfig> = { ...DEFAULT_CONFIG, ...config };
    if (typeof merged.maxQueryLength !== 'number' || Number.isNaN(merged.maxQueryLength)) {
      merged.maxQueryLength = DEFAULT_MAX_QUERY_LENGTH;
    }
    this.config = merged;
  }

  /**
   * Connect to MygramDB server.
   *
   * @returns {Promise<void>} Resolves when connected
   * @throws {ConnectionError} If connection fails
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      this.clientHandle = this.native.createClient({
        host: this.config.host,
        port: this.config.port,
        timeout: this.config.timeout
      });

      const result = this.native.connect(this.clientHandle);
      if (!result) {
        const error = this.native.getLastError(this.clientHandle);
        throw new ConnectionError(error || 'Failed to connect');
      }

      this.connected = true;
    } catch (error) {
      if (error instanceof ConnectionError) {
        throw error;
      }
      throw new ConnectionError(error instanceof Error ? error.message : 'Connection failed');
    }
  }

  /**
   * Disconnect from server.
   *
   * @returns {void}
   */
  disconnect(): void {
    if (this.clientHandle) {
      this.native.disconnect(this.clientHandle);
      this.native.destroyClient(this.clientHandle);
      this.clientHandle = null;
    }
    this.connected = false;
  }

  /**
   * Whether the client is connected.
   *
   * @returns {boolean}
   */
  isConnected(): boolean {
    if (!this.clientHandle) {
      return false;
    }
    return this.native.isConnected(this.clientHandle);
  }

  /**
   * Search for documents in a table.
   *
   * @param {string} table - Table name
   * @param {string} query - Search query text
   * @param {SearchOptions} [options={}] - Search options
   * @returns {Promise<SearchResponse>} Search response
   */
  async search(table: string, query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const command = buildSearchCommand(table, query, options, this.config.maxQueryLength);
    const response = await this.sendCommand(command);
    return parseSearchResponse(response);
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
    const response = await this.sendCommand(command);
    return parseFacetResponse(response);
  }

  /**
   * Count matching documents in a table.
   *
   * @param {string} table - Table name
   * @param {string} query - Search query text
   * @param {CountOptions} [options={}] - Count options
   * @returns {Promise<CountResponse>} Count response
   */
  async count(table: string, query: string, options: CountOptions = {}): Promise<CountResponse> {
    const command = buildCountCommand(table, query, options, this.config.maxQueryLength);
    const response = await this.sendCommand(command);
    return parseCountResponse(response);
  }

  /**
   * Get a document by its primary key.
   *
   * @param {string} table - Table name
   * @param {string} primaryKey - Primary key value
   * @returns {Promise<Document>} Document object
   */
  async get(table: string, primaryKey: string): Promise<Document> {
    const response = await this.sendCommand(buildGetCommand(table, primaryKey));
    return parseDocumentResponse(response);
  }

  /**
   * Get server information.
   *
   * @returns {Promise<ServerInfo>} Server information
   */
  async info(): Promise<ServerInfo> {
    const response = await this.sendCommand('INFO');
    return parseInfoResponse(response);
  }

  /**
   * Get server configuration in YAML format.
   *
   * @returns {Promise<string>} Configuration string
   */
  async getConfig(): Promise<string> {
    const response = await this.sendCommand('CONFIG');
    if (response.startsWith('+OK\n')) {
      return response.substring('+OK\n'.length);
    }
    if (response.startsWith('OK CONFIG\n')) {
      return response.substring('OK CONFIG\n'.length);
    }
    throw new ProtocolError(`Invalid CONFIG response: ${response}`);
  }

  /**
   * Get replication status.
   *
   * @returns {Promise<ReplicationStatus>} Replication status
   */
  async getReplicationStatus(): Promise<ReplicationStatus> {
    const response = await this.sendCommand('REPLICATION STATUS');
    return parseReplicationStatusResponse(response);
  }

  /**
   * Stop replication.
   *
   * @returns {Promise<void>}
   */
  async stopReplication(): Promise<void> {
    const response = await this.sendCommand('REPLICATION STOP');
    expectOk(response, 'Failed to stop replication');
  }

  /**
   * Start replication.
   *
   * @returns {Promise<void>}
   */
  async startReplication(): Promise<void> {
    const response = await this.sendCommand('REPLICATION START');
    expectOk(response, 'Failed to start replication');
  }

  /**
   * Enable debug mode.
   *
   * @returns {Promise<void>}
   */
  async enableDebug(): Promise<void> {
    const response = await this.sendCommand('DEBUG ON');
    expectOk(response, 'Failed to enable debug');
  }

  /**
   * Disable debug mode.
   *
   * @returns {Promise<void>}
   */
  async disableDebug(): Promise<void> {
    const response = await this.sendCommand('DEBUG OFF');
    expectOk(response, 'Failed to disable debug');
  }

  /**
   * Send raw command to server.
   *
   * @param {string} command - Command string
   * @returns {Promise<string>} Response from server
   * @throws {ConnectionError} If not connected
   */
  sendCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.clientHandle) {
        reject(new ConnectionError('Not connected to server'));
        return;
      }

      try {
        const rawResponse = this.native.sendCommand(this.clientHandle, command);
        const response = rawResponse.replace(/\r\n/g, '\n').trim();
        if (response.startsWith('ERROR ')) {
          throw new ProtocolError(response.substring(6));
        }
        resolve(response);
      } catch (error) {
        if (error instanceof ProtocolError) {
          reject(error);
          return;
        }
        const errorMsg = this.native.getLastError(this.clientHandle);
        reject(new ConnectionError(errorMsg || (error instanceof Error ? error.message : 'Command failed')));
      }
    });
  }
}

function expectOk(response: string, errorMessage: string): void {
  if (!response.startsWith('OK')) {
    throw new ProtocolError(`${errorMessage}: ${response}`);
  }
}
