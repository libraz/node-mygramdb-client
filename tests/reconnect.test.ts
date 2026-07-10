import type * as net from 'node:net';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { MygramClient } from '../src/client';
import { ConnectionError } from '../src/errors';

// Reuse the socket-mock pattern from client-mock.test.ts / connection.test.ts.
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

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function writes(socket: net.Socket): unknown[][] {
  return (socket.write as MockInstance).mock.calls;
}

describe('MygramClient auto-reconnect (pure-JS transport)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reconnects once and resends when the socket is dead before send', async () => {
    const { client, socket: first } = createConnectedClient({ autoReconnect: true });
    await client.connect();

    // The socket dies while idle, before the next command is written.
    first.emit('close');
    expect(client.isConnected()).toBe(false);

    const promise = client.search('articles', 'hello');

    // A fresh socket was created for the single reconnect attempt.
    const second = getInternalSocket(client);
    expect(second).not.toBe(first);

    second.emit('connect'); // reconnect handshake completes
    await flushMicrotasks();

    // The command is (re)written on the new socket exactly once.
    expect(writes(second)).toHaveLength(1);
    expect(writes(second)[0][0]).toContain('SEARCH articles hello');

    second.emit('data', 'OK RESULTS 0\r\n');
    await expect(promise).resolves.toEqual({ results: [], totalCount: 0 });
  });

  it('surfaces ConnectionError without resending when the drop happens after the write', async () => {
    const { client, socket } = createConnectedClient({ autoReconnect: true });
    await client.connect();

    const promise = client.search('articles', 'hello');
    // The command reached the wire before the socket dropped.
    expect(writes(socket)).toHaveLength(1);

    socket.emit('error', new Error('Connection reset'));

    await expect(promise).rejects.toBeInstanceOf(ConnectionError);
    // No reconnect and no resend: the socket reference and write count are unchanged.
    expect(getInternalSocket(client)).toBe(socket);
    expect(writes(socket)).toHaveLength(1);
  });

  it('rejects with ConnectionError when the single reconnect attempt fails', async () => {
    const { client, socket: first } = createConnectedClient({ autoReconnect: true });
    await client.connect();
    first.emit('close');

    const promise = client.search('articles', 'hello');
    const second = getInternalSocket(client);
    expect(second).not.toBe(first);

    // The reconnect handshake fails; only one attempt is made.
    second.emit('error', new Error('ECONNREFUSED'));

    await expect(promise).rejects.toBeInstanceOf(ConnectionError);
  });

  it('rejects immediately without reconnecting when autoReconnect is disabled', async () => {
    const { client, socket } = createConnectedClient(); // default: autoReconnect false
    await client.connect();
    socket.emit('close');

    await expect(client.search('articles', 'hello')).rejects.toBeInstanceOf(ConnectionError);
    // The dead socket reference is left in place - no reconnect was attempted.
    expect(getInternalSocket(client)).toBe(socket);
  });
});
