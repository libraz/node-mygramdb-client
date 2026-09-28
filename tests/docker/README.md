# Closed-loop E2E (docker-compose)

A self-contained end-to-end stack: **MySQL** (seeded with a fixed dataset) plus a
**MygramDB** server that replicates from it. It lets `yarn test:e2e` run against a
real server with deterministic data — nothing outside this directory is needed,
because the server is pulled as a published image.

## Run

```bash
# One shot: bring the stack up, run the e2e suite, tear it down.
yarn test:e2e:docker
```

Equivalent manual steps:

```bash
docker compose -f tests/docker/docker-compose.yml up -d --wait
MYGRAM_E2E_SEEDED=1 yarn test:e2e
docker compose -f tests/docker/docker-compose.yml down -v
```

## Knobs (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `MYGRAMDB_VERSION` | `1.10.2` | Server image tag (`ghcr.io/libraz/mygram-db:<tag>`; e.g. `1.8.0`, `latest`) |
| `DB_FLAVOR` | `mysql` | `mysql` or `mariadb`; selects the compose file and seed database |
| `MYSQL_VERSION` | `8.4` | MySQL image tag (used when `DB_FLAVOR=mysql`) |
| `MARIADB_VERSION` | `11.8` | MariaDB image tag (used when `DB_FLAVOR=mariadb`) |
| `MYGRAM_PORT` | `11016` | Host port mapped to the server's TCP API |
| `MYGRAM_HTTP_PORT` | `18080` | Host port mapped to the server's HTTP/health API |
| `MYGRAM_ADMIN_TOKEN` | `e2e-admin-token` | Administrative token given to the server and, when it supports `AUTH`, to the client |
| `KEEP_UP` | `0` | When `1`, leave the stack running after tests (debugging) |

```bash
MYGRAMDB_VERSION=1.8.0 yarn test:e2e:docker   # older server, same suite
DB_FLAVOR=mariadb yarn test:e2e:docker        # against MariaDB instead of MySQL
KEEP_UP=1 yarn test:e2e:docker                # inspect the running stack afterwards
```

## Database version matrix

```bash
# Run the full suite once per target below, sequentially, tearing the stack
# down between each. Non-zero exit if any target fails.
yarn test:e2e:docker:matrix

# Only a subset
yarn test:e2e:docker:matrix --only mysql:8.4,mariadb:11.8
```

Targets (mirrors the server's own `e2e/run-matrix.sh`): `mysql:8.4`, `mysql:9.7`,
`mariadb:10.11`, `mariadb:11.8`, `mariadb:12.3`. Every entry is a supported LTS;
innovation releases are superseded by the next one a quarter later, so they are
reached with `--only` rather than carried in the default list.

## Administrative authentication

The server's TCP listener binds `0.0.0.0` so the host can reach it, and v1.10
refuses to start in that shape unless `api.admin_token` is configured. The token
is injected through `MYGRAM_API_ADMIN_TOKEN`, which the server reads ahead of the
mounted `mygramdb.yaml`, so one config file serves every image the suite runs
against — an older server simply ignores the variable.

`run-e2e.sh` then reads the running server's version from `GET /info` and hands
the client a token only when that version is at least 1.10.0. The tag alone is
not enough to decide, since it can be a moving alias such as `latest`, and a
server predating `AUTH` rejects the command outright. Against v1.10 this means
the suite's administrative calls — `CACHE STATS`, `DUMP STATUS`, `OPTIMIZE`,
`SET`, `SHOW VARIABLES` and the `SYNC` family — exercise the authenticated path
on every connect, pooled connections included.

## What it exercises

The fixed dataset (`mysql-init/02-seed.sql`) lets the suite assert exact results.
With `MYGRAM_E2E_SEEDED=1` the `seeded dataset (docker e2e)` block in
`tests/e2e.test.ts` checks, among others:

- database-qualified identity (`testdb.articles`) resolving to the seeded rows,
  and bare/qualified names resolving identically on a single-database server
- multi-word phrase quoting and `enabled = 1` required-filter visibility
- Japanese (ngram) matching
- `searchRaw` boolean `OR`
- `facet` aggregation by category
- `searchWithHighlights` snippet wrapping (server runs with `verify_text: all`)

Two further blocks cover the surface a specific server version introduced, and
skip against anything older — the gate reads the version from `INFO` rather than
the image tag, so a moving alias resolves correctly:

- `v1.9 query surface`: `boolean` query mode including a nested group and a mode
  combined with a filter, literal mode treating `OR` as text, the comparison
  filter operators through both the record and the array form, facet pagination
  with its distinct-value total, and ascending primary-key order
- `v1.10 protocol surface`: readiness on `INFO`, a typed `ServerError` code for
  an unknown table, the replication diagnostics fields, and — when a token is
  configured — that search needs none, that an administrative command without
  one is refused with the authentication code, that `authenticate()` upgrades an
  open connection, that a wrong token fails the connect outright, and that a
  pooled connection can run an administrative command

The version-agnostic v1.7+ round-trip checks (`searchRaw`, `setVariable` /
`showVariables`, `sync` family) also run without the seed, against any server.
The `connection pool (seeded dataset)` block additionally drives a concurrent
burst through `MygramPool` to verify pooled throughput end-to-end.

## Files

- `docker-compose.yml` — MySQL + MygramDB services
- `docker-compose.mariadb.yml` — MariaDB + MygramDB services (`DB_FLAVOR=mariadb`)
- `mygramdb.yaml` — server config (replicates `testdb` from the `mysql` service)
- `mygramdb-mariadb.yaml` — same config, pointed at the `mariadb` service
- `mysql-init/01-schema.sql` — schema + replication grants
- `mysql-init/02-seed.sql` — deterministic dataset
- `mariadb-init/01-schema.sql` — same schema minus the MySQL-only FULLTEXT ngram index
- `mariadb-init/02-seed.sql` — same deterministic dataset
- `run-e2e.sh` — orchestrates up → test → down (used by `yarn test:e2e:docker`)
- `run-matrix.sh` — runs `run-e2e.sh` once per database version target (used by `yarn test:e2e:docker:matrix`)
