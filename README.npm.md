# mygramdb-client

[![CI](https://img.shields.io/github/actions/workflow/status/libraz/node-mygramdb-client/ci.yml?branch=main&label=CI)](https://github.com/libraz/node-mygramdb-client/actions)
[![npm](https://img.shields.io/npm/v/mygramdb-client)](https://www.npmjs.com/package/mygramdb-client)
[![codecov](https://codecov.io/gh/libraz/node-mygramdb-client/branch/main/graph/badge.svg)](https://codecov.io/gh/libraz/node-mygramdb-client)
[![License](https://img.shields.io/github/license/libraz/node-mygramdb-client)](https://github.com/libraz/node-mygramdb-client/blob/main/LICENSE)

Node.js client library for [MygramDB](https://github.com/libraz/mygram-db/) — a high-performance in-memory full-text search engine that is **25-200x faster** than MySQL FULLTEXT with MySQL replication support.

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

- [GitHub Repository](https://github.com/libraz/node-mygramdb-client)
- [MygramDB Server](https://github.com/libraz/mygram-db/)

## License

[MIT](https://github.com/libraz/node-mygramdb-client/blob/main/LICENSE)
