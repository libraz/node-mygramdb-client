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
  ReplicationState,
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
 * Decode one server-escaped response value.
 *
 * The server quotes a primary key or a string filter value whenever it is
 * empty or contains whitespace, a double quote, a backslash or a control
 * character, escaping `\\`, `\"`, `\r`, `\n`, `\t` and `\xNN` inside the
 * quotes. An unquoted token is returned as-is, so this is safe to apply to
 * every token.
 *
 * @param {string} token - Single token exactly as it appeared on the wire
 * @returns {string} The original value
 */
export function unescapeResponseValue(token: string): string {
  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) {
    return token;
  }

  const body = token.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\') {
      out += body[i];
      continue;
    }
    i += 1;
    switch (body[i]) {
      case 'r':
        out += '\r';
        break;
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'x': {
        const hex = body.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 2;
        } else {
          out += 'x';
        }
        break;
      }
      case undefined:
        // Trailing backslash: keep it rather than dropping data.
        out += '\\';
        break;
      default:
        out += body[i];
        break;
    }
  }
  return out;
}

/**
 * Split a response line into space-delimited tokens, keeping a quoted section
 * whole.
 *
 * A space only ends a token outside quotes, so both a standalone quoted value
 * and a `column="a b"` pair survive the split. Escaped characters are left
 * untouched here and decoded by {@link unescapeResponseValue}.
 *
 * @param {string} line - Response line without its trailing newline
 * @returns {string[]} Raw tokens, still escaped
 */
function tokenizeResponseLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && inQuotes && i + 1 < line.length) {
      current += ch + line[i + 1];
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === ' ' && !inQuotes) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current !== '') {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Decoded `ERROR` frame payload.
 */
export interface ParsedErrorFrame {
  /** Numeric error code, or `undefined` for an untyped (pre-v1.10) frame */
  code: number | undefined;
  /** Human-readable message with the code prefix removed */
  message: string;
}

/** Largest value the server can encode in an `ERROR` frame's `uint16` code. */
const MAX_ERROR_CODE = 65535;

/**
 * Parse the leading token of an `ERROR` frame payload as a numeric code.
 *
 * Mirrors the server's `protocol::ParseErrorFrame`: a token counts as a code
 * only when it is all decimal digits, fits in a `uint16`, and is non-zero.
 * Anything else means the frame came from a pre-v1.10 server and the whole
 * payload is the message.
 *
 * @param {string} token - First whitespace-delimited token of the payload
 * @returns {number | undefined} The code, or undefined when the token is not one
 */
function parseErrorCodeToken(token: string): number | undefined {
  if (token === '' || !/^[0-9]+$/.test(token)) {
    return undefined;
  }
  const code = Number.parseInt(token, 10);
  if (code === 0 || code > MAX_ERROR_CODE) {
    return undefined;
  }
  return code;
}

/**
 * Parse an `ERROR` frame into a code and a message.
 *
 * MygramDB v1.10+ emits `ERROR <code> <message>`; earlier servers emit
 * `ERROR <message>`. Both are accepted, so one client talks to either.
 *
 * @param {string} frame - Complete `ERROR` frame (newline-normalized, trimmed)
 * @returns {ParsedErrorFrame | null} Decoded payload, or null when the frame is
 *   not an `ERROR` frame at all
 *
 * @example
 * ```typescript
 * parseErrorFrame('ERROR 4007 Table not found');
 * // => { code: 4007, message: 'Table not found' }
 * parseErrorFrame('ERROR Table not found');
 * // => { code: undefined, message: 'Table not found' }
 * ```
 */
export function parseErrorFrame(frame: string): ParsedErrorFrame | null {
  if (!frame.startsWith('ERROR ')) {
    return null;
  }

  const payload = frame.substring('ERROR '.length);
  const separator = payload.indexOf(' ');
  const codeToken = separator === -1 ? payload : payload.substring(0, separator);
  const code = parseErrorCodeToken(codeToken);
  if (code === undefined) {
    return { code: undefined, message: payload };
  }

  const message = separator === -1 ? '' : payload.substring(separator + 1);
  // A bare `ERROR <code>` carries no text; surface the code so the thrown
  // Error still has a usable message.
  return { code, message: message === '' ? `Server error ${code}` : message };
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

  const headerParts = tokenizeResponseLine(firstLine);
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
    // HIGHLIGHT mode: each payload line is "<pk>[\t<snippet>]". The snippet is
    // sanitized rather than escaped by the server, so only the key is decoded.
    results = payloadLines.map((line) => {
      const tab = line.indexOf('\t');
      if (tab < 0) {
        return { primaryKey: unescapeResponseValue(line), snippet: '' };
      }
      return { primaryKey: unescapeResponseValue(line.slice(0, tab)), snippet: line.slice(tab + 1) };
    });
  } else {
    // Classic mode: PKs follow the count on the first line.
    const ids = headerParts.slice(3);
    results = ids.map((id) => ({ primaryKey: unescapeResponseValue(id) }));
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
 * OK FACET <num_values> [<total_values>]
 * <value1>\t<count1>
 * <value2>\t<count2>
 * ...
 * ```
 * `<num_values>` counts the rows in this page; `<total_values>` is the distinct
 * value count before OFFSET and LIMIT and is sent by MygramDB v1.10+ only. When
 * an older server omits it, {@link FacetResponse.totalCount} falls back to the
 * page size.
 *
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
  const pageCount = parseInt(headerParts[2], 10);
  if (Number.isNaN(pageCount)) {
    throw new ProtocolError(`Invalid FACET count: ${headerParts[2]}`);
  }

  let totalCount = pageCount;
  if (headerParts.length >= 4 && headerParts[3] !== '') {
    const parsedTotal = parseInt(headerParts[3], 10);
    if (Number.isNaN(parsedTotal)) {
      throw new ProtocolError(`Invalid FACET total count: ${headerParts[3]}`);
    }
    totalCount = parsedTotal;
  }

  const results: FacetValue[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const tab = line.indexOf('\t');
    // A line starting with '#' is a comment (e.g. `# DEBUG`) only when it has
    // no tab. A facet value may legitimately start with '#', in which case the
    // line still has the `<value>\t<count>` shape and must be kept (MygramDB v1.8+).
    if (line === '' || (line.startsWith('#') && tab < 0)) continue;
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

  return { results, totalCount };
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
 * The wire form is `OK DOC <primaryKey> <column>=<value> ...`. The primary key
 * and any string column value are quoted and escaped by the server when they
 * are empty or carry whitespace, a quote, a backslash or a control character,
 * so tokens are split with quoting in mind and then decoded. A value may
 * itself contain `=`; only the first one separates the column from the value.
 *
 * @param {string} response - Raw response (newline-normalized)
 * @returns {Document} Parsed document
 * @throws {ProtocolError} When the response prefix is not `OK DOC `
 */
export function parseDocumentResponse(response: string): Document {
  if (!response.startsWith('OK DOC ')) {
    throw new ProtocolError(`Invalid GET response: ${response}`);
  }

  const parts = tokenizeResponseLine(response.substring('OK DOC '.length));
  const primaryKey = parts.length > 0 ? unescapeResponseValue(parts[0]) : '';
  const fields: Record<string, string> = {};

  parts.slice(1).forEach((part) => {
    const separator = part.indexOf('=');
    if (separator <= 0) return;
    fields[part.slice(0, separator)] = unescapeResponseValue(part.slice(separator + 1));
  });

  return { primaryKey, fields };
}

/**
 * Parse INFO response.
 *
 * MygramDB v1.10+ additionally reports `data_initialized` and `readiness`,
 * evaluated from the same inputs as the HTTP health endpoint, so a TCP-only
 * deployment can gate traffic without polling HTTP. Both are left undefined
 * when an older server omits them.
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
  if (fields.data_initialized !== undefined) {
    info.dataInitialized = fields.data_initialized === 'true';
  }
  if (fields.readiness !== undefined) {
    info.ready = fields.readiness === 'ready';
  }
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
    if (fields.status !== undefined) {
      result.state = fields.status as ReplicationState;
    }
    type NumericField = 'processedEvents' | 'queueSize' | 'crcErrors' | 'lastErrorCode' | 'lastAppliedUnixtime';
    const assignInt = (key: NumericField | 'secondsSinceLastApplied', raw: string | undefined): void => {
      if (raw === undefined) return;
      const parsed = parseInt(raw, 10);
      if (!Number.isNaN(parsed)) {
        result[key] = parsed;
      }
    };
    assignInt('processedEvents', fields.processed_events);
    assignInt('queueSize', fields.queue_size);
    assignInt('crcErrors', fields.crc_errors);
    // The server reports 0 for "no error recorded"; leave the field unset so it
    // is never mistaken for a code in the ErrorCode table.
    if (fields.last_error_code !== undefined && fields.last_error_code !== '0') {
      assignInt('lastErrorCode', fields.last_error_code);
    }
    assignInt('lastAppliedUnixtime', fields.last_applied_unixtime);
    assignInt('secondsSinceLastApplied', fields.seconds_since_last_applied);
    if (fields.schema_incompatible !== undefined) {
      result.schemaIncompatible = fields.schema_incompatible === 'true';
    }
    if (fields.last_error !== undefined && fields.last_error !== '') {
      result.lastError = fields.last_error;
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
    status: fields.status ?? 'IDLE',
    filepath: fields.filepath ?? '',
    tablesTotal: parseIntOrZero(fields.tables_total),
    tablesProcessed: parseIntOrZero(fields.tables_processed),
    currentTable: fields.current_table ?? '',
    elapsedSeconds: parseFloatOrZero(fields.elapsed_seconds),
    saveInProgress: fields.save_in_progress === 'true',
    loadInProgress: fields.load_in_progress === 'true',
    replicationPausedForDump: fields.replication_paused_for_dump === 'true'
  };
  if (fields.error !== undefined) {
    status.error = fields.error;
  }
  if (fields.result_filepath !== undefined) {
    status.resultFilepath = fields.result_filepath;
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
  const currentMemoryBytes = parseIntOrZero(fields.current_memory_bytes);
  const stats: CacheStats = {
    enabled: fields.enabled === 'true',
    totalQueries: parseIntOrZero(fields.total_queries),
    hits: parseIntOrZero(fields.cache_hits),
    misses: parseIntOrZero(fields.cache_misses),
    hitRate: parseFloatOrZero(fields.hit_rate),
    entries: parseIntOrZero(fields.current_entries),
    currentMemoryBytes,
    currentMemoryMb: currentMemoryBytes / BYTES_PER_MB,
    invalidationIndexMemoryBytes: parseIntOrZero(fields.invalidation_index_memory_bytes),
    invalidationQueueMemoryBytes: parseIntOrZero(fields.invalidation_queue_memory_bytes),
    accountedMemoryBytes: parseIntOrZero(fields.accounted_memory_bytes),
    evictions: parseIntOrZero(fields.evictions),
    ttlExpirations: parseIntOrZero(fields.ttl_expirations),
    rejections: parseIntOrZero(fields.rejection_count),
    rejectionOversize: parseIntOrZero(fields.rejection_oversize),
    rejectionMemoryBudget: parseIntOrZero(fields.rejection_memory_budget),
    rejectionDuplicate: parseIntOrZero(fields.rejection_duplicate),
    staleEntryRemovals: parseIntOrZero(fields.stale_entry_removals),
    decompressionFailures: parseIntOrZero(fields.decompression_failures),
    staleLruEntries: parseIntOrZero(fields.stale_lru_entries),
    invalidationsImmediate: parseIntOrZero(fields.invalidations_immediate),
    invalidationsDeferred: parseIntOrZero(fields.invalidations_deferred),
    invalidationsBatches: parseIntOrZero(fields.invalidations_batches),
    totalTimeSavedMs: parseFloatOrZero(fields.total_time_saved_ms)
  };
  // The server omits the timing lines entirely until the first hit or miss.
  if (fields.avg_cache_hit_time_ms !== undefined) {
    stats.avgHitTimeMs = parseFloatOrZero(fields.avg_cache_hit_time_ms);
  }
  if (fields.avg_cache_miss_time_ms !== undefined) {
    stats.avgMissTimeMs = parseFloatOrZero(fields.avg_cache_miss_time_ms);
  }
  return stats;
}

/** Bytes in one megabyte, for the display-oriented MB projections. */
const BYTES_PER_MB = 1024 * 1024;

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
