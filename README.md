# mygramdb-client

[![CI](https://img.shields.io/github/actions/workflow/status/libraz/node-mygramdb-client/ci.yml?branch=main&label=CI)](https://github.com/libraz/node-mygramdb-client/actions)
[![npm](https://img.shields.io/npm/v/mygramdb-client)](https://www.npmjs.com/package/mygramdb-client)
[![codecov](https://codecov.io/gh/libraz/node-mygramdb-client/branch/main/graph/badge.svg)](https://codecov.io/gh/libraz/node-mygramdb-client)
[![License](https://img.shields.io/github/license/libraz/node-mygramdb-client)](https://github.com/libraz/node-mygramdb-client/blob/main/LICENSE)

Node.js client library for [MygramDB](https://github.com/libraz/mygram-db/) — a high-performance in-memory full-text search engine with MySQL replication support.

## Overview

MygramDB provides **25-200x faster** full-text search than MySQL FULLTEXT. This client supports both a pure JavaScript implementation and optional C++ native bindings for maximum performance.

| | MySQL FULLTEXT | MygramDB |
|---|---|---|
| **Search Speed** | Baseline | 25-200x faster |
| **Storage** | On-disk | In-memory |
| **Replication** | — | MySQL binlog |
| **Protocol** | MySQL | TCP (memcached-style) |

### Features

- **Dual Implementation** — Optional C++ native bindings with automatic JavaScript fallback
- **Search Expression Parser** — Web-style search syntax (+required, -excluded, "phrase", OR, grouping)
- **Full Protocol Support** — All MygramDB commands (SEARCH, COUNT, GET, INFO, etc.)
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
