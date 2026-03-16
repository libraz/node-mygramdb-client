/**
 * MygramDB Client Types
 */

/**
 * Client configuration options
 */
export interface ClientConfig {
  /** Server hostname or IP address */
  host?: string;
  /** Server port number */
  port?: number;
  /**
   * Unix domain socket path for local connections
   *
   * When set, the client connects via Unix socket instead of TCP.
   * This bypasses TCP overhead and server-side rate limiting.
   *
   * @example '/tmp/mygramdb.sock'
   */
  socketPath?: string;
  /** Connection timeout in milliseconds */
  timeout?: number;
  /** Receive buffer size in bytes */
  recvBufferSize?: number;
  /** Maximum allowed query expression length (characters) */
  maxQueryLength?: number;
}

/**
 * Search result document
 */
export interface SearchResult {
  /** Document primary key */
  primaryKey: string;
}

/**
 * Document with filter fields
 */
export interface Document {
  /** Document primary key */
  primaryKey: string;
  /** Filter fields as key-value pairs */
  fields: Record<string, string>;
}

/**
 * Query debug information (when debug mode is enabled)
 */
export interface DebugInfo {
  /** Total query execution time in milliseconds */
  queryTimeMs: number;
  /** Index search time in milliseconds */
  indexTimeMs: number;
  /** Filter processing time in milliseconds */
  filterTimeMs: number;
  /** Number of search terms */
  terms: number;
  /** Number of n-grams generated */
  ngrams: number;
  /** Initial candidate count from index */
  candidates: number;
  /** Results after AND intersection */
  afterIntersection: number;
  /** Results after NOT filtering */
  afterNot: number;
  /** Results after FILTER conditions */
  afterFilters: number;
  /** Final result count before LIMIT/OFFSET */
  final: number;
  /** Optimization strategy used */
  optimization: string;
  /** Sort specification (e.g. "id DESC") */
  sort?: string;
  /** Cache status (hit, miss, disabled) */
  cache?: string;
  /** Cache age in milliseconds (for cache hits) */
  cacheAgeMs?: number;
  /** Time saved by cache hit in milliseconds */
  cacheSavedMs?: number;
  /** Limit value */
  limit?: number;
  /** Offset value */
  offset?: number;
}

/**
 * Search query response
 */
export interface SearchResponse {
  /** Array of search results */
  results: SearchResult[];
  /** Total count of matching documents */
  totalCount: number;
  /** Debug information (if debug mode enabled) */
  debug?: DebugInfo;
}

/**
 * Count query response
 */
export interface CountResponse {
  /** Total count of matching documents */
  count: number;
  /** Debug information (if debug mode enabled) */
  debug?: DebugInfo;
}

/**
 * Server information
 */
export interface ServerInfo {
  /** Server version */
  version: string;
  /** Server uptime in seconds */
  uptimeSeconds: number;
  /** Total requests processed */
  totalRequests: number;
  /** Active connections count */
  activeConnections: number;
  /** Index size in bytes */
  indexSizeBytes: number;
  /** Total document count */
  docCount: number;
  /** List of table names */
  tables: string[];
}

/**
 * Replication status
 */
export interface ReplicationStatus {
  /** Whether replication is running */
  running: boolean;
  /** Current GTID position */
  gtid: string;
  /** Raw status string */
  statusStr: string;
}

/**
 * Search options
 */
export interface SearchOptions {
  /** Maximum number of results to return */
  limit?: number;
  /** Result offset for pagination */
  offset?: number;
  /** Additional required terms (AND) */
  andTerms?: string[];
  /** Excluded terms (NOT) */
  notTerms?: string[];
  /** Filter conditions as key-value pairs */
  filters?: Record<string, string>;
  /** Column name for sorting (empty for primary key) */
  sortColumn?: string;
  /** Sort in descending order */
  sortDesc?: boolean;
}

/**
 * Count options
 */
export interface CountOptions {
  /** Additional required terms (AND) */
  andTerms?: string[];
  /** Excluded terms (NOT) */
  notTerms?: string[];
  /** Filter conditions as key-value pairs */
  filters?: Record<string, string>;
}

/**
 * Dump operation status
 */
export interface DumpStatus {
  /** Current status (saving, loading, idle, completed, failed) */
  status: string;
  /** File path of the dump */
  filepath: string;
  /** Total number of tables */
  tablesTotal: number;
  /** Number of tables processed */
  tablesProcessed: number;
  /** Currently processing table name */
  currentTable: string;
  /** Elapsed time in seconds */
  elapsedSeconds: number;
  /** Error message if status is failed */
  error?: string;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  /** Whether cache is enabled */
  enabled: boolean;
  /** Maximum cache memory in MB */
  maxMemoryMb: number;
  /** Current cache memory usage in MB */
  currentMemoryMb: number;
  /** Number of cached entries */
  entries: number;
  /** Cache hit count */
  hits: number;
  /** Cache miss count */
  misses: number;
  /** Cache hit rate percentage */
  hitRate: number;
  /** Number of cache evictions */
  evictions: number;
  /** Cache TTL in seconds */
  ttlSeconds: number;
}
