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
  /**
   * Deadline for one ordinary command in milliseconds. Default: 5000.
   *
   * Long-running administrative operations have their own deadlines below,
   * because a dump or an optimize can legitimately outrun a request timeout.
   */
  timeout?: number;
  /**
   * Deadline for establishing the connection, in milliseconds. Covers the
   * socket handshake and, when {@link adminToken} is set, the `AUTH` that
   * follows it. Defaults to {@link timeout}.
   */
  connectTimeout?: number;
  /**
   * Deadline for `DUMP SAVE`, in milliseconds. Defaults to 600000 (10 minutes).
   */
  dumpSaveTimeout?: number;
  /**
   * Deadline for `DUMP LOAD`, in milliseconds. Defaults to 600000 (10 minutes).
   */
  dumpLoadTimeout?: number;
  /**
   * Deadline for `DUMP VERIFY`, in milliseconds. Defaults to 600000 (10 minutes).
   */
  dumpVerifyTimeout?: number;
  /**
   * Deadline for `OPTIMIZE`, in milliseconds. Defaults to 600000 (10 minutes).
   */
  optimizeTimeout?: number;
  /** Receive buffer size in bytes */
  recvBufferSize?: number;
  /**
   * Largest single response frame the client will hold, in bytes.
   * Default: 67108864 (64 MiB).
   *
   * A frame that grows past this cannot be trusted or resynchronized, so the
   * connection is closed and the pending command rejected with a
   * {@link ../errors.ProtocolError}.
   */
  maxResponseBytes?: number;
  /** Maximum allowed query expression length (characters) */
  maxQueryLength?: number;
  /**
   * Reconnect once and resend when the socket is found dead before a command is
   * written to the wire (pure-JavaScript transport only). A failure that occurs
   * after the command has been written is surfaced as a {@link ConnectionError}
   * without resending, since the command may already have been applied
   * server-side. The native binding does not honour this flag. Default: false.
   */
  autoReconnect?: boolean;
  /**
   * Administrative token sent as `AUTH <token>` immediately after the
   * connection is established (MygramDB v1.10+).
   *
   * A v1.10 server gates administrative commands — `DUMP *`, `REPLICATION *`,
   * `SYNC *`, `CONFIG *`, `OPTIMIZE`, `DEBUG *`, `CACHE *`, `SET` and
   * `SHOW VARIABLES` — behind an `AUTH` issued on the same TCP connection, and
   * refuses to start when the listener is not loopback and no token is
   * configured. Setting this makes the client authenticate on every connect,
   * including a reconnect performed by {@link ClientConfig.autoReconnect} and
   * every connection a {@link ../pool.MygramPool} opens.
   *
   * Ordinary SEARCH / COUNT / GET / FACET / INFO traffic never needs a token.
   * The TCP transport does not encrypt it, so keep that listener on a trusted
   * network or behind a terminating proxy.
   */
  adminToken?: string;
}

/**
 * Comparison operator for a FILTER clause (MygramDB v1.9+).
 *
 * Earlier servers accepted equality only. `<>` is an accepted spelling of `!=`.
 */
export type FilterOperator = '=' | '!=' | '<>' | '>' | '>=' | '<' | '<=';

/**
 * A single FILTER condition with an explicit comparison operator.
 *
 * Use the array form of {@link SearchOptions.filters} when the same column
 * needs more than one condition, e.g. a bounded range.
 *
 * @example
 * ```typescript
 * // price >= 100 AND price <= 500
 * filters: [
 *   { column: 'price', op: '>=', value: '100' },
 *   { column: 'price', op: '<=', value: '500' }
 * ]
 * ```
 */
export interface FilterCondition {
  /** Filter column name */
  column: string;
  /** Comparison operator; defaults to `=` when omitted */
  op?: FilterOperator;
  /** Value to compare against */
  value: string;
}

/**
 * Value side of the record form of {@link SearchOptions.filters}: either a bare
 * string (equality) or an operator/value pair.
 */
export type FilterValue = string | { op: FilterOperator; value: string };

/**
 * FILTER clauses, in either of two shapes.
 *
 * - A record keyed by column: `{ status: 'active', price: { op: '>=', value: '100' } }`.
 *   Concise, but holds at most one condition per column.
 * - An array of {@link FilterCondition}: required when a column carries two
 *   conditions, such as a range.
 */
