/**
 * Native C++ client wrapper for MygramDB
 *
 * This module provides a TypeScript wrapper around the native C++ binding,
 * with the same interface as the pure JavaScript client.
 */

import {
  DEFAULT_MAX_QUERY_LENGTH,
  ensureQueryLengthWithinLimit,
  ensureSafeCommandValue,
  ensureSafeFilters,
  ensureSafeStringArray,
  validateFacetColumn,
  validateFuzzy,
  validateHighlight
} from './command-utils.js';
import { ConnectionError, ProtocolError } from './errors.js';
import type {
  ClientConfig,
  CountOptions,
  CountResponse,
  DebugInfo,
  Document,
  FacetOptions,
  FacetResponse,
  FacetValue,
  ReplicationStatus,
  SearchOptions,
  SearchResponse,
  SearchResult,
  ServerInfo
} from './types.js';

/**
 * Result of parsing a web-style search expression
 */
export interface SimplifiedExpression {
  mainTerm: string;
  andTerms: string[];
  notTerms: string[];
}

// Native binding interface
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
 * Native MygramDB client using C++ bindings
 *
 * This class provides the same interface as MygramClient but uses
 * native C++ code for better performance.
 */
export class NativeMygramClient {
  private config: Required<ClientConfig>;
  private native: NativeBinding;
  private clientHandle: unknown = null;
  private connected = false;

  /**
   * Create a new native MygramDB client
   *
   * @param {NativeBinding} native - Native binding object
   * @param {ClientConfig} [config={}] - Client configuration
   */
  constructor(native: NativeBinding, config: ClientConfig = {}) {
    this.native = native;
    const mergedConfig: Required<ClientConfig> = { ...DEFAULT_CONFIG, ...config };
    if (typeof mergedConfig.maxQueryLength !== 'number' || Number.isNaN(mergedConfig.maxQueryLength)) {
      mergedConfig.maxQueryLength = DEFAULT_MAX_QUERY_LENGTH;
    }
    this.config = mergedConfig;
  }

  /**
   * Connect to MygramDB server
   *
   * @returns {Promise<void>} Resolves when connected
   * @throws {ConnectionError} If connection fails
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return Promise.resolve();
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

    return undefined;
  }

  /**
   * Disconnect from server
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
   * Check if connected to server
   *
   * @returns {boolean} True if connected, false otherwise
   */
  isConnected(): boolean {
    if (!this.clientHandle) {
      return false;
    }
    return this.native.isConnected(this.clientHandle);
  }

