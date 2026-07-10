/**
 * Integration tests for MygramDB client against a real server
 *
 * These tests require a running MygramDB server on localhost:11016.
 * Tests are skipped if the server is not available.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MygramClient } from '../src/client';
import { createMygramClient, getClientType, isNativeAvailable } from '../src/client-factory';
import { PoolOverloadError, ProtocolError } from '../src/errors';
import type { NativeMygramClient } from '../src/native-client';
import { MygramPool } from '../src/pool';
import { convertSearchExpression, simplifySearchExpression } from '../src/search-expression';

const TEST_HOST = process.env.MYGRAM_HOST || '127.0.0.1';
const TEST_PORT = parseInt(process.env.MYGRAM_PORT || '11016', 10);

/**
 * Set to `1` by tests/docker/run-e2e.sh, which boots a server seeded with the
 * fixed dataset in tests/docker/mysql-init. Only then can we assert exact
 * result sets; against an arbitrary developer server these are skipped.
 */
const SEEDED = process.env.MYGRAM_E2E_SEEDED === '1';

/** Common client interface for testing both implementations */
type TestClient = MygramClient | NativeMygramClient;

/**
 * Poll `predicate` until it is truthy or the deadline passes. Used by the pool
 * resilience tests to wait for out-of-band background reconnects without
 * coupling to a fixed sleep.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

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

    describe('v1.7 database-qualified table identity', () => {
      it('resolves a database.table identity the same as the bare name', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;

        // info.tables may already be qualified (database.table) or bare.
        const reported = info.tables[0];
        const bare = reported.includes('.') ? reported.slice(reported.indexOf('.') + 1) : reported;

        const viaReported = await client.search(reported, 'test', { limit: 5 });
        const viaBare = await client.search(bare, 'test', { limit: 5 });

        expect(viaReported.totalCount).toBe(viaBare.totalCount);
      });
    });

    describe('v1.7 searchRaw (boolean expressions)', () => {
      it('round-trips a boolean OR expression', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;
        const table = info.tables[0];

        const result = await client.searchRaw(table, 'hello OR world', { limit: 5 });
        expect(result).toBeDefined();
        expect(typeof result.totalCount).toBe('number');
        expect(Array.isArray(result.results)).toBe(true);
      });

      it('round-trips a grouped expression built by convertSearchExpression', async () => {
        const info = await client.info();
        if (info.tables.length === 0) return;
        const table = info.tables[0];

        const raw = convertSearchExpression('hello OR (world AND test)');
        const result = await client.searchRaw(table, raw, { limit: 5 });
        expect(typeof result.totalCount).toBe('number');
      });
    });

    describe('v1.7 runtime variables', () => {
      it('round-trips SET and SHOW VARIABLES', async () => {
        // Some builds mark all variables immutable; tolerate a server rejection
        // as long as the protocol round-trips cleanly.
        try {
          await client.setVariable('logging.level', 'info');
        } catch (err) {
          expect(err).toBeInstanceOf(ProtocolError);
        }
        const vars = await client.showVariables('logging%');
        expect(typeof vars).toBe('string');
        expect(vars.length).toBeGreaterThan(0);
      });
    });

    describe('v1.7 sync', () => {
      it('round-trips SYNC STATUS', async () => {
        const status = await client.syncStatus();
        expect(typeof status).toBe('string');
        expect(status).toContain('SYNC_STATUS');
      });

      it('round-trips SYNC STOP with no active sync', async () => {
        // With nothing running the server may answer OK or ERROR; both prove
        // the command framed correctly.
        try {
          const res = await client.syncStop();
          expect(typeof res).toBe('string');
        } catch (err) {
          expect(err).toBeInstanceOf(ProtocolError);
        }
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

    // Deterministic assertions against the fixed dataset seeded by
    // tests/docker/run-e2e.sh. See tests/docker/mysql-init/02-seed.sql.
    describe.skipIf(!SEEDED)('seeded dataset (docker e2e)', () => {
      let client: MygramClient;
      const TABLE = 'testdb.articles'; // database-qualified identity (v1.7)

      const ids = (r: { results: { primaryKey: string }[] }): string[] => r.results.map((d) => d.primaryKey).sort();

      beforeEach(async () => {
        client = new MygramClient({ host: TEST_HOST, port: TEST_PORT, timeout: 5000 });
        await client.connect();
      });
      afterEach(() => client.disconnect());

      it('search resolves a database-qualified identity to the seeded rows', async () => {
        const res = await client.search(TABLE, 'python');
        expect(res.totalCount).toBe(1);
        expect(ids(res)).toEqual(['3']);
      });

      it('quotes a multi-word phrase and excludes disabled rows', async () => {
        // id 6 also contains "machine learning" but is enabled=0 (hidden).
        const res = await client.search(TABLE, 'machine learning');
        expect(res.totalCount).toBe(1);
        expect(ids(res)).toEqual(['3']);
      });

      it('matches Japanese content', async () => {
        const res = await client.search(TABLE, '機械学習');
        expect(res.totalCount).toBe(2);
        expect(ids(res)).toEqual(['1', '5']);
      });

      it('count matches a single row', async () => {
        const res = await client.count(TABLE, 'golang');
        expect(res.count).toBe(1);
      });

      it('searchRaw evaluates a boolean OR expression', async () => {
        const res = await client.searchRaw(TABLE, 'ruby OR python');
        expect(res.totalCount).toBe(2);
        expect(ids(res)).toEqual(['2', '3']);
      });

      it('searchRaw evaluates a nested OR group under AND', async () => {
        // The expression is sent unquoted so the server parses the grouping;
        // ruby ∩ (rails ∪ python) = {2}.
        const res = await client.searchRaw(TABLE, 'ruby AND (rails OR python)');
        expect(res.totalCount).toBe(1);
        expect(ids(res)).toEqual(['2']);
      });

      it('bare and qualified names resolve identically (single-database)', async () => {
        const qualified = await client.search('testdb.articles', 'python');
        const bare = await client.search('articles', 'python');
        expect(bare.totalCount).toBe(qualified.totalCount);
        expect(bare.totalCount).toBe(1);
      });

      it('facet aggregates enabled rows by category', async () => {
        const resp = await client.facet(TABLE, 'category');
        const byValue = Object.fromEntries(resp.results.map((v) => [v.value, v.count]));
        expect(byValue.tech).toBe(3);
        expect(byValue.science).toBe(2);
      });

      it('get returns a seeded document by primary key', async () => {
        const doc = await client.get(TABLE, '1');
        expect(doc.primaryKey).toBe('1');
        expect(doc.fields.category).toBe('tech');
      });

      it('searchWithHighlights returns a snippet wrapping the match', async () => {
        const res = await client.searchWithHighlights(TABLE, 'python', {
          highlight: { openTag: '<em>', closeTag: '</em>' }
        });
        expect(res.totalCount).toBe(1);
        expect(res.results[0].snippet).toContain('<em>python</em>');
      });
    });
  });

  describe.skipIf(!serverAvailable || !SEEDED)('connection pool (seeded dataset)', () => {
    const TABLE = 'testdb.articles';
    const POOL_SIZE = 12;
    const BURST = 500;
    let pool: MygramPool;

    beforeAll(async () => {
      pool = new MygramPool({
        connection: { host: TEST_HOST, port: TEST_PORT, timeout: 15000 },
        size: POOL_SIZE,
        maxQueue: BURST * 2, // absorb the whole burst rather than shed it
        queueTimeoutMs: 15000,
        keepAliveIntervalMs: 0
      });
      await pool.start();
    });

    afterAll(async () => {
      await pool.close();
    });

    it('starts every connection', () => {
      const metrics = pool.metrics();
      expect(metrics.totalConnections).toBe(POOL_SIZE);
      expect(metrics.healthyConnections).toBe(POOL_SIZE);
    });

    it('sustains a burst of concurrent searches across the pool', async () => {
      const responses = await Promise.all(Array.from({ length: BURST }, () => pool.search(TABLE, 'python')));

      expect(responses).toHaveLength(BURST);
      for (const res of responses) {
        expect(res.totalCount).toBeGreaterThanOrEqual(0);
      }

      const metrics = pool.metrics();
      expect(metrics.completed).toBeGreaterThanOrEqual(BURST);
      expect(metrics.inFlight).toBe(0); // every slot released
      expect(metrics.queueDepth).toBe(0);
      expect(metrics.rejectedOverload).toBe(0); // queue was large enough
      // Concurrency is bounded by the pool size, so latency stays measurable.
      expect(metrics.latencyP99Ms).toBeGreaterThanOrEqual(metrics.latencyP50Ms);
    });

    it('mixes query types under load without cross-talk', async () => {
      const [search, count, doc] = await Promise.all([
        pool.search(TABLE, 'golang'),
        pool.count(TABLE, 'golang'),
        pool.get(TABLE, '1')
      ]);

      expect(search.totalCount).toBe(count.count);
      expect(doc.primaryKey).toBe('1');
    });

    it('routes each distinct query to its own response under heavy concurrency', async () => {
      // A burst of the SAME query cannot detect response misrouting - every
      // answer is identical. This drives many DIFFERENT queries with known
      // result sets, shuffled and fired concurrently, so a slot handing one
      // caller another caller's response would fail the per-query assertion.
      const cases: { q: string; ids: string[] }[] = [
        { q: 'python', ids: ['3'] },
        { q: 'ruby', ids: ['2'] },
        { q: 'golang', ids: ['4'] },
        { q: 'rails', ids: ['2'] },
        { q: 'programming', ids: ['2'] },
        { q: 'tutorial', ids: ['4'] },
        { q: 'basics', ids: ['3'] },
        { q: 'machine learning', ids: ['3'] },
        { q: '機械学習', ids: ['1', '5'] }
      ];

      const jobs = Array.from({ length: 360 }, (_, i) => cases[i % cases.length]);
      for (let i = jobs.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
      }

      const responses = await Promise.all(jobs.map((job) => pool.search(TABLE, job.q).then((res) => ({ job, res }))));

      for (const { job, res } of responses) {
        const expected = [...job.ids].sort();
        expect(res.results.map((d) => d.primaryKey).sort()).toEqual(expected);
        expect(res.totalCount).toBe(job.ids.length);
      }
    });

    it('runs administrative commands through withClient', async () => {
      const info = await pool.withClient((client) => client.info(), { idempotent: true });
      expect(info.version).toMatch(/^MygramDB/);
    });
  });

  describe.skipIf(!serverAvailable || !SEEDED)('connection pool resilience (seeded dataset)', () => {
    const TABLE = 'testdb.articles';

    it('heals after every pooled connection is dropped underneath it', async () => {
      // Models a server restart / network blip: the sockets die while the pool
      // still believes them healthy. The pool must notice on next use, retire
      // the dead slots, reconnect out of band, and resume serving correct data.
      const pool = new MygramPool({
        connection: { host: TEST_HOST, port: TEST_PORT, timeout: 15000 },
        size: 4,
        readRetries: 2,
        reconnectBackoffMs: [50, 250],
        queueTimeoutMs: 15000,
        keepAliveIntervalMs: 0
      });
      await pool.start();

      try {
        expect(pool.metrics().healthyConnections).toBe(4);

        // Destroy every live socket out from under the pool.
        const slots = (pool as unknown as { slots: { client: { disconnect(): void } }[] }).slots;
        for (const slot of slots) {
          slot.client.disconnect();
        }

        // The first commands hit dead sockets; retries and background reconnects
        // absorb the disruption. Transient failures during recovery are expected.
        await Promise.allSettled(Array.from({ length: 8 }, () => pool.search(TABLE, 'python')));

        // Background reconnects heal every slot.
        await waitFor(() => pool.metrics().healthyConnections === 4);
        expect(pool.metrics().reconnects).toBeGreaterThanOrEqual(4);

        // Once healed the pool returns correct results again.
        const res = await pool.search(TABLE, 'python');
        expect(res.totalCount).toBe(1);
        expect(res.results.map((d) => d.primaryKey)).toEqual(['3']);
      } finally {
        await pool.close();
      }
    });
  });

  describe.skipIf(!serverAvailable || !SEEDED)('connection pool backpressure (seeded dataset)', () => {
    const TABLE = 'testdb.articles';

    it('sheds excess callers with PoolOverloadError while saturated', async () => {
      // size 1 + maxQueue 1: at most one in-flight command and one queued
      // waiter, so a concurrent burst beyond that is shed immediately rather
      // than buffered without bound.
      const pool = new MygramPool({
        connection: { host: TEST_HOST, port: TEST_PORT, timeout: 15000 },
        size: 1,
        maxQueue: 1,
        queueTimeoutMs: 15000,
        keepAliveIntervalMs: 0
      });
      await pool.start();

      try {
        const results = await Promise.allSettled(Array.from({ length: 8 }, () => pool.search(TABLE, 'python')));

        const rejected = results.filter((r) => r.status === 'rejected');
        expect(rejected.length).toBeGreaterThan(0);
        for (const r of rejected) {
          expect((r as PromiseRejectedResult).reason).toBeInstanceOf(PoolOverloadError);
        }
        expect(pool.metrics().rejectedOverload).toBeGreaterThan(0);

        // The calls that were admitted (the slot + the single queued waiter)
        // still returned correct data, proving shedding does not corrupt the
        // ones that got through.
        const fulfilled = results.filter(
          (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof pool.search>>> => r.status === 'fulfilled'
        );
        expect(fulfilled.length).toBeGreaterThanOrEqual(2);
        for (const r of fulfilled) {
          expect(r.value.totalCount).toBe(1);
          expect(r.value.results.map((d) => d.primaryKey)).toEqual(['3']);
        }
      } finally {
        await pool.close();
      }
    });
  });

  describe.skipIf(serverAvailable)('without server', () => {
    it('should skip tests when server is not available', () => {
      console.log('MygramDB server is not available, skipping integration tests');
      expect(true).toBe(true);
    });
  });
});
