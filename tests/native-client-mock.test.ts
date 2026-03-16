import { describe, expect, it, vi } from 'vitest';
import { ConnectionError, ProtocolError } from '../src/errors';
import { NativeMygramClient } from '../src/native-client';

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

describe('NativeMygramClient', () => {
  describe('constructor', () => {
    it('should create client with default config', () => {
      const native = createMockNative();
      const client = new NativeMygramClient(native);
      expect(client).toBeDefined();
    });

    it('should handle NaN maxQueryLength', () => {
      const native = createMockNative();
      const client = new NativeMygramClient(native, { maxQueryLength: NaN });
      const internalLimit = (client as unknown as { config: { maxQueryLength: number } }).config.maxQueryLength;
      expect(internalLimit).toBeGreaterThan(0);
    });
  });

  describe('connect', () => {
    it('should connect successfully', async () => {
      const native = createMockNative();
      const client = new NativeMygramClient(native);

      await client.connect();

      expect(native.createClient).toHaveBeenCalledWith({
        host: '127.0.0.1',
        port: 11016,
        timeout: 5000
      });
      expect(native.connect).toHaveBeenCalledWith('handle');
    });

    it('should resolve immediately if already connected', async () => {
      const native = createMockNative();
      const client = new NativeMygramClient(native);

      await client.connect();
      await client.connect();

      expect(native.createClient).toHaveBeenCalledTimes(1);
    });

    it('should throw ConnectionError on failed connect', async () => {
      const native = createMockNative({
        connect: vi.fn().mockReturnValue(false),
        getLastError: vi.fn().mockReturnValue('Connection refused')
      });
      const client = new NativeMygramClient(native);

      await expect(client.connect()).rejects.toThrow(ConnectionError);
      await expect(client.connect()).rejects.toThrow('Connection refused');
    });

    it('should throw ConnectionError with default message when getLastError returns empty', async () => {
      const native = createMockNative({
        connect: vi.fn().mockReturnValue(false),
        getLastError: vi.fn().mockReturnValue('')
      });
      const client = new NativeMygramClient(native);

      await expect(client.connect()).rejects.toThrow('Failed to connect');
    });

    it('should wrap non-ConnectionError exceptions', async () => {
      const native = createMockNative({
        createClient: vi.fn().mockImplementation(() => {
          throw new TypeError('invalid argument');
        })
      });
      const client = new NativeMygramClient(native);

      await expect(client.connect()).rejects.toThrow(ConnectionError);
      await expect(client.connect()).rejects.toThrow('invalid argument');
    });

    it('should wrap non-Error exceptions', async () => {
      const native = createMockNative({
        createClient: vi.fn().mockImplementation(() => {
          throw 'string error';
        })
      });
      const client = new NativeMygramClient(native);

      await expect(client.connect()).rejects.toThrow(ConnectionError);
      await expect(client.connect()).rejects.toThrow('Connection failed');
    });
  });

  describe('disconnect', () => {
    it('should disconnect when connected', async () => {
      const native = createMockNative();
      const client = new NativeMygramClient(native);

      await client.connect();
      client.disconnect();

      expect(native.disconnect).toHaveBeenCalledWith('handle');
      expect(native.destroyClient).toHaveBeenCalledWith('handle');
    });

    it('should be safe to call when not connected', () => {
      const native = createMockNative();
      const client = new NativeMygramClient(native);

      expect(() => client.disconnect()).not.toThrow();
      expect(native.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('isConnected', () => {
    it('should return false when no handle', () => {
      const native = createMockNative();
      const client = new NativeMygramClient(native);

      expect(client.isConnected()).toBe(false);
    });

    it('should delegate to native isConnected', async () => {
      const native = createMockNative();
      const client = new NativeMygramClient(native);

      await client.connect();
      expect(client.isConnected()).toBe(true);
      expect(native.isConnected).toHaveBeenCalledWith('handle');
    });
  });

  describe('sendCommand', () => {
    it('should throw ConnectionError when not connected', async () => {
      const native = createMockNative();
      const client = new NativeMygramClient(native);

      await expect(client.sendCommand('INFO')).rejects.toThrow(ConnectionError);
    });

    it('should send command and return response', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('OK\r\n')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      const result = await client.sendCommand('INFO');
      expect(result).toBe('OK');
      expect(native.sendCommand).toHaveBeenCalledWith('handle', 'INFO');
    });

    it('should throw ProtocolError on ERROR response', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('ERROR unknown command')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await expect(client.sendCommand('BAD')).rejects.toThrow(ProtocolError);
      await expect(client.sendCommand('BAD')).rejects.toThrow('unknown command');
    });

    it('should throw ConnectionError on native exception', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockImplementation(() => {
          throw new Error('socket closed');
        }),
        getLastError: vi.fn().mockReturnValue('connection lost')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await expect(client.sendCommand('INFO')).rejects.toThrow(ConnectionError);
      await expect(client.sendCommand('INFO')).rejects.toThrow('connection lost');
    });

    it('should use error message when getLastError returns empty', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockImplementation(() => {
          throw new Error('native crash');
        }),
        getLastError: vi.fn().mockReturnValue('')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await expect(client.sendCommand('INFO')).rejects.toThrow('native crash');
    });

    it('should handle non-Error exception in sendCommand', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockImplementation(() => {
          throw 'string error';
        }),
        getLastError: vi.fn().mockReturnValue('')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await expect(client.sendCommand('INFO')).rejects.toThrow(ConnectionError);
      await expect(client.sendCommand('INFO')).rejects.toThrow('Command failed');
    });
  });

  describe('search', () => {
    it('should parse basic search response', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('OK RESULTS 3 id1 id2 id3')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      const result = await client.search('articles', 'hello');
      expect(result.totalCount).toBe(3);
      expect(result.results).toHaveLength(3);
    });

    it('should build command with all options', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('OK RESULTS 0')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await client.search('articles', 'hello', {
        andTerms: ['world'],
        notTerms: ['spam'],
        filters: { status: 'published' },
        sortColumn: 'created_at',
        sortDesc: false,
        limit: 50,
        offset: 10
      });

      const command = native.sendCommand.mock.calls[0][1] as string;
      expect(command).toContain('SEARCH articles hello');
      expect(command).toContain('AND world');
      expect(command).toContain('NOT spam');
      expect(command).toContain('FILTER status = published');
      expect(command).toContain('SORT created_at ASC');
      expect(command).toContain('LIMIT 10,50');
    });

    it('should parse search response with debug info', async () => {
      const response = [
        'OK RESULTS 1 id1',
        '# DEBUG',
        'query_time: 2.5',
        'index_time: 1.0',
        'filter_time: 0.3',
        'terms: 2',
        'ngrams: 4',
        'candidates: 200',
        'after_intersection: 100',
        'after_not: 90',
        'after_filters: 80',
        'final: 1',
        'optimization: prefix',
        'limit: 50',
        'offset: 10'
      ].join('\n');

      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue(response)
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      const result = await client.search('articles', 'hello');
      expect(result.debug).toBeDefined();
      expect(result.debug!.queryTimeMs).toBe(2.5);
      expect(result.debug!.optimization).toBe('prefix');
      expect(result.debug!.limit).toBe(50);
      expect(result.debug!.offset).toBe(10);
    });

    it('should throw ProtocolError on invalid search response', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('BAD RESPONSE')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await expect(client.search('articles', 'hello')).rejects.toThrow(ProtocolError);
    });
  });

  describe('count', () => {
    it('should parse count response', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('OK COUNT 42')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      const result = await client.count('articles', 'hello');
      expect(result.count).toBe(42);
    });

    it('should build command with AND/NOT/FILTER terms', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('OK COUNT 10')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await client.count('articles', 'hello', {
        andTerms: ['world'],
        notTerms: ['spam'],
        filters: { status: 'active' }
      });

      const command = native.sendCommand.mock.calls[0][1] as string;
      expect(command).toContain('COUNT articles hello');
      expect(command).toContain('AND world');
      expect(command).toContain('NOT spam');
      expect(command).toContain('FILTER');
      expect(command).toContain('status=active');
    });

    it('should parse count with debug info', async () => {
      const response = ['OK COUNT 10', '# DEBUG', 'query_time: 0.5', 'terms: 1'].join('\n');
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue(response)
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      const result = await client.count('articles', 'hello');
      expect(result.count).toBe(10);
      expect(result.debug!.queryTimeMs).toBe(0.5);
    });

    it('should throw ProtocolError on invalid count response', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('BAD')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await expect(client.count('articles', 'hello')).rejects.toThrow(ProtocolError);
    });
  });

  describe('get', () => {
    it('should parse document response', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('OK DOC 123 title=Hello status=published')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      const doc = await client.get('articles', '123');
      expect(doc.primaryKey).toBe('123');
      expect(doc.fields).toEqual({ title: 'Hello', status: 'published' });
    });

    it('should throw ProtocolError on invalid response', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('NOT FOUND')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await expect(client.get('articles', '123')).rejects.toThrow(ProtocolError);
    });
  });

  describe('info', () => {
    it('should parse info response', async () => {
      const response = [
        'OK INFO',
        'version: 1.0.0',
        'uptime_seconds: 7200',
        'total_requests: 500',
        'connected_clients: 3',
        'used_memory_bytes: 2097152',
        'total_documents: 1000',
        'tables: articles, users, logs'
      ].join('\n');

      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue(response)
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      const info = await client.info();
      expect(info.version).toBe('1.0.0');
      expect(info.uptimeSeconds).toBe(7200);
      expect(info.totalRequests).toBe(500);
      expect(info.activeConnections).toBe(3);
      expect(info.indexSizeBytes).toBe(2097152);
      expect(info.docCount).toBe(1000);
      expect(info.tables).toEqual(['articles', 'users', 'logs']);
    });

    it('should throw ProtocolError on invalid response', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('BAD')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await expect(client.info()).rejects.toThrow(ProtocolError);
    });
  });

  describe('getConfig', () => {
    it('should parse +OK config response', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('+OK\nport: 11016')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      const config = await client.getConfig();
      expect(config).toBe('port: 11016');
    });

    it('should parse OK CONFIG response', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('OK CONFIG\nport: 11016')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      const config = await client.getConfig();
      expect(config).toBe('port: 11016');
    });

    it('should throw ProtocolError on invalid response', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('BAD')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await expect(client.getConfig()).rejects.toThrow(ProtocolError);
    });
  });

  describe('replication', () => {
    it('should parse single-line replication status', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('OK REPLICATION status=running gtid=abc-123')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      const status = await client.getReplicationStatus();
      expect(status.running).toBe(true);
      expect(status.gtid).toBe('abc-123');
    });

    it('should parse multi-line replication status', async () => {
      const response = [
        'OK REPLICATION',
        'status: running',
        'current_gtid: def-456',
        'processed_events: 100',
        'END'
      ].join('\n');

      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue(response)
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      const status = await client.getReplicationStatus();
      expect(status.running).toBe(true);
      expect(status.gtid).toBe('def-456');
    });

    it('should throw on invalid replication response', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('BAD')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await expect(client.getReplicationStatus()).rejects.toThrow(ProtocolError);
    });

    it('should stop replication', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('OK')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await client.stopReplication();
      expect(native.sendCommand).toHaveBeenCalledWith('handle', 'REPLICATION STOP');
    });

    it('should throw on failed stop replication', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('FAIL')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await expect(client.stopReplication()).rejects.toThrow(ProtocolError);
    });

    it('should start replication', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('OK')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await client.startReplication();
      expect(native.sendCommand).toHaveBeenCalledWith('handle', 'REPLICATION START');
    });

    it('should throw on failed start replication', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('FAIL')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await expect(client.startReplication()).rejects.toThrow(ProtocolError);
    });
  });

  describe('debug', () => {
    it('should enable debug', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('OK')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await client.enableDebug();
      expect(native.sendCommand).toHaveBeenCalledWith('handle', 'DEBUG ON');
    });

    it('should throw on failed enable debug', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('FAIL')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await expect(client.enableDebug()).rejects.toThrow(ProtocolError);
    });

    it('should disable debug', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('OK')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await client.disableDebug();
      expect(native.sendCommand).toHaveBeenCalledWith('handle', 'DEBUG OFF');
    });

    it('should throw on failed disable debug', async () => {
      const native = createMockNative({
        sendCommand: vi.fn().mockReturnValue('FAIL')
      });
      const client = new NativeMygramClient(native);
      await client.connect();

      await expect(client.disableDebug()).rejects.toThrow(ProtocolError);
    });
  });
});
