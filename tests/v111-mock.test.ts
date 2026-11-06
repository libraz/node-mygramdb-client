import type * as net from 'node:net';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { MygramClient } from '../src/client';
import { ensureSafeIdentifier, needsWireQuoting, quoteWireToken, validateFacetColumn } from '../src/command-utils';
import { beginResponseFrame, isResponseComplete } from '../src/connection';
import { ErrorCode } from '../src/error-codes';
import { InputValidationError, ProtocolError, ServerError } from '../src/errors';
import { parseDocumentResponse, parseSearchResponse } from '../src/response-parser';
import {
  convertSearchExpression,
  hasComplexExpression,
  parseSearchExpression,
  parseSearchExpressionNative,
  simplifySearchExpression
} from '../src/search-expression';

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

/** Feed `chunks` to a fresh frame for `command` and report whether the last chunk completed it. */
function completes(command: string, chunks: string[], debug = false): boolean[] {
  const frame = beginResponseFrame(command, debug);
  let buffer = '';
  return chunks.map((chunk) => {
    buffer += chunk;
    return isResponseComplete(buffer, frame);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MygramDB v1.11 reply framing', () => {
  it('ends a FACET reply with a distinct-value total after both blank lines', () => {
    const head = 'OK FACET 2 2\r\nai\t3\r\nmisc\t1\r\n';
    expect(completes('FACET t category', [head, '\r\n', '\r\n'])).toEqual([false, false, true]);
  });

  it('ends a FACET reply without a total at the first blank line', () => {
    const head = 'OK FACET 2\r\nai\t3\r\nmisc\t1\r\n';
    expect(completes('FACET t category', [head, '\r\n'])).toEqual([false, true]);
  });

  it('skips the transport CRLF left behind by a total-less FACET reply', async () => {
    const { client, socket } = await connectedClient();
    const facet = client.facet('articles', 'category');
    socket.emit('data', 'OK FACET 1\r\nai\t3\r\n\r\n');
    expect((await facet).results).toEqual([{ value: 'ai', count: 3 }]);

    const count = client.count('articles', 'q');
    socket.emit('data', '\r\nOK COUNT 7\r\n');
    expect((await count).count).toBe(7);
  });

  it('keeps reading CONFIG HELP <path> through its internal blank line', () => {
    const chunks = ['+OK\r\napi.default_limit\r\n', '\r\nType: integer\r\n', 'Default: 100\r\n', '\r\n'];
    expect(completes('config help api.default_limit', chunks)).toEqual([false, false, false, true]);
  });

  it('treats a bare +OK body line that is empty as body, not as the terminator', () => {
    expect(completes('CONFIG SHOW api.x', ['+OK\r\n', '\r\n', '\r\n'])).toEqual([false, false, true]);
  });

  it('ends SYNC STATUS after the blank line that follows END', () => {
    const chunks = ['OK SYNC_STATUS\r\nstatus=IDLE\r\n', 'END\r\n', '\r\n'];
    expect(completes('SYNC STATUS', chunks)).toEqual([false, false, true]);
  });

  it('returns a failing highlighted search error at once', async () => {
    const { client, socket } = await connectedClient();
    const search = client.searchWithHighlights('articles', 'q', { highlight: {} });
    expect(lastCommand(socket)).toContain(' HIGHLIGHT');
    socket.emit('data', 'ERROR 4007 Table not found: articles\r\n');
    await expect(search).rejects.toMatchObject({ code: ErrorCode.TableNotFound });
  });

  it('returns a failing DEBUG search error at once', async () => {
    const { client, socket } = await connectedClient();
    const enabling = client.enableDebug();
    socket.emit('data', 'OK DEBUG_ON\r\n');
    await enabling;

    const search = client.search('articles', 'q');
    socket.emit('data', 'ERROR 3000 Empty query\r\n');
    await expect(search).rejects.toBeInstanceOf(ServerError);
  });

  it('does not wait for a highlight body when the word sits inside a quoted term', async () => {
    const { client, socket } = await connectedClient();
    const search = client.search('articles', 'say highlight now');
    expect(lastCommand(socket)).toContain('"say highlight now"');
    socket.emit('data', 'OK RESULTS 1 a\r\n');
    expect((await search).totalCount).toBe(1);
  });

  it('expects highlight rows only for an unquoted HIGHLIGHT clause', () => {
    const header = 'OK RESULTS 1\r\n';
    expect(completes('SEARCH t "a highlight b" LIMIT 10', ['OK RESULTS 1 a\r\n'])).toEqual([true]);
    expect(completes('search t q highlight', [header, 'a\tsnippet\r\n', '\r\n'])).toEqual([false, false, true]);
  });

  it('tracks DEBUG ON/OFF from the reply regardless of how the command was spelled', async () => {
    const { client, socket } = await connectedClient();
    const on = client.sendCommand('debug   on');
    socket.emit('data', 'OK DEBUG_ON\r\n');
    await on;

    const search = client.search('articles', 'q');
    socket.emit('data', 'OK RESULTS 0\r\n');
    await flush();
    let settled = false;
    search.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    socket.emit('data', '\r\n# DEBUG\r\nquery_time: 0.1ms\r\n\r\n');
    expect((await search).debug).toBeDefined();

    const off = client.sendCommand('DEBUG OFF');
    socket.emit('data', 'OK DEBUG_OFF\r\n');
    await off;
    const plain = client.search('articles', 'q');
    socket.emit('data', 'OK RESULTS 0\r\n');
    expect((await plain).totalCount).toBe(0);
  });

  it('forgets the DEBUG flag when the connection closes', async () => {
    const { client, socket } = await connectedClient();
    const on = client.sendCommand('DEBUG ON');
    socket.emit('data', 'OK DEBUG_ON\r\n');
    await on;
    socket.emit('close');
    expect((client as unknown as { connection: { debugMode: boolean } }).connection.debugMode).toBe(false);
  });

  it('gives lowercase and irregularly spaced long operations their own deadline', async () => {
    vi.useFakeTimers();
    const { client, socket } = await connectedClient({ timeout: 100, optimizeTimeout: 5000, dumpLoadTimeout: 5000 });
    for (const command of ['optimize', 'Dump \t Load /tmp/a.dump', 'DUMP\u3000verify x']) {
      const pending = client.sendCommand(command);
      let outcome: string | undefined;
      pending.then(
        () => {
          outcome = 'ok';
        },
        (error: Error) => {
          outcome = error.message;
        }
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(outcome).toBeUndefined();
      socket.emit('data', 'OK OPTIMIZED\r\n');
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe('ok');
    }
  });

  it('keeps an ordinary raw command on the request timeout', async () => {
    vi.useFakeTimers();
    const { client } = await connectedClient({ timeout: 100, optimizeTimeout: 5000 });
    const pending = client.sendCommand('INFO');
    const assertion = expect(pending).rejects.toThrow('Command timeout');
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
  });
});

describe('MygramDB v1.11 name validation', () => {
  it.each([
    ['U+3000', 'a\u3000b'],
    ['U+00A0', 'a\u00A0b'],
    ['U+0085', 'a\u0085b'],
    ['U+2003', 'a\u2003b']
  ])('rejects an identifier containing %s', (_label, name) => {
    expect(() => ensureSafeIdentifier(name, 'table')).toThrow(InputValidationError);
    expect(() => validateFacetColumn(name)).toThrow(InputValidationError);
  });

  it('accepts U+200B and non-ASCII letters whose UTF-8 bytes include 0xA0', () => {
    expect(ensureSafeIdentifier('a\u200Bb', 'table')).toBe('a\u200Bb');
    expect(ensureSafeIdentifier('\u00E0\u3042', 'table')).toBe('\u00E0\u3042');
  });

  it('rejects Unicode whitespace in table, filter key, sort column and SET variable names', async () => {
    const { client } = await connectedClient();
    await expect(client.search('art\u3000icles', 'q')).rejects.toBeInstanceOf(InputValidationError);
    await expect(client.search('articles', 'q', { filters: { 'a\u00A0b': 'x' } })).rejects.toBeInstanceOf(
      InputValidationError
    );
    await expect(client.search('articles', 'q', { sortColumn: 'a\u0085b' })).rejects.toBeInstanceOf(
      InputValidationError
    );
    await expect(client.setVariable('a\u3000b', '1')).rejects.toBeInstanceOf(InputValidationError);
    await expect(client.facet('articles', 'a\u00A0b')).rejects.toBeInstanceOf(InputValidationError);
  });
});

describe('MygramDB v1.11 wire quoting follows Unicode White_Space', () => {
  it('quotes U+0085 and leaves U+200B bare', () => {
    expect(needsWireQuoting('a\u0085b')).toBe(true);
    expect(quoteWireToken('a\u0085b')).toBe('"a\u0085b"');
    expect(needsWireQuoting('a\u200Bb')).toBe(false);
    expect(quoteWireToken('a\u200Bb')).toBe('a\u200Bb');
  });

  it('does not quote characters that merely share a byte with whitespace in UTF-8', () => {
    expect(needsWireQuoting('\u00E0')).toBe(false);
    expect(needsWireQuoting('\u3042\u3044')).toBe(false);
  });

  it('quotes bare tokens carrying a quote or backslash', () => {
    expect(quoteWireToken("it's")).toBe('"it\'s"');
    expect(quoteWireToken('C:\\dir')).toBe('"C:\\\\dir"');
    expect(quoteWireToken('say"hi')).toBe('"say\\"hi"');
  });

  it('matches reserved words by ASCII case folding only', () => {
    expect(needsWireQuoting('Order')).toBe(true);
    expect(needsWireQuoting('\u017Fort')).toBe(false);
  });
});

describe('MygramDB v1.11 web-syntax expressions', () => {
  it('excludes a whole negated nested group', () => {
    expect(convertSearchExpression('x +(a -(b OR c))')).toBe('x AND (a NOT (b OR c))');
    expect(convertSearchExpression('x -(a -(b c) d)')).toBe('x AND NOT (a NOT (b c) d)');
  });

  it('does not let a pending NOT leak past the next token', () => {
    expect(convertSearchExpression('x +(a - OR b)')).toBe('x AND (a OR b)');
    expect(convertSearchExpression('x +(a -)')).toBe('x AND (a)');
  });

  it('keeps a quoted phrase shaped like a group as a phrase', () => {
    const parsed = parseSearchExpression('"(a OR b)" -"(c)"');
    expect(parsed.requiredTerms).toEqual(['(a OR b)']);
    expect(parsed.requiredIsGroup).toEqual([false]);
    expect(parsed.excludedIsGroup).toEqual([false]);
    expect(hasComplexExpression(parsed)).toBe(false);
    expect(convertSearchExpression('"(a OR b)" -"(c)"')).toBe('"(a OR b)" AND NOT "(c)"');
    expect(simplifySearchExpression('"(a OR b)"').mainTerm).toBe('(a OR b)');
  });

  it('flags a real group after + or -', () => {
    const parsed = parseSearchExpression('+(a OR b) -(c d)');
    expect(parsed.requiredIsGroup).toEqual([true]);
    expect(parsed.excludedIsGroup).toEqual([true]);
    expect(hasComplexExpression(parsed)).toBe(true);
  });

  it.each([
    ['OR-tools', 'OR-tools'],
    ['OR\u56DE\u8DEF', 'OR\u56DE\u8DEF'],
    ['ORM', 'ORM']
  ])('reads %s as a term, not the operator', (input, term) => {
    expect(parseSearchExpression(input).requiredTerms).toEqual([term]);
    expect(convertSearchExpression(`go ${input}`)).toBe(`go AND ${term}`);
  });

  it('still reads a standalone OR in any case as the operator', () => {
    expect(convertSearchExpression('a or b')).toBe('(a OR b)');
    expect(convertSearchExpression('a Or(b)')).toBe('(a OR (b))');
  });

  it('treats an expression with a top-level OR as one group', () => {
    expect(convertSearchExpression('a OR b c')).toBe('(a OR b c)');
    expect(convertSearchExpression('c a OR b')).toBe('(c a OR b)');
    expect(convertSearchExpression('a OR b -c')).toBe('(a OR b NOT c)');
  });

  it('parses a bare expression and its parenthesized form to the same group', () => {
    const bare = parseSearchExpression('a OR b c');
    const wrapped = parseSearchExpression('(a OR b c)');
    expect(wrapped.rawExpression).toBe(`(${bare.rawExpression})`);
    expect(convertSearchExpression('a OR (b c)')).toBe('(a OR (b c))');
  });

  it('rejects an OR with a missing operand', () => {
    expect(() => parseSearchExpression('OR a')).toThrow();
    expect(() => parseSearchExpression('a OR')).toThrow();
    expect(() => parseSearchExpression('a OR OR b')).toThrow();
    expect(() => parseSearchExpression('+ OR a')).toThrow();
  });

  it('does not split a term on whitespace the server tokenizer keeps inside it', () => {
    expect(parseSearchExpression('a\u00A0b').requiredTerms).toEqual(['a\u00A0b']);
    expect(convertSearchExpression('a\u00A0b')).toBe('"a\u00A0b"');
    expect(parseSearchExpression('a\u3000b').requiredTerms).toEqual(['a', 'b']);
  });

  it('no longer reports optional terms', () => {
    expect('optionalTerms' in parseSearchExpression('a b')).toBe(false);
    expect('optionalTerms' in parseSearchExpressionNative('a b')).toBe(false);
  });

  it('parses the same through the native entry point', () => {
    expect(parseSearchExpressionNative('"(a OR b)" -x')).toEqual({
      mainTerm: '(a OR b)',
      andTerms: [],
      notTerms: ['x']
    });
    expect(parseSearchExpressionNative('go OR-tools')).toEqual({
      mainTerm: 'go',
      andTerms: ['OR-tools'],
      notTerms: []
    });
    expect(() => parseSearchExpressionNative('a OR b c')).toThrow();
  });
});

describe('MygramDB v1.11 response decoding', () => {
  it('rejects a GET reply with a malformed quoted value', () => {
    expect(() => parseDocumentResponse('OK DOC 1 title="abc')).toThrow(ProtocolError);
    expect(() => parseDocumentResponse('OK DOC 1 title="a\\x4"')).toThrow(ProtocolError);
    expect(() => parseDocumentResponse('OK DOC 1 title="a\\xZZ"')).toThrow(ProtocolError);
  });

  it('decodes a well-formed GET reply, including an empty value', () => {
    const doc = parseDocumentResponse('OK DOC "a b" title="x y" empty="" n=3 path=C:\\dir');
    expect(doc.primaryKey).toBe('a b');
    expect(doc.fields).toEqual({ title: 'x y', empty: '', n: '3', path: 'C:\\dir' });
  });

  it('rejects a SEARCH reply with a malformed quoted primary key', () => {
    expect(() => parseSearchResponse('OK RESULTS 2 a "b')).toThrow(ProtocolError);
  });

  it('does not split a primary key on a non-ASCII space', () => {
    expect(parseSearchResponse('OK RESULTS 1 a\u00A0b').results).toEqual([{ primaryKey: 'a\u00A0b' }]);
  });
});

describe('MygramDB v1.11 error code registry', () => {
  it('carries the SET configuration codes', () => {
    expect(ErrorCode.ConfigUnknownVariable).toBe(1008);
    expect(ErrorCode.ConfigVariableNotMutable).toBe(1009);
  });
});
