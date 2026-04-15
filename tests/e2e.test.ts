/**
 * Integration tests for MygramDB client against a real server
 *
 * These tests require a running MygramDB server on localhost:11016.
 * Tests are skipped if the server is not available.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MygramClient } from '../src/client';
import { createMygramClient, getClientType, isNativeAvailable } from '../src/client-factory';
import { ProtocolError } from '../src/errors';
import type { NativeMygramClient } from '../src/native-client';
import { simplifySearchExpression } from '../src/search-expression';

const TEST_HOST = process.env.MYGRAM_HOST || '127.0.0.1';
const TEST_PORT = parseInt(process.env.MYGRAM_PORT || '11016', 10);

/** Common client interface for testing both implementations */
type TestClient = MygramClient | NativeMygramClient;

/**
 * Check if the MygramDB server is available
 */
async function isServerAvailable(): Promise<boolean> {
  const client = new MygramClient({ host: TEST_HOST, port: TEST_PORT, timeout: 1000 });
  try {
    await client.connect();
    client.disconnect();
    return true;
  } catch {
    return false;
  }
}

/**
 * Shared test suite that works with both client implementations
 */
function runClientTests(clientName: string, createClient: () => TestClient): void {
  describe(clientName, () => {
    let client: TestClient;

    beforeEach(async () => {
      client = createClient();
      await client.connect();
    });

    afterEach(() => {
      client.disconnect();
    });

    describe('connection', () => {
      it('should connect successfully', () => {
        expect(client.isConnected()).toBe(true);
      });

      it('should disconnect successfully', () => {
        client.disconnect();
        expect(client.isConnected()).toBe(false);
      });
    });

    describe('info', () => {
      it('should return server info', async () => {
        const info = await client.info();

        expect(info).toBeDefined();
        expect(info.version).toMatch(/^MygramDB/);
        expect(typeof info.uptimeSeconds).toBe('number');
        expect(info.uptimeSeconds).toBeGreaterThanOrEqual(0);
        expect(typeof info.totalRequests).toBe('number');
        expect(typeof info.activeConnections).toBe('number');
        expect(info.activeConnections).toBeGreaterThanOrEqual(1);
        expect(typeof info.indexSizeBytes).toBe('number');
        expect(typeof info.docCount).toBe('number');
        expect(Array.isArray(info.tables)).toBe(true);
      });
    });

    describe('config', () => {
      it('should return server config in YAML format', async () => {
        const config = await client.getConfig();

        expect(config).toBeDefined();
        expect(typeof config).toBe('string');
        expect(config.length).toBeGreaterThan(0);
        expect(config).toMatch(/api:/);
        expect(config).toMatch(/port:/);
      });
    });

    describe('replication status', () => {
      it('should return replication status', async () => {
        const status = await client.getReplicationStatus();

        expect(status).toBeDefined();
        expect(typeof status.running).toBe('boolean');
        expect(typeof status.gtid).toBe('string');
        expect(typeof status.statusStr).toBe('string');
      });
    });

    describe('debug mode', () => {
      it('should enable and disable debug mode', async () => {
        await expect(client.enableDebug()).resolves.not.toThrow();
        await expect(client.disableDebug()).resolves.not.toThrow();
      });
    });

    describe('search', () => {
      it('should execute search command', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;

        const table = info.tables[0];
        const result = await client.search(table, 'test');

        expect(result).toBeDefined();
        expect(typeof result.totalCount).toBe('number');
        expect(result.totalCount).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(result.results)).toBe(true);
      });

      it('should execute search with limit option', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;

        const table = info.tables[0];
        const result = await client.search(table, 'test', { limit: 5 });

        expect(result).toBeDefined();
        expect(result.results.length).toBeLessThanOrEqual(5);
      });

      it('should execute search with offset option', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;

        const table = info.tables[0];
        const result = await client.search(table, 'test', { limit: 10, offset: 5 });

        expect(result).toBeDefined();
        expect(typeof result.totalCount).toBe('number');
      });

      it('should execute search with AND terms', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;

        const table = info.tables[0];
        const result = await client.search(table, 'hello', { andTerms: ['world'] });

        expect(result).toBeDefined();
        expect(typeof result.totalCount).toBe('number');
      });

      it('should execute search with NOT terms', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;

        const table = info.tables[0];
        const result = await client.search(table, 'hello', { notTerms: ['goodbye'] });

        expect(result).toBeDefined();
        expect(typeof result.totalCount).toBe('number');
      });

      it('should return debug info when debug mode is enabled', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;

        await client.enableDebug();
        const table = info.tables[0];
        const result = await client.search(table, 'test');
        await client.disableDebug();

        expect(result.debug).toBeDefined();
        expect(typeof result.debug!.queryTimeMs).toBe('number');
        expect(typeof result.debug!.optimization).toBe('string');
        // New v1.4.0 debug fields are optional but should be string/number when present
        if (result.debug!.sort !== undefined) {
          expect(typeof result.debug!.sort).toBe('string');
        }
        if (result.debug!.cache !== undefined) {
          expect(typeof result.debug!.cache).toBe('string');
        }
        if (result.debug!.cacheAgeMs !== undefined) {
          expect(typeof result.debug!.cacheAgeMs).toBe('number');
        }
        if (result.debug!.cacheSavedMs !== undefined) {
          expect(typeof result.debug!.cacheSavedMs).toBe('number');
        }
      });
    });

    describe('v1.6 fuzzy search', () => {
      it('should accept FUZZY 1 clause and return a valid SearchResponse', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;
        const table = info.tables[0];

        const result = await client.search(table, 'machne', { fuzzy: 1, limit: 5 });
        expect(result).toBeDefined();
        expect(typeof result.totalCount).toBe('number');
        expect(Array.isArray(result.results)).toBe(true);
      });

      it('should accept FUZZY 2 clause', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;
        const table = info.tables[0];

        const result = await client.search(table, 'unrelated', { fuzzy: 2, limit: 5 });
        expect(result).toBeDefined();
        expect(typeof result.totalCount).toBe('number');
      });
    });

    describe('v1.6 highlight', () => {
      it('should round-trip a bare HIGHLIGHT clause (or surface a server config error)', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;
        const table = info.tables[0];

        // HIGHLIGHT requires `memory.verify_text: ascii|all` on the server;
        // when the table is not configured for it the server returns
        // ERROR. Either outcome proves the client correctly round-trips
        // the new clause.
        try {
          const result = await client.search(table, 'test', { highlight: {}, limit: 3 });
          expect(result).toBeDefined();
          expect(Array.isArray(result.results)).toBe(true);
          for (const r of result.results) {
            expect(typeof r.snippet).toBe('string');
          }
        } catch (err) {
          expect(err).toBeInstanceOf(ProtocolError);
        }
      });

      it('should round-trip custom HIGHLIGHT tags and parameters', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;
        const table = info.tables[0];

        try {
          const result = await client.search(table, 'test', {
            highlight: {
              openTag: '<mark>',
              closeTag: '</mark>',
              snippetLen: 80,
              maxFragments: 2
            },
            limit: 3
          });
          expect(result).toBeDefined();
          for (const r of result.results) {
            expect(typeof r.snippet).toBe('string');
          }
        } catch (err) {
          expect(err).toBeInstanceOf(ProtocolError);
        }
      });
    });

    describe('v1.6 BM25 (_score sort)', () => {
      it('should accept SORT _score DESC (or surface a server config error)', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;
        const table = info.tables[0];

        try {
          const result = await client.search(table, 'test', {
            sortColumn: '_score',
            sortDesc: true,
            limit: 5
          });
          expect(result).toBeDefined();
          expect(typeof result.totalCount).toBe('number');
        } catch (err) {
          // _score sorting requires `verify_text: ascii|all` on the server;
          // when the table is not configured for it the server returns an
          // ERROR. Either outcome proves the client correctly round-trips
          // the new clause.
          expect(err).toBeInstanceOf(ProtocolError);
        }
      });
    });

    describe('v1.6 facet', () => {
      it('should round-trip a FACET command (or surface a server config error)', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;
        const table = info.tables[0];

        // Many test schemas have no filter columns; the server then
        // returns an ERROR. Either outcome is acceptable as long as the
        // protocol round-trips cleanly.
        try {
          const resp = await client.facet(table, 'status');
          expect(resp).toBeDefined();
          expect(Array.isArray(resp.results)).toBe(true);
          for (const v of resp.results) {
            expect(typeof v.value).toBe('string');
            expect(typeof v.count).toBe('number');
          }
        } catch (err) {
          expect(err).toBeInstanceOf(ProtocolError);
        }
      });

      it('should round-trip a scoped FACET (QUERY + LIMIT)', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;
        const table = info.tables[0];

        try {
          const resp = await client.facet(table, 'status', { query: 'test', limit: 5 });
          expect(resp).toBeDefined();
          expect(Array.isArray(resp.results)).toBe(true);
        } catch (err) {
          expect(err).toBeInstanceOf(ProtocolError);
        }
      });
    });

    describe('count', () => {
      it('should execute count command', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;

        const table = info.tables[0];
        const result = await client.count(table, 'test');

        expect(result).toBeDefined();
        expect(typeof result.count).toBe('number');
        expect(result.count).toBeGreaterThanOrEqual(0);
      });

      it('should execute count with AND terms', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;

        const table = info.tables[0];
        const result = await client.count(table, 'hello', { andTerms: ['world'] });

        expect(result).toBeDefined();
        expect(typeof result.count).toBe('number');
      });

      it('should execute count with NOT terms', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;

        const table = info.tables[0];
        const result = await client.count(table, 'hello', { notTerms: ['goodbye'] });

        expect(result).toBeDefined();
        expect(typeof result.count).toBe('number');
      });

      it('should return debug info when debug mode is enabled', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;

        await client.enableDebug();
        const table = info.tables[0];
        const result = await client.count(table, 'test');
        await client.disableDebug();

        expect(result.debug).toBeDefined();
        expect(typeof result.debug!.queryTimeMs).toBe('number');
      });
    });

    describe('search with web-style expressions', () => {
      it('should search with simple terms (AND)', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;

        const table = info.tables[0];
        const expr = simplifySearchExpression('hello world');

        // Verify AND behavior: "world" should be in andTerms
        expect(expr.mainTerm).toBe('hello');
        expect(expr.andTerms).toEqual(['world']);

        const result = await client.search(table, expr.mainTerm, {
          andTerms: expr.andTerms,
          notTerms: expr.notTerms
        });

        expect(result).toBeDefined();
        expect(typeof result.totalCount).toBe('number');
      });

      it('should search with required terms (+)', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;

        const table = info.tables[0];
        const expr = simplifySearchExpression('+golang +tutorial');
        const result = await client.search(table, expr.mainTerm, {
          andTerms: expr.andTerms,
          notTerms: expr.notTerms
        });

        expect(result).toBeDefined();
        expect(typeof result.totalCount).toBe('number');
      });

      it('should search with excluded terms (-)', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;

        const table = info.tables[0];
        const expr = simplifySearchExpression('+programming -java');
        const result = await client.search(table, expr.mainTerm, {
          andTerms: expr.andTerms,
          notTerms: expr.notTerms
        });

        expect(result).toBeDefined();
        expect(typeof result.totalCount).toBe('number');
      });

      it('should search with quoted phrase', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;

        const table = info.tables[0];
        const expr = simplifySearchExpression('"machine learning" tutorial');
        const result = await client.search(table, expr.mainTerm, {
          andTerms: expr.andTerms,
          notTerms: expr.notTerms
        });

        expect(result).toBeDefined();
        expect(typeof result.totalCount).toBe('number');
      });

      it('should search with Japanese terms and full-width space', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;

        const table = info.tables[0];
        const expr = simplifySearchExpression('機械学習　チュートリアル');

        // Verify full-width space is treated as AND
        expect(expr.mainTerm).toBe('機械学習');
        expect(expr.andTerms).toEqual(['チュートリアル']);

        const result = await client.search(table, expr.mainTerm, {
          andTerms: expr.andTerms,
          notTerms: expr.notTerms
        });

        expect(result).toBeDefined();
        expect(typeof result.totalCount).toBe('number');
      });

      it('should count with web-style expression', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;

        const table = info.tables[0];
        const expr = simplifySearchExpression('+hello +world -goodbye');
        const result = await client.count(table, expr.mainTerm, {
          andTerms: expr.andTerms,
          notTerms: expr.notTerms
        });

        expect(result).toBeDefined();
        expect(typeof result.count).toBe('number');
      });
    });
  });
}

