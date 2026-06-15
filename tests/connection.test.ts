import type * as net from 'node:net';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { MygramClient } from '../src/client';
import { isResponseComplete } from '../src/connection';
import { ConnectionError, InputValidationError, ProtocolError, TimeoutError } from '../src/errors';

vi.mock('node:net', async () => {
  const { EventEmitter } = await vi.importActual<typeof import('node:events')>('node:events');

  class MockSocket extends EventEmitter {
    setEncoding = vi.fn();
    setTimeout = vi.fn();
    connect = vi.fn();
    write = vi.fn();
    destroy = vi.fn();
  }

  return {
    Socket: MockSocket
  };
});

function getInternalSocket(client: MygramClient): net.Socket {
  return (client as unknown as { connection: { socket: net.Socket } }).connection.socket;
}

function createConnectedClient(config = {}): { client: MygramClient; socket: net.Socket } {
  const client = new MygramClient(config);
  const connectPromise = client.connect();
  const socket = getInternalSocket(client);
  socket.emit('connect');
  connectPromise.catch(() => {});
  return { client, socket };
}

describe('isResponseComplete', () => {
  describe('END-marker responses', () => {
    it('treats OK INFO as complete only after END\\r\\n', () => {
      expect(isResponseComplete('OK INFO\r\nversion: 1.0\r\n')).toBe(false);
      expect(isResponseComplete('OK INFO\r\nversion: 1.0\r\n\r\n')).toBe(false);
      expect(isResponseComplete('OK INFO\r\nversion: 1.0\r\nEND\r\n')).toBe(true);
    });

    it('treats OK CACHE_STATS as complete only after END marker', () => {
      // Server response has internal blank lines, so \r\n\r\n MUST NOT trigger completion.
      expect(isResponseComplete('OK CACHE_STATS\r\n\r\nenabled: true\r\n\r\n')).toBe(false);
      expect(isResponseComplete('OK CACHE_STATS\r\n\r\nenabled: true\r\n\r\nEND\r\n')).toBe(true);
    });

    it('treats OK DUMP_STATUS as complete only after END marker', () => {
      expect(isResponseComplete('OK DUMP_STATUS\r\nstatus: idle\r\n')).toBe(false);
      expect(isResponseComplete('OK DUMP_STATUS\r\nstatus: idle\r\nEND\r\n')).toBe(true);
    });

    it('treats OK DUMP_INFO (with filepath) as complete only after END marker', () => {
      expect(isResponseComplete('OK DUMP_INFO /tmp/d.bin\r\nversion: 2\r\n')).toBe(false);
      expect(isResponseComplete('OK DUMP_INFO /tmp/d.bin\r\nversion: 2\r\nEND\r\n')).toBe(true);
    });

    it('treats OK REPLICATION as complete only after END marker', () => {
      expect(isResponseComplete('OK REPLICATION\r\nstatus: running\r\n')).toBe(false);
      expect(isResponseComplete('OK REPLICATION\r\nstatus: running\r\nEND\r\n')).toBe(true);
    });

    it('also accepts LF-only END terminators (legacy mocks)', () => {
      expect(isResponseComplete('OK INFO\nversion: 1\nEND\n')).toBe(true);
      expect(isResponseComplete('OK CACHE_STATS\nenabled: true\nEND\n')).toBe(true);
    });
  });

  describe('blank-line responses', () => {
    it('treats +OK CONFIG response as complete after \\r\\n\\r\\n', () => {
      expect(isResponseComplete('+OK\r\nport: 11016\r\n')).toBe(false);
      expect(isResponseComplete('+OK\r\nport: 11016\r\n\r\n')).toBe(true);
    });

    it('treats OK FACET as complete after \\r\\n\\r\\n', () => {
      expect(isResponseComplete('OK FACET 2\r\nfoo\t1\r\nbar\t2\r\n')).toBe(false);
      expect(isResponseComplete('OK FACET 2\r\nfoo\t1\r\nbar\t2\r\n\r\n')).toBe(true);
    });
  });

  describe('single-line responses', () => {
    it('treats OK COUNT as complete after first \\r\\n', () => {
      expect(isResponseComplete('OK COUNT 42\r\n')).toBe(true);
      expect(isResponseComplete('OK COUNT 42\n')).toBe(true);
    });

    it('treats OK RESULTS without DEBUG as complete after first \\r\\n', () => {
      expect(isResponseComplete('OK RESULTS 3 a b c\r\n')).toBe(true);
    });

    it('treats OK RESULTS with DEBUG as multi-line ending in blank line', () => {
      expect(isResponseComplete('OK RESULTS 1 id1\r\n# DEBUG\r\nquery_time: 0.5\r\n')).toBe(false);
      expect(isResponseComplete('OK RESULTS 1 id1\r\n# DEBUG\r\nquery_time: 0.5\r\n\r\n')).toBe(true);
    });

    it('returns false on incomplete buffers', () => {
      expect(isResponseComplete('')).toBe(false);
      expect(isResponseComplete('OK RESULTS')).toBe(false);
      expect(isResponseComplete('OK INFO')).toBe(false);
    });
  });
});

