import type * as net from 'node:net';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { MygramClient } from '../src/client';
import {
  escapeQueryString,
  parseTableIdentity,
  qualifyTableIdentity,
  quoteCommandArgument
} from '../src/command-utils';
import { isResponseComplete } from '../src/connection';
import { InputValidationError, ProtocolError } from '../src/errors';
import { NativeMygramClient } from '../src/native-client';

// Reuse the existing mock pattern from v16-mock.test.ts
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

function createConnectedClient(config = {}): { client: MygramClient; socket: net.Socket } {
  const client = new MygramClient(config);
  const connectPromise = client.connect();
  const socket = (client as unknown as { connection: { socket: net.Socket } }).connection.socket;
  socket.emit('connect');
  connectPromise.catch(() => {});
  return { client, socket };
}

function lastCommand(socket: net.Socket): string {
  const calls = (socket.write as MockInstance).mock.calls;
  return calls[calls.length - 1][0] as string;
}

function createMockNative(overrides = {}) {
  return {
    createClient: vi.fn().mockReturnValue('handle'),
    connect: vi.fn().mockReturnValue(true),
    disconnect: vi.fn(),
    destroyClient: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    search: vi.fn(),
    sendCommand: vi.fn(),
    getLastError: vi.fn().mockReturnValue(''),
    simplifySearchExpression: vi.fn(),
    ...overrides
  };
}

describe('escapeQueryString (C++ EscapeQueryString parity)', () => {
  it('returns the explicit empty token for empty input', () => {
    expect(escapeQueryString('', 'query')).toBe('""');
  });

  it('passes single tokens through unchanged', () => {
    expect(escapeQueryString('hello', 'query')).toBe('hello');
    expect(escapeQueryString('機械学習', 'query')).toBe('機械学習');
  });

  it('quotes values containing whitespace', () => {
    expect(escapeQueryString('machine learning', 'query')).toBe('"machine learning"');
  });

  it('quotes and escapes embedded double quotes and backslashes', () => {
    expect(escapeQueryString('say "hi"', 'query')).toBe('"say \\"hi\\""');
    expect(escapeQueryString('a\\b c', 'query')).toBe('"a\\\\b c"');
  });

  it('quotes values containing a single quote even without spaces', () => {
    expect(escapeQueryString("o'brien", 'query')).toBe('"o\'brien"');
  });

  it('does NOT quote a lone backslash with no whitespace (matches C++ EscapeQueryString)', () => {
    expect(escapeQueryString('a\\b', 'query')).toBe('a\\b');
  });

  it('rejects control characters before quoting', () => {
    expect(() => escapeQueryString('a\nb', 'query')).toThrow(InputValidationError);
  });
});

describe('quoteCommandArgument', () => {
  it('quotes empty values as the explicit empty token', () => {
    expect(quoteCommandArgument('', 'value')).toBe('""');
  });

  it('passes simple values through and quotes spaced values', () => {
    expect(quoteCommandArgument('info', 'value')).toBe('info');
    expect(quoteCommandArgument('two words', 'value')).toBe('"two words"');
  });

  it('quotes a lone backslash (matches C++ QuoteCommandArgumentIfNeeded)', () => {
    expect(quoteCommandArgument('a\\b', 'value')).toBe('"a\\\\b"');
  });
});

describe('qualifyTableIdentity', () => {
  it('returns the bare table when no database is given', () => {
    expect(qualifyTableIdentity('articles')).toBe('articles');
    expect(qualifyTableIdentity('articles', '')).toBe('articles');
  });

  it('joins database and table with a dot', () => {
    expect(qualifyTableIdentity('articles', 'app_db')).toBe('app_db.articles');
  });

  it('rejects empty table names', () => {
    expect(() => qualifyTableIdentity('')).toThrow(InputValidationError);
  });

  it('rejects whitespace in either part', () => {
    expect(() => qualifyTableIdentity('a b', 'db')).toThrow(InputValidationError);
    expect(() => qualifyTableIdentity('t', 'a b')).toThrow(InputValidationError);
  });

  it('rejects a dot embedded in a part when a database is supplied separately', () => {
    expect(() => qualifyTableIdentity('schema.articles', 'app_db')).toThrow(InputValidationError);
    expect(() => qualifyTableIdentity('articles', 'a.b')).toThrow(InputValidationError);
  });
});

