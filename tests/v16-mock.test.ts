import type * as net from 'node:net';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { MygramClient } from '../src/client';
import { validateFacetColumn, validateFuzzy, validateHighlight } from '../src/command-utils';
import { InputValidationError, ProtocolError } from '../src/errors';
import { NativeMygramClient } from '../src/native-client';

// Reuse the existing mock pattern from client-mock.test.ts
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
  const socket = (client as unknown as { socket: net.Socket }).socket;
  socket.emit('connect');
  connectPromise.catch(() => {});
  return { client, socket };
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

describe('validateFuzzy', () => {
  it('accepts 0, 1, 2', () => {
    expect(() => validateFuzzy(0)).not.toThrow();
    expect(() => validateFuzzy(1)).not.toThrow();
    expect(() => validateFuzzy(2)).not.toThrow();
  });

  it('rejects values outside 0..2', () => {
    expect(() => validateFuzzy(3)).toThrow(InputValidationError);
    expect(() => validateFuzzy(-1)).toThrow(InputValidationError);
  });
});

describe('validateHighlight', () => {
  it('accepts undefined and empty options', () => {
    expect(() => validateHighlight(undefined)).not.toThrow();
    expect(() => validateHighlight({})).not.toThrow();
  });

  it('accepts a fully populated, valid options object', () => {
    expect(() =>
      validateHighlight({
        openTag: '<em>',
        closeTag: '</em>',
        snippetLen: 200,
        maxFragments: 3
      })
    ).not.toThrow();
  });

  it('requires openTag and closeTag to be set together', () => {
    expect(() => validateHighlight({ openTag: '<em>' })).toThrow(InputValidationError);
    expect(() => validateHighlight({ closeTag: '</em>' })).toThrow(InputValidationError);
  });

  it('rejects whitespace inside tags', () => {
    expect(() => validateHighlight({ openTag: '< em>', closeTag: '</em>' })).toThrow(InputValidationError);
  });

  it('rejects control characters inside tags', () => {
    expect(() => validateHighlight({ openTag: '<em>\n', closeTag: '</em>' })).toThrow(InputValidationError);
  });

  it('rejects out-of-range snippetLen', () => {
    expect(() => validateHighlight({ snippetLen: -1 })).toThrow(InputValidationError);
    expect(() => validateHighlight({ snippetLen: 10001 })).toThrow(InputValidationError);
  });

  it('rejects out-of-range maxFragments', () => {
    expect(() => validateHighlight({ maxFragments: -1 })).toThrow(InputValidationError);
    expect(() => validateHighlight({ maxFragments: 101 })).toThrow(InputValidationError);
  });
});

describe('validateFacetColumn', () => {
  it('accepts well-formed column names', () => {
    expect(() => validateFacetColumn('status')).not.toThrow();
    expect(() => validateFacetColumn('a_b-c.d')).not.toThrow();
  });

  it('rejects empty', () => {
    expect(() => validateFacetColumn('')).toThrow(InputValidationError);
  });

  it('rejects whitespace and control characters', () => {
    expect(() => validateFacetColumn('a b')).toThrow(InputValidationError);
    expect(() => validateFacetColumn('a\tb')).toThrow(InputValidationError);
    expect(() => validateFacetColumn('a\nb')).toThrow(InputValidationError);
    expect(() => validateFacetColumn('a\x7fb')).toThrow(InputValidationError);
  });
});

