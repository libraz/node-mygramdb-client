# Advanced Usage

This guide covers advanced usage patterns and best practices for mygramdb-client.

## Connection Pooling

A single `MygramClient` owns one socket and serializes every command through a
FIFO queue, so one connection tops out at roughly `1 / RTT` requests per second.
To sustain hundreds of requests per second from a single Node process, use the
built-in `MygramPool`, which fans requests across N connections and keeps up to
N commands in flight concurrently.

```typescript
import { MygramPool } from 'mygramdb-client';

const pool = new MygramPool({
  connection: { host: 'localhost', port: 11016 },
  size: 12
});

// start() is optional: it warms every connection up front for fail-fast
// startup. Omit it and the first query starts the pool lazily (like pg.Pool).
await pool.start();

// The pool exposes the query surface directly; connection borrow/return is
// handled internally and load-balanced across the pool.
const results = await pool.search('articles', 'test', { limit: 100 });
console.log(results);

// Inspect health and load at any time.
console.log(pool.metrics());

// close() tears the pool down; end() is an alias (pg / mysql2 convention).
await pool.close();
```

### Sizing the pool

Each slot handles at most one in-flight command, so the pool size is the
effective maximum concurrency. Size it with Little's law:

```
size ≈ targetThroughput(req/s) × p95RTT(s)
```

Then add headroom (about 3x) for RTT variance and spikes. For example, to reach
500 req/s over a LAN with a 5 ms p95 RTT, `500 × 0.005 = 2.5`, so a pool of
**8–12** connections comfortably absorbs the load. Measure your real p95 RTT
before committing to a number, and prefer the pure-JavaScript transport
(`forceJavaScript: true`, the default) for high concurrency — the native
binding's `sendCommand` is synchronous and blocks the event loop for the whole
round trip.

### Backpressure and resilience

`MygramPool` is built for overload conditions:

- **Load shedding.** When every slot is busy, callers wait in a bounded queue
  (`maxQueue`). Once the queue is full, further calls reject immediately with
  `PoolOverloadError` instead of growing memory without bound — translate this
  into an HTTP 503 with `Retry-After` at your edge.
- **Queue deadline.** A caller waiting for a free slot is bounded by
  `queueTimeoutMs`, so real wait time never runs away.
- **Self-healing.** A connection that fails is retired and reconnected out of
  band with exponential backoff while the other slots keep serving. Idempotent
  reads (`search`, `count`, `get`, `facet`) are retried once on another slot
  after a `ConnectionError`. Background errors that never reach a caller
  (reconnect failures, keep-alive retirements) surface through `onError`.

```typescript
const pool = new MygramPool({
  connection: { host: 'localhost', port: 11016, timeout: 3000 },
  size: 12,
  maxQueue: 96, // reject beyond this to shed load fast
  queueTimeoutMs: 3000, // cap real wait time
  readRetries: 1, // retry idempotent reads once on another slot
  reconnectBackoffMs: [100, 5000],
  onMetrics: (m) => console.log('pool', m),
  metricsIntervalMs: 5000,
  onError: (err) => console.error('pool background error', err) // otherwise swallowed
});

try {
  await pool.search('articles', 'test');
} catch (error) {
  if (error instanceof PoolOverloadError) {
    // Backpressure: shed this request (e.g. respond 503).
  }
}
```

For administrative commands that the pool does not expose directly, borrow a
client through `withClient`:

```typescript
const info = await pool.withClient((client) => client.info(), { idempotent: true });
```

### Circuit breaker

Set `circuitBreaker` to make the pool fail fast when the server becomes
unreachable instead of retrying into it. The breaker sits **outside** the
read-retry loop, so once it is open a call throws `CircuitOpenError` before a
slot is even acquired. Omit `circuitBreaker` to disable it.

- **Closed** (normal): calls run as usual. Each `ConnectionError` /
  `TimeoutError` increments a counter; `failureThreshold` consecutive network
  failures (default 5) trip the breaker **open**.
- **Open**: every call fails fast with `CircuitOpenError`. After
  `resetTimeoutMs` (default 10000) the next call is admitted as a single
  **half-open** trial.
- **Half-open**: one trial call is allowed; its success closes the breaker, its
  failure reopens it. Concurrent calls during the trial also fail fast.

Only `ConnectionError` and `TimeoutError` trip the breaker. A `ProtocolError`
(a reachable server rejecting the query) or a `PoolOverloadError` (local
backpressure) leaves it closed.

```typescript
import { MygramPool, CircuitOpenError } from 'mygramdb-client';

const pool = new MygramPool({
  connection: { host: 'localhost', port: 11016 },
  circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 10000 }
});

try {
  await pool.search('articles', 'test');
} catch (error) {
  if (error instanceof CircuitOpenError) {
    // Server is unreachable; the breaker is shedding load. Back off.
  }
}
```

