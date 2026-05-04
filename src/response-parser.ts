/**
 * Shared response parsers for the MygramDB protocol.
 *
 * Both the pure-JavaScript {@link MygramClient} and the native-binding
 * {@link NativeMygramClient} consume identical wire responses, so all
 * parsing lives here as plain functions.
 */

import { ProtocolError } from './errors.js';
import type {
  CacheStats,
  CountResponse,
  DebugInfo,
  Document,
  DumpStatus,
  FacetResponse,
  FacetValue,
  ReplicationStatus,
  SearchResponse,
  SearchResult,
  ServerInfo
} from './types.js';

/**
 * Split colon-delimited "key: value" lines into a map. Lines that are
 * empty, comment lines (`#`), or the terminal `END` marker are skipped.
 */
function parseColonKeyValueLines(lines: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line === 'END' || line.startsWith('#')) {
      continue;
    }
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key === '') continue;
    result[key] = value;
  }
  return result;
}

/**
 * Parse SEARCH response.
 *
 * Two formats are supported:
 *
 * 1. Classic (single-line):
 *    `OK RESULTS <total_count> <id1> <id2> ...`
 *
 * 2. HIGHLIGHT (multi-line, MygramDB v1.6+):
 *    ```
 *    OK RESULTS <total_count>
 *    <id1>\t<snippet1>
 *    <id2>\t<snippet2>
 *    ...
 *    ```
 *
 * Either format may be followed by a `# DEBUG` block.
 *
 * @param {string} response - Raw response (newline-normalized)
 * @returns {SearchResponse} Parsed search response
 * @throws {ProtocolError} When the response prefix is not `OK RESULTS `
 */
export function parseSearchResponse(response: string): SearchResponse {
  const lines = response.split('\n');
  const firstLine = lines[0];

  if (!firstLine.startsWith('OK RESULTS ')) {
    throw new ProtocolError(`Invalid SEARCH response: ${firstLine}`);
  }

  const headerParts = firstLine.split(' ');
  const totalCount = parseInt(headerParts[2], 10);

  const payloadLines: string[] = [];
  let debugIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '# DEBUG') {
      debugIndex = i;
      break;
    }
    if (line === '') continue;
    payloadLines.push(line);
  }

  let results: SearchResult[];
  if (payloadLines.length > 0) {
    // HIGHLIGHT mode: each payload line is "<pk>[\t<snippet>]".
    results = payloadLines.map((line) => {
      const tab = line.indexOf('\t');
      if (tab < 0) {
        return { primaryKey: line, snippet: '' };
      }
      return { primaryKey: line.slice(0, tab), snippet: line.slice(tab + 1) };
    });
  } else {
    // Classic mode: PKs follow the count on the first line.
    const ids = headerParts.slice(3);
    results = ids.map((id) => ({ primaryKey: id }));
  }

  let debug: DebugInfo | undefined;
  if (debugIndex !== -1) {
    debug = parseDebugInfo(lines.slice(debugIndex + 1));
  }

  return { results, totalCount, debug };
}

/**
 * Parse FACET response (MygramDB v1.6+).
 *
 * Format:
 * ```
 * OK FACET <num_values>
 * <value1>\t<count1>
 * <value2>\t<count2>
 * ...
 * ```
 * Lines starting with `#` (debug/comment) are ignored.
 *
 * @param {string} response - Raw response (newline-normalized)
 * @returns {FacetResponse} Parsed facet response
 * @throws {ProtocolError} When the response is malformed
 */
export function parseFacetResponse(response: string): FacetResponse {
  const lines = response.split('\n');
  const firstLine = lines[0];

  if (!firstLine.startsWith('OK FACET')) {
    throw new ProtocolError(`Invalid FACET response: ${firstLine}`);
  }

  const headerParts = firstLine.split(' ');
  if (headerParts.length < 3) {
    throw new ProtocolError('Invalid FACET response: missing count');
  }
  if (Number.isNaN(parseInt(headerParts[2], 10))) {
    throw new ProtocolError(`Invalid FACET count: ${headerParts[2]}`);
  }

  const results: FacetValue[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '' || line.startsWith('#')) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) {
      throw new ProtocolError(`Invalid FACET row: ${line}`);
    }
    const value = line.slice(0, tab);
    const countStr = line.slice(tab + 1).trim();
    const count = parseInt(countStr, 10);
    if (Number.isNaN(count)) {
      throw new ProtocolError(`Invalid FACET count for ${value}: ${countStr}`);
    }
    results.push({ value, count });
  }

  return { results };
}