describe('parseTableIdentity', () => {
  it('parses a bare name with a null database', () => {
    expect(parseTableIdentity('articles')).toEqual({ database: null, table: 'articles' });
  });

  it('splits a qualified identity on the first dot', () => {
    expect(parseTableIdentity('app_db.articles')).toEqual({ database: 'app_db', table: 'articles' });
  });

  it('rejects empty halves', () => {
    expect(() => parseTableIdentity('.articles')).toThrow(InputValidationError);
    expect(() => parseTableIdentity('app_db.')).toThrow(InputValidationError);
  });

  it('rejects unsafe identities', () => {
    expect(() => parseTableIdentity('')).toThrow(InputValidationError);
    expect(() => parseTableIdentity('a b')).toThrow(InputValidationError);
  });
});

describe('isResponseComplete framing for SYNC_STATUS', () => {
  it('treats OK SYNC_STATUS as END-terminated multi-line', () => {
    expect(isResponseComplete('OK SYNC_STATUS\r\n')).toBe(false);
    expect(isResponseComplete('OK SYNC_STATUS\r\nstatus=IDLE\r\n')).toBe(false);
    expect(isResponseComplete('OK SYNC_STATUS\r\nstatus=IDLE\r\nEND\r\n')).toBe(true);
    expect(isResponseComplete('OK SYNC_STATUS\r\ntable=users status=RUNNING\r\nEND\r\n')).toBe(true);
    // The server appends a trailing blank line after END for SYNC_STATUS.
    expect(isResponseComplete('OK SYNC_STATUS\r\nstatus=IDLE message="x"\r\nEND\r\n\r\n')).toBe(true);
  });
});

describe('MygramClient v1.7 database-qualified table identity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes a database.table identity through SEARCH unchanged', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.search('app_db.articles', 'hello');
    expect(lastCommand(socket)).toContain('SEARCH app_db.articles hello');
    socket.emit('data', 'OK RESULTS 0\r\n');
    await promise;
  });

  it('quotes multi-word AND / NOT terms and filter values (C++ EscapeQueryString parity)', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.search('articles', 'hello', {
      andTerms: ['machine learning'],
      notTerms: ['old stuff'],
      filters: { status: 'in review' }
    });
    const command = lastCommand(socket);
    expect(command).toContain('AND "machine learning"');
    expect(command).toContain('NOT "old stuff"');
    expect(command).toContain('FILTER status = "in review"');
    // Single-word values stay verbatim.
    socket.emit('data', 'OK RESULTS 0\r\n');
    await promise;
  });

  it('searchWithHighlights enables the HIGHLIGHT clause', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.searchWithHighlights('articles', 'hello');
    expect(lastCommand(socket)).toMatch(/\bHIGHLIGHT\b/);
    socket.emit('data', 'OK RESULTS 1\r\npk1\t<em>hello</em>\r\n\r\n');
    const res = await promise;
    expect(res.results[0]).toEqual({ primaryKey: 'pk1', snippet: '<em>hello</em>' });
  });

  it('passes a database.table identity through COUNT, GET and FACET', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const countP = client.count('app_db.articles', 'x');
    expect(lastCommand(socket)).toContain('COUNT app_db.articles x');
    socket.emit('data', 'OK COUNT 0\r\n');
    await countP;

    const getP = client.get('app_db.articles', 'pk1');
    expect(lastCommand(socket)).toContain('GET app_db.articles pk1');
    socket.emit('data', 'OK DOC pk1\r\n');
    await getP;

    const facetP = client.facet('app_db.articles', 'category');
    expect(lastCommand(socket)).toContain('FACET app_db.articles category');
    socket.emit('data', 'OK FACET 0\r\n\r\n');
    await facetP;
  });
});

