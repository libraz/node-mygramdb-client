# API Reference

Complete API reference for mygramdb-client.

## MygramClient Class

The main client class for interacting with MygramDB.

### Constructor

```typescript
new MygramClient(config?: ClientConfig)
```

Creates a new MygramDB client instance.

**Parameters:**
- `config` (ClientConfig, optional) - Client configuration options

**Example:**
```typescript
const client = new MygramClient({
  host: 'localhost',
  port: 11016,
  timeout: 5000,
});
```

## Connection Methods

### connect()

```typescript
async connect(): Promise<void>
```

Establishes a connection to the MygramDB server.

**Returns:** Promise that resolves when connected

**Throws:**
- `ConnectionError` - If connection fails
- `TimeoutError` - If connection times out

**Example:**
```typescript
await client.connect();
```

### disconnect()

```typescript
disconnect(): void
```

Closes the connection to the server.

**Example:**
```typescript
client.disconnect();
```

### isConnected()

```typescript
isConnected(): boolean
```

Checks if the client is currently connected.

**Returns:** `true` if connected, `false` otherwise

**Example:**
```typescript
if (client.isConnected()) {
  console.log('Client is connected');
}
```

## Search Methods

### search()

```typescript
async search(
  table: string,
  query: string,
  options?: SearchOptions
): Promise<SearchResponse>
```