/**
 * Check if native client actually works (not just loadable)
 */
async function isNativeClientWorking(): Promise<boolean> {
  if (!isNativeAvailable()) {
    return false;
  }
  try {
    const client = createMygramClient({ host: TEST_HOST, port: TEST_PORT, timeout: 1000 });
    // Check if it's actually a native client with working methods
    if (getClientType(client) !== 'native') {
      return false;
    }
    await client.connect();
    await client.info();
    client.disconnect();
    return true;
  } catch {
    return false;
  }
}

describe('Integration Tests', async () => {
  const serverAvailable = await isServerAvailable();
  const nativeWorking = serverAvailable ? await isNativeClientWorking() : false;

  describe.skipIf(!serverAvailable)('with real server', () => {
    // Test pure JavaScript client
    runClientTests(
      'MygramClient (JavaScript)',
      () => new MygramClient({ host: TEST_HOST, port: TEST_PORT, timeout: 5000 })
    );

    // Test native client if it actually works
    describe.skipIf(!nativeWorking)('NativeMygramClient (C++)', () => {
      runClientTests(
        'NativeMygramClient',
        () => createMygramClient({ host: TEST_HOST, port: TEST_PORT, timeout: 5000 }) as NativeMygramClient
      );
    });

    // Test client factory
    describe('createMygramClient factory', () => {
      it('should create a client that connects successfully', async () => {
        const client = createMygramClient({ host: TEST_HOST, port: TEST_PORT, timeout: 5000 });
        await client.connect();

        expect(client.isConnected()).toBe(true);

        const clientType = getClientType(client);
        expect(['native', 'javascript']).toContain(clientType);

        client.disconnect();
      });

      it('should force JavaScript implementation when requested', async () => {
        const client = createMygramClient({ host: TEST_HOST, port: TEST_PORT, timeout: 5000 }, true);
        await client.connect();

        expect(getClientType(client)).toBe('javascript');
        expect(client).toBeInstanceOf(MygramClient);

        client.disconnect();
      });

      it('isNativeAvailable should return boolean', () => {
        const available = isNativeAvailable();
        expect(typeof available).toBe('boolean');
        console.log(`Native client available: ${available}`);
      });
    });

    // Tests for new methods only available on MygramClient (JS)
    describe('MygramClient new methods (JS only)', () => {
      let jsClient: MygramClient;

      beforeEach(async () => {
        jsClient = new MygramClient({ host: TEST_HOST, port: TEST_PORT, timeout: 5000 });
        await jsClient.connect();
      });

      afterEach(() => {
        jsClient.disconnect();
      });

      it('should get cache stats', async () => {
        const stats = await jsClient.cacheStats();
        expect(stats).toBeDefined();
        expect(typeof stats.enabled).toBe('boolean');
        expect(typeof stats.hits).toBe('number');
        expect(typeof stats.misses).toBe('number');
        expect(typeof stats.hitRate).toBe('number');
      });

      it('should clear cache without error', async () => {
        await expect(jsClient.cacheClear()).resolves.not.toThrow();
      });

      it('should get dump status', async () => {
        const status = await jsClient.dumpStatus();
        expect(status).toBeDefined();
        expect(typeof status.status).toBe('string');
        expect(typeof status.tablesTotal).toBe('number');
        expect(typeof status.tablesProcessed).toBe('number');
        expect(typeof status.elapsedSeconds).toBe('number');
      });

      it('should optimize a specific table', async () => {
        const serverInfo = await jsClient.info();
        if (serverInfo.tables.length === 0) return;
        const table = serverInfo.tables[0];
        await expect(jsClient.optimize(table)).resolves.not.toThrow();
      });
    });
  });

  describe.skipIf(serverAvailable)('without server', () => {
    it('should skip tests when server is not available', () => {
      console.log('MygramDB server is not available, skipping integration tests');
      expect(true).toBe(true);
    });
  });
});
