# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.0] - 2026-09-28

Tracks MygramDB **v1.10.2**, a corrective release that unifies wire quoting
across every string reaching the server and fixes several response-framing
bugs. The e2e docker stack defaults to the `1.10.2` server image.

### Fixed

- **Every wire-bound string is quoted by one shared rule** (search terms,
  filter values, `AND`/`NOT` terms, highlight tags, primary keys and command
  arguments): empty text, a reserved clause keyword, ASCII or Unicode
  whitespace (including the full-width and no-break space a full-width IME
  or a pasted value can carry), a quote, a backslash or a parenthesis are all
  quoted, mirroring the server's own tokenizer and the reference C++ client's
  `wire_quoting.h`. Previously only ASCII whitespace and quote characters
  were covered, so a term containing U+3000 or U+00A0 reached the server
  unquoted and split into extra tokens.
- **`get()` quotes a primary key containing whitespace or a reserved word**
  instead of rejecting it. A key is data, not an identifier, so a key
  returned by `search()` can always be sent back to `get()` unchanged.
- **A web-style search expression converts to a query with the same
  meaning.** A literal term equal to a reserved keyword (`golang not`,
  `filter`, `+not`) is quoted so it reaches the server as text rather than
  as the operator; a minus sign inside a `+(...)` group now renders as `NOT`
  rather than a literal hyphen the server's parser does not understand, and
  a plus sign inside a group is dropped rather than glued onto the next
  term.
- **`simplifySearchExpression()` and `parseSearchExpressionNative()` refuse
  an expression containing OR or grouping** instead of silently wrapping it
  in parentheses as a single `mainTerm`. That synthesized term was then
  re-quoted by `search()`'s own escaping, turning `(python OR ruby)` into one
  opaque literal phrase instead of a boolean OR — use
  `convertSearchExpression()` with `searchRaw()` for an expression that may
  contain OR or grouping.
- **A `SEARCH`/`COUNT` reply with `HIGHLIGHT` rows or a `DEBUG` block is read
  completely** even when a chunk boundary lands right after the header line,
  which previously looked like a complete single-line response and truncated
  the rest. `SHOW VARIABLES`'s bare ASCII table (no `OK`/`+OK` prefix) has the
  same fix: every border and row line ends in `\r\n` on its own, so the first
  border line was previously mistaken for the whole response.
- **The native C++ addon (`native/`) carries the same corrections** — the
  shared quoting rule, the web-syntax expression fixes, and the response-
  framing fix in its `sendCommand` transport — plus `Connect()` now resolves
  and tries every address `getaddrinfo` returns (reaching an IPv6-only host)
  and no longer raises `SIGPIPE` on a send to a reset connection.

### Testing

- **The docker e2e suite runs across the server's database matrix** —
  MySQL 8.4 and 9.7 and MariaDB 10.11, 11.8 and 12.3 — through
  `yarn test:e2e:docker:matrix`, with `--only` to select targets.

## [1.5.0] - 2026-08-10

Tracks MygramDB **v1.9.0** and **v1.10.0**. Every addition is backward
compatible with older servers: an `ERROR` frame without a code, an `INFO`
without readiness fields and a `FACET` header without a total are all still
parsed, and a client that sets no `adminToken` behaves exactly as before.

Three of the fixes below change what existing code sees, so check them before
upgrading. `CacheStats` no longer carries `maxMemoryMb` or `ttlSeconds`, which
never appeared in the response and always read as `0` — referencing either is
now a type error. Literal search text quotes protocol keywords, so
`search(table, 'a AND b')` matches that phrase instead of reaching the server as
two clauses; `searchRaw()` or `queryMode: 'boolean'` is how an expression is sent
now. And unprefixed terms in a web-style search expression combine with `AND`
rather than `OR`, which narrows results that previously widened.

### Added

- **Administrative authentication** — `ClientConfig.adminToken` sends
  `AUTH <token>` on every connect, including an `autoReconnect` recovery and
  every connection a `MygramPool` opens. `authenticate(token?)` authenticates an
  already-open connection. MygramDB v1.10 gates `DUMP *`, `REPLICATION *`,
  `SYNC *`, `CONFIG *`, `OPTIMIZE`, `DEBUG *`, `CACHE *`, `SET` and
  `SHOW VARIABLES` behind it; ordinary search traffic needs no token. A rejected
  token fails the connect rather than returning a half-usable connection, and a
  command issued without awaiting `connect()` is dispatched behind the `AUTH`,
  never ahead of it.
- **Typed server errors** — a server rejection now throws `ServerError`, which
  carries the numeric `code` MygramDB v1.10 puts on every `ERROR` frame plus the
  `rawFrame` as received, with `message` holding only the human-readable
  remainder. `ServerError` extends `ProtocolError`, so code that catches
  `ProtocolError` is unaffected. The full `ErrorCode` enumeration is exported
  alongside `isRetryableErrorCode()`, `isConnectionLostErrorCode()` and
  `isAuthRequiredErrorCode()` for classifying a code without hard-coding sets.