describe('MygramClient v1.6 search clauses', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits FUZZY 1 when fuzzy=1', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();

    const promise = client.search('articles', 'machne', { fuzzy: 1 });
    const command = (socket.write as MockInstance).mock.calls[0][0] as string;
    expect(command).toContain('SEARCH articles machne');
    expect(command).toContain('FUZZY 1');

    socket.emit('data', 'OK RESULTS 0\n');
    await promise;
  });

  it('emits FUZZY 2 when fuzzy=2', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.search('articles', 'machne', { fuzzy: 2 });
    const command = (socket.write as MockInstance).mock.calls[0][0] as string;
    expect(command).toContain('FUZZY 2');
    socket.emit('data', 'OK RESULTS 0\n');
    await promise;
  });

  it('rejects invalid fuzzy distance before sending', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    await expect(client.search('articles', 'q', { fuzzy: 5 })).rejects.toThrow(InputValidationError);
    expect((socket.write as MockInstance).mock.calls.length).toBe(0);
  });

  it('emits a bare HIGHLIGHT clause when an empty options object is supplied', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.search('articles', 'hello', { highlight: {} });

    const command = (socket.write as MockInstance).mock.calls[0][0] as string;
    expect(command).toMatch(/\bHIGHLIGHT\b/);
    expect(command).not.toContain('TAG');
    expect(command).not.toContain('SNIPPET_LEN');
    expect(command).not.toContain('MAX_FRAGMENTS');

    socket.emit('data', 'OK RESULTS 0\n');
    await promise;
  });

  it('emits HIGHLIGHT TAG/SNIPPET_LEN/MAX_FRAGMENTS in canonical order', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.search('articles', 'hello', {
      highlight: {
        openTag: '<strong>',
        closeTag: '</strong>',
        snippetLen: 200,
        maxFragments: 5
      }
    });

    const command = (socket.write as MockInstance).mock.calls[0][0] as string;
    expect(command).toContain('HIGHLIGHT TAG <strong> </strong> SNIPPET_LEN 200 MAX_FRAGMENTS 5');

    socket.emit('data', 'OK RESULTS 0\n');
    await promise;
  });

  it('places SORT before FUZZY before HIGHLIGHT before LIMIT', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.search('articles', 'q', {
      sortColumn: '_score',
      sortDesc: true,
      fuzzy: 1,
      highlight: {},
      limit: 10
    });

    const command = (socket.write as MockInstance).mock.calls[0][0] as string;
    const idxSort = command.indexOf('SORT _score DESC');
    const idxFuzzy = command.indexOf('FUZZY 1');
    const idxHl = command.indexOf('HIGHLIGHT');
    const idxLimit = command.indexOf('LIMIT 10');
    expect(idxSort).toBeGreaterThan(-1);
    expect(idxFuzzy).toBeGreaterThan(-1);
    expect(idxHl).toBeGreaterThan(-1);
    expect(idxLimit).toBeGreaterThan(-1);
    expect(idxSort).toBeLessThan(idxFuzzy);
    expect(idxFuzzy).toBeLessThan(idxHl);
    expect(idxHl).toBeLessThan(idxLimit);

    socket.emit('data', 'OK RESULTS 0\n');
    await promise;
  });

  it('omits FUZZY and HIGHLIGHT when not requested', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.search('articles', 'hello');
    const command = (socket.write as MockInstance).mock.calls[0][0] as string;
    expect(command).not.toContain('FUZZY');
    expect(command).not.toContain('HIGHLIGHT');
    socket.emit('data', 'OK RESULTS 0\n');
    await promise;
  });

  it('rejects highlight with mismatched tag pairing before sending', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    await expect(client.search('articles', 'q', { highlight: { openTag: '<em>' } })).rejects.toThrow(
      InputValidationError
    );
    expect((socket.write as MockInstance).mock.calls.length).toBe(0);
  });

  it('emits SORT _score DESC for BM25', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.search('articles', 'machine learning', { sortColumn: '_score', sortDesc: true });
    const command = (socket.write as MockInstance).mock.calls[0][0] as string;
    expect(command).toContain('SORT _score DESC');
    socket.emit('data', 'OK RESULTS 0\n');
    await promise;
  });
});

describe('MygramClient v1.6 search HIGHLIGHT response parsing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses multi-line HIGHLIGHT results', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.search('articles', 'hello', { highlight: {} });

    socket.emit('data', 'OK RESULTS 2\r\nid1\thello <em>world</em>\r\nid2\tanother <em>match</em>\r\n\r\n');

    const result = await promise;
    expect(result.totalCount).toBe(2);
    expect(result.results).toEqual([
      { primaryKey: 'id1', snippet: 'hello <em>world</em>' },
      { primaryKey: 'id2', snippet: 'another <em>match</em>' }
    ]);
  });

  it('parses HIGHLIGHT row without snippet (empty string)', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.search('articles', 'hello', { highlight: {} });

    // No tab in second row -> snippet is empty
    socket.emit('data', 'OK RESULTS 2\r\nid1\thello\r\nid2\t\r\n\r\n');

    const result = await promise;
    expect(result.results).toEqual([
      { primaryKey: 'id1', snippet: 'hello' },
      { primaryKey: 'id2', snippet: '' }
    ]);
  });

  it('still parses classic single-line response', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.search('articles', 'hello');
    socket.emit('data', 'OK RESULTS 3 id1 id2 id3\n');

    const result = await promise;
    expect(result.totalCount).toBe(3);
    expect(result.results).toEqual([{ primaryKey: 'id1' }, { primaryKey: 'id2' }, { primaryKey: 'id3' }]);
  });
});