describe('Connection - command queue serialization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serializes concurrent sendCommand calls (FIFO)', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const writes: string[] = [];
    (socket.write as MockInstance).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });

    const p1 = client.sendCommand('FIRST');
    const p2 = client.sendCommand('SECOND');
    const p3 = client.sendCommand('THIRD');

    // Only the first command is on the wire until its response arrives.
    expect(writes).toEqual(['FIRST\r\n']);

    socket.emit('data', 'OK ONE\r\n');
    expect(await p1).toBe('OK ONE');

    // After the first response, the second command is dispatched.
    expect(writes).toEqual(['FIRST\r\n', 'SECOND\r\n']);
    socket.emit('data', 'OK TWO\r\n');
    expect(await p2).toBe('OK TWO');

    expect(writes).toEqual(['FIRST\r\n', 'SECOND\r\n', 'THIRD\r\n']);
    socket.emit('data', 'OK THREE\r\n');
    expect(await p3).toBe('OK THREE');
  });

  it('preserves response ordering across concurrent callers', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const order: string[] = [];
    const p1 = client.sendCommand('A').then((r) => {
      order.push(`a:${r}`);
    });
    const p2 = client.sendCommand('B').then((r) => {
      order.push(`b:${r}`);
    });

    socket.emit('data', 'OK A\r\n');
    socket.emit('data', 'OK B\r\n');
    await Promise.all([p1, p2]);

    expect(order).toEqual(['a:OK A', 'b:OK B']);
  });

  it('rejects all queued commands when socket closes mid-flight', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const p1 = client.sendCommand('FIRST');
    const p2 = client.sendCommand('SECOND');
    const p3 = client.sendCommand('THIRD');

    socket.emit('close');

    await expect(p1).rejects.toThrow(ConnectionError);
    await expect(p2).rejects.toThrow(ConnectionError);
    await expect(p3).rejects.toThrow(ConnectionError);
  });

  it('rejects queued commands when an error fires mid-flight', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const p1 = client.sendCommand('FIRST');
    const p2 = client.sendCommand('SECOND');

    socket.emit('error', new Error('Connection reset'));

    await expect(p1).rejects.toThrow(ConnectionError);
    await expect(p2).rejects.toThrow(ConnectionError);
  });
});

describe('Connection - connect timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects connect() with TimeoutError when no connect event arrives', async () => {
    vi.useFakeTimers();

    const client = new MygramClient({ host: 'unreachable.example', port: 11016, timeout: 1000 });
    const promise = client.connect();
    promise.catch(() => {});

    // Advance past the configured timeout without emitting 'connect'.
    await vi.advanceTimersByTimeAsync(1100);

    await expect(promise).rejects.toThrow(TimeoutError);
    expect(client.isConnected()).toBe(false);
  });
});