export type FilterSpec = Record<string, FilterValue> | FilterCondition[];

/**
 * How the server should interpret the search text (MygramDB v1.9+).
 *
 * - `literal` (default) — the text is a phrase. Reserved words such as `AND`,
 *   `OR` and `NOT` are quoted so they match as ordinary terms.
 * - `boolean` — the text is an expression. `AND`/`OR`/`NOT` and parentheses are
 *   interpreted by the server's expression parser.
 *
 * Literal is the default on every surface, so `alpha AND beta` keeps its
 * meaning when an application moves between the TCP, HTTP and typed clients.
 */
export type QueryMode = 'literal' | 'boolean';

/**
 * Search result document
 */
export interface SearchResult {
  /** Document primary key */
  primaryKey: string;
  /**
   * Highlighted snippet (HIGHLIGHT clause, MygramDB v1.6+)
   *
   * Present only when the search request enabled highlighting via
   * {@link SearchOptions.highlight}. Empty string when no snippet
   * was produced for this document.
   */
  snippet?: string;
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
  /**
   * Whether every configured table has completed its initial data load
   * (MygramDB v1.10+). Undefined when the server does not report it.
   */
  dataInitialized?: boolean;
  /**
   * Whether the server is ready to serve queries (MygramDB v1.10+), evaluated
   * from the same inputs as the HTTP health endpoint. Undefined when the server
   * does not report it.
   */
  ready?: boolean;
}

/**
 * Replication status
 */
/**
 * Replication state reported by `REPLICATION STATUS`.
 *
 * `failed` is distinct from `stopped`: the reader stopped on an error rather
 * than on request, and {@link ReplicationStatus.lastError} explains why.
 * `not_configured` means the server runs without a binlog reader at all.
 */
export type ReplicationState = 'running' | 'stopped' | 'failed' | 'not_configured';

export interface ReplicationStatus {
  /** Whether replication is running */
  running: boolean;
  /** Current GTID position */
  gtid: string;
  /** Raw status string */
  statusStr: string;
  /**
   * Reported state, which separates a failure from a requested stop.
   *
   * Undefined for the single-line legacy response format. An unrecognized
   * value is passed through rather than dropped, so a future server state is
   * still visible.
   */
  state?: ReplicationState;
  /**
   * Binlog events whose checksum did not verify (MygramDB v1.10+).
   */
  crcErrors?: number;
  /**
   * Whether replication stopped because the MySQL schema no longer matches the
   * configured columns (MygramDB v1.10+).
   */
  schemaIncompatible?: boolean;
  /**
   * Error code of the last replication failure (MygramDB v1.10+), from the same
   * table as {@link ../error-codes.ErrorCode}. Unset while no failure is
   * recorded, and cleared by the server once a start succeeds.
   */
  lastErrorCode?: number;
  /**
   * Message for {@link lastErrorCode} (MygramDB v1.10+). Unset when empty.
   */
  lastError?: string;
  /**
   * Unix time at which the last event was applied (MygramDB v1.10+). Stamped
   * where the replication position advances, so it tracks real progress rather
   * than mere connectivity.
   */
  lastAppliedUnixtime?: number;
  /**
   * Seconds since {@link lastAppliedUnixtime} (MygramDB v1.10+); the replication
   * lag to alert on.
   */
  secondsSinceLastApplied?: number;
  /**
   * Number of replication events processed so far.
   *
   * Available in MygramDB v1.6+ multi-line REPLICATION STATUS responses.
   * Undefined when the server omits the field (older protocol or
   * single-line legacy format).
   */
  processedEvents?: number;
  /**
   * Current size of the replication queue (only present while running).
   *
   * Available in MygramDB v1.6+ multi-line REPLICATION STATUS responses
   * when the binlog reader is running. Undefined otherwise.
   */
  queueSize?: number;
}

/**
 * HIGHLIGHT clause options (MygramDB v1.6+)
 *
 * When supplied to {@link SearchOptions.highlight}, the server returns
 * highlighted snippets in {@link SearchResult.snippet}. Pass an empty
 * object (`{}`) to use server defaults (`<em>`/`</em>`, 100-codepoint
 * snippet, up to 3 fragments).
 */