### Pool events

`onEvent` delivers discrete lifecycle events. It coexists with the periodic
`onMetrics` snapshot and the background-error `onError` sink. Four `PoolEvent`
values are emitted:

- `acquire` — a slot was handed to a caller; payload `{ waitMs }` (`0` when a
  slot was free immediately).
- `retry` — an idempotent read was retried on another slot; payload
  `{ attempt, error }`.
- `connection_discarded` — a dead slot was retired for background reconnection;
  empty payload.
- `breaker_state_change` — the circuit breaker changed state; payload
  `{ state }` (`'closed' | 'open' | 'half-open'`).

An `onEvent` callback that throws is swallowed, so instrumentation cannot
disrupt the pool.

```typescript
const pool = new MygramPool({
  connection: { host: 'localhost', port: 11016 },
  circuitBreaker: {},
  onEvent: (event, payload) => {
    console.log('pool event', event, payload);
  }
});
```

## Client Auto-Reconnect

For a standalone `MygramClient` (not the pool), set `autoReconnect` on the
`ClientConfig` to recover from a socket that died while idle. When enabled, the
client reconnects once and resends the command **only** if the socket is found
dead *before* the command is written to the wire. A failure that happens *after*
the write surfaces as a `ConnectionError` without resending, since the command
may already have been applied server-side. This applies to the pure-JavaScript
transport only — the native binding does not implement it. Default: `false`.

```typescript
const client = new MygramClient({
  host: 'localhost',
  port: 11016,
  autoReconnect: true // reconnect-and-resend once on a pre-write dead socket
});
```

## Batch Operations

Process multiple queries efficiently:

```typescript
import { MygramClient, SearchResponse } from 'mygramdb-client';

async function batchSearch(
  client: MygramClient,
  table: string,
  queries: string[]
): Promise<SearchResponse[]> {
  return Promise.all(
    queries.map((query) => client.search(table, query))
  );
}

// Usage
const client = new MygramClient();
await client.connect();

const queries = [
  'golang tutorial',
  'python guide',
  'javascript tips',
  'rust programming',
];

const results = await batchSearch(client, 'articles', queries);

results.forEach((result, index) => {
  console.log(`Query "${queries[index]}": ${result.totalCount} results`);
});
```

## Parallel Processing with Pool

Fire many queries concurrently and let the pool bound the real concurrency to
its size — surplus calls wait in the queue automatically:

```typescript
async function parallelSearch(
  pool: MygramPool,
  table: string,
  queries: string[]
): Promise<SearchResponse[]> {
  return Promise.all(queries.map((query) => pool.search(table, query)));
}

// Usage
const results = await parallelSearch(pool, 'articles', [
  'golang',
  'python',
  'javascript',
  'rust',
  'java',
  'c++',
]);
```

## Health Checking

Implement health checks for monitoring:

```typescript
import { MygramClient } from 'mygramdb-client';

interface HealthCheckResult {
  healthy: boolean;
  version?: string;
  uptime?: number;
  docCount?: number;
  replicationRunning?: boolean;
  error?: string;
}

async function healthCheck(client: MygramClient): Promise<HealthCheckResult> {
  try {
    const [info, status] = await Promise.all([
      client.info(),
      client.getReplicationStatus(),
    ]);

    return {
      healthy: true,
      version: info.version,
      uptime: info.uptimeSeconds,
      docCount: info.docCount,
      replicationRunning: status.running,
    };
  } catch (error) {
    return {
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Usage
const client = new MygramClient();
await client.connect();

const health = await healthCheck(client);
if (health.healthy) {
  console.log('Server is healthy');
  console.log(`Version: ${health.version}`);
  console.log(`Uptime: ${health.uptime} seconds`);
  console.log(`Documents: ${health.docCount}`);
} else {
  console.error('Server is unhealthy:', health.error);
}
```

## Retry Logic

Implement automatic retry for transient failures:

```typescript
import { MygramClient, TimeoutError, ConnectionError } from 'mygramdb-client';

async function searchWithRetry(
  client: MygramClient,
  table: string,
  query: string,
  maxRetries: number = 3,
  retryDelay: number = 1000
): Promise<SearchResponse> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await client.search(table, query);
    } catch (error) {
      lastError = error as Error;

      // Only retry on timeout or connection errors
      if (
        error instanceof TimeoutError ||
        error instanceof ConnectionError
      ) {
        if (attempt < maxRetries) {
          console.log(`Attempt ${attempt} failed, retrying in ${retryDelay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, retryDelay));

          // Reconnect if connection was lost
          if (error instanceof ConnectionError && !client.isConnected()) {
            await client.connect();
          }

          continue;
        }
      }

      // Don't retry on protocol errors
      throw error;
    }
  }

  throw lastError;
}

