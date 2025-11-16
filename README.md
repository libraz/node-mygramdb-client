# mygram-client

[![npm version](https://img.shields.io/npm/v/mygram-client.svg)](https://www.npmjs.com/package/mygram-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Node.js client library for [MygramDB](https://github.com/libraz/mygram-db/) - A high-performance in-memory full-text search engine that is **25-200x faster** than MySQL FULLTEXT with MySQL replication support.

## Features

- **Pure JavaScript/TypeScript** - No native dependencies, works on all platforms
- **Full Protocol Support** - All MygramDB commands (SEARCH, COUNT, GET, INFO, etc.)
- **Search Expression Parser** - Web-style search syntax (+required, -excluded, OR, grouping)
- **Type Safety** - Full TypeScript definitions
- **Promise-based API** - Modern async/await interface
- **Connection Pooling Ready** - Designed for easy integration with connection pools
- **Debug Mode** - Built-in support for query performance metrics

## Installation

```bash
npm install mygram-client
# or
yarn add mygram-client
```

## Quick Start

```typescript
import { MygramClient } from 'mygram-client';

const client = new MygramClient({
  host: 'localhost',
  port: 11016
});

await client.connect();

// Search for documents
const results = await client.search('articles', 'hello world', {
  limit: 100,
  offset: 50,  // MySQL-compatible: LIMIT 50,100
  filters: { status: 'published', lang: 'en' },  // Multiple FILTER clauses
  sortColumn: 'created_at',
  sortDesc: true
});

console.log(`Found ${results.totalCount} results`);

// Count matching documents
const count = await client.count('articles', 'technology');

// Get document by ID
const doc = await client.get('articles', '12345');

await client.disconnect();
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
} from 'mygram-client';
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
- [npm package](https://www.npmjs.com/package/mygram-client)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