  /**
   * Search for documents in a table
   *
   * @param {string} table - Table name to search in
   * @param {string} query - Search query text
   * @param {SearchOptions} [options={}] - Search options
   * @returns {Promise<SearchResponse>} Search response
   * @throws {ConnectionError} If not connected to server
   * @throws {TimeoutError} If command times out
   * @throws {ProtocolError} If server returns an error
   */
  async search(table: string, query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const {
      limit = 1000,
      offset = 0,
      andTerms = [],
      notTerms = [],
      filters = {},
      sortColumn = '',
      sortDesc = true,
      fuzzy = 0,
      highlight
    } = options;

    const safeTable = ensureSafeCommandValue(table, 'table');
    const safeQuery = ensureSafeCommandValue(query, 'query');
    ensureSafeStringArray(andTerms, 'andTerms');
    ensureSafeStringArray(notTerms, 'notTerms');
    const safeFilters = ensureSafeFilters(filters);
    const safeSortColumn = sortColumn ? ensureSafeCommandValue(sortColumn, 'sortColumn') : '';
    validateFuzzy(fuzzy);
    validateHighlight(highlight);

    ensureQueryLengthWithinLimit(
      {
        query: safeQuery,
        andTerms,
        notTerms,
        filters: safeFilters,
        sortColumn: safeSortColumn
      },
      this.config.maxQueryLength
    );

    const parts: string[] = ['SEARCH', safeTable, safeQuery];

    // Add AND terms
    if (andTerms.length > 0) {
      andTerms.forEach((term) => {
        parts.push('AND', term);
      });
    }

    // Add NOT terms
    if (notTerms.length > 0) {
      notTerms.forEach((term) => {
        parts.push('NOT', term);
      });
    }

    // Add filters (each FILTER is a separate clause)
    const filterEntries = Object.entries(safeFilters);
    filterEntries.forEach(([key, value]) => {
      parts.push('FILTER', key, '=', value);
    });

    // Add sort (use _score for BM25 in MygramDB v1.6+)
    if (safeSortColumn) {
      parts.push('SORT', safeSortColumn, sortDesc ? 'DESC' : 'ASC');
    }

    // Add fuzzy (MygramDB v1.6+)
    if (fuzzy > 0) {
      parts.push('FUZZY', `${fuzzy}`);
    }

    // Add highlight (MygramDB v1.6+)
    if (highlight) {
      parts.push('HIGHLIGHT');
      const openTag = highlight.openTag ?? '';
      const closeTag = highlight.closeTag ?? '';
      if (openTag !== '' && closeTag !== '') {
        parts.push('TAG', openTag, closeTag);
      }
      if (highlight.snippetLen && highlight.snippetLen > 0) {
        parts.push('SNIPPET_LEN', `${highlight.snippetLen}`);
      }
      if (highlight.maxFragments && highlight.maxFragments > 0) {
        parts.push('MAX_FRAGMENTS', `${highlight.maxFragments}`);
      }
    }

    // Add limit and offset
    if (offset > 0) {
      parts.push('LIMIT', `${offset},${limit}`);
    } else {
      parts.push('LIMIT', `${limit}`);
    }

    const response = await this.sendCommand(parts.join(' '));
    return NativeMygramClient.parseSearchResponse(response);
  }

  /**
   * Aggregate distinct filter-column values with document counts (MygramDB v1.6+).
   *
   * @param {string} table - Table name
   * @param {string} column - Filter column to aggregate
   * @param {FacetOptions} [options={}] - Optional query, refinements and limit
   * @returns {Promise<FacetResponse>} Facet values with document counts
   */
  async facet(table: string, column: string, options: FacetOptions = {}): Promise<FacetResponse> {
    const { query = '', andTerms = [], notTerms = [], filters = {}, limit = 0 } = options;

    const safeTable = ensureSafeCommandValue(table, 'table');
    validateFacetColumn(column);
    const safeQuery = query ? ensureSafeCommandValue(query, 'query') : '';
    ensureSafeStringArray(andTerms, 'andTerms');
    ensureSafeStringArray(notTerms, 'notTerms');
    const safeFilters = ensureSafeFilters(filters);
    ensureQueryLengthWithinLimit(
      {
        query: safeQuery,
        andTerms,
        notTerms,
        filters: safeFilters,
        sortColumn: ''
      },
      this.config.maxQueryLength
    );

    const parts: string[] = ['FACET', safeTable, column];

    if (safeQuery !== '') {
      parts.push('QUERY', safeQuery);
      if (andTerms.length > 0) {
        andTerms.forEach((term) => {
          parts.push('AND', term);
        });
      }
      if (notTerms.length > 0) {
        notTerms.forEach((term) => {
          parts.push('NOT', term);
        });
      }
      Object.entries(safeFilters).forEach(([key, value]) => {
        parts.push('FILTER', key, '=', value);
      });
    }

    if (limit > 0) {
      parts.push('LIMIT', `${limit}`);
    }

    const response = await this.sendCommand(parts.join(' '));
    return NativeMygramClient.parseFacetResponse(response);
  }