// Usage
const results = await searchWithRetry(client, 'articles', 'test', 3, 1000);
```

## Query Performance Monitoring

Track and analyze query performance:

```typescript
import { MygramClient, SearchResponse } from 'mygramdb-client';

class PerformanceMonitor {
  private stats: Map<string, { count: number; totalMs: number; minMs: number; maxMs: number }> = new Map();

  async monitoredSearch(
    client: MygramClient,
    table: string,
    query: string
  ): Promise<SearchResponse> {
    const startTime = Date.now();
    const results = await client.search(table, query);
    const duration = Date.now() - startTime;

    this.recordMetric(query, duration);
    return results;
  }

  private recordMetric(query: string, durationMs: number): void {
    const existing = this.stats.get(query);

    if (existing) {
      existing.count++;
      existing.totalMs += durationMs;
      existing.minMs = Math.min(existing.minMs, durationMs);
      existing.maxMs = Math.max(existing.maxMs, durationMs);
    } else {
      this.stats.set(query, {
        count: 1,
        totalMs: durationMs,
        minMs: durationMs,
        maxMs: durationMs,
      });
    }
  }

  getStats(query: string) {
    const stats = this.stats.get(query);
    if (!stats) return null;

    return {
      count: stats.count,
      avgMs: stats.totalMs / stats.count,
      minMs: stats.minMs,
      maxMs: stats.maxMs,
    };
  }

  getAllStats() {
    const results: Record<string, any> = {};
    this.stats.forEach((stats, query) => {
      results[query] = {
        count: stats.count,
        avgMs: stats.totalMs / stats.count,
        minMs: stats.minMs,
        maxMs: stats.maxMs,
      };
    });
    return results;
  }

  reset(): void {
    this.stats.clear();
  }
}

// Usage
const monitor = new PerformanceMonitor();
const client = new MygramClient();
await client.connect();

for (let i = 0; i < 100; i++) {
  await monitor.monitoredSearch(client, 'articles', 'golang');
}

const stats = monitor.getStats('golang');
console.log(`Average query time: ${stats?.avgMs}ms`);
console.log(`Min: ${stats?.minMs}ms, Max: ${stats?.maxMs}ms`);
```

## Caching Layer

Implement a caching layer for frequently accessed data:

```typescript
import { MygramClient, SearchResponse } from 'mygramdb-client';

class CachedMygramClient {
  private cache: Map<string, { data: SearchResponse; timestamp: number }> = new Map();

  constructor(
    private client: MygramClient,
    private ttlMs: number = 60000
  ) {}

  async search(
    table: string,
    query: string,
    useCache: boolean = true
  ): Promise<SearchResponse> {
    const cacheKey = `${table}:${query}`;

    if (useCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.ttlMs) {
        return cached.data;
      }
    }

    const results = await this.client.search(table, query);
    this.cache.set(cacheKey, { data: results, timestamp: Date.now() });
    return results;
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheStats() {
    return {
      entries: this.cache.size,
      oldestEntry: Math.min(
        ...Array.from(this.cache.values()).map((v) => v.timestamp)
      ),
    };
  }
}

// Usage
const client = new MygramClient();
await client.connect();

const cachedClient = new CachedMygramClient(client, 60000);

// First call - hits server
const results1 = await cachedClient.search('articles', 'golang');

// Second call - returns cached result
const results2 = await cachedClient.search('articles', 'golang');

// Force bypass cache
const results3 = await cachedClient.search('articles', 'golang', false);
```

## Pagination Helper

Implement pagination for large result sets:

```typescript
import { MygramClient, SearchResponse } from 'mygramdb-client';

class PaginatedSearch {
  constructor(
    private client: MygramClient,
    private table: string,
    private query: string,
    private pageSize: number = 100
  ) {}

  async *pages(): AsyncIterableIterator<SearchResponse> {
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const results = await this.client.search(this.table, this.query, {
        limit: this.pageSize,
        offset,
      });

      yield results;

      offset += results.results.length;
      hasMore = offset < results.totalCount;
    }
  }

  async getAllResults(): Promise<SearchResult[]> {
    const allResults: SearchResult[] = [];

    for await (const page of this.pages()) {
      allResults.push(...page.results);
    }

    return allResults;
  }
}

// Usage
const client = new MygramClient();
await client.connect();

const paginated = new PaginatedSearch(client, 'articles', 'golang', 100);

