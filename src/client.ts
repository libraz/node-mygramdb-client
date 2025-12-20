/**
 * MygramDB Client Implementation
 */

import { Socket } from 'net';
import {
  ClientConfig,
  SearchResult,
  SearchResponse,
  CountResponse,
  Document,
  ServerInfo,
  ReplicationStatus,
  SearchOptions,
  CountOptions,
  DebugInfo
} from './types';
import { ConnectionError, ProtocolError, TimeoutError } from './errors';
import {
  DEFAULT_MAX_QUERY_LENGTH,
  ensureSafeCommandValue,
  ensureSafeFilters,
  ensureSafeStringArray,
  ensureQueryLengthWithinLimit
} from './command-utils';

const DEFAULT_CONFIG: Required<ClientConfig> = {
  host: '127.0.0.1',
  port: 11016,
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

      this.socket.connect(this.config.port, this.config.host);
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
      sortDesc = true
    } = options;

    const safeTable = ensureSafeCommandValue(table, 'table');
    const safeQuery = ensureSafeCommandValue(query, 'query');
    ensureSafeStringArray(andTerms, 'andTerms');
    ensureSafeStringArray(notTerms, 'notTerms');
    const safeFilters = ensureSafeFilters(filters);
    const safeSortColumn = sortColumn ? ensureSafeCommandValue(sortColumn, 'sortColumn') : '';

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

    // Add sort
    if (safeSortColumn) {
      parts.push('SORT', safeSortColumn, sortDesc ? 'DESC' : 'ASC');
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
      this.socket!.write(`${command}\r\n`);
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
      this.responseBuffer.startsWith('+OK\n')
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
    } else if (this.responseBuffer.includes('# DEBUG')) {
      // Debug response - wait for empty line after debug section
      if (this.isMultiLineResponseComplete()) {
        this.completeResponse();
      }
    } else if (lines.length > 1 && lines[lines.length - 1] === '') {
      // Single-line response with newline
      this.completeResponse();
    }
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
   * Parse SEARCH response
   */
  private static parseSearchResponse(response: string): SearchResponse {
    const lines = response.split('\n');
    const firstLine = lines[0];

    if (!firstLine.startsWith('OK RESULTS ')) {
      throw new ProtocolError(`Invalid SEARCH response: ${firstLine}`);
    }

    const parts = firstLine.split(' ');
    const totalCount = parseInt(parts[2], 10);
    const ids = parts.slice(3);

    const results: SearchResult[] = ids.map((id) => ({ primaryKey: id }));

    // Parse debug info if present
    let debug: DebugInfo | undefined;
    const debugIndex = lines.findIndex((line) => line === '# DEBUG');
    if (debugIndex !== -1) {
      debug = MygramClient.parseDebugInfo(lines.slice(debugIndex + 1));
    }

    return { results, totalCount, debug };
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
    const debugIndex = lines.findIndex((line) => line === '# DEBUG');
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
