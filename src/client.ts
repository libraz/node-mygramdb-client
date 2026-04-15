/**
 * MygramDB Client Implementation
 */

import { Socket } from 'node:net';
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
import { ConnectionError, ProtocolError, TimeoutError } from './errors.js';
import type {
  CacheStats,
  ClientConfig,
  CountOptions,
  CountResponse,
  DebugInfo,
  Document,
  DumpStatus,
  FacetOptions,
  FacetResponse,
  FacetValue,
  ReplicationStatus,
  SearchOptions,
  SearchResponse,
  SearchResult,
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
 * MygramDB client for Node.js
 *
 * This class provides a high-level interface for connecting to and
 * querying MygramDB servers using pure JavaScript (no C++ bindings).
 *
 * Example usage:
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
  private config: Required<ClientConfig>;
  private socket: Socket | null = null;
  private connected = false;
  private responseBuffer = '';
  private pendingResolve: ((value: string) => void) | null = null;
  private pendingReject: ((error: Error) => void) | null = null;
  private timeoutHandle: NodeJS.Timeout | null = null;

  /**
   * Create a new MygramDB client
   *
   * @param {ClientConfig} [config={}] - Client configuration
   */
  constructor(config: ClientConfig = {}) {
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

    return new Promise((resolve, reject) => {
      this.socket = new Socket();
      this.socket.setEncoding('utf8');
      this.socket.setTimeout(this.config.timeout);

      this.socket.on('connect', () => {
        this.connected = true;
        resolve();
      });

      this.socket.on('data', (data: string) => {
        this.handleData(data);
      });

      this.socket.on('error', (err: Error) => {
        this.connected = false;
        if (this.pendingReject) {
          this.pendingReject(new ConnectionError(err.message));
          this.clearPending();
        } else {
          reject(new ConnectionError(err.message));
        }
      });

      this.socket.on('timeout', () => {
        if (this.pendingReject) {
          this.pendingReject(new TimeoutError('Request timeout'));
          this.clearPending();
        }
        this.disconnect();
      });

      this.socket.on('close', () => {
        this.connected = false;
        if (this.pendingReject) {
          this.pendingReject(new ConnectionError('Connection closed'));
          this.clearPending();
        }
      });

      if (this.config.socketPath) {
        this.socket.connect({ path: this.config.socketPath });
      } else {
        this.socket.connect(this.config.port, this.config.host);
      }
    });
  }

  /**
   * Disconnect from server
   *
   * @returns {void}
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.clearPending();
  }

  /**
   * Check if connected to server
   *
   * @returns {boolean} True if connected, false otherwise
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Search for documents in a table
   *
   * @param {string} table - Table name to search in
   * @param {string} query - Search query text
   * @param {SearchOptions} [options={}] - Search options including limit, offset, andTerms, notTerms,
   *   filters, sortColumn, and sortDesc
   * @returns {Promise<SearchResponse>} Search response containing results array, totalCount, and
   *   optional debug info
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
    return MygramClient.parseSearchResponse(response);
  }

  /**
   * Count matching documents in a table
   *
   * @param {string} table - Table name to count documents in
   * @param {string} query - Search query text
   * @param {CountOptions} [options={}] - Count options including andTerms, notTerms, and filters
   * @returns {Promise<CountResponse>} Count response containing count and optional debug info
   * @throws {ConnectionError} If not connected to server
   * @throws {TimeoutError} If command times out
   * @throws {ProtocolError} If server returns an error
   */
  async count(table: string, query: string, options: CountOptions = {}): Promise<CountResponse> {
    const { andTerms = [], notTerms = [], filters = {} } = options;

    const safeTable = ensureSafeCommandValue(table, 'table');
    const safeQuery = ensureSafeCommandValue(query, 'query');
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

    const parts: string[] = ['COUNT', safeTable, safeQuery];

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

    const response = await this.sendCommand(parts.join(' '));
    return MygramClient.parseCountResponse(response);
  }

  /**
   * Get a document by its primary key
   *
   * @param {string} table - Table name to retrieve document from
   * @param {string} primaryKey - Primary key value of the document
   * @returns {Promise<Document>} Document object containing primaryKey and fields
   * @throws {ConnectionError} If not connected to server
   * @throws {TimeoutError} If command times out
   * @throws {ProtocolError} If server returns an error
   */
  async get(table: string, primaryKey: string): Promise<Document> {
    const safeTable = ensureSafeCommandValue(table, 'table');
    const safePrimaryKey = ensureSafeCommandValue(primaryKey, 'primaryKey');
    const response = await this.sendCommand(`GET ${safeTable} ${safePrimaryKey}`);
    return MygramClient.parseDocumentResponse(response);
  }

  /**
   * Get server information including version, uptime, and statistics
   *
   * @returns {Promise<ServerInfo>} Server information object
   * @throws {ConnectionError} If not connected to server
   * @throws {TimeoutError} If command times out
   * @throws {ProtocolError} If server returns an error
   */
  async info(): Promise<ServerInfo> {
    const response = await this.sendCommand('INFO');
    return MygramClient.parseInfoResponse(response);
  }

  /**
   * Get server configuration in YAML format
   *
   * @returns {Promise<string>} Configuration string in YAML format
   * @throws {ConnectionError} If not connected to server
   * @throws {TimeoutError} If command times out
   * @throws {ProtocolError} If server returns an error
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
   * Get current replication status including running state and GTID position
   *
   * @returns {Promise<ReplicationStatus>} Replication status object
   * @throws {ConnectionError} If not connected to server
   * @throws {TimeoutError} If command times out
   * @throws {ProtocolError} If server returns an error
   */
  async getReplicationStatus(): Promise<ReplicationStatus> {
    const response = await this.sendCommand('REPLICATION STATUS');
    return MygramClient.parseReplicationStatusResponse(response);
  }

  /**
   * Stop binlog replication (index becomes read-only)
   *
   * @returns {Promise<void>} Resolves when replication is stopped
   * @throws {ConnectionError} If not connected to server
   * @throws {TimeoutError} If command times out
   * @throws {ProtocolError} If server returns an error
   */
  async stopReplication(): Promise<void> {
    const response = await this.sendCommand('REPLICATION STOP');
    if (!response.startsWith('OK')) {
      throw new ProtocolError(`Failed to stop replication: ${response}`);
    }
  }

  /**
   * Start binlog replication
   *
   * @returns {Promise<void>} Resolves when replication is started
   * @throws {ConnectionError} If not connected to server
   * @throws {TimeoutError} If command times out
   * @throws {ProtocolError} If server returns an error
   */
  async startReplication(): Promise<void> {
    const response = await this.sendCommand('REPLICATION START');
    if (!response.startsWith('OK')) {
      throw new ProtocolError(`Failed to start replication: ${response}`);
    }
  }

  /**
   * Enable debug mode for this connection to receive detailed query metrics
   *
   * @returns {Promise<void>} Resolves when debug mode is enabled
   * @throws {ConnectionError} If not connected to server
   * @throws {TimeoutError} If command times out
   * @throws {ProtocolError} If server returns an error
   */
  async enableDebug(): Promise<void> {
    const response = await this.sendCommand('DEBUG ON');
    if (!response.startsWith('OK')) {
      throw new ProtocolError(`Failed to enable debug: ${response}`);
    }
  }

  /**
   * Disable debug mode for this connection
   *
   * @returns {Promise<void>} Resolves when debug mode is disabled
   * @throws {ConnectionError} If not connected to server
   * @throws {TimeoutError} If command times out
   * @throws {ProtocolError} If server returns an error
   */
  async disableDebug(): Promise<void> {
    const response = await this.sendCommand('DEBUG OFF');
    if (!response.startsWith('OK')) {
      throw new ProtocolError(`Failed to disable debug: ${response}`);
    }
  }

  /**
   * Save a dump of the index to the specified file path
   *
   * This operation is asynchronous on the server side. Use {@link dumpStatus}
   * to monitor progress.
   *
   * @param {string} filepath - File path on the server to save the dump
   * @returns {Promise<string>} The filepath where the dump is being saved
   * @throws {ConnectionError} If not connected to server
   * @throws {ProtocolError} If server returns an error
   */
  async dumpSave(filepath: string): Promise<string> {
    const safeFilepath = ensureSafeCommandValue(filepath, 'filepath');
    const response = await this.sendCommand(`DUMP SAVE ${safeFilepath}`);
    if (response.startsWith('OK DUMP_STARTED ')) {
      return response.substring('OK DUMP_STARTED '.length);
    }
    if (response.startsWith('OK DUMP_SAVED ')) {
      return response.substring('OK DUMP_SAVED '.length);
    }
    throw new ProtocolError(`Invalid DUMP SAVE response: ${response}`);
  }

  /**
   * Load a dump from the specified file path
   *
   * @param {string} filepath - File path on the server to load the dump from
   * @returns {Promise<void>} Resolves when the dump is loaded
   * @throws {ConnectionError} If not connected to server
   * @throws {ProtocolError} If server returns an error
   */
  async dumpLoad(filepath: string): Promise<void> {
    const safeFilepath = ensureSafeCommandValue(filepath, 'filepath');
    const response = await this.sendCommand(`DUMP LOAD ${safeFilepath}`);
    if (!response.startsWith('OK')) {
      throw new ProtocolError(`Failed to load dump: ${response}`);
    }
  }

  /**
   * Get the status of an ongoing dump operation
   *
   * @returns {Promise<DumpStatus>} Current dump operation status
   * @throws {ConnectionError} If not connected to server
   * @throws {ProtocolError} If server returns an error
   */
  async dumpStatus(): Promise<DumpStatus> {
    const response = await this.sendCommand('DUMP STATUS');
    return MygramClient.parseDumpStatusResponse(response);
  }

  /**
   * Verify the integrity of a dump file
   *
   * @param {string} filepath - File path of the dump to verify
   * @returns {Promise<string>} Verification result message
   * @throws {ConnectionError} If not connected to server
   * @throws {ProtocolError} If server returns an error
   */
  async dumpVerify(filepath: string): Promise<string> {
    const safeFilepath = ensureSafeCommandValue(filepath, 'filepath');
    const response = await this.sendCommand(`DUMP VERIFY ${safeFilepath}`);
    if (!response.startsWith('OK')) {
      throw new ProtocolError(`Failed to verify dump: ${response}`);
    }
    return response;
  }

  /**
   * Get metadata information about a dump file
   *
   * @param {string} filepath - File path of the dump to inspect
   * @returns {Promise<string>} Dump metadata as a string
   * @throws {ConnectionError} If not connected to server
   * @throws {ProtocolError} If server returns an error
   */
  async dumpInfo(filepath: string): Promise<string> {
    const safeFilepath = ensureSafeCommandValue(filepath, 'filepath');
    const response = await this.sendCommand(`DUMP INFO ${safeFilepath}`);
    if (!response.startsWith('OK')) {
      throw new ProtocolError(`Failed to get dump info: ${response}`);
    }
    return response;
  }

  /**
   * Get cache statistics
   *
   * @returns {Promise<CacheStats>} Cache statistics
   * @throws {ConnectionError} If not connected to server
   * @throws {ProtocolError} If server returns an error
   */
  async cacheStats(): Promise<CacheStats> {
    const response = await this.sendCommand('CACHE STATS');
    return MygramClient.parseCacheStatsResponse(response);
  }

  /**
   * Clear the query cache
   *
   * @param {string} [table] - Optional table name to clear cache for; clears all if omitted
   * @returns {Promise<void>} Resolves when cache is cleared
   * @throws {ConnectionError} If not connected to server
   * @throws {ProtocolError} If server returns an error
   */
  async cacheClear(table?: string): Promise<void> {
    const command = table ? `CACHE CLEAR ${ensureSafeCommandValue(table, 'table')}` : 'CACHE CLEAR';
    const response = await this.sendCommand(command);
    if (!response.startsWith('OK')) {
      throw new ProtocolError(`Failed to clear cache: ${response}`);
    }
  }

  /**
   * Enable the query cache
   *
   * @returns {Promise<void>} Resolves when cache is enabled
   * @throws {ConnectionError} If not connected to server
   * @throws {ProtocolError} If server returns an error
   */
  async cacheEnable(): Promise<void> {
    const response = await this.sendCommand('CACHE ENABLE');
    if (!response.startsWith('OK')) {
      throw new ProtocolError(`Failed to enable cache: ${response}`);
    }
  }

  /**
   * Disable the query cache
   *
   * @returns {Promise<void>} Resolves when cache is disabled
   * @throws {ConnectionError} If not connected to server
   * @throws {ProtocolError} If server returns an error
   */
  async cacheDisable(): Promise<void> {
    const response = await this.sendCommand('CACHE DISABLE');
    if (!response.startsWith('OK')) {
      throw new ProtocolError(`Failed to disable cache: ${response}`);
    }
  }

  /**
   * Optimize (rebuild) the index for a table or all tables
   *
   * @param {string} [table] - Optional table name to optimize; optimizes all if omitted
   * @returns {Promise<void>} Resolves when optimization completes
   * @throws {ConnectionError} If not connected to server
   * @throws {ProtocolError} If server returns an error
   */
  async optimize(table?: string): Promise<void> {
    const command = table ? `OPTIMIZE ${ensureSafeCommandValue(table, 'table')}` : 'OPTIMIZE';
    const response = await this.sendCommand(command);
    if (!response.startsWith('OK')) {
      throw new ProtocolError(`Failed to optimize: ${response}`);
    }
  }

  /**
   * Aggregate distinct filter-column values with document counts (MygramDB v1.6+).
   *
   * When `options.query` is empty, FACET returns the distinct values
   * across the entire table. When provided, the aggregation is scoped
   * to documents matching the query (with optional AND/NOT/FILTER refinements).
   *
   * @param {string} table - Table name
   * @param {string} column - Filter column to aggregate
   * @param {FacetOptions} [options={}] - Optional query, refinements and limit
   * @returns {Promise<FacetResponse>} Facet values with document counts
   * @throws {ConnectionError} If not connected to server
   * @throws {TimeoutError} If command times out
   * @throws {ProtocolError} If server returns an error
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
    return MygramClient.parseFacetResponse(response);
  }

  /**
   * Send raw command to server
   *
   * This is a low-level interface for sending custom commands.
   * Most users should use the higher-level methods instead.
   *
   * @param {string} command - Command string (without \r\n terminator)
   * @returns {Promise<string>} Response string from server
   * @throws {ConnectionError} If not connected to server
   * @throws {TimeoutError} If command times out
   * @throws {ProtocolError} If server returns an error
   */
  async sendCommand(command: string): Promise<string> {
    if (!this.connected || !this.socket) {
      throw new ConnectionError('Not connected to server');
    }

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      // Set timeout
      this.timeoutHandle = setTimeout(() => {
        this.clearPending();
        reject(new TimeoutError('Command timeout'));
      }, this.config.timeout);

      // Send command
      this.socket?.write(`${command}\r\n`);
    });
  }

  /**
   * Check if buffer contains a complete multi-line response
   * Handles both LF (\n) and CRLF (\r\n) line endings, including buggy patterns
   */
  private isMultiLineResponseComplete(): boolean {
    return (
      this.responseBuffer.endsWith('\n\n') ||
      this.responseBuffer.endsWith('\r\n\r\n') ||
      this.responseBuffer.endsWith('\n\r\n') // Server bug workaround
    );
  }

  /**
   * Handle incoming data from server
   */
  private handleData(data: string): void {
    this.responseBuffer += data;

    // Check if we have a complete response
    // Multi-line responses end with empty line or single-line with \n
    const lines = this.responseBuffer.split('\n');

    // Check for complete response
    if (
      this.responseBuffer.includes('OK INFO\n') ||
      this.responseBuffer.includes('OK CONFIG\n') ||
      this.responseBuffer.startsWith('+OK\n') ||
      this.responseBuffer.includes('OK DUMP_STATUS\n') ||
      this.responseBuffer.includes('OK CACHE_STATS\n')
    ) {
      // Multi-line response
      if (this.isMultiLineResponseComplete()) {
        this.completeResponse();
      }
    } else if (this.responseBuffer.startsWith('OK REPLICATION\n')) {
      // Multi-line REPLICATION response - wait for END marker
      if (this.responseBuffer.includes('\nEND\n') || this.responseBuffer.endsWith('\nEND')) {
        this.completeResponse();
      }
    } else if (this.responseBuffer.startsWith('OK FACET ') || this.responseBuffer.startsWith('OK FACET\r')) {
      // FACET response (MygramDB v1.6+) - multi-line, terminated by blank line
      if (this.isMultiLineResponseComplete()) {
        this.completeResponse();
      }
    } else if (this.responseBuffer.includes('# DEBUG')) {
      // Debug response - wait for empty line after debug section
      if (this.isMultiLineResponseComplete()) {
        this.completeResponse();
      }
    } else if (this.responseBuffer.startsWith('OK RESULTS ') && this.bufferHasHighlightRows()) {
      // HIGHLIGHT response (MygramDB v1.6+) - multi-line; terminated by blank line
      if (this.isMultiLineResponseComplete()) {
        this.completeResponse();
      }
    } else if (lines.length > 1 && lines[lines.length - 1] === '') {
      // Single-line response with newline
      this.completeResponse();
    }
  }

  /**
   * Detect HIGHLIGHT-mode SEARCH responses by checking for tab-prefixed
   * payload lines after the count line. Classic single-line responses
   * never contain tabs.
   */
  private bufferHasHighlightRows(): boolean {
    const firstLineEnd = this.responseBuffer.indexOf('\n');
    if (firstLineEnd < 0) return false;
    const rest = this.responseBuffer.slice(firstLineEnd + 1);
    return rest.includes('\t');
  }

  /**
   * Complete pending response
   */
  private completeResponse(): void {
    if (this.pendingResolve) {
      // Normalize CRLF to LF for consistent parsing
      const response = this.responseBuffer.replace(/\r\n/g, '\n').trim();
      this.responseBuffer = '';

      if (response.startsWith('ERROR ')) {
        const error = response.substring(6);
        if (this.pendingReject) {
          this.pendingReject(new ProtocolError(error));
        }
      } else {
        this.pendingResolve(response);
      }

      this.clearPending();
    }
  }

  /**
   * Clear pending promise handlers and timeout
   */
  private clearPending(): void {
    this.pendingResolve = null;
    this.pendingReject = null;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  /**
   * Parse SEARCH response.
   *
   * Two formats are supported:
   *
   * 1. Classic (single-line):
   *    `OK RESULTS <total_count> <id1> <id2> ...`
   *
   * 2. HIGHLIGHT (multi-line, MygramDB v1.6+):
   *    ```
   *    OK RESULTS <total_count>
   *    <id1>\t<snippet1>
   *    <id2>\t<snippet2>
   *    ...
   *    ```
   *
   * Either format may be followed by a `# DEBUG` block.
   */
  private static parseSearchResponse(response: string): SearchResponse {
    const lines = response.split('\n');
    const firstLine = lines[0];

    if (!firstLine.startsWith('OK RESULTS ')) {
      throw new ProtocolError(`Invalid SEARCH response: ${firstLine}`);
    }

    const headerParts = firstLine.split(' ');
    const totalCount = parseInt(headerParts[2], 10);

    // Collect payload lines that precede an optional # DEBUG block.
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
      // HIGHLIGHT mode: each payload line is "<pk>[\t<snippet>]".
      results = payloadLines.map((line) => {
        const tab = line.indexOf('\t');
        if (tab < 0) {
          return { primaryKey: line, snippet: '' };
        }
        return { primaryKey: line.slice(0, tab), snippet: line.slice(tab + 1) };
      });
    } else {
      // Classic mode: PKs follow the count on the first line.
      const ids = headerParts.slice(3);
      results = ids.map((id) => ({ primaryKey: id }));
    }

    let debug: DebugInfo | undefined;
    if (debugIndex !== -1) {
      debug = MygramClient.parseDebugInfo(lines.slice(debugIndex + 1));
    }

    return { results, totalCount, debug };
  }

  /**
   * Parse FACET response (MygramDB v1.6+).
   *
   * Format:
   * ```
   * OK FACET <num_values>
   * <value1>\t<count1>
   * <value2>\t<count2>
   * ...
   * ```
   * Lines starting with `#` (debug/comment) are ignored.
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

  /**
   * Parse COUNT response
   */
  private static parseCountResponse(response: string): CountResponse {
    const lines = response.split('\n');
    const firstLine = lines[0];

    if (!firstLine.startsWith('OK COUNT ')) {
      throw new ProtocolError(`Invalid COUNT response: ${firstLine}`);
    }

    const count = parseInt(firstLine.split(' ')[2], 10);

    // Parse debug info if present
    let debug: DebugInfo | undefined;
    const debugIndex = lines.indexOf('# DEBUG');
    if (debugIndex !== -1) {
      debug = MygramClient.parseDebugInfo(lines.slice(debugIndex + 1));
    }

    return { count, debug };
  }

  /**
   * Parse GET response
   */
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

  /**
   * Parse INFO response
   */
  private static parseInfoResponse(response: string): ServerInfo {
    if (!response.startsWith('OK INFO')) {
      throw new ProtocolError(`Invalid INFO response: ${response}`);
    }

    const lines = response.split('\n').slice(1); // Skip "OK INFO" line
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

  /**
   * Parse debug info from response lines
   */
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
        case 'sort':
          debug.sort = value;
          break;
        case 'cache':
          debug.cache = value;
          break;
        case 'cache_age_ms':
          debug.cacheAgeMs = parseFloat(value);
          break;
        case 'cache_saved_ms':
          debug.cacheSavedMs = parseFloat(value);
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

  /**
   * Parse DUMP STATUS response
   */
  private static parseDumpStatusResponse(response: string): DumpStatus {
    if (!response.startsWith('OK DUMP_STATUS')) {
      throw new ProtocolError(`Invalid DUMP STATUS response: ${response}`);
    }

    const status: Partial<DumpStatus> = {
      status: 'idle',
      filepath: '',
      tablesTotal: 0,
      tablesProcessed: 0,
      currentTable: '',
      elapsedSeconds: 0
    };

    const lines = response.split('\n').slice(1);
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) return;

      const key = trimmed.substring(0, colonIndex).trim();
      const value = trimmed.substring(colonIndex + 1).trim();

      switch (key) {
        case 'status':
          status.status = value;
          break;
        case 'filepath':
          status.filepath = value;
          break;
        case 'tables_total':
          status.tablesTotal = parseInt(value, 10);
          break;
        case 'tables_processed':
          status.tablesProcessed = parseInt(value, 10);
          break;
        case 'current_table':
          status.currentTable = value;
          break;
        case 'elapsed_seconds':
          status.elapsedSeconds = parseFloat(value);
          break;
        case 'error':
          status.error = value;
          break;
        default:
          break;
      }
    });

    return status as DumpStatus;
  }

  /**
   * Parse CACHE STATS response
   */
  private static parseCacheStatsResponse(response: string): CacheStats {
    if (!response.startsWith('OK CACHE_STATS')) {
      throw new ProtocolError(`Invalid CACHE STATS response: ${response}`);
    }

    const stats: Partial<CacheStats> = {
      enabled: false,
      maxMemoryMb: 0,
      currentMemoryMb: 0,
      entries: 0,
      hits: 0,
      misses: 0,
      hitRate: 0,
      evictions: 0,
      ttlSeconds: 0
    };

    const lines = response.split('\n').slice(1);
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) return;

      const key = trimmed.substring(0, colonIndex).trim();
      const value = trimmed.substring(colonIndex + 1).trim();

      switch (key) {
        case 'enabled':
          stats.enabled = value === 'true';
          break;
        case 'max_memory_mb':
          stats.maxMemoryMb = parseFloat(value);
          break;
        case 'current_memory_mb':
          stats.currentMemoryMb = parseFloat(value);
          break;
        case 'entries':
          stats.entries = parseInt(value, 10);
          break;
        case 'hits':
          stats.hits = parseInt(value, 10);
          break;
        case 'misses':
          stats.misses = parseInt(value, 10);
          break;
        case 'hit_rate':
          stats.hitRate = parseFloat(value.replace('%', ''));
          break;
        case 'evictions':
          stats.evictions = parseInt(value, 10);
          break;
        case 'ttl_seconds':
          stats.ttlSeconds = parseInt(value, 10);
          break;
        default:
          break;
      }
    });

    return stats as CacheStats;
  }
}
