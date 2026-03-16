import type * as net from 'node:net';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { MygramClient } from '../src/client';
import { ConnectionError, ProtocolError, TimeoutError } from '../src/errors';

// Mock the net module
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

  // Start connection
  const connectPromise = client.connect();

  // Get socket instance (created inside connect())
  const socket = (client as unknown as { socket: net.Socket }).socket;

  // Emit connect event
  socket.emit('connect');

  // Wait for connection
  connectPromise.catch(() => {});

  return { client, socket };
}

describe('MygramClient (mocked socket)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('connect', () => {
    it('should connect via TCP', async () => {
      const client = new MygramClient({ host: 'localhost', port: 11016 });
      const promise = client.connect();

      const socket = (client as unknown as { socket: net.Socket }).socket;
      expect(socket.setEncoding).toHaveBeenCalledWith('utf8');
      expect(socket.setTimeout).toHaveBeenCalledWith(5000);

      socket.emit('connect');
      await promise;

      expect(client.isConnected()).toBe(true);
      expect(socket.connect).toHaveBeenCalledWith(11016, 'localhost');
    });

    it('should connect via Unix socket', async () => {
      const client = new MygramClient({ socketPath: '/tmp/mygramdb.sock' });
      const promise = client.connect();

      const socket = (client as unknown as { socket: net.Socket }).socket;
      socket.emit('connect');
      await promise;

      expect(socket.connect).toHaveBeenCalledWith({ path: '/tmp/mygramdb.sock' });
    });

    it('should resolve immediately if already connected', async () => {
      const { client } = createConnectedClient();
      await client.connect();

      // Second call should resolve immediately
      await client.connect();
      expect(client.isConnected()).toBe(true);
    });

    it('should reject on connection error', async () => {
      const client = new MygramClient();
      const promise = client.connect();

      const socket = (client as unknown as { socket: net.Socket }).socket;
      socket.emit('error', new Error('ECONNREFUSED'));

      await expect(promise).rejects.toThrow(ConnectionError);
      await expect(promise).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('socket events', () => {
    it('should handle error during pending command', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const commandPromise = client.sendCommand('INFO');

      // Simulate error during pending command
      socket.emit('error', new Error('Connection reset'));

      await expect(commandPromise).rejects.toThrow(ConnectionError);
      expect(client.isConnected()).toBe(false);
    });

    it('should handle timeout during pending command', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const commandPromise = client.sendCommand('INFO');

      // Simulate timeout
      socket.emit('timeout');

      await expect(commandPromise).rejects.toThrow(TimeoutError);
    });

    it('should handle close during pending command', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const commandPromise = client.sendCommand('INFO');

      // Simulate close
      socket.emit('close');

      await expect(commandPromise).rejects.toThrow(ConnectionError);
      await expect(commandPromise).rejects.toThrow('Connection closed');
    });
  });

  describe('search', () => {
    it('should parse basic search response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.search('articles', 'hello');
      socket.emit('data', 'OK RESULTS 3 id1 id2 id3\n');

      const result = await promise;
      expect(result.totalCount).toBe(3);
      expect(result.results).toEqual([{ primaryKey: 'id1' }, { primaryKey: 'id2' }, { primaryKey: 'id3' }]);
      expect(result.debug).toBeUndefined();
    });

    it('should send correct command with AND/NOT terms', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.search('articles', 'hello', {
        andTerms: ['world', 'foo'],
        notTerms: ['spam'],
        limit: 50,
        offset: 10,
        filters: { status: 'published' },
        sortColumn: 'created_at',
        sortDesc: true
      });

      const writeCall = (socket.write as MockInstance).mock.calls[0][0] as string;
      expect(writeCall).toContain('SEARCH articles hello');
      expect(writeCall).toContain('AND world');
      expect(writeCall).toContain('AND foo');
      expect(writeCall).toContain('NOT spam');
      expect(writeCall).toContain('FILTER status = published');
      expect(writeCall).toContain('SORT created_at DESC');
      expect(writeCall).toContain('LIMIT 10,50');

      socket.emit('data', 'OK RESULTS 1 id1\n');
      await promise;
    });

    it('should send ASC sort when sortDesc is false', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.search('articles', 'hello', {
        sortColumn: 'title',
        sortDesc: false
      });

      const writeCall = (socket.write as MockInstance).mock.calls[0][0] as string;
      expect(writeCall).toContain('SORT title ASC');

      socket.emit('data', 'OK RESULTS 0\n');
      await promise;
    });

    it('should send LIMIT without offset when offset is 0', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.search('articles', 'hello', { limit: 100 });

      const writeCall = (socket.write as MockInstance).mock.calls[0][0] as string;
      expect(writeCall).toContain('LIMIT 100');
      expect(writeCall).not.toContain(',');

      socket.emit('data', 'OK RESULTS 0\n');
      await promise;
    });

    it('should parse search response with debug info', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.search('articles', 'hello');

      const response = [
        'OK RESULTS 2 id1 id2',
        '# DEBUG',
        'query_time: 1.5',
        'index_time: 0.8',
        'filter_time: 0.2',
        'terms: 1',
        'ngrams: 3',
        'candidates: 100',
        'after_intersection: 50',
        'after_not: 45',
        'after_filters: 40',
        'final: 2',
        'optimization: ngram',
        'sort: id DESC',
        'cache: miss',
        'limit: 1000 (default)',
        'offset: 0 (default)',
        '',
        ''
      ].join('\n');

      socket.emit('data', response);

      const result = await promise;
      expect(result.totalCount).toBe(2);
      expect(result.debug).toBeDefined();
      expect(result.debug!.queryTimeMs).toBe(1.5);
      expect(result.debug!.indexTimeMs).toBe(0.8);
      expect(result.debug!.filterTimeMs).toBe(0.2);
      expect(result.debug!.terms).toBe(1);
      expect(result.debug!.ngrams).toBe(3);
      expect(result.debug!.candidates).toBe(100);
      expect(result.debug!.afterIntersection).toBe(50);
      expect(result.debug!.afterNot).toBe(45);
      expect(result.debug!.afterFilters).toBe(40);
      expect(result.debug!.final).toBe(2);
      expect(result.debug!.optimization).toBe('ngram');
      expect(result.debug!.sort).toBe('id DESC');
      expect(result.debug!.cache).toBe('miss');
      expect(result.debug!.limit).toBe(1000);
      expect(result.debug!.offset).toBe(0);
    });

    it('should parse debug info with cache hit', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.search('articles', 'hello');

      const response = [
        'OK RESULTS 1 id1',
        '# DEBUG',
        'query_time: 0.1',
        'cache: hit',
        'cache_age_ms: 500.0',
        'cache_saved_ms: 2.3',
        '',
        ''
      ].join('\n');

      socket.emit('data', response);

      const result = await promise;
      expect(result.debug!.cache).toBe('hit');
      expect(result.debug!.cacheAgeMs).toBe(500.0);
      expect(result.debug!.cacheSavedMs).toBe(2.3);
    });

    it('should throw ProtocolError on invalid response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.search('articles', 'hello');
      socket.emit('data', 'INVALID RESPONSE\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });

    it('should parse empty results', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.search('articles', 'nonexistent');
      socket.emit('data', 'OK RESULTS 0\n');

      const result = await promise;
      expect(result.totalCount).toBe(0);
      expect(result.results).toEqual([]);
    });
  });

  describe('count', () => {
    it('should parse count response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.count('articles', 'hello');
      socket.emit('data', 'OK COUNT 42\n');

      const result = await promise;
      expect(result.count).toBe(42);
      expect(result.debug).toBeUndefined();
    });

    it('should send correct command with AND/NOT/FILTER terms', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.count('articles', 'hello', {
        andTerms: ['world'],
        notTerms: ['spam'],
        filters: { lang: 'en' }
      });

      const writeCall = (socket.write as MockInstance).mock.calls[0][0] as string;
      expect(writeCall).toContain('COUNT articles hello');
      expect(writeCall).toContain('AND world');
      expect(writeCall).toContain('NOT spam');
      expect(writeCall).toContain('FILTER lang = en');

      socket.emit('data', 'OK COUNT 10\n');
      await promise;
    });

    it('should parse count response with debug info', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.count('articles', 'hello');
      const response = ['OK COUNT 42', '# DEBUG', 'query_time: 0.5', 'terms: 1', '', ''].join('\n');
      socket.emit('data', response);

      const result = await promise;
      expect(result.count).toBe(42);
      expect(result.debug).toBeDefined();
      expect(result.debug!.queryTimeMs).toBe(0.5);
    });

    it('should throw ProtocolError on invalid response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.count('articles', 'hello');
      socket.emit('data', 'INVALID\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });
  });

  describe('get', () => {
    it('should parse document response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.get('articles', '123');
      socket.emit('data', 'OK DOC 123 title=Hello status=published\n');

      const doc = await promise;
      expect(doc.primaryKey).toBe('123');
      expect(doc.fields).toEqual({ title: 'Hello', status: 'published' });
    });

    it('should parse document with no fields', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.get('articles', '456');
      socket.emit('data', 'OK DOC 456\n');

      const doc = await promise;
      expect(doc.primaryKey).toBe('456');
      expect(doc.fields).toEqual({});
    });

    it('should throw ProtocolError on invalid response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.get('articles', '123');
      socket.emit('data', 'NOT FOUND\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });
  });

  describe('info', () => {
    it('should parse info response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.info();

      const response = [
        'OK INFO',
        'version: 1.2.3',
        'uptime_seconds: 3600',
        'total_requests: 1000',
        'connected_clients: 5',
        'used_memory_bytes: 1048576',
        'total_documents: 500',
        'tables: articles, users',
        '',
        ''
      ].join('\n');

      socket.emit('data', response);

      const info = await promise;
      expect(info.version).toBe('1.2.3');
      expect(info.uptimeSeconds).toBe(3600);
      expect(info.totalRequests).toBe(1000);
      expect(info.activeConnections).toBe(5);
      expect(info.indexSizeBytes).toBe(1048576);
      expect(info.docCount).toBe(500);
      expect(info.tables).toEqual(['articles', 'users']);
    });

    it('should skip comment lines and empty lines', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.info();

      const response = ['OK INFO', '# Server', 'version: 2.0.0', '', '# Stats', 'total_requests: 10', '', ''].join(
        '\n'
      );

      socket.emit('data', response);

      const info = await promise;
      expect(info.version).toBe('2.0.0');
      expect(info.totalRequests).toBe(10);
    });

    it('should throw ProtocolError on invalid response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.info();
      socket.emit('data', 'BAD RESPONSE\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });
  });

  describe('getConfig', () => {
    it('should parse +OK config response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.getConfig();
      socket.emit('data', '+OK\nport: 11016\nhost: 0.0.0.0\n\n');

      const config = await promise;
      expect(config).toBe('port: 11016\nhost: 0.0.0.0');
    });

    it('should parse OK CONFIG response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.getConfig();
      socket.emit('data', 'OK CONFIG\nport: 11016\n\n');

      const config = await promise;
      expect(config).toBe('port: 11016');
    });

    it('should throw ProtocolError on invalid response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.getConfig();
      socket.emit('data', 'BAD RESPONSE\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });
  });

  describe('replication', () => {
    it('should parse single-line replication status', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.getReplicationStatus();
      socket.emit('data', 'OK REPLICATION status=running gtid=abc-123\n');

      const status = await promise;
      expect(status.running).toBe(true);
      expect(status.gtid).toBe('abc-123');
    });

    it('should parse multi-line replication status', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.getReplicationStatus();
      socket.emit('data', 'OK REPLICATION\nstatus: running\ncurrent_gtid: def-456\nprocessed_events: 100\nEND\n');

      const status = await promise;
      expect(status.running).toBe(true);
      expect(status.gtid).toBe('def-456');
    });

    it('should parse stopped replication status', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.getReplicationStatus();
      socket.emit('data', 'OK REPLICATION status=stopped gtid=\n');

      const status = await promise;
      expect(status.running).toBe(false);
    });

    it('should throw ProtocolError on invalid replication response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.getReplicationStatus();
      socket.emit('data', 'BAD RESPONSE\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });

    it('should stop replication', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.stopReplication();
      socket.emit('data', 'OK\n');

      await promise;
    });

    it('should throw on failed stop replication', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.stopReplication();
      socket.emit('data', 'FAIL\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });

    it('should start replication', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.startReplication();
      socket.emit('data', 'OK\n');

      await promise;
    });

    it('should throw on failed start replication', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.startReplication();
      socket.emit('data', 'FAIL\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });
  });

  describe('debug', () => {
    it('should enable debug', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.enableDebug();
      socket.emit('data', 'OK\n');

      await promise;
    });

    it('should throw on failed enable debug', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.enableDebug();
      socket.emit('data', 'FAIL\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });

    it('should disable debug', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.disableDebug();
      socket.emit('data', 'OK\n');

      await promise;
    });

    it('should throw on failed disable debug', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.disableDebug();
      socket.emit('data', 'FAIL\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });
  });

  describe('dump operations', () => {
    it('should parse DUMP_STARTED response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.dumpSave('/tmp/dump.bin');
      socket.emit('data', 'OK DUMP_STARTED /tmp/dump.bin\n');

      const filepath = await promise;
      expect(filepath).toBe('/tmp/dump.bin');
    });

    it('should parse DUMP_SAVED response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.dumpSave('/tmp/dump.bin');
      socket.emit('data', 'OK DUMP_SAVED /tmp/dump.bin\n');

      const filepath = await promise;
      expect(filepath).toBe('/tmp/dump.bin');
    });

    it('should throw on invalid dump save response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.dumpSave('/tmp/dump.bin');
      socket.emit('data', 'FAIL\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });

    it('should load dump', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.dumpLoad('/tmp/dump.bin');
      socket.emit('data', 'OK\n');

      await promise;
    });

    it('should throw on failed dump load', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.dumpLoad('/tmp/dump.bin');
      socket.emit('data', 'FAIL\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });

    it('should parse dump status response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.dumpStatus();

      const response = [
        'OK DUMP_STATUS',
        'status: saving',
        'filepath: /tmp/dump.bin',
        'tables_total: 5',
        'tables_processed: 2',
        'current_table: articles',
        'elapsed_seconds: 3.5',
        '',
        ''
      ].join('\n');

      socket.emit('data', response);

      const status = await promise;
      expect(status.status).toBe('saving');
      expect(status.filepath).toBe('/tmp/dump.bin');
      expect(status.tablesTotal).toBe(5);
      expect(status.tablesProcessed).toBe(2);
      expect(status.currentTable).toBe('articles');
      expect(status.elapsedSeconds).toBe(3.5);
    });

    it('should parse dump status with error', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.dumpStatus();

      const response = ['OK DUMP_STATUS', 'status: failed', 'error: disk full', '', ''].join('\n');

      socket.emit('data', response);

      const status = await promise;
      expect(status.status).toBe('failed');
      expect(status.error).toBe('disk full');
    });

    it('should throw on invalid dump status response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.dumpStatus();
      socket.emit('data', 'BAD\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });

    it('should verify dump', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.dumpVerify('/tmp/dump.bin');
      socket.emit('data', 'OK VERIFIED\n');

      const result = await promise;
      expect(result).toBe('OK VERIFIED');
    });

    it('should throw on failed dump verify', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.dumpVerify('/tmp/dump.bin');
      socket.emit('data', 'FAIL\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });

    it('should get dump info', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.dumpInfo('/tmp/dump.bin');
      socket.emit('data', 'OK DUMP tables=3\n');

      const result = await promise;
      expect(result).toBe('OK DUMP tables=3');
    });

    it('should throw on failed dump info', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.dumpInfo('/tmp/dump.bin');
      socket.emit('data', 'FAIL\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });
  });

  describe('cache operations', () => {
    it('should parse cache stats response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.cacheStats();

      const response = [
        'OK CACHE_STATS',
        'enabled: true',
        'max_memory_mb: 256',
        'current_memory_mb: 128.5',
        'entries: 1000',
        'hits: 5000',
        'misses: 200',
        'hit_rate: 96.15%',
        'evictions: 50',
        'ttl_seconds: 3600',
        '',
        ''
      ].join('\n');

      socket.emit('data', response);

      const stats = await promise;
      expect(stats.enabled).toBe(true);
      expect(stats.maxMemoryMb).toBe(256);
      expect(stats.currentMemoryMb).toBe(128.5);
      expect(stats.entries).toBe(1000);
      expect(stats.hits).toBe(5000);
      expect(stats.misses).toBe(200);
      expect(stats.hitRate).toBe(96.15);
      expect(stats.evictions).toBe(50);
      expect(stats.ttlSeconds).toBe(3600);
    });

    it('should throw on invalid cache stats response', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.cacheStats();
      socket.emit('data', 'BAD\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });

    it('should clear cache', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.cacheClear();
      socket.emit('data', 'OK\n');
      await promise;
    });

    it('should clear cache for specific table', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.cacheClear('articles');

      const writeCall = (socket.write as MockInstance).mock.calls[0][0] as string;
      expect(writeCall).toContain('CACHE CLEAR articles');

      socket.emit('data', 'OK\n');
      await promise;
    });

    it('should throw on failed cache clear', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.cacheClear();
      socket.emit('data', 'FAIL\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });

    it('should enable cache', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.cacheEnable();
      socket.emit('data', 'OK\n');
      await promise;
    });

    it('should throw on failed cache enable', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.cacheEnable();
      socket.emit('data', 'FAIL\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });

    it('should disable cache', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.cacheDisable();
      socket.emit('data', 'OK\n');
      await promise;
    });

    it('should throw on failed cache disable', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.cacheDisable();
      socket.emit('data', 'FAIL\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });
  });

  describe('optimize', () => {
    it('should optimize all tables', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.optimize();

      const writeCall = (socket.write as MockInstance).mock.calls[0][0] as string;
      expect(writeCall).toContain('OPTIMIZE\r\n');

      socket.emit('data', 'OK\n');
      await promise;
    });

    it('should optimize specific table', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.optimize('articles');

      const writeCall = (socket.write as MockInstance).mock.calls[0][0] as string;
      expect(writeCall).toContain('OPTIMIZE articles');

      socket.emit('data', 'OK\n');
      await promise;
    });

    it('should throw on failed optimize', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.optimize();
      socket.emit('data', 'FAIL\n');

      await expect(promise).rejects.toThrow(ProtocolError);
    });
  });

  describe('error responses', () => {
    it('should handle ERROR response from server', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.sendCommand('BAD COMMAND');
      socket.emit('data', 'ERROR unknown command\n');

      await expect(promise).rejects.toThrow(ProtocolError);
      await expect(promise).rejects.toThrow('unknown command');
    });
  });

  describe('CRLF handling', () => {
    it('should normalize CRLF to LF in responses', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.search('articles', 'test');
      socket.emit('data', 'OK RESULTS 1 id1\r\n');

      const result = await promise;
      expect(result.totalCount).toBe(1);
    });

    it('should handle multi-line response with CRLF', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.info();
      socket.emit('data', 'OK INFO\r\nversion: 1.0.0\r\n\r\n');

      const info = await promise;
      expect(info.version).toBe('1.0.0');
    });
  });

  describe('chunked data', () => {
    it('should handle data received in chunks', async () => {
      const { client, socket } = createConnectedClient();
      await client.connect();

      const promise = client.search('articles', 'hello');

      // Send data in two chunks
      socket.emit('data', 'OK RESULTS ');
      socket.emit('data', '2 id1 id2\n');

      const result = await promise;
      expect(result.totalCount).toBe(2);
    });
  });
});
