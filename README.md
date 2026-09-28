# mygramdb-client

[![CI](https://img.shields.io/github/actions/workflow/status/libraz/node-mygramdb-client/ci.yml?branch=main&label=CI)](https://github.com/libraz/node-mygramdb-client/actions)
[![npm](https://img.shields.io/npm/v/mygramdb-client)](https://www.npmjs.com/package/mygramdb-client)
[![codecov](https://codecov.io/gh/libraz/node-mygramdb-client/branch/main/graph/badge.svg)](https://codecov.io/gh/libraz/node-mygramdb-client)
[![License](https://img.shields.io/github/license/libraz/node-mygramdb-client)](https://github.com/libraz/node-mygramdb-client/blob/main/LICENSE)

Node.js client library for [MygramDB](https://github.com/libraz/mygram-db/) — a high-performance in-memory full-text search engine with MySQL replication support.

Tracks MygramDB through v1.10 — typed error codes, administrative `AUTH`,
readiness on `INFO`, boolean query mode, comparison filters and facet
pagination — and stays compatible with servers back to v1.6.

## Overview

MygramDB answers full-text queries from memory instead of an on-disk MySQL FULLTEXT index. How much that gains depends on the query and the dataset; the [published benchmarks](https://mygramdb.libraz.net/benchmarks) give the numbers together with the conditions they were measured under. This client supports both a pure JavaScript implementation and optional C++ native bindings for maximum performance.

| | MySQL FULLTEXT | MygramDB |
|---|---|---|
| **Search Speed** | Baseline | [Measured](https://mygramdb.libraz.net/benchmarks) |
| **Storage** | On-disk | In-memory |
| **Replication** | — | MySQL binlog |
| **Protocol** | MySQL | TCP (memcached-style) |

### Features

- **Dual Implementation** — Optional C++ native bindings with automatic JavaScript fallback
- **Search Expression Parser** — Web-style search syntax (+required, -excluded, "phrase", OR, grouping)
- **Full Protocol Support** — All MygramDB commands (SEARCH, COUNT, GET, INFO, etc.)
- **Connection Pool** — Built-in `MygramPool` for hundreds of req/s, with backpressure, load shedding, self-healing reconnects, and an optional circuit breaker
- **Resilience** — Pool circuit breaker (fail fast when the server is unreachable) and standalone-client `autoReconnect`
- **Type Safety** — Full TypeScript definitions
- **Promise-based API** — Modern async/await interface

## Installation

```bash
npm install mygramdb-client
```

Or use yarn/pnpm:
```bash
yarn add mygramdb-client
pnpm add mygramdb-client
```

## Quick Start

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

// Count
const count = await client.count('articles', 'technology');

// Get document by ID
const doc = await client.get('articles', '12345');

client.disconnect();
```

### Connection Pooling

A single client serializes every command through one socket. For high
throughput (hundreds of req/s), use the built-in `MygramPool`, which fans
requests across N connections with backpressure and self-healing reconnects:

```typescript
import { MygramPool } from 'mygramdb-client';

const pool = new MygramPool({ connection: { host: 'localhost' }, size: 12 });
await pool.start(); // optional warm-up; the first query starts the pool lazily

const results = await pool.search('articles', 'hello', { limit: 100 });
console.log(pool.metrics());

await pool.close();
```

Add `circuitBreaker` to make the pool fail fast with `CircuitOpenError` when the
server is unreachable, and `onEvent` for discrete lifecycle events. A standalone
`MygramClient` can set `autoReconnect` to reconnect-and-resend once on a
pre-write dead socket. See
[Connection Pooling](docs/en/advanced-usage.md#connection-pooling) for sizing
guidance and [Circuit breaker](docs/en/advanced-usage.md#circuit-breaker) for
the resilience features.

## Search Expressions

Parse web-style search queries into structured search parameters:

```typescript
import { simplifySearchExpression } from 'mygramdb-client';

// Space = AND, - = NOT, "" = phrase, OR = OR, () = grouping
const expr = simplifySearchExpression('hello world -spam');
// → { mainTerm: 'hello', andTerms: ['world'], notTerms: ['spam'] }

const results = await client.search('articles', expr.mainTerm, {
  andTerms: expr.andTerms,
  notTerms: expr.notTerms,
  limit: 100,
  offset: 50,
  filters: { status: 'published', lang: 'en' },
  sortColumn: 'created_at',
  sortDesc: true
});
```

## MygramDB v1.6 Features

### BM25 Relevance Scoring

Sort by relevance using the special `_score` sort column (requires
`verify_text: ascii|all` on the server):

```typescript
const results = await client.search('articles', 'machine learning', {
  sortColumn: '_score',
  sortDesc: true,
  limit: 10
});
```

### Fuzzy Search (Levenshtein)

```typescript
// Allow up to 1 edit (default) or 2 edits.
const results = await client.search('articles', 'machne', {
  fuzzy: 1,
  limit: 10
});
```

### Highlighting

```typescript
const results = await client.search('articles', 'golang', {
  highlight: {
    openTag: '<strong>',
    closeTag: '</strong>',
    snippetLen: 200,
    maxFragments: 3
  },
  sortColumn: '_score',
  sortDesc: true,
  limit: 10
});

for (const r of results.results) {
  console.log(r.primaryKey, r.snippet);
}
```

Pass an empty `{}` to enable highlighting with server defaults
(`<em>`/`</em>`, 100 code points, up to 3 fragments).

### Facets

Aggregate distinct filter-column values with document counts. Optionally
scope the aggregation to a search result set:

```typescript
// All distinct statuses:
const all = await client.facet('articles', 'status');

// Top categories among documents matching "machine learning":
const top = await client.facet('articles', 'category', {
  query: 'machine learning',
  filters: { status: '1' },
  limit: 10
});

for (const v of top.results) {
  console.log(`${v.value}: ${v.count}`);
}
```

## MygramDB v1.7 Features

### Multi-database (qualified table identity)

A v1.7+ instance can index tables from more than one database. Reference a
table as `database.table`; bare names still work on single-database servers.

```typescript
await client.search('app_db.articles', 'hello');

import { qualifyTableIdentity, parseTableIdentity } from 'mygramdb-client';
qualifyTableIdentity('articles', 'app_db'); // 'app_db.articles'
parseTableIdentity('app_db.articles');      // { database: 'app_db', table: 'articles' }
```

### Boolean search

`search()` sends the query as a single (auto-quoted) token. For boolean
`AND`/`OR`/`NOT`/grouping, build the expression and pass it to `searchRaw()`:

```typescript
import { convertSearchExpression } from 'mygramdb-client';

const raw = convertSearchExpression('python OR (ruby AND rails)');
const res = await client.searchRaw('articles', raw, { limit: 50 });
```

`searchRaw()` sends the expression verbatim (unquoted) so the server's boolean
parser interprets `AND`/`OR`/`NOT`/grouping; a quoted phrase embedding those
keywords is treated as a literal (MygramDB v1.8+).

### Runtime variables and on-demand sync

```typescript
await client.setVariable('logging.level', 'info');
console.log(await client.showVariables('logging%'));

await client.sync('app_db.articles');
console.log(await client.syncStatus());
await client.syncStop('app_db.articles');
```

## MygramDB v1.9 Features

### Boolean query mode with typed clauses

`searchRaw()` sends an expression on its own. To combine one with filters,
sorting, fuzzy matching or highlighting, pass `queryMode: 'boolean'` to
`search()`. The default stays `literal`, so plain user text keeps matching as a
phrase:

```typescript
await client.search('articles', 'alpha AND (xqz OR jkv)', {
  queryMode: 'boolean',
  filters: { status: 'published' },
  sortColumn: '_score'
});
```

### Comparison filters

Filters accept `=`, `!=`, `<>`, `>`, `>=`, `<` and `<=`. Use the array form when
one column needs two conditions:

```typescript
await client.search('products', 'laptop', {
  filters: [
    { column: 'price', op: '>=', value: '100' },
    { column: 'price', op: '<=', value: '500' }
  ]
});
```

### Facet pagination

```typescript
const page = await client.facet('articles', 'category', { limit: 20, offset: 40 });
console.log(`${page.results.length} of ${page.totalCount} categories`);
```

## MygramDB v1.10 Features

### Administrative authentication

A v1.10 server gates administrative commands (`DUMP *`, `REPLICATION *`,
`SYNC *`, `CONFIG *`, `OPTIMIZE`, `DEBUG *`, `CACHE *`, `SET`,
`SHOW VARIABLES`) behind `AUTH`. Set `adminToken` and the client authenticates
on every connect, reconnects and pooled connections included:

```typescript
const client = new MygramClient({ adminToken: process.env.MYGRAM_ADMIN_TOKEN });
await client.connect();
await client.dumpSave('/var/lib/mygramdb/dump.mgd');
```

Ordinary search traffic needs no token.

### Typed error codes

`ERROR` frames now carry a numeric code, so failures can be classified without
matching message text. Server rejections arrive as `ServerError`, a subclass of
`ProtocolError`:

```typescript
import { ErrorCode, ServerError, isRetryableErrorCode } from 'mygramdb-client';

try {
  await client.search('articles', 'hello');
} catch (error) {
  if (error instanceof ServerError && isRetryableErrorCode(error.code)) {
    // 6028 loading / 6029 not ready / 6030 busy — back off and retry
  }
}
```

### Readiness on INFO

```typescript
const info = await client.info();
if (info.ready === false) {
  // the server is up but not yet serving queries
}
```

### Replication lag and operation deadlines

`getReplicationStatus()` reports `secondsSinceLastApplied`, stamped where the
replication position advances, so it measures progress rather than
connectivity. It is an administrative command, so a v1.10 server with a token
configured needs `adminToken` to answer it — unlike the readiness fields on
`INFO`. Dumps and `OPTIMIZE` get their own deadlines, leaving `timeout` short
enough to detect a stalled query:

```typescript
const client = new MygramClient({ timeout: 3000, dumpSaveTimeout: 900_000 });

const status = await client.getReplicationStatus();
if ((status.secondsSinceLastApplied ?? 0) > 60) {
  console.warn(`replication is ${status.secondsSinceLastApplied}s behind`, status.lastError);
}
```

## TypeScript

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

## Development

```bash
yarn install      # Install dependencies
yarn build        # Build library
yarn test         # Run tests
yarn lint         # Lint and format check
yarn lint:fix     # Auto-fix lint + format issues
```

## License

[MIT](LICENSE)
