import type * as net from 'node:net';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { MygramClient } from '../src/client';
import { ProtocolError } from '../src/errors';
import {
  parseCacheStatsResponse,
  parseDocumentResponse,
  parseDumpStatusResponse,
  parseReplicationStatusResponse,
  parseSearchResponse,
  unescapeResponseValue
} from '../src/response-parser';

vi.mock('node:net', async () => {
  const { EventEmitter } = await vi.importActual<typeof import('node:events')>('node:events');

  class MockSocket extends EventEmitter {
    setEncoding = vi.fn();
    setTimeout = vi.fn();
    connect = vi.fn();
    write = vi.fn();
    destroy = vi.fn();
  }

  return { Socket: MockSocket };
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function connectedClient(config = {}): Promise<{ client: MygramClient; socket: net.Socket }> {
  const client = new MygramClient(config);
  const connectPromise = client.connect();
  const socket = (client as unknown as { connection: { socket: net.Socket } }).connection.socket;
  socket.emit('connect');
  await flush();
  await connectPromise;
  return { client, socket };
}

function lastCommand(socket: net.Socket): string {
  const written = (socket.write as MockInstance).mock.calls.map((call) => call[0] as string);
  return written[written.length - 1];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('escaped response values', () => {
  it('returns an unquoted token unchanged', () => {
    expect(unescapeResponseValue('plain-key')).toBe('plain-key');
  });

  it('decodes the escapes the server writes inside quotes', () => {
    expect(unescapeResponseValue('"a b"')).toBe('a b');
    expect(unescapeResponseValue('"back\\\\slash"')).toBe('back\\slash');
    expect(unescapeResponseValue('"say \\"hi\\""')).toBe('say "hi"');
    expect(unescapeResponseValue('"line\\r\\nbreak\\ttab"')).toBe('line\r\nbreak\ttab');
    expect(unescapeResponseValue('"bell\\x07"')).toBe('bell');
  });

  it('decodes an empty quoted value, which the server always quotes', () => {
    expect(unescapeResponseValue('""')).toBe('');
  });

  it('leaves an unrecognized escape as the literal character', () => {
    expect(unescapeResponseValue('"a\\qb"')).toBe('aqb');
    expect(unescapeResponseValue('"a\\xZZ"')).toBe('axZZ');
  });
});

describe('SEARCH primary key decoding', () => {
  it('keeps a quoted key with spaces as one result', () => {
    const parsed = parseSearchResponse('OK RESULTS 2 plain "key with spaces"');
    expect(parsed.totalCount).toBe(2);
    expect(parsed.results.map((r) => r.primaryKey)).toEqual(['plain', 'key with spaces']);
  });

  it('decodes escapes inside a quoted key', () => {
    const parsed = parseSearchResponse('OK RESULTS 1 "a\\\\b \\"c\\""');
    expect(parsed.results[0].primaryKey).toBe('a\\b "c"');
  });

  it('decodes the key in HIGHLIGHT mode and leaves the snippet alone', () => {
    const parsed = parseSearchResponse('OK RESULTS 1\n"key with spaces"\tthe <b>hit</b> here');
    expect(parsed.results[0].primaryKey).toBe('key with spaces');
    expect(parsed.results[0].snippet).toBe('the <b>hit</b> here');
  });
});

describe('GET document decoding', () => {
  it('splits columns on the first = and keeps quoted values whole', () => {
    const doc = parseDocumentResponse('OK DOC 42 status=published title="Hello World" url="a=b&c=d"');
    expect(doc.primaryKey).toBe('42');
    expect(doc.fields).toEqual({
      status: 'published',
      title: 'Hello World',
      url: 'a=b&c=d'
    });
  });

  it('decodes a quoted primary key', () => {
    const doc = parseDocumentResponse('OK DOC "key with spaces" n=1');
    expect(doc.primaryKey).toBe('key with spaces');
    expect(doc.fields).toEqual({ n: '1' });
  });

  it('keeps NULL and boolean column values as the server spells them', () => {
    const doc = parseDocumentResponse('OK DOC 1 a=NULL b=true c=false');
    expect(doc.fields).toEqual({ a: 'NULL', b: 'true', c: 'false' });
  });
});

describe('CACHE STATS parsing', () => {
  const response = [
    'OK CACHE_STATS',
    '',
    '# Cache',
    'enabled: true',
    'total_queries: 10',
    'cache_hits: 7',
    'cache_misses: 3',
    'hit_rate: 0.7000',
    'current_entries: 5',
    'current_memory_bytes: 2097152',
    'invalidation_queue_memory_bytes: 512',
    'total_time_saved_ms: 42.500',
    'END'
  ].join('\n');

  it('reads the field names the server actually emits', () => {
    const stats = parseCacheStatsResponse(response);
    expect(stats.hits).toBe(7);
    expect(stats.misses).toBe(3);
    expect(stats.entries).toBe(5);
    expect(stats.totalQueries).toBe(10);
    expect(stats.currentMemoryBytes).toBe(2097152);
    expect(stats.currentMemoryMb).toBe(2);
    expect(stats.invalidationQueueMemoryBytes).toBe(512);
    expect(stats.totalTimeSavedMs).toBe(42.5);
  });

  it('reports the hit rate as a ratio, not a percentage', () => {
    expect(parseCacheStatsResponse(response).hitRate).toBe(0.7);
  });
});

describe('REPLICATION STATUS v1.10 fields', () => {
  const response = [
    'OK REPLICATION',
    'status: failed',
    'current_gtid: uuid:1-100',
    'processed_events: 4242',
    'queue_size: 0',
    'crc_errors: 2',
    'schema_incompatible: false',
    'last_error_code: 2017',
    'last_error: Undecodable binlog event',
    'last_applied_unixtime: 1770000000',
    'seconds_since_last_applied: 120',
    'END'
  ].join('\n');

  it('surfaces the diagnostic fields', () => {
    const status = parseReplicationStatusResponse(response);
    expect(status.running).toBe(false);
    expect(status.state).toBe('failed');
    expect(status.crcErrors).toBe(2);
    expect(status.schemaIncompatible).toBe(false);
    expect(status.lastErrorCode).toBe(2017);
    expect(status.lastError).toBe('Undecodable binlog event');
    expect(status.lastAppliedUnixtime).toBe(1770000000);
    expect(status.secondsSinceLastApplied).toBe(120);
  });

  it('separates a failure from a requested stop', () => {
    const stopped = parseReplicationStatusResponse('OK REPLICATION\nstatus: stopped\ncurrent_gtid: \nEND');
    expect(stopped.running).toBe(false);
    expect(stopped.state).toBe('stopped');
  });

  it('leaves the error code unset when the server reports none', () => {
    const clean = parseReplicationStatusResponse(
      'OK REPLICATION\nstatus: running\ncurrent_gtid: uuid:1-5\nlast_error_code: 0\nlast_error: \nEND'
    );
    expect(clean.lastErrorCode).toBeUndefined();
    expect(clean.lastError).toBeUndefined();
  });

  it('leaves the new fields undefined for a pre-v1.10 response', () => {
    const legacy = parseReplicationStatusResponse('OK REPLICATION\nstatus: running\ncurrent_gtid: uuid:1-5\nEND');
    expect(legacy.running).toBe(true);
    expect(legacy.crcErrors).toBeUndefined();
    expect(legacy.lastAppliedUnixtime).toBeUndefined();
  });
});

describe('DUMP STATUS parsing', () => {
  it('reports the in-progress flags and the written path', () => {
    const status = parseDumpStatusResponse(
      [
        'OK DUMP_STATUS',
        'save_in_progress: false',
        'load_in_progress: false',
        'replication_paused_for_dump: false',
        'status: COMPLETED',
        'filepath: /var/lib/mygramdb/dump.mgd',
        'tables_processed: 2',
        'tables_total: 2',
        'elapsed_seconds: 3.25',
        'result_filepath: /var/lib/mygramdb/dump.mgd',
        'END'
      ].join('\n')
    );
    expect(status.status).toBe('COMPLETED');
    expect(status.saveInProgress).toBe(false);
    expect(status.loadInProgress).toBe(false);
    expect(status.replicationPausedForDump).toBe(false);
    expect(status.resultFilepath).toBe('/var/lib/mygramdb/dump.mgd');
    expect(status.elapsedSeconds).toBe(3.25);
  });

  it('reports a paused replication while a save runs', () => {
    const status = parseDumpStatusResponse(
      [
        'OK DUMP_STATUS',
        'save_in_progress: true',
        'load_in_progress: false',
        'replication_paused_for_dump: true',
        'status: SAVING',
        'END'
      ].join('\n')
    );
    expect(status.saveInProgress).toBe(true);
    expect(status.replicationPausedForDump).toBe(true);
    expect(status.resultFilepath).toBeUndefined();
  });
});

describe('DUMP SAVE without a path', () => {
  it('omits the argument so the server uses its configured default', async () => {
    const { client, socket } = await connectedClient();
    const promise = client.dumpSave();
    socket.emit('data', 'OK DUMP_STARTED /var/lib/mygramdb/default.mgd\r\n');
    await expect(promise).resolves.toBe('/var/lib/mygramdb/default.mgd');
    expect(lastCommand(socket)).toBe('DUMP SAVE\r\n');
  });

  it('still quotes an explicit path', async () => {
    const { client, socket } = await connectedClient();
    const promise = client.dumpSave('/tmp/with space.mgd');
    socket.emit('data', 'OK DUMP_STARTED /tmp/with space.mgd\r\n');
    await promise;
    expect(lastCommand(socket)).toBe('DUMP SAVE "/tmp/with space.mgd"\r\n');
  });
});

describe('operation-specific deadlines', () => {
  it('gives DUMP SAVE its own budget instead of the request timeout', async () => {
    vi.useFakeTimers();
    try {
      const { client, socket } = await connectedClient({ timeout: 1000, dumpSaveTimeout: 60000 });
      const promise = client.dumpSave('/tmp/dump.mgd');
      const settled = vi.fn();
      promise.then(settled, settled);

      // Past the ordinary request timeout, the dump is still running.
      await vi.advanceTimersByTimeAsync(5000);
      expect(settled).not.toHaveBeenCalled();

      socket.emit('data', 'OK DUMP_STARTED /tmp/dump.mgd\r\n');
      await expect(promise).resolves.toBe('/tmp/dump.mgd');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still bounds DUMP SAVE at its own deadline', async () => {
    vi.useFakeTimers();
    try {
      const { client } = await connectedClient({ timeout: 1000, dumpSaveTimeout: 10000 });
      const promise = client.dumpSave('/tmp/dump.mgd');
      const rejection = expect(promise).rejects.toThrow('Command timeout');
      await vi.advanceTimersByTimeAsync(10001);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an ordinary command on the request timeout', async () => {
    vi.useFakeTimers();
    try {
      const { client } = await connectedClient({ timeout: 1000, dumpSaveTimeout: 60000 });
      const promise = client.search('articles', 'hello');
      const rejection = expect(promise).rejects.toThrow('Command timeout');
      await vi.advanceTimersByTimeAsync(1001);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults the connect deadline to the request timeout', () => {
    const client = new MygramClient({ timeout: 1234 });
    const config = (client as unknown as { config: { connectTimeout: number } }).config;
    expect(config.connectTimeout).toBe(1234);
  });

  it('honours an explicit connect deadline', () => {
    const client = new MygramClient({ timeout: 1234, connectTimeout: 500 });
    const config = (client as unknown as { config: { connectTimeout: number } }).config;
    expect(config.connectTimeout).toBe(500);
  });
});

describe('response frame cap', () => {
  it('drops the connection when a frame outgrows maxResponseBytes', async () => {
    const { client, socket } = await connectedClient({ maxResponseBytes: 64 });
    const promise = client.search('articles', 'hello');
    // Never terminated, so the buffer keeps growing past the cap.
    socket.emit('data', `OK RESULTS 1 ${'x'.repeat(128)}`);
    await expect(promise).rejects.toThrow(ProtocolError);
    await expect(promise).rejects.toThrow('maxResponseBytes');
    expect(client.isConnected()).toBe(false);
  });

  it('accepts a frame that fits', async () => {
    const { client, socket } = await connectedClient({ maxResponseBytes: 1024 });
    const promise = client.search('articles', 'hello');
    socket.emit('data', 'OK RESULTS 1 doc-1\r\n');
    await expect(promise).resolves.toMatchObject({ totalCount: 1 });
  });
});
