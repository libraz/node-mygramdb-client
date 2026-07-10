# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-07-10

Adds a built-in connection pool with resilience controls for high-throughput
workloads and tracks MygramDB **v1.8.0** boolean-expression handling. The pool
is additive; direct `MygramClient` usage is unchanged apart from the opt-in
`autoReconnect` flag.

### Added

- **`MygramPool`** — a connection pool sized for hundreds of requests per second.
  It spreads work across a fixed set of clients with least-in-flight dispatch,
  a bounded wait queue with load shedding (`PoolOverloadError`) and a per-call
  queue deadline (`TimeoutError`), exponential-backoff self-healing reconnects,
  idle keep-alive pings, optional metrics sampling (`onMetrics` / `metrics()`),
  and idempotent-read retry on a healthy slot. Configure via `MygramPoolConfig`
  (`size`, `maxQueue`, `queueTimeoutMs`, `readRetries`, `reconnectBackoffMs`,
  `keepAliveIntervalMs`, `metricsIntervalMs`, `onMetrics`, `onError`,
  `circuitBreaker`, `onEvent`, `clientFactory`).
- The pool follows Node ecosystem conventions: `start()` is optional warm-up
  (the first query starts it lazily, memoized and idempotent), `close()` tears
  it down gracefully with `end()` as an alias, and `onError` surfaces
  background errors that no caller is awaiting. `withClient()` checks out a
  single client for multi-command work.
- **Circuit breaker** — an optional `circuitBreaker` (`CircuitBreakerConfig`:
  `failureThreshold` default 5, `resetTimeoutMs` default 10000) wraps the query
  path so the pool fails fast with **`CircuitOpenError`** against an unreachable
  server instead of retrying into it, then probes with a half-open trial. State
  transitions (`CircuitState`) are reported through the event sink.
- **`onEvent`** — an optional sink for discrete lifecycle events
  (`PoolEvent`: `acquire`, `connection_discarded`, `retry`,
  `breaker_state_change`); callback errors are swallowed so instrumentation
  cannot disrupt the pool.
- **`PoolOverloadError`** — thrown when the wait queue is full so callers can
  shed load (map to HTTP 503).
- **`autoReconnect`** (`ClientConfig`) — when the pure-JavaScript transport
  finds the socket dead *before* a command is written, it reconnects and
  resends once. A failure *after* the write is surfaced as a `ConnectionError`
  without resending, since the command may already have been applied. The
  native binding does not honour the flag. Default: false.

### Fixed

- **`searchRaw()` / `searchRawWithHighlights()` now send the boolean expression
  verbatim (unquoted).** MygramDB v1.8+ treats a quoted phrase that embeds
  `AND` / `OR` / `NOT` as a literal phrase, so a quoted expression no longer
  matches; sending it unquoted lets the server's AST parser interpret the
  operators and parentheses, matching the reference client. Control characters
  are still rejected.
- **The published bundle now imports cleanly from both ESM and CommonJS.** Node
  built-ins are kept external in their `node:` form, and the native loader
  resolves its own path from `import.meta.url` or `__filename` depending on the
  format it runs under, so `import`/`require` of the package no longer throws at
  load time.

### Changed

- The docker e2e stack now defaults to the MygramDB v1.8.0 server image.

## [1.3.0] - 2026-06-15

Tracks MygramDB **v1.7.0** (database-qualified table identity, boolean search,
on-demand sync, runtime variables). All additions are backward compatible:
existing single-database, single-token usage produces byte-identical commands.

### Added

- **Database-qualified table identity** — every table-taking method
  (`search`, `count`, `get`, `facet`, `sync`, ...) now accepts a
  `database.table` identity (e.g. `app_db.articles`) for MygramDB v1.7+
  multi-database deployments. Bare names keep working for single-database
  servers. New helpers `qualifyTableIdentity(table, database?)` and
  `parseTableIdentity(identity)` build and split identities.
- **`searchRaw()` / `searchRawWithHighlights()`** — send a pre-built boolean
  expression (`AND` / `OR` / `NOT` / parentheses) as a single token so the
  server's AST parser interprets it. Pair with `convertSearchExpression()` to
  preserve OR / grouping semantics that the AND/NOT decomposition of `search()`
  cannot express. New `SearchRawOptions` type.
- **`searchWithHighlights()`** — convenience wrapper around `search()` with the
  `HIGHLIGHT` clause enabled, mirroring the C++ client's `SearchWithHighlights`.
- **Runtime variables** — `setVariable(name, value)` (`SET`) and
  `showVariables(likePattern?)` (`SHOW VARIABLES [LIKE ...]`).
- **On-demand sync** — `sync(table)`, `syncStatus()`, and `syncStop(table?)`
  (`SYNC` / `SYNC STATUS` / `SYNC STOP`). The transport now recognizes the
  `OK SYNC_STATUS ... END` multi-line response frame.
- All of the above are mirrored on `NativeMygramClient`, which also gains the
  previously missing `cacheStats`/`cacheClear`/`cacheEnable`/`cacheDisable`,
  `optimize`, and `dumpSave`/`dumpLoad`/`dumpStatus`/`dumpVerify`/`dumpInfo`
  methods so both clients expose the same surface.