export interface HighlightOptions {
  /** Opening tag for highlighted spans (must be set together with closeTag) */
  openTag?: string;
  /** Closing tag for highlighted spans (must be set together with openTag) */
  closeTag?: string;
  /** Snippet length in code points (1..10000); 0 keeps server default */
  snippetLen?: number;
  /** Maximum number of fragments per document (1..100); 0 keeps server default */
  maxFragments?: number;
}

/**
 * Search options
 */
export interface SearchOptions {
  /**
   * How the server interprets `query` (MygramDB v1.9+). Defaults to `literal`.
   *
   * Set `boolean` to combine an expression such as `alpha AND (xqz OR jkv)`
   * with the typed clauses below — filters, sorting, fuzzy matching and
   * highlighting. {@link MygramClient.searchRaw} remains the compact
   * expression-only entry point that takes no such clauses.
   */
  queryMode?: QueryMode;
  /** Maximum number of results to return */
  limit?: number;
  /** Result offset for pagination */
  offset?: number;
  /** Additional required terms (AND) */
  andTerms?: string[];
  /** Excluded terms (NOT) */
  notTerms?: string[];
  /**
   * FILTER conditions. A plain `{ column: value }` record filters on equality;
   * pass `{ op, value }` or the {@link FilterCondition} array form to use the
   * comparison operators added in MygramDB v1.9.
   */
  filters?: FilterSpec;
  /**
   * Column name for sorting.
   *
   * Use the special column name `_score` to sort by BM25 relevance
   * (MygramDB v1.6+, requires `verify_text: ascii|all` on the server).
   * Empty string sorts by primary key.
   */
  sortColumn?: string;
  /** Sort in descending order */
  sortDesc?: boolean;
  /**
   * Fuzzy search edit distance (MygramDB v1.6+).
   *
   * - 0 (or omitted) - exact match
   * - 1 - allow up to 1 edit (Levenshtein)
   * - 2 - allow up to 2 edits
   */
  fuzzy?: number;
  /**
   * HIGHLIGHT clause options (MygramDB v1.6+).
   *
   * When set, the server returns matching snippets in
   * {@link SearchResult.snippet}. Pass an empty object to use defaults.
   */
  highlight?: HighlightOptions;
}

/**
 * Options for {@link MygramClient.searchRaw} (MygramDB v1.7+).
 *
 * Unlike {@link SearchOptions}, a raw search sends a pre-built boolean
 * expression as a single token, so it exposes only pagination and highlight
 * controls — AND/NOT/FILTER refinements belong inside the expression itself.
 */
export interface SearchRawOptions {
  /** Maximum number of results to return (0 = server default) */
  limit?: number;
  /** Result offset for pagination */
  offset?: number;
  /**
   * HIGHLIGHT clause options. Pass an empty object (`{}`) to enable
   * highlighting with server defaults.
   */
  highlight?: HighlightOptions;
}

/**
 * Count options
 */
export interface CountOptions {
  /**
   * How the server interprets `query` (MygramDB v1.9+). Defaults to `literal`.
   */
  queryMode?: QueryMode;
  /** Additional required terms (AND) */
  andTerms?: string[];
  /** Excluded terms (NOT) */
  notTerms?: string[];
  /**
   * FILTER conditions. A plain `{ column: value }` record filters on equality;
   * pass `{ op, value }` or the {@link FilterCondition} array form to use the
   * comparison operators added in MygramDB v1.9.
   */
  filters?: FilterSpec;
}

/**
 * Dump operation status
 */
export interface DumpStatus {
  /**
   * Current status, uppercase as reported by the server: `IDLE`, `SAVING`,
   * `LOADING`, `COMPLETED` or `FAILED`. A server running without progress
   * tracking reports `SAVE_IN_PROGRESS` / `LOAD_IN_PROGRESS` / `IDLE` instead.
   */
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
  /** Whether a `DUMP SAVE` is running right now */
  saveInProgress: boolean;
  /** Whether a `DUMP LOAD` is running right now */
  loadInProgress: boolean;
  /**
   * Whether replication is paused to hold the index still for the dump.
   * Replication resumes on its own when the dump finishes.
   */
  replicationPausedForDump: boolean;
  /** Path actually written, reported once a save completes */
  resultFilepath?: string;
}

