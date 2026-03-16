import { describe, expect, it } from 'vitest';
import { MygramClient } from '../src/client';
import { ConnectionError, InputValidationError } from '../src/errors';

describe('MygramClient', () => {
  describe('constructor', () => {
    it('should create client with default config', () => {
      const client = new MygramClient();
      expect(client).toBeDefined();
      expect(client.isConnected()).toBe(false);
    });

    it('should create client with custom config', () => {
      const client = new MygramClient({
        host: 'example.com',
        port: 12345,
        timeout: 10000
      });
      expect(client).toBeDefined();
      expect(client.isConnected()).toBe(false);
    });

    it('should create client with Unix socket path', () => {
      const client = new MygramClient({
        socketPath: '/tmp/mygramdb.sock',
        timeout: 5000
      });
      expect(client).toBeDefined();
      expect(client.isConnected()).toBe(false);
    });

    it('should handle NaN maxQueryLength gracefully', () => {
      const client = new MygramClient({ maxQueryLength: NaN });
      expect(client).toBeDefined();
      // Should fall back to default
      const internalLimit = (client as unknown as { config: { maxQueryLength: number } }).config.maxQueryLength;
      expect(internalLimit).toBeGreaterThan(0);
    });

    it('should accept maxQueryLength of 0 to disable limit', () => {
      const client = new MygramClient({ maxQueryLength: 0 });
      const internalLimit = (client as unknown as { config: { maxQueryLength: number } }).config.maxQueryLength;
      expect(internalLimit).toBe(0);
    });
  });

  describe('disconnect', () => {
    it('should disconnect without error even when not connected', () => {
      const client = new MygramClient();
      expect(() => client.disconnect()).not.toThrow();
      expect(client.isConnected()).toBe(false);
    });

    it('should be idempotent', () => {
      const client = new MygramClient();
      client.disconnect();
      client.disconnect();
      expect(client.isConnected()).toBe(false);
    });
  });

  describe('sendCommand', () => {
    it('should throw ConnectionError when not connected', async () => {
      const client = new MygramClient();
      await expect(client.sendCommand('INFO')).rejects.toThrow(ConnectionError);
      await expect(client.sendCommand('INFO')).rejects.toThrow('Not connected to server');
    });
  });

  describe('search', () => {
    it('should throw ConnectionError when not connected', async () => {
      const client = new MygramClient();
      await expect(client.search('articles', 'test')).rejects.toThrow(ConnectionError);
    });

    it('should validate table name for control characters', async () => {
      const client = new MygramClient();
      await expect(client.search('articles\n', 'test')).rejects.toThrow(InputValidationError);
    });

    it('should validate query for control characters', async () => {
      const client = new MygramClient();
      await expect(client.search('articles', 'test\r')).rejects.toThrow(InputValidationError);
    });

    it('should validate andTerms for control characters', async () => {
      const client = new MygramClient();
      await expect(client.search('articles', 'test', { andTerms: ['good\0bad'] })).rejects.toThrow(
        InputValidationError
      );
    });

    it('should validate notTerms for control characters', async () => {
      const client = new MygramClient();
      await expect(client.search('articles', 'test', { notTerms: ['bad\t'] })).rejects.toThrow(InputValidationError);
    });

    it('should validate filter values for control characters', async () => {
      const client = new MygramClient();
      await expect(client.search('articles', 'test', { filters: { status: 'ok\nfail' } })).rejects.toThrow(
        InputValidationError
      );
    });

    it('should validate filter keys for control characters', async () => {
      const client = new MygramClient();
      await expect(client.search('articles', 'test', { filters: { 'key\n': 'value' } })).rejects.toThrow(
        InputValidationError
      );
    });

    it('should validate sortColumn for control characters', async () => {
      const client = new MygramClient();
      await expect(client.search('articles', 'test', { sortColumn: 'col\r\n' })).rejects.toThrow(InputValidationError);
    });
  });

  describe('count', () => {
    it('should throw ConnectionError when not connected', async () => {
      const client = new MygramClient();
      await expect(client.count('articles', 'test')).rejects.toThrow(ConnectionError);
    });

    it('should validate inputs', async () => {
      const client = new MygramClient();
      await expect(client.count('articles\n', 'test')).rejects.toThrow(InputValidationError);
    });
  });

  describe('get', () => {
    it('should throw ConnectionError when not connected', async () => {
      const client = new MygramClient();
      await expect(client.get('articles', '123')).rejects.toThrow(ConnectionError);
    });

    it('should validate table name', async () => {
      const client = new MygramClient();
      await expect(client.get('articles\n', '123')).rejects.toThrow(InputValidationError);
    });

    it('should validate primary key', async () => {
      const client = new MygramClient();
      await expect(client.get('articles', '123\r')).rejects.toThrow(InputValidationError);
    });
  });

  describe('info', () => {
    it('should throw ConnectionError when not connected', async () => {
      const client = new MygramClient();
      await expect(client.info()).rejects.toThrow(ConnectionError);
    });
  });

  describe('getConfig', () => {
    it('should throw ConnectionError when not connected', async () => {
      const client = new MygramClient();
      await expect(client.getConfig()).rejects.toThrow(ConnectionError);
    });
  });

  describe('replication', () => {
    it('should throw ConnectionError when not connected - getReplicationStatus', async () => {
      const client = new MygramClient();
      await expect(client.getReplicationStatus()).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected - stopReplication', async () => {
      const client = new MygramClient();
      await expect(client.stopReplication()).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected - startReplication', async () => {
      const client = new MygramClient();
      await expect(client.startReplication()).rejects.toThrow(ConnectionError);
    });
  });

  describe('debug', () => {
    it('should throw ConnectionError when not connected - enableDebug', async () => {
      const client = new MygramClient();
      await expect(client.enableDebug()).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected - disableDebug', async () => {
      const client = new MygramClient();
      await expect(client.disableDebug()).rejects.toThrow(ConnectionError);
    });
  });

  describe('dump operations', () => {
    it('should throw ConnectionError when not connected - dumpSave', async () => {
      const client = new MygramClient();
      await expect(client.dumpSave('/tmp/dump.bin')).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected - dumpLoad', async () => {
      const client = new MygramClient();
      await expect(client.dumpLoad('/tmp/dump.bin')).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected - dumpStatus', async () => {
      const client = new MygramClient();
      await expect(client.dumpStatus()).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected - dumpVerify', async () => {
      const client = new MygramClient();
      await expect(client.dumpVerify('/tmp/dump.bin')).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected - dumpInfo', async () => {
      const client = new MygramClient();
      await expect(client.dumpInfo('/tmp/dump.bin')).rejects.toThrow(ConnectionError);
    });

    it('should validate filepath for control characters - dumpSave', async () => {
      const client = new MygramClient();
      await expect(client.dumpSave('/tmp/dump\n.bin')).rejects.toThrow(InputValidationError);
    });

    it('should validate filepath for control characters - dumpLoad', async () => {
      const client = new MygramClient();
      await expect(client.dumpLoad('/tmp/dump\r.bin')).rejects.toThrow(InputValidationError);
    });

    it('should validate filepath for control characters - dumpVerify', async () => {
      const client = new MygramClient();
      await expect(client.dumpVerify('/tmp/dump\0.bin')).rejects.toThrow(InputValidationError);
    });

    it('should validate filepath for control characters - dumpInfo', async () => {
      const client = new MygramClient();
      await expect(client.dumpInfo('/tmp/dump\t.bin')).rejects.toThrow(InputValidationError);
    });
  });

  describe('cache operations', () => {
    it('should throw ConnectionError when not connected - cacheStats', async () => {
      const client = new MygramClient();
      await expect(client.cacheStats()).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected - cacheClear', async () => {
      const client = new MygramClient();
      await expect(client.cacheClear()).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected - cacheClear with table', async () => {
      const client = new MygramClient();
      await expect(client.cacheClear('articles')).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected - cacheEnable', async () => {
      const client = new MygramClient();
      await expect(client.cacheEnable()).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected - cacheDisable', async () => {
      const client = new MygramClient();
      await expect(client.cacheDisable()).rejects.toThrow(ConnectionError);
    });

    it('should validate table name for cacheClear', async () => {
      const client = new MygramClient();
      await expect(client.cacheClear('articles\n')).rejects.toThrow(InputValidationError);
    });
  });

  describe('optimize', () => {
    it('should throw ConnectionError when not connected', async () => {
      const client = new MygramClient();
      await expect(client.optimize()).rejects.toThrow(ConnectionError);
    });

    it('should throw ConnectionError when not connected - with table', async () => {
      const client = new MygramClient();
      await expect(client.optimize('articles')).rejects.toThrow(ConnectionError);
    });

    it('should validate table name', async () => {
      const client = new MygramClient();
      await expect(client.optimize('articles\n')).rejects.toThrow(InputValidationError);
    });
  });

  describe('input validation', () => {
    it('should reject queries containing newline characters', async () => {
      const client = new MygramClient();
      await expect(client.search('articles', 'safe\nunsafe')).rejects.toThrow(InputValidationError);
    });

    it('should reject filters containing newline characters', async () => {
      const client = new MygramClient();
      await expect(
        client.search('articles', 'safe', {
          filters: { status: 'ok\nfail' }
        })
      ).rejects.toThrow(InputValidationError);
    });

    it('should reject queries exceeding the default length limit', async () => {
      const client = new MygramClient();
      const longQuery = 'a'.repeat(1024);
      const internalLimit = (client as unknown as { config: { maxQueryLength: number } }).config.maxQueryLength;
      expect(typeof internalLimit).toBe('number');
      expect(internalLimit).toBeGreaterThan(0);
      await expect(client.search('articles', longQuery)).rejects.toThrow(InputValidationError);
      await expect(client.count('articles', longQuery)).rejects.toThrow(InputValidationError);
    });

    it('should allow longer queries when maxQueryLength is raised', async () => {
      const client = new MygramClient({ maxQueryLength: 2048 });
      const longQuery = 'a'.repeat(1024);
      await expect(client.search('articles', longQuery)).rejects.toThrow(ConnectionError);
    });
  });
});