// Iterate through pages
for await (const page of paginated.pages()) {
  console.log(`Page has ${page.results.length} results`);
  console.log(`Total available: ${page.totalCount}`);
}

// Or get all results at once
const allResults = await paginated.getAllResults();
console.log(`Retrieved ${allResults.length} total results`);
```

## Error Recovery

Implement comprehensive error recovery:

```typescript
import {
  MygramClient,
  ConnectionError,
  ProtocolError,
  TimeoutError,
} from 'mygramdb-client';

class ResilientClient {
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  constructor(private client: MygramClient) {}

  async search(table: string, query: string): Promise<SearchResponse> {
    try {
      return await this.client.search(table, query);
    } catch (error) {
      if (error instanceof ConnectionError) {
        return this.handleConnectionError(table, query);
      }
      if (error instanceof TimeoutError) {
        return this.handleTimeoutError(table, query);
      }
      throw error;
    }
  }

  private async handleConnectionError(
    table: string,
    query: string
  ): Promise<SearchResponse> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      throw new Error('Max reconnection attempts reached');
    }

    this.reconnectAttempts++;
    console.log(`Reconnecting... (attempt ${this.reconnectAttempts})`);

    await new Promise((resolve) =>
      setTimeout(resolve, this.reconnectDelay * this.reconnectAttempts)
    );

    await this.client.connect();
    this.reconnectAttempts = 0;

    return this.client.search(table, query);
  }

  private async handleTimeoutError(
    table: string,
    query: string
  ): Promise<SearchResponse> {
    console.log('Query timed out, retrying...');
    await new Promise((resolve) => setTimeout(resolve, 500));
    return this.client.search(table, query);
  }
}

// Usage
const client = new MygramClient();
await client.connect();

const resilient = new ResilientClient(client);
const results = await resilient.search('articles', 'test');
```

## Load Balancing

Distribute queries across multiple servers:

```typescript
import { MygramClient, ClientConfig } from 'mygramdb-client';

class LoadBalancedClient {
  private clients: MygramClient[] = [];
  private currentIndex = 0;

  constructor(private configs: ClientConfig[]) {}

  async init(): Promise<void> {
    for (const config of this.configs) {
      const client = new MygramClient(config);
      await client.connect();
      this.clients.push(client);
    }
  }

  private getNextClient(): MygramClient {
    const client = this.clients[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.clients.length;
    return client;
  }

  async search(table: string, query: string): Promise<SearchResponse> {
    const client = this.getNextClient();
    return client.search(table, query);
  }

  async close(): Promise<void> {
    this.clients.forEach((client) => client.disconnect());
  }
}

// Usage
const loadBalancer = new LoadBalancedClient([
  { host: 'server1.example.com', port: 11016 },
  { host: 'server2.example.com', port: 11016 },
  { host: 'server3.example.com', port: 11016 },
]);

await loadBalancer.init();

// Queries are distributed round-robin across servers
const results1 = await loadBalancer.search('articles', 'test1');
const results2 = await loadBalancer.search('articles', 'test2');
const results3 = await loadBalancer.search('articles', 'test3');

await loadBalancer.close();
```

## Best Practices

### 1. Always Use Connection Pooling in Production

```typescript
// Good - fans requests across N connections
const pool = new MygramPool({ connection: config, size: 12 });
await pool.start();

// Bad - a single connection serializes every command through one socket
const client = new MygramClient(config);
await client.connect();
```

### 2. Handle Errors Gracefully

```typescript
// Good
try {
  const results = await client.search('articles', 'test');
} catch (error) {
  if (error instanceof TimeoutError) {
    // Retry logic
  } else if (error instanceof ConnectionError) {
    // Reconnect logic
  } else {
    // Log and report
  }
}

// Bad - no error handling
const results = await client.search('articles', 'test');
```

### 3. Use Appropriate Timeouts

```typescript
// Good - reasonable timeout for your use case
const client = new MygramClient({ timeout: 5000 });

// Bad - too short, may cause false timeouts
const client = new MygramClient({ timeout: 100 });

// Bad - too long, blocks for too long on failures
const client = new MygramClient({ timeout: 60000 });
```

### 4. Monitor Performance

```typescript
// Good - track query performance
const monitor = new PerformanceMonitor();
await monitor.monitoredSearch(client, 'articles', 'test');

// Periodically log stats
setInterval(() => {
  console.log(monitor.getAllStats());
}, 60000);
```

### 5. Clean Up Resources

```typescript
// Good
try {
  await client.connect();
  // Do work
} finally {
  client.disconnect();
}

// Bad - connection leak
await client.connect();
// Do work
// Forget to disconnect
```