describe('MygramClient v1.7 searchRaw (boolean expressions)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a boolean expression verbatim (unquoted) so the server parses operators', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.searchRaw('articles', 'python OR (ruby AND rails)', { limit: 50 });
    const command = lastCommand(socket);
    // Unquoted: a quoted phrase embedding AND/OR/NOT would be treated as a
    // literal phrase by the server (MygramDB v1.8+).
    expect(command).toContain('SEARCH articles python OR (ruby AND rails)');
    expect(command).not.toContain('"python OR (ruby AND rails)"');
    expect(command.trimEnd()).toMatch(/LIMIT 50$/);
    socket.emit('data', 'OK RESULTS 0\r\n');
    await promise;
  });

  it('sends a nested boolean grouping verbatim', async () => {
    // The exact shape MygramDB 1.8.0 fixed: a nested OR group under AND must
    // reach the parser unquoted to be detected as boolean.
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.searchRaw('articles', 'alpha AND (xqz OR jkv)');
    expect(lastCommand(socket)).toContain('SEARCH articles alpha AND (xqz OR jkv)');
    socket.emit('data', 'OK RESULTS 0\r\n');
    await promise;
  });

  it('preserves an embedded quoted phrase inside a raw expression', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.searchRaw('articles', '"machine learning" OR python');
    // Embedded quotes pass through verbatim so the server handles the phrase.
    expect(lastCommand(socket)).toContain('SEARCH articles "machine learning" OR python');
    socket.emit('data', 'OK RESULTS 0\r\n');
    await promise;
  });

  it('rejects a raw expression containing control characters before sending', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    // A verbatim send must still block CRLF injection into the command stream.
    await expect(client.searchRaw('articles', 'a OR b\r\nINFO')).rejects.toThrow(InputValidationError);
    expect((socket.write as MockInstance).mock.calls.length).toBe(0);
  });

  it('emits a bare OFFSET when only offset is set', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.searchRaw('articles', 'a OR b', { offset: 20 });
    expect(lastCommand(socket).trimEnd()).toMatch(/OFFSET 20$/);
    socket.emit('data', 'OK RESULTS 0\r\n');
    await promise;
  });

  it('rejects an empty raw query before sending', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    await expect(client.searchRaw('articles', '')).rejects.toThrow(InputValidationError);
    expect((socket.write as MockInstance).mock.calls.length).toBe(0);
  });

  it('searchRawWithHighlights appends a HIGHLIGHT clause and parses snippets', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.searchRawWithHighlights('articles', 'a OR b');
    expect(lastCommand(socket)).toMatch(/\bHIGHLIGHT\b/);
    socket.emit('data', 'OK RESULTS 1\r\npk1\tthe <em>a</em> snippet\r\n\r\n');
    const res = await promise;
    expect(res.results[0]).toEqual({ primaryKey: 'pk1', snippet: 'the <em>a</em> snippet' });
  });
});

describe('MygramClient v1.7 SET / SHOW VARIABLES', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits SET name = value and accepts a +OK acknowledgement', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.setVariable('logging.level', 'info');
    expect(lastCommand(socket)).toContain('SET logging.level = info');
    socket.emit('data', "+OK Variable 'logging.level' set to 'info'\r\n\r\n");
    await expect(promise).resolves.toBeUndefined();
  });

  it('quotes SET values containing spaces', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.setVariable('logging.format', 'json pretty');
    expect(lastCommand(socket)).toContain('SET logging.format = "json pretty"');
    socket.emit('data', '+OK done\r\n\r\n');
    await promise;
  });

  it('rejects an empty variable name before sending', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    await expect(client.setVariable('', 'v')).rejects.toThrow(InputValidationError);
    expect((socket.write as MockInstance).mock.calls.length).toBe(0);
  });

  it('emits SHOW VARIABLES with no pattern', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.showVariables();
    expect(lastCommand(socket)).toBe('SHOW VARIABLES\r\n');
    socket.emit('data', '+OK 0 rows\r\n\r\n');
    await promise;
  });

  it('emits SHOW VARIABLES LIKE with a quoted pattern', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.showVariables('logging%');
    expect(lastCommand(socket)).toContain('SHOW VARIABLES LIKE logging%');
    socket.emit('data', '+OK 0 rows\r\n\r\n');
    await promise;
  });
});