describe('MygramClient.facet', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits FACET <table> <column> with no QUERY when query omitted', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.facet('articles', 'status');

    const command = (socket.write as MockInstance).mock.calls[0][0] as string;
    expect(command.trim()).toBe('FACET articles status');

    socket.emit('data', 'OK FACET 2\r\npublished\t10\r\ndraft\t3\r\n\r\n');
    const resp = await promise;
    expect(resp.results).toEqual([
      { value: 'published', count: 10 },
      { value: 'draft', count: 3 }
    ]);
  });

  it('emits QUERY/AND/NOT/FILTER/LIMIT in order when scoped', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.facet('articles', 'category', {
      query: 'machine learning',
      andTerms: ['python'],
      notTerms: ['draft'],
      filters: { status: '1' },
      limit: 10
    });

    const command = (socket.write as MockInstance).mock.calls[0][0] as string;
    expect(command).toContain('FACET articles category');
    expect(command).toContain('QUERY machine learning');
    expect(command).toContain('AND python');
    expect(command).toContain('NOT draft');
    expect(command).toContain('FILTER status = 1');
    expect(command.trimEnd()).toMatch(/LIMIT 10$/);

    socket.emit('data', 'OK FACET 1\r\nai\t5\r\n\r\n');
    await promise;
  });

  it('parses FACET response with no rows', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.facet('articles', 'status');
    socket.emit('data', 'OK FACET 0\r\n\r\n');
    const resp = await promise;
    expect(resp.results).toEqual([]);
  });

  it('skips comment lines in FACET response', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.facet('articles', 'status');
    socket.emit('data', 'OK FACET 1\r\npublished\t7\r\n# query_time_ms: 1.2\r\n# total_docs_searched: 100\r\n\r\n');
    const resp = await promise;
    expect(resp.results).toEqual([{ value: 'published', count: 7 }]);
  });

  it('handles a value that contains a space', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.facet('articles', 'category');
    socket.emit('data', 'OK FACET 1\r\nMachine Learning\t42\r\n\r\n');
    const resp = await promise;
    expect(resp.results).toEqual([{ value: 'Machine Learning', count: 42 }]);
  });

  it('throws ProtocolError on malformed FACET row', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.facet('articles', 'status');
    socket.emit('data', 'OK FACET 1\r\nno-tab-here\r\n\r\n');
    await expect(promise).rejects.toThrow(ProtocolError);
  });

  it('throws ProtocolError on non-numeric FACET count', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.facet('articles', 'status');
    socket.emit('data', 'OK FACET 1\r\nfoo\tbar\r\n\r\n');
    await expect(promise).rejects.toThrow(ProtocolError);
  });

  it('throws ProtocolError on non-numeric FACET header count', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.facet('articles', 'status');
    socket.emit('data', 'OK FACET abc\r\n\r\n');
    await expect(promise).rejects.toThrow(ProtocolError);
  });

  it('rejects empty column name before sending', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    await expect(client.facet('articles', '')).rejects.toThrow(InputValidationError);
    expect((socket.write as MockInstance).mock.calls.length).toBe(0);
  });

  it('rejects column name with whitespace before sending', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    await expect(client.facet('articles', 'bad name')).rejects.toThrow(InputValidationError);
    expect((socket.write as MockInstance).mock.calls.length).toBe(0);
  });

  it('propagates ERROR responses from the server as ProtocolError', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.facet('articles', 'unknown_column');
    socket.emit('data', 'ERROR unknown facet column\r\n');
    await expect(promise).rejects.toThrow(ProtocolError);
  });

  it('enforces max query length on the facet query', async () => {
    const { client } = createConnectedClient({ maxQueryLength: 10 });
    await client.connect();
    await expect(client.facet('articles', 'status', { query: 'this query is far too long' })).rejects.toThrow(
      InputValidationError
    );
  });
});