/**
 * Parse COUNT response.
 *
 * @param {string} response - Raw response (newline-normalized)
 * @returns {CountResponse} Parsed count response
 * @throws {ProtocolError} When the response prefix is not `OK COUNT `
 */
export function parseCountResponse(response: string): CountResponse {
  const lines = response.split('\n');
  const firstLine = lines[0];

  if (!firstLine.startsWith('OK COUNT ')) {
    throw new ProtocolError(`Invalid COUNT response: ${firstLine}`);
  }

  const count = parseInt(firstLine.split(' ')[2], 10);

  let debug: DebugInfo | undefined;
  const debugIndex = lines.indexOf('# DEBUG');
  if (debugIndex !== -1) {
    debug = parseDebugInfo(lines.slice(debugIndex + 1));
  }

  return { count, debug };
}

/**
 * Parse GET response.
 *
 * @param {string} response - Raw response (newline-normalized)
 * @returns {Document} Parsed document
 * @throws {ProtocolError} When the response prefix is not `OK DOC `
 */
export function parseDocumentResponse(response: string): Document {
  if (!response.startsWith('OK DOC ')) {
    throw new ProtocolError(`Invalid GET response: ${response}`);
  }

  const parts = response.substring(7).split(' ');
  const primaryKey = parts[0];
  const fields: Record<string, string> = {};

  parts.slice(1).forEach((part) => {
    const [key, value] = part.split('=');
    if (key && value) {
      fields[key] = value;
    }
  });

  return { primaryKey, fields };
}

/**
 * Parse INFO response.
 *
 * @param {string} response - Raw response (newline-normalized)
 * @returns {ServerInfo} Parsed server info
 * @throws {ProtocolError} When the response prefix is not `OK INFO`
 */
export function parseInfoResponse(response: string): ServerInfo {
  if (!response.startsWith('OK INFO')) {
    throw new ProtocolError(`Invalid INFO response: ${response}`);
  }

  const lines = response.split('\n').slice(1);
  const fields = parseColonKeyValueLines(lines);
  const info: ServerInfo = {
    version: fields.version ?? '',
    uptimeSeconds: parseIntOrZero(fields.uptime_seconds),
    totalRequests: parseIntOrZero(fields.total_requests),
    activeConnections: parseIntOrZero(fields.connected_clients),
    indexSizeBytes: parseIntOrZero(fields.used_memory_bytes),
    docCount: parseIntOrZero(fields.total_documents),
    tables: fields.tables ? fields.tables.split(',').map((s) => s.trim()) : []
  };
  return info;
}

/**
 * Parse REPLICATION STATUS response.
 *
 * Handles both the legacy single-line format
 *   `OK REPLICATION status=running gtid=xxx`
 * and the multi-line format
 *   ```
 *   OK REPLICATION
 *   status: running
 *   current_gtid: xxx
 *   processed_events: 123
 *   queue_size: 4
 *   END
 *   ```
 *
 * @param {string} response - Raw response (newline-normalized)
 * @returns {ReplicationStatus} Parsed replication status
 * @throws {ProtocolError} When the response prefix is not `OK REPLICATION`
 */
export function parseReplicationStatusResponse(response: string): ReplicationStatus {
  if (!response.startsWith('OK REPLICATION')) {
    throw new ProtocolError(`Invalid REPLICATION STATUS response: ${response}`);
  }

  const lines = response.split('\n');

  if (lines[0].trim() === 'OK REPLICATION') {
    // Multi-line format
    const fields = parseColonKeyValueLines(lines.slice(1));
    const result: ReplicationStatus = {
      running: fields.status === 'running',
      gtid: fields.current_gtid ?? '',
      statusStr: response
    };
    if (fields.processed_events !== undefined) {
      const parsed = parseInt(fields.processed_events, 10);
      if (!Number.isNaN(parsed)) {
        result.processedEvents = parsed;
      }
    }
    if (fields.queue_size !== undefined) {
      const parsed = parseInt(fields.queue_size, 10);
      if (!Number.isNaN(parsed)) {
        result.queueSize = parsed;
      }
    }
    return result;
  }

  // Single-line legacy format: OK REPLICATION status=running gtid=xxx
  const parts = response.substring('OK REPLICATION'.length).trim().split(' ');
  const statusPart = parts.find((p) => p.startsWith('status='));
  const gtidPart = parts.find((p) => p.startsWith('gtid='));

  return {
    running: statusPart?.split('=')[1] === 'running',
    gtid: gtidPart?.split('=')[1] ?? '',
    statusStr: response
  };
}

