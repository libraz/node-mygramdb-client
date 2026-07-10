import type * as net from 'node:net';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { MygramClient } from '../src/client';
import { parseFacetResponse } from '../src/response-parser';

// Reuse the socket-mock pattern from v17-mock.test.ts.
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

describe('MygramDB v1.8 searchRaw verbatim boolean expression', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the boolean expression verbatim (unquoted) so the server parses operators', async () => {
    const { client, socket } = createConnectedClient();
    await client.connect();
    const promise = client.searchRaw('articles', 'python OR (ruby AND rails)');
    const command = lastCommand(socket);
    expect(command).toContain('SEARCH articles python OR (ruby AND rails)');
    expect(command).not.toContain('"python OR (ruby AND rails)"');
    socket.emit('data', 'OK RESULTS 0\r\n');
    await promise;
  });
});

describe('MygramDB v1.8 FACET values starting with #', () => {
  it('keeps a #-prefixed facet value (tab-bearing row) and skips a tab-less comment', () => {
    const response = ['OK FACET 2', '#javascript\t12', '# this is a comment', 'python\t7', ''].join('\n');
    const res = parseFacetResponse(response);
    expect(res.results).toEqual([
      { value: '#javascript', count: 12 },
      { value: 'python', count: 7 }
    ]);
  });
});
