# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.2.1]: https://github.com/libraz/node-mygramdb-client/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/libraz/node-mygramdb-client/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/libraz/mygram-db/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/libraz/mygram-db/releases/tag/v1.0.0