  /**
   * Count matching documents in a table
   *
   * @param {string} table - Table name
   * @param {string} query - Search query text
   * @param {CountOptions} [options={}] - Count options
   * @returns {Promise<CountResponse>} Count response
   */
  async count(table: string, query: string, options: CountOptions = {}): Promise<CountResponse> {
    const { andTerms = [], notTerms = [], filters = {} } = options;

    const safeTable = ensureSafeCommandValue(table, 'table');
    const safeQuery = ensureSafeCommandValue(query, 'query');
    ensureSafeStringArray(andTerms, 'andTerms');
    ensureSafeStringArray(notTerms, 'notTerms');
    const safeFilters = ensureSafeFilters(filters);

    const parts: string[] = ['COUNT', safeTable, safeQuery];

    if (andTerms.length > 0) {
      andTerms.forEach((term) => {
        parts.push('AND', term);
      });
    }

    if (notTerms.length > 0) {
      notTerms.forEach((term) => {
        parts.push('NOT', term);
      });
    }

    const filterEntries = Object.entries(safeFilters);
    if (filterEntries.length > 0) {
      parts.push('FILTER');
      filterEntries.forEach(([key, value], index) => {
        if (index > 0) parts.push('AND');
        parts.push(`${key}=${value}`);
      });
    }

    const response = await this.sendCommand(parts.join(' '));
    return NativeMygramClient.parseCountResponse(response);
  }

  /**
   * Get a document by its primary key
   *
   * @param {string} table - Table name
   * @param {string} primaryKey - Primary key value
   * @returns {Promise<Document>} Document object
   */
  async get(table: string, primaryKey: string): Promise<Document> {
    const safeTable = ensureSafeCommandValue(table, 'table');
    const safePrimaryKey = ensureSafeCommandValue(primaryKey, 'primaryKey');
    const response = await this.sendCommand(`GET ${safeTable} ${safePrimaryKey}`);
    return NativeMygramClient.parseDocumentResponse(response);
  }

  /**
   * Get server information
   *
   * @returns {Promise<ServerInfo>} Server information
   */
  async info(): Promise<ServerInfo> {
    const response = await this.sendCommand('INFO');
    return NativeMygramClient.parseInfoResponse(response);
  }

  /**
   * Get server configuration in YAML format
   *
   * @returns {Promise<string>} Configuration string
   */
  async getConfig(): Promise<string> {
    const response = await this.sendCommand('CONFIG');
    // Handle both "+OK\n..." and "OK CONFIG\n..." formats
    if (response.startsWith('+OK\n')) {
      return response.substring('+OK\n'.length);
    }
    if (response.startsWith('OK CONFIG\n')) {
      return response.substring('OK CONFIG\n'.length);
    }
    throw new ProtocolError(`Invalid CONFIG response: ${response}`);
  }

  /**
   * Get replication status
   *
   * @returns {Promise<ReplicationStatus>} Replication status
   */
  async getReplicationStatus(): Promise<ReplicationStatus> {
    const response = await this.sendCommand('REPLICATION STATUS');
    return NativeMygramClient.parseReplicationStatusResponse(response);
  }

  /**
   * Stop replication
   *
   * @returns {Promise<void>}
   */
  async stopReplication(): Promise<void> {
    const response = await this.sendCommand('REPLICATION STOP');
    if (!response.startsWith('OK')) {
      throw new ProtocolError(`Failed to stop replication: ${response}`);
    }
  }

  /**
   * Start replication
   *
   * @returns {Promise<void>}
   */
  async startReplication(): Promise<void> {
    const response = await this.sendCommand('REPLICATION START');
    if (!response.startsWith('OK')) {
      throw new ProtocolError(`Failed to start replication: ${response}`);
    }
  }

  /**
   * Enable debug mode
   *
   * @returns {Promise<void>}
   */
  async enableDebug(): Promise<void> {
    const response = await this.sendCommand('DEBUG ON');
    if (!response.startsWith('OK')) {
      throw new ProtocolError(`Failed to enable debug: ${response}`);
    }
  }

  /**
   * Disable debug mode
   *
   * @returns {Promise<void>}
   */
  async disableDebug(): Promise<void> {
    const response = await this.sendCommand('DEBUG OFF');
    if (!response.startsWith('OK')) {
      throw new ProtocolError(`Failed to disable debug: ${response}`);
    }
  }