Searches for documents in the specified table. Multi-word queries are quoted
automatically so they reach the server as a single phrase token; use
[`searchRaw()`](#searchraw) for boolean `AND`/`OR`/`NOT`/grouping expressions.

**Parameters:**
- `table` (string) - Name of the table to search. In a MygramDB v1.7+
  multi-database deployment, pass a `database.table` identity (e.g.
  `app_db.articles`); a bare name still works for single-database servers.
- `query` (string) - Search query text
- `options` (SearchOptions, optional) - Search options

**Returns:** Promise resolving to SearchResponse

**Throws:**
- `InputValidationError` - If the query contains control characters or exceeds the configured length limit
- `ConnectionError` - If not connected
- `TimeoutError` - If request times out
- `ProtocolError` - If server returns an error

**Example:**
```typescript
const results = await client.search('articles', 'golang tutorial', {
  limit: 50,
  offset: 0,
  andTerms: ['beginner'],
  notTerms: ['advanced'],
  filters: { status: '1', category: 'tech' },
  sortColumn: 'created_at',
  sortDesc: true,
});

console.log(`Found ${results.totalCount} results`);
results.results.forEach((result) => {
  console.log(`ID: ${result.primaryKey}`);
});
```

### searchWithHighlights()

```typescript
async searchWithHighlights(
  table: string,
  query: string,
  options?: SearchOptions
): Promise<SearchResponse>
```

The same call as [`search()`](#search) with the `HIGHLIGHT` clause enabled. Any
`highlight` options passed in `options` are preserved; otherwise server defaults
are used (`<em>`/`</em>`, 100 code points, up to 3 fragments). Snippets are
returned in `result.snippet`.

**Example:**
```typescript
const results = await client.searchWithHighlights('articles', 'golang', {
  highlight: { openTag: '<strong>', closeTag: '</strong>' },
});
for (const r of results.results) {
  console.log(r.primaryKey, r.snippet);
}
```

### count()

```typescript
async count(
  table: string,
  query: string,
  options?: CountOptions
): Promise<CountResponse>
```

Counts matching documents without retrieving their IDs.

**Parameters:**
- `table` (string) - Name of the table to search
- `query` (string) - Search query text
- `options` (CountOptions, optional) - Count options

**Returns:** Promise resolving to CountResponse

**Throws:**
- `InputValidationError` - If the query contains control characters or exceeds the configured length limit
- `ConnectionError` - If not connected
- `TimeoutError` - If request times out
- `ProtocolError` - If server returns an error

**Example:**
```typescript
const count = await client.count('articles', 'machine learning', {
  filters: { status: '1' },
});
console.log(`Total matches: ${count.count}`);
```

### searchRaw()

```typescript
async searchRaw(
  table: string,
  rawQuery: string,
  options?: SearchRawOptions
): Promise<SearchResponse>
```

Searches using a pre-built boolean expression (MygramDB v1.7+). The expression
is sent verbatim (unquoted) so the server's AST parser can interpret
`AND` / `OR` / `NOT` / parentheses — a quoted phrase that embeds those keywords
is treated as a literal phrase (MygramDB v1.8+). Pair with
[`convertSearchExpression()`](#exported-functions) to preserve OR / grouping
semantics that `search()`'s AND/NOT decomposition cannot express.

**Parameters:**
- `table` (string) - Table name (bare or `database.table`)
- `rawQuery` (string) - Pre-built boolean expression
- `options` (SearchRawOptions, optional) - `limit`, `offset`, and `highlight`

**Returns:** Promise resolving to SearchResponse

**Example:**
```typescript
const raw = convertSearchExpression('python OR (ruby AND rails)');
const results = await client.searchRaw('articles', raw, { limit: 50 });
```

### searchRawWithHighlights()

```typescript
async searchRawWithHighlights(
  table: string,
  rawQuery: string,
  options?: SearchRawOptions
): Promise<SearchResponse>
```

The same call as [`searchRaw()`](#searchraw) with the `HIGHLIGHT` clause
enabled. Any `highlight` options passed in `options` are preserved; otherwise
server defaults are used. Snippets are returned in `result.snippet`.

**Example:**
```typescript
const raw = convertSearchExpression('python OR (ruby AND rails)');
const results = await client.searchRawWithHighlights('articles', raw, { highlight: {} });
```

## Facet Methods

### facet()

```typescript
async facet(
  table: string,
  column: string,
  options?: FacetOptions
): Promise<FacetResponse>
```

Aggregates the distinct values of a filter column with their document counts
(MygramDB v1.6+). With no `query`, the aggregation spans the whole table; with a
`query` (and optional `andTerms`/`notTerms`/`filters` refinements), it is scoped
to the matching documents.

**Parameters:**
- `table` (string) - Table name (bare or `database.table`)
- `column` (string) - Filter column to aggregate
- `options` (FacetOptions, optional) - Optional query scope, refinements, and `limit`

**Returns:** Promise resolving to FacetResponse

**Throws:**
- `InputValidationError` - If an argument contains control characters or the query exceeds the configured length limit
- `ConnectionError` - If not connected
- `TimeoutError` - If request times out
- `ProtocolError` - If server returns an error

**Example:**
```typescript
// All distinct statuses across the table:
const all = await client.facet('articles', 'status');

// Top categories among documents matching "machine learning":
const top = await client.facet('articles', 'category', {
  query: 'machine learning',
  filters: { status: '1' },
  limit: 10,
});
for (const v of top.results) {
  console.log(`${v.value}: ${v.count}`);
}
```

## Document Methods

### get()

```typescript
async get(table: string, primaryKey: string): Promise<Document>
```

Retrieves a document by its primary key.

**Parameters:**
- `table` (string) - Name of the table
- `primaryKey` (string) - Primary key of the document

**Returns:** Promise resolving to Document

**Throws:**
- `ConnectionError` - If not connected
- `TimeoutError` - If request times out
- `ProtocolError` - If document not found or server error

**Example:**
```typescript
const doc = await client.get('articles', '12345');
console.log(doc.primaryKey);
console.log(doc.fields); // { status: '1', category: 'tech', ... }
```

## Server Information Methods

### info()

```typescript
async info(): Promise<ServerInfo>
```

Retrieves comprehensive server information including version, uptime, document count, and table list.

**Returns:** Promise resolving to ServerInfo

**Throws:**
- `ConnectionError` - If not connected
- `TimeoutError` - If request times out
- `ProtocolError` - If server returns an error

**Example:**
```typescript
const info = await client.info();
console.log(`Version: ${info.version}`);
console.log(`Uptime: ${info.uptimeSeconds} seconds`);
console.log(`Total documents: ${info.docCount}`);
console.log(`Tables: ${info.tables.join(', ')}`);
```

### getConfig()

```typescript
async getConfig(): Promise<string>
```

Retrieves the server configuration in YAML format.

**Returns:** Promise resolving to configuration string (YAML format)

**Throws:**
- `ConnectionError` - If not connected
- `TimeoutError` - If request times out
- `ProtocolError` - If server returns an error

**Example:**
```typescript
const config = await client.getConfig();
console.log(config);
```

## Replication Methods

### getReplicationStatus()

```typescript
async getReplicationStatus(): Promise<ReplicationStatus>
```

Retrieves the current MySQL binlog replication status.

**Returns:** Promise resolving to ReplicationStatus

**Throws:**
- `ConnectionError` - If not connected
- `TimeoutError` - If request times out
- `ProtocolError` - If server returns an error

**Example:**
```typescript
const status = await client.getReplicationStatus();
console.log(`Running: ${status.running}`);
console.log(`GTID: ${status.gtid}`);
console.log(`Status: ${status.statusStr}`);
```

### stopReplication()

```typescript
async stopReplication(): Promise<void>
```

Stops the MySQL binlog replication.

**Returns:** Promise that resolves when replication is stopped

**Throws:**
- `ConnectionError` - If not connected
- `TimeoutError` - If request times out
- `ProtocolError` - If server returns an error

**Example:**
```typescript
await client.stopReplication();
console.log('Replication stopped');
```

### startReplication()

```typescript
async startReplication(): Promise<void>
```

Starts the MySQL binlog replication.

**Returns:** Promise that resolves when replication is started

**Throws:**
- `ConnectionError` - If not connected
- `TimeoutError` - If request times out
- `ProtocolError` - If server returns an error

**Example:**
```typescript
await client.startReplication();
console.log('Replication started');
```

## Debug Methods

### enableDebug()

```typescript
async enableDebug(): Promise<void>
```

Enables debug mode to receive detailed query performance metrics with search results.

**Returns:** Promise that resolves when debug mode is enabled

**Throws:**
- `ConnectionError` - If not connected
- `TimeoutError` - If request times out
- `ProtocolError` - If server returns an error

**Example:**
```typescript
await client.enableDebug();

const results = await client.search('articles', 'test');
if (results.debug) {
  console.log(`Query time: ${results.debug.queryTimeMs}ms`);
  console.log(`Index time: ${results.debug.indexTimeMs}ms`);
  console.log(`Candidates: ${results.debug.candidates}`);
  console.log(`Final results: ${results.debug.final}`);
}
```

### disableDebug()

```typescript
async disableDebug(): Promise<void>
```

Disables debug mode.

**Returns:** Promise that resolves when debug mode is disabled

**Throws:**
- `ConnectionError` - If not connected
- `TimeoutError` - If request times out
- `ProtocolError` - If server returns an error

**Example:**
```typescript
await client.disableDebug();
```

## Cache Methods

### cacheStats()

```typescript
async cacheStats(): Promise<CacheStats>
```

Returns query-cache statistics (enabled state, memory usage, entry count, hit
rate, evictions, TTL).

```typescript
const stats = await client.cacheStats();
console.log(`Hit rate: ${stats.hitRate}%, entries: ${stats.entries}`);
```

### cacheClear()

```typescript
async cacheClear(table?: string): Promise<void>
```

Clears the query cache. With no argument, clears every table's cached entries;
with a table, clears only that table's entries.

### cacheEnable()

```typescript
async cacheEnable(): Promise<void>
```

Enables the query cache.

### cacheDisable()

```typescript
async cacheDisable(): Promise<void>
```

Disables the query cache.

## Index Maintenance Methods

### optimize()

```typescript
async optimize(table?: string): Promise<void>
```

Optimizes (rebuilds) the index. With no argument, optimizes every table; with a
table, optimizes only that table.

```typescript
await client.optimize('articles');
```

## Dump Methods

### dumpSave()

```typescript
async dumpSave(filepath: string): Promise<string>
```

Starts saving an index dump to `filepath` on the server. Resolves with the
filepath being written. Use [`dumpStatus()`](#dumpstatus) to monitor progress.

### dumpLoad()

```typescript
async dumpLoad(filepath: string): Promise<void>
```

Loads an index dump from `filepath` on the server.

### dumpStatus()

```typescript
async dumpStatus(): Promise<DumpStatus>
```

Returns the status of the current dump operation (status, filepath, table
progress, elapsed time, and any error).

### dumpVerify()

```typescript
async dumpVerify(filepath: string): Promise<string>
```

Verifies the integrity of a dump file, resolving with the raw server result
message.

### dumpInfo()

```typescript
async dumpInfo(filepath: string): Promise<string>
```

Returns metadata about a dump file as the raw server response string.

```typescript
const path = await client.dumpSave('/var/lib/mygramdb/snapshot.dump');
console.log((await client.dumpStatus()).status);
console.log(await client.dumpInfo(path));
```

## Runtime Variable Methods (v1.7+)

### setVariable()

```typescript
async setVariable(name: string, value: string): Promise<void>
```

Sets a runtime variable (MySQL-compatible `SET`). Values containing whitespace
are quoted automatically.

```typescript
await client.setVariable('logging.level', 'info');
```

### showVariables()

```typescript
async showVariables(likePattern?: string): Promise<string>
```

Returns the runtime variables table (`SHOW VARIABLES [LIKE <pattern>]`) as the
raw server response string.

```typescript
const table = await client.showVariables('logging%');
```

## Sync Methods (v1.7+)

### sync()

```typescript
async sync(table: string): Promise<string>
```

Starts an on-demand full reload of a table (`SYNC <table>`). Accepts a bare or
`database.table` identity. Resolves with the server acknowledgement.

### syncStatus()

```typescript
async syncStatus(): Promise<string>
```

Returns the `SYNC STATUS` report (in-flight and recent sync operations) as the
raw server response string.

### syncStop()

```typescript
async syncStop(table?: string): Promise<string>
```

Stops a running sync. With no table, stops every in-flight sync; with a table,
stops only that table's sync.

```typescript
await client.sync('app_db.articles');
console.log(await client.syncStatus());
await client.syncStop('app_db.articles');
```

## MygramPool Class

A pool of connections that fans requests across N clients to sustain high
request rates from a single Node process. See
[Connection Pooling](./advanced-usage.md#connection-pooling) for sizing and
usage guidance.

### Constructor

```typescript
new MygramPool(config?: MygramPoolConfig)
```

`MygramPoolConfig` fields (all optional):

| Field | Default | Description |
| --- | --- | --- |
| `connection` | `{}` | `ClientConfig` passed to every pooled connection |
| `size` | `8` | Number of connections; the effective maximum concurrency |
| `forceJavaScript` | `true` | Use the pure-JS transport (recommended for high concurrency) |
| `maxQueue` | `size * 8` | Max callers allowed to wait before shedding with `PoolOverloadError` |
| `queueTimeoutMs` | connection timeout / `5000` | Deadline for a caller waiting for a free slot |
| `readRetries` | `1` | Times an idempotent read is retried on another slot after a `ConnectionError` |
| `reconnectBackoffMs` | `[100, 5000]` | Reconnect backoff `[initialMs, maxMs]` (exponential + jitter) |
| `keepAliveIntervalMs` | `30000` | Interval for pinging idle connections; `0` disables |
| `metricsIntervalMs` | `0` | Interval for emitting `onMetrics`; `0` disables |
| `onMetrics` | — | Metrics sink invoked every `metricsIntervalMs` |
| `onError` | — | Sink for background errors (reconnect / keep-alive) that never reach a caller |
| `circuitBreaker` | — (disabled) | `CircuitBreakerConfig` wrapping the query path; an open breaker fails fast with `CircuitOpenError` before acquiring a slot |
| `onEvent` | — | Sink for discrete lifecycle events (`PoolEvent`); a throwing callback is swallowed |
| `clientFactory` | `createMygramClient` | Injectable client factory (primarily for testing) |

### Methods

```typescript
start(): Promise<void>   // optional warm-up; memoized and idempotent
close(): Promise<void>   // graceful teardown
end(): Promise<void>     // alias for close()
metrics(): PoolMetrics

// Query surface (load-balanced, idempotent reads retried on ConnectionError)
search(table, query, options?): Promise<SearchResponse>
searchWithHighlights(table, query, options?): Promise<SearchResponse>
searchRaw(table, rawQuery, options?): Promise<SearchResponse>
searchRawWithHighlights(table, rawQuery, options?): Promise<SearchResponse>
count(table, query, options?): Promise<CountResponse>
get(table, primaryKey): Promise<Document>
facet(table, column, options?): Promise<FacetResponse>

// Escape hatch for administrative commands
withClient<T>(operation: (client) => Promise<T>, options?: { idempotent?: boolean }): Promise<T>
```

`start()` opens every connection and resolves once at least one is healthy;
failed connections reconnect in the background. Calling it is optional — the
first query starts the pool lazily (a failed lazy start rejects that query and
is retried on the next). `close()` (alias `end()`) rejects waiting callers and
disconnects every connection.

### PoolMetrics

```typescript
interface PoolMetrics {
  totalConnections: number;    // configured pool size
  healthyConnections: number;  // connected and usable
  inFlight: number;            // commands currently in flight
  queueDepth: number;          // callers waiting for a slot
  rejectedOverload: number;    // cumulative load-shed calls
  reconnects: number;          // cumulative connection retirements
  completed: number;           // cumulative successful commands
  failed: number;              // cumulative failed commands
  latencyP50Ms: number;        // median command latency
  latencyP99Ms: number;        // 99th-percentile command latency
}
```

### CircuitBreakerConfig

```typescript
interface CircuitBreakerConfig {
  failureThreshold?: number; // Consecutive network failures that trip the breaker open (default: 5)
  resetTimeoutMs?: number;   // Time the breaker stays open before a half-open trial (default: 10000)
}
```

Only `ConnectionError` and `TimeoutError` count as network failures;
`ProtocolError` and `PoolOverloadError` do not trip the breaker. See
[Circuit breaker](./advanced-usage.md#circuit-breaker).

### PoolEvent

```typescript
type PoolEvent = 'acquire' | 'connection_discarded' | 'retry' | 'breaker_state_change';
```

Delivered to `onEvent(event, payload)`:

| Event | Payload |
| --- | --- |
| `acquire` | `{ waitMs }` |
| `retry` | `{ attempt, error }` |
| `connection_discarded` | `{}` |
| `breaker_state_change` | `{ state }` (see `CircuitState`) |

### CircuitState

```typescript
type CircuitState = 'closed' | 'open' | 'half-open';
```

The circuit-breaker state reported in the `breaker_state_change` event payload:
`closed` (normal), `open` (failing fast), `half-open` (probing with a trial call).

## Type Definitions

### ClientConfig

```typescript
interface ClientConfig {
  host?: string;           // Server hostname (default: '127.0.0.1')
  port?: number;           // Server port (default: 11016)
  timeout?: number;        // Connection timeout in ms (default: 5000)
  recvBufferSize?: number; // Receive buffer size in bytes (default: 65536)
  maxQueryLength?: number; // Maximum query expression length before validation fails (default: 128)
  autoReconnect?: boolean; // Reconnect + resend once on a pre-write dead socket, pure-JS transport only (default: false)
}
```

### SearchOptions

```typescript
interface SearchOptions {
  limit?: number;                    // Max results (default: 1000)
  offset?: number;                   // Pagination offset (default: 0)
  andTerms?: string[];               // Additional required terms
  notTerms?: string[];               // Excluded terms
  filters?: Record<string, string>;  // Filter conditions (column: value)
  sortColumn?: string;               // Sort column (default: primary key)
  sortDesc?: boolean;                // Sort descending (default: true)
  fuzzy?: number;                    // Fuzzy edit distance (0 = exact)
  highlight?: HighlightOptions;      // Enable highlighted snippets
}
```

### SearchRawOptions

```typescript
interface SearchRawOptions {
  limit?: number;              // Max results (default: 0 = server default)
  offset?: number;             // Pagination offset (default: 0)
  highlight?: HighlightOptions; // Pass {} to enable highlighting with defaults
}
```

### CountOptions

```typescript
interface CountOptions {
  andTerms?: string[];               // Additional required terms
  notTerms?: string[];               // Excluded terms
  filters?: Record<string, string>;  // Filter conditions (column: value)
}
```

### HighlightOptions

```typescript
interface HighlightOptions {
  openTag?: string;       // Opening tag (set together with closeTag)
  closeTag?: string;      // Closing tag (set together with openTag)
  snippetLen?: number;    // Snippet length in code points (0 = server default)
  maxFragments?: number;  // Max fragments per document (0 = server default)
}
```

### FacetOptions

```typescript
interface FacetOptions {
  query?: string;                    // Optional query scoping the aggregation
  andTerms?: string[];               // Additional required terms
  notTerms?: string[];               // Excluded terms
  filters?: Record<string, string>;  // Filter conditions (column: value)
  limit?: number;                    // Max facet values (0 = no limit)
}
```

### FacetResponse

```typescript
interface FacetResponse {
  results: FacetValue[]; // Facet values in server-defined order
}

interface FacetValue {
  value: string;  // Distinct value of the facet column
  count: number;  // Documents holding this value
}
```

### SearchResponse

```typescript
interface SearchResponse {
  results: SearchResult[];  // Array of search results
  totalCount: number;       // Total matching documents
  debug?: DebugInfo;        // Debug info (if debug mode enabled)
}
```

### SearchResult

```typescript
interface SearchResult {
  primaryKey: string;  // Primary key of the document
  snippet?: string;    // Highlighted snippet, present only when highlighting is enabled (MygramDB v1.6+)
}
```

### CountResponse

```typescript
interface CountResponse {
  count: number;       // Total matching documents
  debug?: DebugInfo;   // Debug info (if debug mode enabled)
}
```

### Document

```typescript
interface Document {
  primaryKey: string;                // Primary key
  fields: Record<string, string>;    // Document fields (column: value)
}
```

### InputValidationError

Client-side validation error thrown when unsafe data would be sent to the server.
Typical triggers include CR/LF characters inside `table`, `query`, or filter values,
and queries whose combined expression length exceeds `ClientConfig.maxQueryLength`.
Adjust your input or increase the limit if longer expressions are required.

### ServerInfo

```typescript
interface ServerInfo {
  version: string;           // Server version
  uptimeSeconds: number;     // Server uptime in seconds
  totalRequests: number;     // Cumulative requests served
  activeConnections: number; // Currently active connections
  indexSizeBytes: number;    // Index size in bytes
  docCount: number;          // Total document count
  tables: string[];          // List of table names
}
```

### ReplicationStatus

```typescript
interface ReplicationStatus {
  running: boolean;          // Is replication running
  gtid: string;              // Current GTID position
  statusStr: string;         // Raw status string
  processedEvents?: number;  // Events processed so far (MygramDB v1.6+)
  queueSize?: number;        // Replication queue size, present while running (MygramDB v1.6+)
}
```

### DebugInfo

```typescript
interface DebugInfo {
  queryTimeMs: number;       // Total query execution time in milliseconds
  indexTimeMs: number;       // Index search time in milliseconds
  filterTimeMs: number;      // Filter processing time in milliseconds
  terms: number;             // Number of search terms
  ngrams: number;            // Number of n-grams generated
  candidates: number;        // Initial candidate count from index
  afterIntersection: number; // Results after AND intersection
  afterNot: number;          // Results after NOT filtering
  afterFilters: number;      // Results after FILTER conditions
  final: number;             // Final result count before LIMIT/OFFSET
  optimization: string;      // Optimization strategy used
  sort?: string;             // Sort specification (e.g. "id DESC")
  cache?: string;            // Cache status (hit, miss, disabled)
  cacheAgeMs?: number;       // Cache age in milliseconds (for cache hits)
  cacheSavedMs?: number;     // Time saved by cache hit in milliseconds
  limit?: number;            // Limit value
  offset?: number;           // Offset value
}
```

### CacheStats

```typescript
interface CacheStats {
  enabled: boolean;         // Whether the cache is enabled
  maxMemoryMb: number;      // Maximum cache memory in MB
  currentMemoryMb: number;  // Current cache memory usage in MB
  entries: number;          // Number of cached entries
  hits: number;             // Cache hit count
  misses: number;           // Cache miss count
  hitRate: number;          // Cache hit rate percentage
  evictions: number;        // Number of cache evictions
  ttlSeconds: number;       // Cache TTL in seconds
}
```

### DumpStatus

```typescript
interface DumpStatus {
  status: string;           // saving, loading, idle, completed, failed
  filepath: string;         // File path of the dump
  tablesTotal: number;      // Total number of tables
  tablesProcessed: number;  // Number of tables processed
  currentTable: string;     // Currently processing table name
  elapsedSeconds: number;   // Elapsed time in seconds
  error?: string;           // Error message when status is failed
}
```

## Error Types

### MygramError

Base error class for all mygramdb-client errors.

```typescript
class MygramError extends Error {
  constructor(message: string);
}
```

### ConnectionError

Thrown when connection to the server fails.

```typescript
class ConnectionError extends MygramError {
  constructor(message: string);
}
```

### ProtocolError

Thrown when the server returns an invalid response or error.

```typescript
class ProtocolError extends MygramError {
  constructor(message: string);
}
```

### TimeoutError

Thrown when a request times out.

```typescript
class TimeoutError extends MygramError {
  constructor(message: string);
}
```

### PoolOverloadError

Thrown by `MygramPool` when the wait queue is full — a load-shedding signal. Map
it to an HTTP 503 with `Retry-After` rather than enqueuing more work.

```typescript
class PoolOverloadError extends MygramError {
  constructor(message: string);
}
```

### CircuitOpenError

Thrown by `MygramPool` when its circuit breaker is open (or half-open with a
trial already in flight). Signals that the pool is failing fast to protect an
unreachable server, before a slot is acquired. See
[Circuit breaker](./advanced-usage.md#circuit-breaker).

```typescript
class CircuitOpenError extends MygramError {
  constructor(message: string);
}
```

## Exported Functions

For search expression parsing utilities, see [Search Expression](./search-expression.md).

### Table identity helpers (v1.7+)

```typescript
qualifyTableIdentity(table: string, database?: string): string
parseTableIdentity(identity: string): { database: string | null; table: string }
```

`qualifyTableIdentity` builds a `database.table` identity (or returns the bare
table when no database is given); `parseTableIdentity` splits one back into its
parts. Both validate the identifier and reject whitespace / control characters.

```typescript
qualifyTableIdentity('articles', 'app_db'); // 'app_db.articles'
parseTableIdentity('app_db.articles');      // { database: 'app_db', table: 'articles' }
```

### Client factory & runtime detection

```typescript
createMygramClient(config?: ClientConfig, forceJavaScript?: boolean): MygramClient | NativeMygramClient
getClientType(client: MygramClient | NativeMygramClient): 'native' | 'javascript'
isNativeAvailable(): boolean
```

`createMygramClient` returns the native C++ client when its binding is available
and `forceJavaScript` is not set, otherwise the pure-JavaScript `MygramClient`;
both expose the same surface. `isNativeAvailable` reports whether the native
binding loaded, and `getClientType` tells which implementation an instance is.

```typescript
const client = createMygramClient({ host: 'localhost', port: 11016 });
isNativeAvailable();       // true when the compiled addon is present
getClientType(client);     // 'native' | 'javascript'
```

`NativeMygramClient` is the native-backed client class. It is rarely
instantiated directly — prefer `createMygramClient`, which selects it
automatically — but it is exported for type annotations and mirrors every
`MygramClient` method.

### Additional exported types

These supporting types are exported for annotation; their shapes appear inline
where they are used.

```typescript
// Structural interface a pooled client must satisfy (search/count/get/... surface).
interface PooledClient { /* the query + lifecycle methods shared by both clients */ }

// Factory injected via MygramPoolConfig.clientFactory.
type PooledClientFactory = (config: ClientConfig, forceJavaScript: boolean) => PooledClient;

// Result of the native simplifySearchExpression (same shape as simplifySearchExpression()).
interface SimplifiedExpression {
  mainTerm: string;
  andTerms: string[];
  notTerms: string[];
}
```