/**
 * Parse a `# DEBUG` block. Each line is `key: value` with the same casing
 * as emitted by the server.
 *
 * @param {string[]} lines - Lines following the `# DEBUG` marker
 * @returns {DebugInfo} Parsed debug info (zero defaults for missing fields)
 */
export function parseDebugInfo(lines: string[]): DebugInfo {
  const fields = parseColonKeyValueLines(lines);
  const stripDefault = (raw: string | undefined): string | undefined =>
    raw === undefined ? undefined : raw.replace('(default)', '').trim();
  const intOrUndefined = (raw: string | undefined): number | undefined => {
    const cleaned = stripDefault(raw);
    if (cleaned === undefined || cleaned === '') return undefined;
    const parsed = parseInt(cleaned, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  };

  const debug: DebugInfo = {
    queryTimeMs: parseFloatOrZero(fields.query_time),
    indexTimeMs: parseFloatOrZero(fields.index_time),
    filterTimeMs: parseFloatOrZero(fields.filter_time),
    terms: parseIntOrZero(fields.terms),
    ngrams: parseIntOrZero(fields.ngrams),
    candidates: parseIntOrZero(fields.candidates),
    afterIntersection: parseIntOrZero(fields.after_intersection),
    afterNot: parseIntOrZero(fields.after_not),
    afterFilters: parseIntOrZero(fields.after_filters),
    final: parseIntOrZero(fields.final),
    optimization: fields.optimization ?? ''
  };
  if (fields.sort !== undefined) debug.sort = fields.sort;
  if (fields.cache !== undefined) debug.cache = fields.cache;
  if (fields.cache_age_ms !== undefined) debug.cacheAgeMs = parseFloat(fields.cache_age_ms);
  if (fields.cache_saved_ms !== undefined) debug.cacheSavedMs = parseFloat(fields.cache_saved_ms);
  const limit = intOrUndefined(fields.limit);
  if (limit !== undefined) debug.limit = limit;
  const offset = intOrUndefined(fields.offset);
  if (offset !== undefined) debug.offset = offset;
  return debug;
}

/**
 * Parse DUMP STATUS response.
 *
 * @param {string} response - Raw response (newline-normalized)
 * @returns {DumpStatus} Parsed dump status
 * @throws {ProtocolError} When the response prefix is not `OK DUMP_STATUS`
 */
export function parseDumpStatusResponse(response: string): DumpStatus {
  if (!response.startsWith('OK DUMP_STATUS')) {
    throw new ProtocolError(`Invalid DUMP STATUS response: ${response}`);
  }

  const lines = response.split('\n').slice(1);
  const fields = parseColonKeyValueLines(lines);
  const status: DumpStatus = {
    status: fields.status ?? 'idle',
    filepath: fields.filepath ?? '',
    tablesTotal: parseIntOrZero(fields.tables_total),
    tablesProcessed: parseIntOrZero(fields.tables_processed),
    currentTable: fields.current_table ?? '',
    elapsedSeconds: parseFloatOrZero(fields.elapsed_seconds)
  };
  if (fields.error !== undefined) {
    status.error = fields.error;
  }
  return status;
}

/**
 * Parse CACHE STATS response.
 *
 * @param {string} response - Raw response (newline-normalized)
 * @returns {CacheStats} Parsed cache stats
 * @throws {ProtocolError} When the response prefix is not `OK CACHE_STATS`
 */
export function parseCacheStatsResponse(response: string): CacheStats {
  if (!response.startsWith('OK CACHE_STATS')) {
    throw new ProtocolError(`Invalid CACHE STATS response: ${response}`);
  }

  const lines = response.split('\n').slice(1);
  const fields = parseColonKeyValueLines(lines);
  return {
    enabled: fields.enabled === 'true',
    maxMemoryMb: parseFloatOrZero(fields.max_memory_mb),
    currentMemoryMb: parseFloatOrZero(fields.current_memory_mb),
    entries: parseIntOrZero(fields.entries),
    hits: parseIntOrZero(fields.hits),
    misses: parseIntOrZero(fields.misses),
    hitRate: parseFloatOrZero(fields.hit_rate?.replace('%', '')),
    evictions: parseIntOrZero(fields.evictions),
    ttlSeconds: parseIntOrZero(fields.ttl_seconds)
  };
}

function parseIntOrZero(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseFloatOrZero(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