  /**
   * Send raw command to server
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
        // Normalize CRLF to LF for consistent parsing
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

  // Response parsing methods (same as MygramClient)
  private static parseSearchResponse(response: string): SearchResponse {
    const lines = response.split('\n');
    const firstLine = lines[0];

    if (!firstLine.startsWith('OK RESULTS ')) {
      throw new ProtocolError(`Invalid SEARCH response: ${firstLine}`);
    }

    const headerParts = firstLine.split(' ');
    const totalCount = parseInt(headerParts[2], 10);

    const payloadLines: string[] = [];
    let debugIndex = -1;
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === '# DEBUG') {
        debugIndex = i;
        break;
      }
      if (line === '') continue;
      payloadLines.push(line);
    }

    let results: SearchResult[];
    if (payloadLines.length > 0) {
      results = payloadLines.map((line) => {
        const tab = line.indexOf('\t');
        if (tab < 0) return { primaryKey: line, snippet: '' };
        return { primaryKey: line.slice(0, tab), snippet: line.slice(tab + 1) };
      });
    } else {
      const ids = headerParts.slice(3);
      results = ids.map((id) => ({ primaryKey: id }));
    }

    let debug: DebugInfo | undefined;
    if (debugIndex !== -1) {
      debug = NativeMygramClient.parseDebugInfo(lines.slice(debugIndex + 1));
    }

    return { results, totalCount, debug };
  }

  /**
   * Parse FACET response (MygramDB v1.6+).
   */
  private static parseFacetResponse(response: string): FacetResponse {
    const lines = response.split('\n');
    const firstLine = lines[0];

    if (!firstLine.startsWith('OK FACET')) {
      throw new ProtocolError(`Invalid FACET response: ${firstLine}`);
    }
    const headerParts = firstLine.split(' ');
    if (headerParts.length < 3) {
      throw new ProtocolError('Invalid FACET response: missing count');
    }
    if (Number.isNaN(parseInt(headerParts[2], 10))) {
      throw new ProtocolError(`Invalid FACET count: ${headerParts[2]}`);
    }

    const results: FacetValue[] = [];
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === '' || line.startsWith('#')) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) {
        throw new ProtocolError(`Invalid FACET row: ${line}`);
      }
      const value = line.slice(0, tab);
      const countStr = line.slice(tab + 1).trim();
      const count = parseInt(countStr, 10);
      if (Number.isNaN(count)) {
        throw new ProtocolError(`Invalid FACET count for ${value}: ${countStr}`);
      }
      results.push({ value, count });
    }

    return { results };
  }

  private static parseCountResponse(response: string): CountResponse {
    const lines = response.split('\n');
    const firstLine = lines[0];

    if (!firstLine.startsWith('OK COUNT ')) {
      throw new ProtocolError(`Invalid COUNT response: ${firstLine}`);
    }

    const count = parseInt(firstLine.split(' ')[2], 10);

    let debug: DebugInfo | undefined;
    const debugIndex = lines.indexOf('# DEBUG');
    if (debugIndex !== -1) {
      debug = NativeMygramClient.parseDebugInfo(lines.slice(debugIndex + 1));
    }

    return { count, debug };
  }

  private static parseDocumentResponse(response: string): Document {
    if (!response.startsWith('OK DOC ')) {
      throw new ProtocolError(`Invalid GET response: ${response}`);
    }

    const parts = response.substring(7).split(' ');
    const primaryKey = parts[0];
    const fields: Record<string, string> = {};

    parts.slice(1).forEach((part) => {
      const [key, value] = part.split('=');
      if (key && value) {
        fields[key] = value;
      }
    });

    return { primaryKey, fields };
  }

  private static parseInfoResponse(response: string): ServerInfo {
    if (!response.startsWith('OK INFO')) {
      throw new ProtocolError(`Invalid INFO response: ${response}`);
    }

    const lines = response.split('\n').slice(1);
    const info: Partial<ServerInfo> = {
      version: '',
      uptimeSeconds: 0,
      totalRequests: 0,
      activeConnections: 0,
      indexSizeBytes: 0,
      docCount: 0,
      tables: []
    };

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const [key, value] = trimmed.split(':').map((s) => s.trim());
      if (!key || !value) return;

      switch (key) {
        case 'version':
          info.version = value;
          break;
        case 'uptime_seconds':
          info.uptimeSeconds = parseInt(value, 10);
          break;
        case 'total_requests':
          info.totalRequests = parseInt(value, 10);
          break;
        case 'connected_clients':
          info.activeConnections = parseInt(value, 10);
          break;
        case 'used_memory_bytes':
          info.indexSizeBytes = parseInt(value, 10);
          break;
        case 'total_documents':
          info.docCount = parseInt(value, 10);
          break;
        case 'tables':
          info.tables = value.split(',').map((s) => s.trim());
          break;
        default:
          break;
      }
    });

    return info as ServerInfo;
  }

  /**
   * Parse REPLICATION STATUS response
   *
   * Handles both single-line format:
   *   OK REPLICATION status=running gtid=xxx
   * And multi-line format:
   *   OK REPLICATION
   *   status: running
   *   current_gtid: xxx
   *   processed_events: 123
   *   END
   */
  private static parseReplicationStatusResponse(response: string): ReplicationStatus {
    if (!response.startsWith('OK REPLICATION')) {
      throw new ProtocolError(`Invalid REPLICATION STATUS response: ${response}`);
    }

    const lines = response.split('\n');

    // Check if multi-line format (first line is just "OK REPLICATION")
    if (lines[0].trim() === 'OK REPLICATION') {
      // Multi-line format
      let running = false;
      let gtid = '';

      lines.slice(1).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'END') return;

        const colonIndex = trimmed.indexOf(':');
        if (colonIndex === -1) return;

        const key = trimmed.substring(0, colonIndex).trim();
        const value = trimmed.substring(colonIndex + 1).trim();

        switch (key) {
          case 'status':
            running = value === 'running';
            break;
          case 'current_gtid':
            gtid = value;
            break;
          default:
            break;
        }
      });

      return { running, gtid, statusStr: response };
    }

    // Single-line format: OK REPLICATION status=running gtid=xxx
    const parts = response.substring(15).split(' ');
    const statusPart = parts.find((p) => p.startsWith('status='));
    const gtidPart = parts.find((p) => p.startsWith('gtid='));

    const running = statusPart?.split('=')[1] === 'running';
    const gtid = gtidPart?.split('=')[1] || '';

    return { running, gtid, statusStr: response };
  }

  private static parseDebugInfo(lines: string[]): DebugInfo {
    const debug: Partial<DebugInfo> = {
      queryTimeMs: 0,
      indexTimeMs: 0,
      filterTimeMs: 0,
      terms: 0,
      ngrams: 0,
      candidates: 0,
      afterIntersection: 0,
      afterNot: 0,
      afterFilters: 0,
      final: 0,
      optimization: ''
    };

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      const [key, value] = trimmed.split(':').map((s) => s.trim());
      if (!key || !value) return;

      switch (key) {
        case 'query_time':
          debug.queryTimeMs = parseFloat(value);
          break;
        case 'index_time':
          debug.indexTimeMs = parseFloat(value);
          break;
        case 'filter_time':
          debug.filterTimeMs = parseFloat(value);
          break;
        case 'terms':
          debug.terms = parseInt(value, 10);
          break;
        case 'ngrams':
          debug.ngrams = parseInt(value, 10);
          break;
        case 'candidates':
          debug.candidates = parseInt(value, 10);
          break;
        case 'after_intersection':
          debug.afterIntersection = parseInt(value, 10);
          break;
        case 'after_not':
          debug.afterNot = parseInt(value, 10);
          break;
        case 'after_filters':
          debug.afterFilters = parseInt(value, 10);
          break;
        case 'final':
          debug.final = parseInt(value, 10);
          break;
        case 'optimization':
          debug.optimization = value;
          break;
        case 'limit':
          debug.limit = parseInt(value.replace('(default)', '').trim(), 10);
          break;
        case 'offset':
          debug.offset = parseInt(value.replace('(default)', '').trim(), 10);
          break;
        default:
          break;
      }
    });

    return debug as DebugInfo;
  }
}