describe('CACHE STATS / DUMP STATUS / DUMP INFO multi-line END detection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('CACHE STATS with internal blank lines is parsed correctly', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const promise = client.cacheStats();

    // Mirror real server output: blank line after header AND before END.
    socket.emit('data', 'OK CACHE_STATS\r\n\r\n# Cache\r\nenabled: true\r\nhits: 100\r\nmisses: 5\r\n\r\nEND\r\n');

    const stats = await promise;
    expect(stats.enabled).toBe(true);
    expect(stats.hits).toBe(100);
    expect(stats.misses).toBe(5);
  });

  it('DUMP STATUS terminated with END marker is parsed correctly', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const promise = client.dumpStatus();
    socket.emit('data', 'OK DUMP_STATUS\r\nstatus: SAVING\r\nfilepath: /tmp/d.bin\r\nEND\r\n');

    const status = await promise;
    expect(status.status).toBe('SAVING');
    expect(status.filepath).toBe('/tmp/d.bin');
  });

  it('DUMP INFO with filepath suffix is detected as multi-line', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const promise = client.dumpInfo('/tmp/d.bin');
    socket.emit('data', 'OK DUMP_INFO /tmp/d.bin\r\nversion: 2\r\ngtid: xyz\r\nEND\r\n');

    const result = await promise;
    expect(result).toContain('OK DUMP_INFO /tmp/d.bin');
    expect(result).toContain('version: 2');
  });

  it('does not prematurely complete CACHE STATS when only the header blank arrived', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const promise = client.cacheStats();

    // First chunk includes header + first blank line. Detection must NOT fire.
    socket.emit('data', 'OK CACHE_STATS\r\n\r\n');
    // Second chunk completes the response.
    socket.emit('data', '# Cache\r\nenabled: true\r\nEND\r\n');

    const stats = await promise;
    expect(stats.enabled).toBe(true);
  });
});

describe('REPLICATION STATUS - processed_events / queue_size', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes processedEvents and queueSize from multi-line responses', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const promise = client.getReplicationStatus();
    socket.emit(
      'data',
      'OK REPLICATION\r\nstatus: running\r\ncurrent_gtid: srv-1:1-100\r\nprocessed_events: 4242\r\nqueue_size: 7\r\nEND\r\n'
    );

    const status = await promise;
    expect(status.running).toBe(true);
    expect(status.gtid).toBe('srv-1:1-100');
    expect(status.processedEvents).toBe(4242);
    expect(status.queueSize).toBe(7);
  });

  it('omits processedEvents and queueSize when not advertised by the server', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const promise = client.getReplicationStatus();
    socket.emit('data', 'OK REPLICATION\r\nstatus: stopped\r\ncurrent_gtid: \r\nEND\r\n');

    const status = await promise;
    expect(status.running).toBe(false);
    expect(status.processedEvents).toBeUndefined();
    expect(status.queueSize).toBeUndefined();
  });
});

