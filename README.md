# mygramdb-client

[![npm version](https://img.shields.io/npm/v/mygramdb-client.svg)](https://www.npmjs.com/package/mygramdb-client)
[![CI](https://github.com/libraz/node-mygramdb-client/actions/workflows/ci.yml/badge.svg)](https://github.com/libraz/node-mygramdb-client/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Node.js client library for [MygramDB](https://github.com/libraz/mygram-db/) - A high-performance in-memory full-text search engine that is **25-200x faster** than MySQL FULLTEXT with MySQL replication support.

## Features

- **Dual Implementation** - Optional C++ native bindings with automatic JavaScript fallback
- **Full Protocol Support** - All MygramDB commands (SEARCH, COUNT, GET, INFO, etc.)
- **Search Expression Parser** - Web-style search syntax (+required, -excluded, "phrase", OR, grouping)
- **Type Safety** - Full TypeScript definitions
- **Promise-based API** - Modern async/await interface
- **Connection Pooling Ready** - Designed for easy integration with connection pools
- **Debug Mode** - Built-in support for query performance metrics

## Installation

```bash
npm install mygramdb-client
# or
yarn add mygramdb-client
```

## Quick Start

```typescript
import { createMygramClient, simplifySearchExpression } from 'mygramdb-client';

// Creates native C++ client if available, otherwise pure JavaScript
const client = createMygramClient({
  host: 'localhost',
  port: 11016
});

await client.connect();

// Parse web-style search expression (space = AND, - = NOT)
const expr = simplifySearchExpression('hello world -spam');
// expr = { mainTerm: 'hello', andTerms: ['world'], notTerms: ['spam'] }

// Search with AND/NOT terms
const results = await client.search('articles', expr.mainTerm, {
  andTerms: expr.andTerms,
  notTerms: expr.notTerms,
  limit: 100,
  offset: 50,  // MySQL-compatible: LIMIT 50,100
  filters: { status: 'published', lang: 'en' },
  sortColumn: 'created_at',
  sortDesc: true
});

console.log(`Found ${results.totalCount} results`);

// Count matching documents
const count = await client.count('articles', 'technology');

// Get document by ID
const doc = await client.get('articles', '12345');

client.disconnect();
```

## Documentation

- **[Getting Started](docs/en/getting-started.md)** - Installation, configuration, and basic usage
- **[API Reference](docs/en/api-reference.md)** - Complete API documentation
- **[Search Expression](docs/en/search-expression.md)** - Advanced search syntax guide
- **[Advanced Usage](docs/en/advanced-usage.md)** - Connection pooling, error handling, and best practices

## TypeScript Support

The library is written in TypeScript and provides full type definitions:

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

Development guidelines are documented within this repository.

```bash
# Install dependencies
yarn install

# Run tests
yarn test

# Build library
yarn build

# Lint and format
yarn lint
yarn format
```

## License

MIT

## Author

libraz <libraz@libraz.net>

## Links

- [MygramDB](https://github.com/libraz/mygram-db/) - The MygramDB server
- [npm package](https://www.npmjs.com/package/mygramdb-client)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
