import type * as net from 'node:net';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { MygramClient } from '../src/client';
import { buildCountCommand, buildFacetCommand, buildSearchCommand } from '../src/command-builder';
import { InputValidationError } from '../src/errors';
import { parseFacetResponse } from '../src/response-parser';

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

const NO_LIMIT = 0;

describe('MygramDB v1.9 query mode', () => {
  it('quotes literal text so reserved words match as terms', () => {
    expect(buildSearchCommand('articles', 'alpha AND beta', {}, NO_LIMIT)).toBe(
      'SEARCH articles "alpha AND beta" LIMIT 1000'
    );
  });

  it('sends a boolean expression verbatim so the server parses the operators', () => {
    expect(buildSearchCommand('articles', 'alpha AND (xqz OR jkv)', { queryMode: 'boolean' }, NO_LIMIT)).toBe(
      'SEARCH articles alpha AND (xqz OR jkv) LIMIT 1000'
    );
  });

  it('combines a boolean expression with typed clauses', () => {
    const command = buildSearchCommand(
      'articles',
      'alpha AND (xqz OR jkv)',
      {
        queryMode: 'boolean',
        filters: { status: 'published' },
        sortColumn: 'published_at',
        sortDesc: false,
        fuzzy: 1,
        highlight: {},
        limit: 20
      },
      NO_LIMIT
    );
    expect(command).toBe(
      'SEARCH articles alpha AND (xqz OR jkv) FILTER status = published ' +
        'SORT published_at ASC FUZZY 1 HIGHLIGHT LIMIT 20'
    );
  });

  it('rejects an empty boolean expression', () => {
    expect(() => buildSearchCommand('articles', '', { queryMode: 'boolean' }, NO_LIMIT)).toThrow(InputValidationError);
  });

  it('applies the query mode to COUNT and FACET as well', () => {
    expect(buildCountCommand('articles', 'a OR b', { queryMode: 'boolean' }, NO_LIMIT)).toBe('COUNT articles a OR b');
    expect(buildFacetCommand('articles', 'tag', { query: 'a OR b', queryMode: 'boolean' }, NO_LIMIT)).toBe(
      'FACET articles tag QUERY a OR b'
    );
  });
});

describe('MygramDB v1.9 comparison filters', () => {
  it('defaults a bare record value to equality', () => {
    expect(buildSearchCommand('articles', 'hello', { filters: { status: 'active' } }, NO_LIMIT)).toContain(
      'FILTER status = active'
    );
  });

  it('emits the operator from the record form', () => {
    expect(
      buildSearchCommand('articles', 'hello', { filters: { price: { op: '>=', value: '100' } } }, NO_LIMIT)
    ).toContain('FILTER price >= 100');
  });

  it('emits two conditions on one column from the array form', () => {
    const command = buildSearchCommand(
      'articles',
      'hello',
      {
        filters: [
          { column: 'price', op: '>=', value: '100' },
          { column: 'price', op: '<=', value: '500' }
        ]
      },
      NO_LIMIT
    );
    expect(command).toContain('FILTER price >= 100 FILTER price <= 500');
  });

  it('accepts every operator the server parses', () => {
    for (const op of ['=', '!=', '<>', '>', '>=', '<', '<='] as const) {
      expect(
        buildSearchCommand('articles', 'hello', { filters: [{ column: 'n', op, value: '1' }] }, NO_LIMIT)
      ).toContain(`FILTER n ${op} 1`);
    }
  });

  it('rejects an unknown operator', () => {
    expect(() =>
      buildSearchCommand(
        'articles',
        'hello',
        // biome-ignore lint/suspicious/noExplicitAny: exercising runtime validation of an off-type operator
        { filters: [{ column: 'n', op: '=~' as any, value: '1' }] },
        NO_LIMIT
      )
    ).toThrow(InputValidationError);
  });

  it('counts a filter column and value but not its operator toward the length limit', () => {
    // 'hello' + 'price' + '100' = 13 characters regardless of the operator.
    const options = { filters: [{ column: 'price', op: '>=' as const, value: '100' }] };
    expect(() => buildSearchCommand('articles', 'hello', options, 13)).not.toThrow();
    expect(() => buildSearchCommand('articles', 'hello', options, 12)).toThrow(InputValidationError);
  });
});

describe('MygramDB v1.9 explicit ascending sort', () => {
  it('emits SORT ASC for primary-key order when no sort column is given', () => {
    expect(buildSearchCommand('articles', 'hello', { sortDesc: false }, NO_LIMIT)).toBe(
      'SEARCH articles hello SORT ASC LIMIT 1000'
    );
  });

  it('emits no SORT clause for the default descending order', () => {
    expect(buildSearchCommand('articles', 'hello', {}, NO_LIMIT)).not.toContain('SORT');
  });
});

describe('MygramDB v1.9 facet pagination', () => {
  it('emits the atomic LIMIT <offset>,<limit> form', () => {
    expect(buildFacetCommand('articles', 'tag', { limit: 10, offset: 20 }, NO_LIMIT)).toBe(
      'FACET articles tag LIMIT 20,10'
    );
  });

  it('emits a bare OFFSET when no limit is given', () => {
    expect(buildFacetCommand('articles', 'tag', { offset: 20 }, NO_LIMIT)).toBe('FACET articles tag OFFSET 20');
  });

  it('parses the total distinct value count from the header', () => {
    const response = ['OK FACET 2 57', 'python\t12', 'ruby\t7', ''].join('\n');
    const res = parseFacetResponse(response);
    expect(res.results).toHaveLength(2);
    expect(res.totalCount).toBe(57);
  });

  it('falls back to the page size when an older server omits the total', () => {
    const response = ['OK FACET 2', 'python\t12', 'ruby\t7', ''].join('\n');
    expect(parseFacetResponse(response).totalCount).toBe(2);
  });
});

describe('MygramDB v1.9 wire round-trip', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a boolean-mode search with filters over the socket', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.search('articles', 'python OR ruby', {
      queryMode: 'boolean',
      filters: { views: { op: '>', value: '1000' } },
      limit: 5
    });
    expect(lastCommand(socket)).toBe('SEARCH articles python OR ruby FILTER views > 1000 LIMIT 5\r\n');
    socket.emit('data', 'OK RESULTS 0\r\n');
    await promise;
  });
});
