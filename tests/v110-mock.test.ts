import type * as net from 'node:net';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { MygramClient } from '../src/client';
import { buildAuthCommand } from '../src/command-builder';
import {
  ErrorCode,
  isAuthRequiredErrorCode,
  isConnectionLostErrorCode,
  isRetryableErrorCode
} from '../src/error-codes';
import { InputValidationError, ProtocolError, ServerError } from '../src/errors';
import { parseErrorFrame, parseInfoResponse } from '../src/response-parser';

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

/** Let the pending microtasks run, so `connect()` resumes and writes its AUTH. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function openSocket(client: MygramClient): Promise<{ socket: net.Socket; connectPromise: Promise<void> }> {
  const connectPromise = client.connect();
  const socket = (client as unknown as { connection: { socket: net.Socket } }).connection.socket;
  socket.emit('connect');
  await flush();
  return { socket, connectPromise };
}

function commands(socket: net.Socket): string[] {
  return (socket.write as MockInstance).mock.calls.map((call) => call[0] as string);
}

function lastCommand(socket: net.Socket): string {
  const written = commands(socket);
  return written[written.length - 1];
}

describe('MygramDB v1.10 ERROR frame codes', () => {
  it('splits a coded frame into a code and a message', () => {
    expect(parseErrorFrame('ERROR 4007 Table not found')).toEqual({ code: 4007, message: 'Table not found' });
  });

  it('keeps the whole payload as the message for an untyped frame', () => {
    expect(parseErrorFrame('ERROR Table not found')).toEqual({ code: undefined, message: 'Table not found' });
  });

  it('treats a leading zero-valued or oversized token as message text', () => {
    // Mirrors the server's ParseErrorFrame, which only accepts a non-zero uint16.
    expect(parseErrorFrame('ERROR 0 something')).toEqual({ code: undefined, message: '0 something' });
    expect(parseErrorFrame('ERROR 70000 something')).toEqual({ code: undefined, message: '70000 something' });
  });

  it('does not treat a numeric-prefixed word as a code', () => {
    expect(parseErrorFrame('ERROR 12abc broke')).toEqual({ code: undefined, message: '12abc broke' });
  });

  it('surfaces the code as the message for a bare coded frame', () => {
    expect(parseErrorFrame('ERROR 6030')).toEqual({ code: 6030, message: 'Server error 6030' });
  });

  it('returns null for a non-ERROR frame', () => {
    expect(parseErrorFrame('OK RESULTS 0')).toBeNull();
  });
});

describe('MygramDB v1.10 ServerError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a command with the numeric code and the message alone', async () => {
    const client = new MygramClient();
    const { socket, connectPromise } = await openSocket(client);
    await connectPromise;

    const promise = client.search('missing', 'hello');
    socket.emit('data', 'ERROR 4007 Table not found\r\n');

    await expect(promise).rejects.toThrow(ServerError);
    const error = await promise.catch((err: unknown) => err as ServerError);
    expect(error.code).toBe(ErrorCode.TableNotFound);
    expect(error.message).toBe('Table not found');
    expect(error.rawFrame).toBe('ERROR 4007 Table not found');
    // Callers written against earlier releases catch ProtocolError.
    expect(error).toBeInstanceOf(ProtocolError);
  });

  it('leaves the code undefined against a pre-v1.10 server', async () => {
    const client = new MygramClient();
    const { socket, connectPromise } = await openSocket(client);
    await connectPromise;

    const promise = client.search('missing', 'hello');
    socket.emit('data', 'ERROR Table not found\r\n');

    const error = await promise.catch((err: unknown) => err as ServerError);
    expect(error.code).toBeUndefined();
    expect(error.message).toBe('Table not found');
  });
});

describe('MygramDB v1.10 error-code classification', () => {
  it('marks the transient server conditions as retryable', () => {
    expect(isRetryableErrorCode(ErrorCode.ServerLoading)).toBe(true);
    expect(isRetryableErrorCode(ErrorCode.ServerNotReady)).toBe(true);
    expect(isRetryableErrorCode(ErrorCode.ServerBusy)).toBe(true);
    expect(isRetryableErrorCode(ErrorCode.TableNotFound)).toBe(false);
    expect(isRetryableErrorCode(undefined)).toBe(false);
  });

  it('recognises a lost connection and a missing credential', () => {
    expect(isConnectionLostErrorCode(ErrorCode.NetworkConnectionClosed)).toBe(true);
    expect(isConnectionLostErrorCode(ErrorCode.ServerBusy)).toBe(false);
    expect(isAuthRequiredErrorCode(ErrorCode.PermissionDenied)).toBe(true);
    expect(isAuthRequiredErrorCode(ErrorCode.ServerBusy)).toBe(false);
  });
});

describe('MygramDB v1.10 AUTH', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('quotes a token containing whitespace', () => {
    expect(buildAuthCommand('s3cret')).toBe('AUTH s3cret');
    expect(buildAuthCommand('two words')).toBe('AUTH "two words"');
  });

  it('rejects an empty token', () => {
    expect(() => buildAuthCommand('')).toThrow(InputValidationError);
  });

  it('authenticates automatically on connect when adminToken is configured', async () => {
    const client = new MygramClient({ adminToken: 's3cret' });
    const { socket, connectPromise } = await openSocket(client);

    expect(lastCommand(socket)).toBe('AUTH s3cret\r\n');
    socket.emit('data', 'OK AUTHENTICATED\r\n');
    await connectPromise;
    expect(client.isConnected()).toBe(true);
  });

  it('sends no AUTH when no token is configured', async () => {
    const client = new MygramClient();
    const { socket, connectPromise } = await openSocket(client);
    await connectPromise;
    expect(commands(socket)).toHaveLength(0);
  });

  it('treats an explicitly undefined adminToken as no token at all', async () => {
    // `{ adminToken: process.env.MYGRAM_ADMIN_TOKEN }` is an ordinary way to
    // build a config, and the key is then present with an undefined value. It
    // must not be read as a request to authenticate with an empty token.
    const client = new MygramClient({ adminToken: undefined });
    const { socket, connectPromise } = await openSocket(client);
    await connectPromise;
    expect(commands(socket)).toHaveLength(0);
    expect(client.isConnected()).toBe(true);
  });

  it('fails the connect and drops the socket when the token is rejected', async () => {
    const client = new MygramClient({ adminToken: 'wrong' });
    const { socket, connectPromise } = await openSocket(client);

    socket.emit('data', 'ERROR 7 Authentication failed\r\n');

    const error = await connectPromise.catch((err: unknown) => err as ServerError);
    expect(error).toBeInstanceOf(ServerError);
    expect(error.code).toBe(ErrorCode.PermissionDenied);
    expect(client.isConnected()).toBe(false);
  });

  it('keeps a command queued behind the AUTH it was raced against', async () => {
    const client = new MygramClient({ adminToken: 's3cret' });
    const { socket, connectPromise } = await openSocket(client);

    const search = client.search('articles', 'hello');
    // The AUTH is still in flight, so the search must not have been written.
    expect(commands(socket)).toEqual(['AUTH s3cret\r\n']);

    socket.emit('data', 'OK AUTHENTICATED\r\n');
    await connectPromise;

    expect(lastCommand(socket)).toContain('SEARCH articles hello');
    socket.emit('data', 'OK RESULTS 0\r\n');
    await search;
  });

  it('re-authenticates on an auto-reconnect', async () => {
    const client = new MygramClient({ adminToken: 's3cret', autoReconnect: true });
    const { socket, connectPromise } = await openSocket(client);
    socket.emit('data', 'OK AUTHENTICATED\r\n');
    await connectPromise;

    socket.emit('close');
    expect(client.isConnected()).toBe(false);

    const search = client.search('articles', 'hello');
    const reconnected = (client as unknown as { connection: { socket: net.Socket } }).connection.socket;
    reconnected.emit('connect');
    await flush();

    expect(lastCommand(reconnected)).toBe('AUTH s3cret\r\n');
    reconnected.emit('data', 'OK AUTHENTICATED\r\n');
    await flush();

    expect(lastCommand(reconnected)).toContain('SEARCH articles hello');
    reconnected.emit('data', 'OK RESULTS 0\r\n');
    await search;
  });

  it('sends AUTH on demand via authenticate()', async () => {
    const client = new MygramClient();
    const { socket, connectPromise } = await openSocket(client);
    await connectPromise;

    const promise = client.authenticate('s3cret');
    expect(lastCommand(socket)).toBe('AUTH s3cret\r\n');
    socket.emit('data', 'OK AUTHENTICATED\r\n');
    await promise;
  });
});

describe('MygramDB v1.10 INFO readiness', () => {
  it('reports data_initialized and readiness', () => {
    const response = [
      'OK INFO',
      '',
      '# Server',
      'version: 1.10.0',
      'uptime_seconds: 42',
      'data_initialized: true',
      'readiness: ready',
      'END'
    ].join('\n');
    const info = parseInfoResponse(response);
    expect(info.dataInitialized).toBe(true);
    expect(info.ready).toBe(true);
  });

  it('reports a not-ready server', () => {
    const response = ['OK INFO', '', 'data_initialized: false', 'readiness: not_ready', 'END'].join('\n');
    const info = parseInfoResponse(response);
    expect(info.dataInitialized).toBe(false);
    expect(info.ready).toBe(false);
  });

  it('leaves both undefined against a pre-v1.10 server', () => {
    const response = ['OK INFO', '', 'version: 1.8.1', 'END'].join('\n');
    const info = parseInfoResponse(response);
    expect(info.dataInitialized).toBeUndefined();
    expect(info.ready).toBeUndefined();
  });
});
