import type * as net from 'node:net';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { MygramClient } from '../src/client';
import { convertSearchExpression, parseSearchExpression } from '../src/search-expression';

// Reuse the socket-mock pattern from v18-mock.test.ts.
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

/** Let the pending microtasks run without advancing past a response the mock hasn't sent yet. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MygramDB v1.10.2 wire quoting', () => {
  it('quotes a search term containing Unicode whitespace (U+3000)', async () => {
    const { client, socket } = createConnectedClient();
    const promise = client.search('articles', '機械学習　チュートリアル');
    expect(lastCommand(socket)).toBe('SEARCH articles "機械学習　チュートリアル" LIMIT 1000\r\n');
    socket.emit('data', 'OK RESULTS 0\r\n');
    await promise;
  });

  it('quotes a filter value equal to a reserved clause keyword', async () => {
    const { client, socket } = createConnectedClient();
    const promise = client.search('articles', 'q', { filters: { status: 'AND' } });
    expect(lastCommand(socket)).toContain('FILTER status = "AND"');
    socket.emit('data', 'OK RESULTS 0\r\n');
    await promise;
  });

  it('quotes an AND term containing a no-break space (U+00A0)', async () => {
    const { client, socket } = createConnectedClient();
    const promise = client.search('articles', 'q', { andTerms: ['a b'] });
    expect(lastCommand(socket)).toContain('AND "a b"');
    socket.emit('data', 'OK RESULTS 0\r\n');
    await promise;
  });
});

describe('MygramDB v1.10.2 web-syntax expression conversion', () => {
  // Mirrors mygram-db tests/client/search_expression_test.cpp's
  // ToQueryStringQuotesLiteralTermsCollidingWithKeywords: a literal term
  // equal to a clause keyword must be quoted, or the server's clause
  // scanner and AST tokenizer both re-read it as the operator instead of
  // search text.
  it('quotes a literal term colliding with a reserved keyword', () => {
    expect(convertSearchExpression('golang not')).toBe('golang AND "not"');
    expect(convertSearchExpression('filter')).toBe('"filter"');
    expect(convertSearchExpression('sort')).toBe('"sort"');
    expect(convertSearchExpression('NOT')).toBe('"NOT"');
    expect(convertSearchExpression('golang NOT old')).toBe('golang AND "NOT" AND old');
    expect(convertSearchExpression('+not')).toBe('"not"');
  });

  it('quotes a term containing an apostrophe', () => {
    // An apostrophe is one of the characters wire_quoting.h's
    // NeedsWireQuoting flags, so an unquoted "don't" would reach the
    // server's tokenizer with different meaning than it was written with.
    expect(convertSearchExpression("don't")).toBe('"don\'t"');
  });

  it('renders a minus inside a group as NOT, not a literal hyphen', () => {
    // The AST parser only recognizes the literal word NOT; a bare '-' has
    // no meaning there, so the minus must be translated on the way in.
    expect(convertSearchExpression('golang +(tutorial -video)')).toBe('golang AND (tutorial NOT video)');
  });

  it('drops a plus inside a group instead of emitting it literally', () => {
    // Adjacent terms are AND'ed by adjacency already inside a group.
    expect(convertSearchExpression('golang +(a +b)')).toBe('golang AND (a b)');
  });

  it('keeps a required parenthesized OR group as one entry, unquoted', () => {
    const expr = parseSearchExpression('+golang +(tutorial OR guide)');
    expect(expr.requiredTerms).toEqual(['golang', '(tutorial OR guide)']);
    expect(convertSearchExpression('+golang +(tutorial OR guide)')).toBe('golang AND (tutorial OR guide)');
  });

  it('quotes a phrase inside an OR group exactly once', () => {
    // CaptureOrExpression applies wire quoting directly to each member as it
    // builds rawExpression, so a quoted phrase is not re-escaped when
    // toQueryString wraps the whole group in parens.
    expect(convertSearchExpression('"machine learning" OR ruby')).toBe('("machine learning" OR ruby)');
  });
});

describe('MygramDB v1.10.2 multi-line response framing', () => {
  it('reads a chunked HIGHLIGHT response completely instead of stopping at the header', async () => {
    const { client, socket } = createConnectedClient();
    const promise = client.search('articles', 'hello', { highlight: {} });
    let settled = false;
    promise.then(() => {
      settled = true;
    });

    // A chunk boundary landing right after the header's own \r\n must not
    // be mistaken for the end of the frame merely because it looks like a
    // complete single-line response.
    socket.emit('data', 'OK RESULTS 1\r\n');
    await flush();
    expect(settled).toBe(false);

    socket.emit('data', 'pk1\thello <em>world</em>\r\n\r\n');
    const result = await promise;
    expect(result.results).toEqual([{ primaryKey: 'pk1', snippet: 'hello <em>world</em>' }]);
  });

  it('reads a chunked DEBUG-mode response completely, past its own blank-line opening', async () => {
    const { client, socket } = createConnectedClient();
    const debugPromise = client.enableDebug();
    socket.emit('data', 'OK\r\n');
    await debugPromise;

    const promise = client.search('articles', 'hello');
    let settled = false;
    promise.then(() => {
      settled = true;
    });

    // The DEBUG block's own opening ("\r\n\r\n# DEBUG\r\n") is itself a
    // blank-line-terminated buffer before "# DEBUG" has actually arrived.
    socket.emit('data', 'OK RESULTS 1 pk1\r\n');
    await flush();
    expect(settled).toBe(false);
    socket.emit('data', '\r\n');
    await flush();
    expect(settled).toBe(false);

    socket.emit('data', '# DEBUG\r\nquery_time: 0.5ms\r\n\r\n');
    const result = await promise;
    expect(result.results).toEqual([{ primaryKey: 'pk1' }]);
    expect(result.debug?.queryTimeMs).toBe(0.5);
  });

  it('reads a chunked SHOW VARIABLES table completely instead of stopping at the border', async () => {
    const { client, socket } = createConnectedClient();
    const promise = client.showVariables();
    let settled = false;
    promise.then(() => {
      settled = true;
    });

    // Every border and row line of the bare ASCII table ends in \r\n on its
    // own, so the very first border line must not be mistaken for the
    // whole (single-line) response.
    socket.emit('data', '+----------+-------+\r\n');
    await flush();
    expect(settled).toBe(false);

    socket.emit(
      'data',
      '| name     | value |\r\n+----------+-------+\r\n| cache_on | true  |\r\n+----------+-------+\r\n\r\n'
    );
    const result = await promise;
    expect(result).toContain('cache_on');
  });
});
