# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.1.0]: https://github.com/libraz/mygram-db/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/libraz/mygram-db/releases/tag/v1.0.0
