import type * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MygramClient } from '../src/client';
import { parseInfoResponse, parseReplicationStatusResponse } from '../src/response-parser';

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

async function connectedClient(): Promise<{ client: MygramClient; socket: net.Socket }> {
  const client = new MygramClient();
  const connectPromise = client.connect();
  const socket = (client as unknown as { connection: { socket: net.Socket } }).connection.socket;
  socket.emit('connect');
  await flush();
  await connectPromise;
  return { client, socket };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MygramDB v1.12 tagged GTIDs', () => {
  const tagged = '3E11FA47-71CA-11E1-9E33-C80AA9429562:tag_a:1-27';

  it('keeps a tagged GTID position whole in a multi-line REPLICATION STATUS', () => {
    const status = parseReplicationStatusResponse(
      `OK REPLICATION\nstatus: running\ncurrent_gtid: ${tagged},3E11FA47-71CA-11E1-9E33-C80AA9429562:1-5\nEND`
    );
    expect(status.running).toBe(true);
    expect(status.gtid).toBe(`${tagged},3E11FA47-71CA-11E1-9E33-C80AA9429562:1-5`);
  });

  it('keeps a tagged GTID position whole in the single-line form', () => {
    expect(parseReplicationStatusResponse(`OK REPLICATION status=running gtid=${tagged}`).gtid).toBe(tagged);
  });

  it('reads REPLICATION STATUS through the client', async () => {
    const { client, socket } = await connectedClient();
    const pending = client.getReplicationStatus();
    socket.emit('data', `OK REPLICATION\r\nstatus: running\r\ncurrent_gtid: ${tagged}\r\nEND\r\n`);
    expect((await pending).gtid).toBe(tagged);
  });
});

describe('MygramDB v1.12 INFO before AUTH', () => {
  it('parses an INFO reply that carries no # Replication section', () => {
    const response = [
      'OK INFO',
      '# Server',
      'version: 1.12.0',
      'uptime_seconds: 10',
      '',
      '# Clients',
      'connected_clients: 2',
      '',
      '# Cache',
      'cache_enabled: 1',
      'END'
    ].join('\n');
    const info = parseInfoResponse(response);
    expect(info.version).toBe('1.12.0');
    expect(info.activeConnections).toBe(2);
  });

  it('frames the reply the same with or without the section', async () => {
    const { client, socket } = await connectedClient();
    const pending = client.info();
    socket.emit('data', 'OK INFO\r\n# Server\r\nversion: 1.12.0\r\n\r\n# Clients\r\nconnected_clients: 1\r\nEND\r\n');
    expect((await pending).version).toBe('1.12.0');
  });
});