- **Boolean query mode** — `SearchOptions.queryMode` (also on `CountOptions` and
  `FacetOptions`) selects `literal` (default) or `boolean`, so an expression such
  as `alpha AND (xqz OR jkv)` can be combined with filters, sorting, fuzzy
  matching and highlighting. `searchRaw()` remains the expression-only entry
  point.
- **Comparison filters** — `filters` accepts `=`, `!=`, `<>`, `>`, `>=`, `<` and
  `<=` through either `{ column: { op, value } }` or a `FilterCondition[]`, the
  latter required when one column carries two conditions such as a range. A bare
  `{ column: value }` record still means equality.
- **Facet pagination** — `FacetOptions.offset` pages through distinct values and
  `FacetResponse.totalCount` reports how many exist before OFFSET and LIMIT,
  falling back to the page size against a server that does not send a total.
- **Readiness on `INFO`** — `ServerInfo.dataInitialized` and `ServerInfo.ready`
  expose the readiness MygramDB v1.10 reports on the TCP surface, so a TCP-only
  deployment can gate traffic without polling the HTTP health endpoint. Both are
  `undefined` when the server omits them.
- **Replication diagnostics** — `ReplicationStatus` gains `state`, which
  separates a failure from a requested stop, plus `crcErrors`,
  `schemaIncompatible`, `lastErrorCode`, `lastError`, `lastAppliedUnixtime` and
  `secondsSinceLastApplied`. The last is the value to alert on: MygramDB v1.10
  stamps it where the replication position advances, so it measures progress
  rather than connectivity.
- **Operation-specific deadlines** — `connectTimeout`, `dumpSaveTimeout`,
  `dumpLoadTimeout`, `dumpVerifyTimeout` and `optimizeTimeout` bound the
  operations that legitimately outrun a request timeout, so `timeout` can stay
  short enough to detect a stalled query.
- **Response frame cap** — `maxResponseBytes` (64 MiB by default) bounds a
  single response. A frame that outgrows it cannot be resynchronized, so the
  connection is closed and the pending command rejected with a `ProtocolError`
  instead of the buffer growing without limit.
- **Dump status detail** — `DumpStatus` gains `saveInProgress`,
  `loadInProgress`, `replicationPausedForDump` and `resultFilepath`.
- `dumpSave()` accepts no argument, writing to the server's configured dump
  directory and default filename.

### Fixed

- Literal search text now quotes standalone protocol keywords (`AND`, `OR`,
  `NOT`, `FILTER`, `SORT`, `LIMIT`, `OFFSET`, `HIGHLIGHT`, `FUZZY`, `FACET`,
  `ORDER`), parentheses and backslashes, matching the reference C++ client's
  `EscapeQueryString`. Searching for the text `AND`, for `foo(bar)` or for a
  value containing `\` previously reached the server as clause keywords, an
  unbalanced group or an escape sequence rather than as literal text.
- `sortDesc: false` without a `sortColumn` now emits `SORT ASC`. It was
  previously dropped, so an explicit request for ascending primary-key order
  silently returned descending results.
- Search results and documents now decode the quoting the server applies to a
  primary key or string column value that is empty or contains whitespace, a
  quote, a backslash or a control character. Such a value was previously split
  on its spaces into several results, or surfaced with its quotes and escape
  sequences intact. A `GET` column value containing `=` is no longer truncated
  at the first one.
- `CACHE STATS` is parsed against the field names the server actually emits.
  Every counter except the hit rate read a key that has never been on the wire,
  so `cacheStats()` reported zeros. `CacheStats` is now the full typed
  statistics surface, `hitRate` is documented as the 0–1 ratio the server
  sends, and `maxMemoryMb` / `ttlSeconds` are gone: they are configuration, not
  statistics, and never appeared in this response.
- Unprefixed terms in a web-style search expression combine with `AND` rather
  than `OR`, matching the documented implicit-AND semantics and the reference
  C++ parser — `golang tutorial` searched for either word instead of both.
  `convertSearchExpression()` also returns a real boolean expression for an
  input carrying OR or grouping; it previously echoed the web syntax back
  verbatim, `+` and `-` included, and dropped any term sitting outside the
  group.
- A client option present but set to `undefined` no longer overwrites its
  default. Assembling a config from optional inputs is ordinary JavaScript, and
  `new MygramClient({ adminToken: process.env.MYGRAM_ADMIN_TOKEN })` with the
  variable unset tried to authenticate with an empty token and failed the
  connect with a `TypeError`; `timeout: undefined` reached the socket the same
  way. Both now behave as though the key were absent.

### Changed

- Toolchain and development dependencies refreshed. TypeScript stays on the 5.x
  line: TypeScript 7 removed the JavaScript Compiler API that `vite-plugin-dts`
  needs to emit declarations.

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

[1.6.0]: https://github.com/libraz/node-mygramdb-client/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/libraz/node-mygramdb-client/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/libraz/node-mygramdb-client/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/libraz/node-mygramdb-client/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/libraz/node-mygramdb-client/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/libraz/node-mygramdb-client/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/libraz/node-mygramdb-client/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/libraz/node-mygramdb-client/releases/tag/v1.0.0