/**
 * FACET options (MygramDB v1.6+).
 *
 * When `query` is empty, FACET returns the distinct values across the
 * entire table. When `query` is provided, the aggregation is scoped to
 * the matching documents (with optional AND/NOT/FILTER refinements).
 */
export interface FacetOptions {
  /** Optional query to scope aggregation to matching documents */
  query?: string;
  /**
   * How the server interprets `query` (MygramDB v1.9+). Defaults to `literal`.
   */
  queryMode?: QueryMode;
  /** Additional required terms (AND) */
  andTerms?: string[];
  /** Excluded terms (NOT) */
  notTerms?: string[];
  /**
   * FILTER conditions. A plain `{ column: value }` record filters on equality;
   * pass `{ op, value }` or the {@link FilterCondition} array form to use the
   * comparison operators added in MygramDB v1.9.
   */
  filters?: FilterSpec;
  /** Maximum number of facet values to return (0 = no limit) */
  limit?: number;
  /**
   * Number of distinct values to skip before the returned page
   * (MygramDB v1.9+). Use with `limit` to page through facet values;
   * {@link FacetResponse.totalCount} reports how many exist in total.
   */
  offset?: number;
}

/**
 * A single FACET value with its document count.
 */
export interface FacetValue {
  /** Distinct value of the facet column */
  value: string;
  /** Number of documents holding this value */
  count: number;
}

/**
 * FACET response.
 */
export interface FacetResponse {
  /** Facet values in the returned page, in server-defined order */
  results: FacetValue[];
  /**
   * Number of distinct values before OFFSET and LIMIT (MygramDB v1.10+).
   *
   * Against an older server, which does not report a total, this falls back to
   * `results.length`.
   */
  totalCount: number;
}

/**
 * Query cache statistics reported by `CACHE STATS`.
 *
 * The maximum cache size and the TTL are configuration, not statistics, and
 * are not part of this response; read them from `SHOW VARIABLES` or from the
 * `cache_ttl_seconds` field of `INFO`.
 */
export interface CacheStats {
  /** Whether the cache is currently enabled */
  enabled: boolean;
  /** Queries that consulted the cache, whether they hit or missed */
  totalQueries: number;
  /** Cache hit count */
  hits: number;
  /** Cache miss count */
  misses: number;
  /** Hit ratio in the range 0–1 (not a percentage) */
  hitRate: number;
  /** Number of cached entries */
  entries: number;
  /** Memory held by cached entries, in bytes */
  currentMemoryBytes: number;
  /** {@link currentMemoryBytes} expressed in MB, for display */
  currentMemoryMb: number;
  /** Memory held by the invalidation reverse indexes, in bytes */
  invalidationIndexMemoryBytes: number;
  /** Memory held by pending and in-flight invalidations, in bytes (MygramDB v1.10+) */
  invalidationQueueMemoryBytes: number;
  /** Total memory charged against the cache budget, in bytes */
  accountedMemoryBytes: number;
  /** Entries evicted to stay within the capacity or memory budget */
  evictions: number;
  /** Entries dropped because their TTL expired */
  ttlExpirations: number;
  /** Insertions refused, for any reason */
  rejections: number;
  /** Insertions refused because the entry exceeded the per-entry size limit */
  rejectionOversize: number;
  /** Insertions refused because the memory budget was exhausted */
  rejectionMemoryBudget: number;
  /** Insertions refused because an equivalent entry was already present */
  rejectionDuplicate: number;
  /** Entries removed after failing a staleness check */
  staleEntryRemovals: number;
  /** Entries discarded because their payload could not be decompressed */
  decompressionFailures: number;
  /** LRU list nodes pointing at entries that are already gone */
  staleLruEntries: number;
  /** Invalidations applied on the row event itself */
  invalidationsImmediate: number;
  /** Invalidations queued for the background worker */
  invalidationsDeferred: number;
  /** Batches the background worker processed */
  invalidationsBatches: number;
  /** Mean time to serve a hit, in milliseconds; undefined until the first hit */
  avgHitTimeMs?: number;
  /** Mean time to serve a miss, in milliseconds; undefined until the first miss */
  avgMissTimeMs?: number;
  /** Execution time avoided by serving hits, in milliseconds */
  totalTimeSavedMs: number;
}