describe('NativeMygramClient v1.6', () => {
  it('emits FUZZY/HIGHLIGHT clauses for SEARCH', async () => {
    const native = createMockNative({
      sendCommand: vi.fn().mockReturnValue('OK RESULTS 0')
    });
    const client = new NativeMygramClient(native);
    await client.connect();

    await client.search('articles', 'q', {
      sortColumn: '_score',
      fuzzy: 1,
      highlight: { openTag: '<b>', closeTag: '</b>', snippetLen: 50, maxFragments: 2 }
    });

    const command = native.sendCommand.mock.calls[0][1] as string;
    expect(command).toContain('SORT _score DESC');
    expect(command).toContain('FUZZY 1');
    expect(command).toContain('HIGHLIGHT TAG <b> </b> SNIPPET_LEN 50 MAX_FRAGMENTS 2');
  });

  it('parses HIGHLIGHT-mode SEARCH response', async () => {
    const response = ['OK RESULTS 2', 'id1\tsnippet1', 'id2\tsnippet2'].join('\n');
    const native = createMockNative({
      sendCommand: vi.fn().mockReturnValue(response)
    });
    const client = new NativeMygramClient(native);
    await client.connect();

    const result = await client.search('articles', 'q', { highlight: {} });
    expect(result.totalCount).toBe(2);
    expect(result.results).toEqual([
      { primaryKey: 'id1', snippet: 'snippet1' },
      { primaryKey: 'id2', snippet: 'snippet2' }
    ]);
  });

  it('rejects invalid fuzzy distance before sending', async () => {
    const native = createMockNative();
    const client = new NativeMygramClient(native);
    await client.connect();
    await expect(client.search('articles', 'q', { fuzzy: 9 })).rejects.toThrow(InputValidationError);
    expect(native.sendCommand).not.toHaveBeenCalled();
  });

  it('emits FACET command and parses response', async () => {
    const native = createMockNative({
      sendCommand: vi.fn().mockReturnValue('OK FACET 2\nfoo\t1\nbar\t2')
    });
    const client = new NativeMygramClient(native);
    await client.connect();

    const resp = await client.facet('articles', 'status');
    expect(native.sendCommand.mock.calls[0][1]).toBe('FACET articles status');
    expect(resp.results).toEqual([
      { value: 'foo', count: 1 },
      { value: 'bar', count: 2 }
    ]);
  });

  it('emits scoped FACET command with refinements', async () => {
    const native = createMockNative({
      sendCommand: vi.fn().mockReturnValue('OK FACET 0')
    });
    const client = new NativeMygramClient(native);
    await client.connect();

    await client.facet('articles', 'category', {
      query: 'ml',
      andTerms: ['python'],
      notTerms: ['draft'],
      filters: { status: '1' },
      limit: 5
    });

    const command = native.sendCommand.mock.calls[0][1] as string;
    expect(command).toContain('FACET articles category');
    expect(command).toContain('QUERY ml');
    expect(command).toContain('AND python');
    expect(command).toContain('NOT draft');
    expect(command).toContain('FILTER status = 1');
    expect(command).toContain('LIMIT 5');
  });

  it('rejects empty FACET column name before sending', async () => {
    const native = createMockNative();
    const client = new NativeMygramClient(native);
    await client.connect();
    await expect(client.facet('articles', '')).rejects.toThrow(InputValidationError);
    expect(native.sendCommand).not.toHaveBeenCalled();
  });

  it('throws ProtocolError on invalid FACET response', async () => {
    const native = createMockNative({
      sendCommand: vi.fn().mockReturnValue('NOT FACET')
    });
    const client = new NativeMygramClient(native);
    await client.connect();
    await expect(client.facet('articles', 'status')).rejects.toThrow(ProtocolError);
  });
});
