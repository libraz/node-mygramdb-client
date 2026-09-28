# mygramdb-client

[![CI](https://img.shields.io/github/actions/workflow/status/libraz/node-mygramdb-client/ci.yml?branch=main&label=CI)](https://github.com/libraz/node-mygramdb-client/actions)
[![npm](https://img.shields.io/npm/v/mygramdb-client)](https://www.npmjs.com/package/mygramdb-client)
[![codecov](https://codecov.io/gh/libraz/node-mygramdb-client/branch/main/graph/badge.svg)](https://codecov.io/gh/libraz/node-mygramdb-client)
[![License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/libraz/node-mygramdb-client/blob/main/LICENSE)

Node.js client library for [MygramDB](https://github.com/libraz/mygram-db/) — a high-performance in-memory full-text search engine with MySQL replication support.

**Server compatibility:** MygramDB 1.6 or later, with the protocol implemented through 1.10.2. A server rejects options it predates, and an older server's `ERROR` frames carry no numeric code; the [API reference](https://github.com/libraz/node-mygramdb-client/blob/main/docs/en/api-reference.md) marks each option that needs a newer server.

<img src="https://raw.githubusercontent.com/libraz/node-mygramdb-client/main/docs/images/request-path.svg" alt="A search call passing from the application through the client's validation and wire-quoting steps to the MygramDB server over TCP, with the response decoded on the way back and MySQL feeding the server through binlog replication." width="960">

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
- **Typed Errors** — Numeric server error codes on `ServerError`, so retry decisions never depend on message text
- **IPv4 and IPv6** — Connects to IPv6 literals and to hostnames that resolve only to `AAAA` records, trying every resolved address
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
import { createMygramClient } from 'mygramdb-client';

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

## Connection Pooling

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
[Connection Pooling](https://github.com/libraz/node-mygramdb-client/blob/main/docs/en/advanced-usage.md#connection-pooling)
for sizing guidance and
[Circuit breaker](https://github.com/libraz/node-mygramdb-client/blob/main/docs/en/advanced-usage.md#circuit-breaker)
for the resilience features.

## Search Expressions

`convertSearchExpression()` turns web-style input into a server boolean query:
unprefixed terms and `+` terms are joined with `AND`, `-` terms become
`AND NOT`, and an OR chain stays in parentheses.

<img src="https://raw.githubusercontent.com/libraz/node-mygramdb-client/main/docs/images/search-expression.svg" alt="The web-syntax input golang &quot;machine learning&quot; -php +(tutorial OR guide) split into four terms and joined into the server query golang AND &quot;machine learning&quot; AND (tutorial OR guide) AND NOT php." width="960">

`search()` sends its query as literal text, so a boolean expression goes through
`searchRaw()`, or through `search()` with `queryMode: 'boolean'` when it also
needs filters, sorting, fuzzy matching or highlighting:

```typescript
import { convertSearchExpression } from 'mygramdb-client';

const raw = convertSearchExpression('golang "machine learning" -php +(tutorial OR guide)');
// → 'golang AND "machine learning" AND (tutorial OR guide) AND NOT php'

const res = await client.searchRaw('articles', raw, { limit: 50 });

await client.search('articles', raw, {
  queryMode: 'boolean',
  filters: { status: 'published' },
  sortColumn: '_score'
});
```

In the default `literal` mode, plain user text keeps matching as a phrase. For
input without OR or grouping, `simplifySearchExpression()` splits it into a main
term plus `AND`/`NOT` terms for `search()`; it throws on OR or grouping, so check
with `hasComplexExpression()` first when the input may contain either:

```typescript
import {
  convertSearchExpression,
  hasComplexExpression,
  parseSearchExpression,
  simplifySearchExpression
} from 'mygramdb-client';

const parsed = parseSearchExpression(userInput);
let results;
if (hasComplexExpression(parsed)) {
  results = await client.searchRaw('articles', convertSearchExpression(userInput));
} else {
  const { mainTerm, andTerms, notTerms } = simplifySearchExpression(userInput);
  results = await client.search('articles', mainTerm, {
    andTerms,
    notTerms,
    limit: 100,
    filters: { status: 'published', lang: 'en' },
    sortColumn: 'created_at',
    sortDesc: true
  });
}
```

## Search Features

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

### Comparison Filters

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

### Facets

Aggregate distinct filter-column values with document counts, optionally
scoped to a search result set, and page through them with `limit`/`offset`:

```typescript
// Top categories among documents matching "machine learning":
const top = await client.facet('articles', 'category', {
  query: 'machine learning',
  filters: { status: '1' },
  limit: 10
});

for (const v of top.results) {
  console.log(`${v.value}: ${v.count}`);
}

const page = await client.facet('articles', 'category', { limit: 20, offset: 40 });
console.log(`${page.results.length} of ${page.totalCount} categories`);
```

### Multi-database Tables

A server can index tables from more than one database. Reference a table as
`database.table`; bare names work on single-database servers.

```typescript
await client.search('app_db.articles', 'hello');

import { qualifyTableIdentity, parseTableIdentity } from 'mygramdb-client';
qualifyTableIdentity('articles', 'app_db'); // 'app_db.articles'
parseTableIdentity('app_db.articles');      // { database: 'app_db', table: 'articles' }
```

## Wire Quoting

Search terms, filter values, `AND`/`NOT` terms, highlight tags, primary keys
and command arguments all go through the same quoting decision. A value is
quoted when it is empty, a reserved clause keyword (`AND`, `OR`, `NOT`,
`FILTER`, `SORT`, `LIMIT`, `OFFSET`, `HIGHLIGHT`, `FUZZY`, `FACET`, `ORDER`,
matched case-insensitively), or contains ASCII or Unicode whitespace
(including the full-width and no-break space a pasted value or a full-width
IME can carry), a control character, a quote, a backslash or a parenthesis.
Callers always pass the raw, unquoted text:

```typescript
// The full-width space stays inside one term.
await client.search('articles', '機械学習　チュートリアル');

// A filter value equal to a reserved keyword still matches literally.
await client.search('articles', 'q', { filters: { status: 'AND' } });
```

`get()` quotes a primary key that contains whitespace or equals a reserved word,
so a key returned by `search()` can always be passed back to `get()` unchanged.
Search results and `get()` documents decode a primary key or string value the
server quoted the same way.

## Authentication and Error Codes

### Administrative Authentication

The server gates administrative commands (`DUMP *`, `REPLICATION *`,
`SYNC *`, `CONFIG *`, `OPTIMIZE`, `DEBUG *`, `CACHE *`, `SET`,
`SHOW VARIABLES`) behind `AUTH`. Set `adminToken` and the client authenticates
on every connect, reconnects and pooled connections included:

```typescript
const client = new MygramClient({ adminToken: process.env.MYGRAM_ADMIN_TOKEN });
await client.connect();
await client.dumpSave('/var/lib/mygramdb/dump.mgd');
```

Ordinary search traffic needs no token.

### Typed Error Codes

`ERROR` frames carry a numeric code, so failures can be classified without
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

### Readiness

```typescript
const info = await client.info();
if (info.ready === false) {
  // the server is up but not yet serving queries
}
```

## Server Administration

### Replication Lag and Operation Deadlines

`getReplicationStatus()` reports `secondsSinceLastApplied`, stamped where the
replication position advances, so it measures progress rather than
connectivity. It is an administrative command, so a server with a token
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

### Runtime Variables and On-demand Sync

```typescript
await client.setVariable('logging.level', 'info');
console.log(await client.showVariables('logging%'));

await client.sync('app_db.articles');
console.log(await client.syncStatus());
await client.syncStop('app_db.articles');
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

## Documentation

- [Getting Started](https://github.com/libraz/node-mygramdb-client/blob/main/docs/en/getting-started.md) — install, configuration, and error handling
- [Search Expressions](https://github.com/libraz/node-mygramdb-client/blob/main/docs/en/search-expression.md) — parse and convert web-style search input
- [API Reference](https://github.com/libraz/node-mygramdb-client/blob/main/docs/en/api-reference.md) — every method, option, and type
- [Advanced Usage](https://github.com/libraz/node-mygramdb-client/blob/main/docs/en/advanced-usage.md) — connection pooling, resilience, authentication, and error codes

## Development

```bash
yarn install      # Install dependencies
yarn build        # Build library
yarn test         # Run tests
yarn lint         # Lint and format check
yarn lint:fix     # Auto-fix lint + format issues
```

## License

[MIT](https://github.com/libraz/node-mygramdb-client/blob/main/LICENSE)