describe('MygramClient v1.7 SYNC family', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits SYNC <table> and returns the acknowledgement', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.sync('app_db.articles');
    expect(lastCommand(socket)).toBe('SYNC app_db.articles\r\n');
    socket.emit('data', 'OK SYNC STARTED table=app_db.articles job_id=1\r\n');
    await expect(promise).resolves.toContain('SYNC STARTED');
  });

  it('parses a multi-line SYNC STATUS response framed by END', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.syncStatus();
    expect(lastCommand(socket)).toBe('SYNC STATUS\r\n');
    socket.emit('data', 'OK SYNC_STATUS\r\ntable=users status=IN_PROGRESS progress=10/100 rows (10.0%)\r\nEND\r\n');
    const status = await promise;
    expect(status).toContain('table=users');
    expect(status).toContain('IN_PROGRESS');
  });

  it('emits a bare SYNC STOP when no table is given', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.syncStop();
    expect(lastCommand(socket)).toBe('SYNC STOP\r\n');
    socket.emit('data', 'OK SYNC STOPPED\r\n');
    await promise;
  });

  it('emits SYNC STOP <table> for a named table', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.syncStop('articles');
    expect(lastCommand(socket)).toBe('SYNC STOP articles\r\n');
    socket.emit('data', 'OK SYNC STOPPED table=articles\r\n');
    await promise;
  });

  it('surfaces server errors as ProtocolError', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.sync('articles');
    socket.emit('data', 'ERROR table not found\r\n');
    await expect(promise).rejects.toThrow(ProtocolError);
  });
});

describe('NativeMygramClient v1.7 parity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds and sends a searchRaw command', async () => {
    const native = createMockNative({ sendCommand: vi.fn().mockReturnValue('OK RESULTS 0') });
    const client = new NativeMygramClient(native);
    await client.connect();
    await client.searchRaw('app_db.articles', 'a OR b', { limit: 10 });
    const command = native.sendCommand.mock.calls[0][1] as string;
    expect(command).toContain('SEARCH app_db.articles a OR b');
    expect(command).not.toContain('"a OR b"');
    expect(command).toContain('LIMIT 10');
  });

  it('builds SET / SHOW VARIABLES / SYNC commands', async () => {
    const native = createMockNative({ sendCommand: vi.fn().mockReturnValue('+OK done') });
    const client = new NativeMygramClient(native);
    await client.connect();

    await client.setVariable('logging.level', 'debug');
    expect(native.sendCommand.mock.calls[0][1]).toBe('SET logging.level = debug');

    native.sendCommand.mockReturnValue('OK SYNC STARTED');
    await client.sync('articles');
    expect(native.sendCommand.mock.calls[1][1]).toBe('SYNC articles');

    native.sendCommand.mockReturnValue('OK SYNC_STATUS\nEND');
    await client.syncStatus();
    expect(native.sendCommand.mock.calls[2][1]).toBe('SYNC STATUS');
  });

  it('exposes cache / optimize / dump methods at parity with MygramClient', async () => {
    const native = createMockNative({ sendCommand: vi.fn().mockReturnValue('OK') });
    const client = new NativeMygramClient(native);
    await client.connect();

    await client.cacheClear('articles');
    expect(native.sendCommand.mock.calls.at(-1)?.[1]).toBe('CACHE CLEAR articles');

    await client.optimize();
    expect(native.sendCommand.mock.calls.at(-1)?.[1]).toBe('OPTIMIZE');

    native.sendCommand.mockReturnValue('OK DUMP_SAVED /tmp/d.bin');
    await client.dumpSave('/tmp/d.bin');
    expect(native.sendCommand.mock.calls.at(-1)?.[1]).toBe('DUMP SAVE /tmp/d.bin');

    native.sendCommand.mockReturnValue('OK CACHE_STATS\nenabled: true\nEND');
    const stats = await client.cacheStats();
    expect(stats.enabled).toBe(true);
  });
});