describe('identifier whitespace validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects table names containing whitespace before sending', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    await expect(client.search('bad table', 'q')).rejects.toThrow(InputValidationError);
    expect((socket.write as MockInstance).mock.calls.length).toBe(0);
  });

  it('rejects empty table names before sending', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    await expect(client.count('', 'q')).rejects.toThrow(InputValidationError);
    expect((socket.write as MockInstance).mock.calls.length).toBe(0);
  });

  it('rejects primary keys with whitespace', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    await expect(client.get('articles', 'a b')).rejects.toThrow(InputValidationError);
    expect((socket.write as MockInstance).mock.calls.length).toBe(0);
  });

  it('rejects sortColumn with whitespace', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    await expect(client.search('articles', 'q', { sortColumn: 'created at' })).rejects.toThrow(InputValidationError);
    expect((socket.write as MockInstance).mock.calls.length).toBe(0);
  });

  it('rejects filter keys with whitespace but allows filter values with spaces', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    // Filter key with whitespace: rejected.
    await expect(client.search('articles', 'q', { filters: { 'bad key': 'v' } })).rejects.toThrow(InputValidationError);
    expect((socket.write as MockInstance).mock.calls.length).toBe(0);

    // Filter value with whitespace: allowed, and quoted so it stays a single
    // token on the wire (matches the C++ client's EscapeQueryString).
    const promise = client.search('articles', 'q', { filters: { status: 'in progress' } });
    const command = (socket.write as MockInstance).mock.calls[0][0] as string;
    expect(command).toContain('FILTER status = "in progress"');
    socket.emit('data', 'OK RESULTS 0\r\n');
    await promise;
  });

  it('quotes dump filepaths with whitespace so they stay one token', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.dumpSave('/tmp/has space.bin');
    const command = (socket.write as MockInstance).mock.calls[0][0] as string;
    expect(command).toBe('DUMP SAVE "/tmp/has space.bin"\r\n');
    socket.emit('data', 'OK DUMP_SAVED /tmp/has space.bin\r\n');
    await promise;
  });

  it('rejects dump filepaths with control characters', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    await expect(client.dumpSave('/tmp/bad\nname.bin')).rejects.toThrow(InputValidationError);
    expect((socket.write as MockInstance).mock.calls.length).toBe(0);
  });
});

describe('OFFSET-only emission', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits "OFFSET <n>" when offset > 0 and limit === 0', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const promise = client.search('articles', 'hello', { offset: 25, limit: 0 });
    const command = (socket.write as MockInstance).mock.calls[0][0] as string;

    expect(command).toContain('OFFSET 25');
    expect(command).not.toContain('LIMIT 0,25');
    expect(command).not.toMatch(/LIMIT\s+0/);

    socket.emit('data', 'OK RESULTS 0\r\n');
    await promise;
  });

  it('still emits "LIMIT <offset>,<limit>" when both are set', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const promise = client.search('articles', 'hello', { offset: 10, limit: 50 });
    const command = (socket.write as MockInstance).mock.calls[0][0] as string;

    expect(command).toContain('LIMIT 10,50');
    expect(command).not.toContain('OFFSET');

    socket.emit('data', 'OK RESULTS 0\r\n');
    await promise;
  });

  it('emits no LIMIT/OFFSET when both are 0', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const promise = client.search('articles', 'hello', { offset: 0, limit: 0 });
    const command = (socket.write as MockInstance).mock.calls[0][0] as string;

    expect(command).not.toContain('LIMIT');
    expect(command).not.toContain('OFFSET');

    socket.emit('data', 'OK RESULTS 0\r\n');
    await promise;
  });
});

describe('empty query escaping', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('quotes empty SEARCH query as "" so the server sees a well-formed token', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const promise = client.search('articles', '', { limit: 10 });
    const command = (socket.write as MockInstance).mock.calls[0][0] as string;

    expect(command).toContain('SEARCH articles ""');

    socket.emit('data', 'OK RESULTS 0\r\n');
    await promise;
  });

  it('quotes empty COUNT query as ""', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const promise = client.count('articles', '');
    const command = (socket.write as MockInstance).mock.calls[0][0] as string;

    expect(command).toContain('COUNT articles ""');

    socket.emit('data', 'OK COUNT 0\r\n');
    await promise;
  });

  it('passes non-empty queries through unchanged', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const promise = client.search('articles', 'hello', { limit: 1 });
    const command = (socket.write as MockInstance).mock.calls[0][0] as string;

    expect(command).toContain('SEARCH articles hello');
    expect(command).not.toContain('""');

    socket.emit('data', 'OK RESULTS 0\r\n');
    await promise;
  });
});

describe('ProtocolError still surfaces normally', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects sendCommand with ProtocolError on ERROR responses', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const promise = client.sendCommand('BAD');
    socket.emit('data', 'ERROR something went wrong\r\n');

    await expect(promise).rejects.toThrow(ProtocolError);
    await expect(promise).rejects.toThrow('something went wrong');
  });
});
