# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.2.0]: https://github.com/libraz/node-mygramdb-client/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/libraz/mygram-db/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/libraz/mygram-db/releases/tag/v1.0.0