- **Self-contained docker-compose e2e** under `tests/docker/` (MySQL seeded with
  a fixed dataset + a published MygramDB server image). Run with
  `yarn test:e2e:docker`; the seeded block in `tests/e2e.test.ts` asserts exact
  result sets for qualified identity, boolean `searchRaw`, facets, highlight,
  and Japanese (ngram) matching.

### Fixed

- **Multi-line responses ending in `END\r\n\r\n` are now framed correctly.**
  `SYNC STATUS` appends a trailing blank line after the `END` marker; the
  transport previously required exactly `END\r\n` and would block until timeout.
  (Found by the new docker e2e.)

### Changed

- **Dump filepaths are now quoted instead of rejected when they contain
  whitespace** (`dumpSave`/`dumpLoad`/`dumpVerify`/`dumpInfo`), matching the C++
  client's `QuoteCommandArgumentIfNeeded`. Control characters are still
  rejected.

- **Query/term quoting now matches the C++ client's `EscapeQueryString`.**
  Query text, `andTerms`, `notTerms`, and filter values that contain
  whitespace or quote characters are wrapped in double quotes (escaping inner
  `"` / `\`) so they reach the server as a single token. Single-token values
  are still sent verbatim, so existing simple queries are unaffected; only
  multi-word values change (e.g. `FILTER status = in progress` →
  `FILTER status = "in progress"`), fixing commands that previously split
  mid-value.

## [1.2.1] - 2026-05-09

### Fixed

- Serialize concurrent `sendCommand` calls through a FIFO queue so parallel
  callers no longer clobber each other's pending promise
- Add an explicit connect-phase timeout; `socket.setTimeout` only governs
  idle reads, so unreachable hosts previously blocked for ~75 s
- Validate identifiers (table, primary key, sort column, filter keys, dump
  filepaths) and reject whitespace, control characters, and empty values
  that would split unquoted protocol tokens
- Emit bare `OFFSET <n>` when `offset > 0 && limit === 0` instead of
  silently sending `LIMIT 0,<n>`
- Serialize empty queries as `""` so the server parses a well-formed token,
  matching the C++ `EscapeQueryString`
- Require `END\r\n` to terminate multi-line responses (`OK INFO`,
  `OK REPLICATION`, `OK CACHE_STATS`, `OK DUMP_INFO`, `OK DUMP_STATUS`); the
  prior lenient `\r\n\r\n` detection could prematurely complete payloads
  that contain internal blank lines
- Parse `processedEvents` and `queueSize` from `REPLICATION STATUS`
- `NativeMygramClient.count` now emits `FILTER <key> = <value>` to match
  `MygramClient` and the C++ client (was wrongly emitting `<key>=<value>`)

### Changed

- Internal refactor: split monolithic `client.ts` (1292 → 395 lines) and
  `native-client.ts` (791 → 317 lines) into focused modules
  - `src/connection.ts` owns the socket lifecycle, FIFO queue, and framing
  - `src/response-parser.ts` holds shared `parseXxxResponse` helpers
  - `src/command-builder.ts` holds shared command builders for search,
    count, facet, get
- New `tests/connection.test.ts` (36 tests) covers framing, FIFO ordering,
  connect timeout, identifier validation, OFFSET-only emission, empty query
  quoting, and replication-status parsing

## [1.2.0] - 2026-04-15

### Added

- MygramDB v1.6 support
  - `SearchOptions.fuzzy` for Levenshtein fuzzy search (edit distance 1 or 2)
  - `SearchOptions.highlight` (`HighlightOptions`) for HIGHLIGHT clause with
    customizable open/close tags, snippet length and max fragments
  - `SearchResult.snippet` field returned when highlighting is enabled
  - `MygramClient.facet()` / `NativeMygramClient.facet()` for FACET aggregation
    with optional query scoping (`FacetOptions`, `FacetValue`, `FacetResponse`)
  - BM25 relevance scoring via the special `_score` sort column
- New validators in `command-utils`: `validateFuzzy`, `validateHighlight`,
  `validateFacetColumn`
- 43 new unit tests covering the v1.6 surface in both client implementations

### Changed

- `parseSearchResponse` now handles the multi-line HIGHLIGHT response format
  in addition to the classic single-line format
- Internal response framing recognises the FACET multi-line response

## [1.1.0] - 2026-03-16

### Added

- npm Trusted Publishing for automated releases
- npm README for better package documentation
- Mock-based tests for improved test coverage

### Changed

- Migrated from ESLint + Prettier to Biome for linting and formatting
- Simplified CI/publish workflows
- Updated .npmignore and added esbuild dev dependency

## [1.0.0] - 2025-12-21

### Added

- Initial release
- TCP socket communication with MygramDB
- Promise-based async API
- Full-text search operations (search, get, set, delete)
- Search expression parser
- Automatic response parsing
- Native C++ bindings (optional)
- Input validation and error handling
- TypeScript type definitions

[1.4.0]: https://github.com/libraz/node-mygramdb-client/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/libraz/node-mygramdb-client/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/libraz/node-mygramdb-client/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/libraz/node-mygramdb-client/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/libraz/node-mygramdb-client/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/libraz/node-mygramdb-client/releases/tag/v1.0.0
