# API Reference

Complete API reference for mygram-client.

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

`searchWithHighlights(table, query, options?)` is the same call with the
`HIGHLIGHT` clause enabled, returning snippets in `result.snippet`.

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
is sent as one quoted token so the server's AST parser can interpret
`AND` / `OR` / `NOT` / parentheses. Pair with
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

`searchRawWithHighlights(table, rawQuery, options?)` is the same call with a
`HIGHLIGHT` clause enabled, returning snippets in `result.snippet`.

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
console.log(`Lag: ${status.lagSeconds} seconds`);
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

## Type Definitions

### ClientConfig

```typescript
interface ClientConfig {
  host?: string;           // Server hostname (default: '127.0.0.1')
  port?: number;           // Server port (default: 11016)
  timeout?: number;        // Connection timeout in ms (default: 5000)
  recvBufferSize?: number; // Receive buffer size in bytes (default: 65536)
  maxQueryLength?: number; // Maximum query expression length before validation fails (default: 128)
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
}
```

### CountOptions

```typescript
interface CountOptions {
  filters?: Record<string, string>;  // Filter conditions (column: value)
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

### InputValidationError

Client-side validation error thrown when unsafe data would be sent to the server.
Typical triggers include CR/LF characters inside `table`, `query`, or filter values,
and queries whose combined expression length exceeds `ClientConfig.maxQueryLength`.
Adjust your input or increase the limit if longer expressions are required.
```

### ServerInfo

```typescript
interface ServerInfo {
  version: string;      // Server version
  uptimeSeconds: number;// Server uptime in seconds
  docCount: number;     // Total document count
  tables: string[];     // List of table names
}
```

### ReplicationStatus

```typescript
interface ReplicationStatus {
  running: boolean;     // Is replication running
  gtid: string;         // Current GTID position
  lagSeconds: number;   // Replication lag in seconds
}
```

### DebugInfo

```typescript
interface DebugInfo {
  queryTimeMs: number;  // Query execution time in milliseconds
  indexTimeMs: number;  // Index lookup time in milliseconds
  candidates: number;   // Number of candidate documents
  final: number;        // Number of final results
}
```

## Error Types

### MygramError

Base error class for all mygram-client errors.

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
