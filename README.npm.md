# mygramdb-client

[![CI](https://img.shields.io/github/actions/workflow/status/libraz/node-mygramdb-client/ci.yml?branch=main&label=CI)](https://github.com/libraz/node-mygramdb-client/actions)
[![npm](https://img.shields.io/npm/v/mygramdb-client)](https://www.npmjs.com/package/mygramdb-client)
[![codecov](https://codecov.io/gh/libraz/node-mygramdb-client/branch/main/graph/badge.svg)](https://codecov.io/gh/libraz/node-mygramdb-client)
[![License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/libraz/node-mygramdb-client/blob/main/LICENSE)

Node.js client library for [MygramDB](https://github.com/libraz/mygram-db/) — an in-memory full-text search engine that answers queries from memory rather than an on-disk MySQL FULLTEXT index, kept in sync by MySQL replication.

**Server compatibility:** MygramDB 1.6 or later, with the protocol implemented through 1.10.2. A server rejects options it predates, and an older server's `ERROR` frames carry no numeric code; the [API reference](https://github.com/libraz/node-mygramdb-client/blob/main/docs/en/api-reference.md) marks each option that needs a newer server.

## Usage

```typescript
import { createMygramClient, simplifySearchExpression } from 'mygramdb-client';

const client = createMygramClient({
  host: 'localhost',
  port: 11016
});

await client.connect();

// Search
const results = await client.search('articles', 'hello');
console.log(`Found ${results.totalCount} results`);

// Parse web-style search expressions
const expr = simplifySearchExpression('hello world -spam');
// → { mainTerm: 'hello', andTerms: ['world'], notTerms: ['spam'] }

const filtered = await client.search('articles', expr.mainTerm, {
  andTerms: expr.andTerms,
  notTerms: expr.notTerms,
  limit: 100,
  filters: { status: 'published' },
  sortColumn: 'created_at',
  sortDesc: true
});

// Count
const count = await client.count('articles', 'technology');

// Get document by ID
const doc = await client.get('articles', '12345');

client.disconnect();
```

### Connection pooling

For high-throughput services, `MygramPool` spreads load across a fixed set of
connections with backpressure and self-healing reconnects:

```typescript
import { MygramPool } from 'mygramdb-client';

const pool = new MygramPool({ connection: { host: 'localhost', port: 11016 }, size: 8 });

// No explicit start needed — the first query opens the pool lazily.
const results = await pool.search('articles', 'hello');

await pool.close(); // graceful teardown (alias: end())
```

Add `circuitBreaker` to fail fast with `CircuitOpenError` when the server is
unreachable; a standalone `MygramClient` can set `autoReconnect` to
reconnect-and-resend once on a pre-write dead socket. See
[Advanced Usage](https://github.com/libraz/node-mygramdb-client/blob/main/docs/en/advanced-usage.md#circuit-breaker)
for the resilience features.

### TypeScript

Full type definitions are included:

```typescript
import type {
  ClientConfig,
  SearchResponse,
  CountResponse,
  Document,
  ServerInfo,
  SearchOptions
} from 'mygramdb-client';
```

## Documentation

- [Getting Started](https://github.com/libraz/node-mygramdb-client/blob/main/docs/en/getting-started.md) — install, configuration, and error handling
- [Search Expressions](https://github.com/libraz/node-mygramdb-client/blob/main/docs/en/search-expression.md) — parse and convert web-style search input
- [API Reference](https://github.com/libraz/node-mygramdb-client/blob/main/docs/en/api-reference.md) — every method, option, and type
- [Advanced Usage](https://github.com/libraz/node-mygramdb-client/blob/main/docs/en/advanced-usage.md) — connection pooling, resilience, authentication, and error codes
- [GitHub Repository](https://github.com/libraz/node-mygramdb-client)
- [MygramDB Server](https://github.com/libraz/mygram-db/)

## License

[MIT](https://github.com/libraz/node-mygramdb-client/blob/main/LICENSE)
