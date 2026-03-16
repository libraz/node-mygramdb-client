/**
 * Integration tests for MygramDB client parsing and protocol handling
 *
 * These tests verify parsing logic without requiring a real server.
 * They can run in CI environments.
 */

import { describe, expect, it } from 'vitest';
import { MygramClient } from '../src/client';
import {
  simplifySearchExpression as autoSimplifySearchExpression,
  createMygramClient,
  getClientType,
  isNativeAvailable
} from '../src/client-factory';
import {
  simplifySearchExpression as jsSimplifySearchExpression,
  parseSearchExpression
} from '../src/search-expression';

// Use the JS implementation for existing tests to maintain consistency
const simplifySearchExpression = jsSimplifySearchExpression;

describe('Search Expression Parsing', () => {
  describe('simplifySearchExpression', () => {
    it('should parse simple space-separated terms as AND', () => {
      const expr = simplifySearchExpression('hello world');

      expect(expr.mainTerm).toBe('hello');
      expect(expr.andTerms).toEqual(['world']);
      expect(expr.notTerms).toEqual([]);
    });

    it('should parse + prefix as required terms', () => {
      const expr = simplifySearchExpression('+golang +tutorial');

      expect(expr.mainTerm).toBe('golang');
      expect(expr.andTerms).toEqual(['tutorial']);
      expect(expr.notTerms).toEqual([]);
    });

    it('should parse - prefix as excluded terms', () => {
      const expr = simplifySearchExpression('+programming -java');

      expect(expr.mainTerm).toBe('programming');
      expect(expr.andTerms).toEqual([]);
      expect(expr.notTerms).toEqual(['java']);
    });

    it('should parse quoted phrases', () => {
      const expr = simplifySearchExpression('"machine learning" tutorial');

      // Quotes preserved for phrase search semantics
      expect(expr.mainTerm).toBe('"machine learning"');
      expect(expr.andTerms).toEqual(['tutorial']);
    });

    it('should handle full-width space as separator', () => {
      const expr = simplifySearchExpression('機械学習　チュートリアル');

      expect(expr.mainTerm).toBe('機械学習');
      expect(expr.andTerms).toEqual(['チュートリアル']);
    });

    it('should parse complex expression with required and excluded terms', () => {
      const expr = simplifySearchExpression('+hello +world -goodbye');

      expect(expr.mainTerm).toBe('hello');
      expect(expr.andTerms).toEqual(['world']);
      expect(expr.notTerms).toEqual(['goodbye']);
    });

    it('should handle multiple excluded terms', () => {
      const expr = simplifySearchExpression('+search -spam -ads -tracking');

      expect(expr.mainTerm).toBe('search');
      expect(expr.andTerms).toEqual([]);
      expect(expr.notTerms).toEqual(['spam', 'ads', 'tracking']);
    });

    it('should handle terms without prefix as optional', () => {
      const expr = simplifySearchExpression('golang tutorial beginner');

      expect(expr.mainTerm).toBe('golang');
      expect(expr.andTerms).toContain('tutorial');
      expect(expr.andTerms).toContain('beginner');
    });
  });

  describe('parseSearchExpression', () => {
    it('should parse simple terms', () => {
      const result = parseSearchExpression('hello world');

      expect(result.requiredTerms).toEqual([]);
      expect(result.optionalTerms).toEqual(['hello', 'world']);
      expect(result.excludedTerms).toEqual([]);
    });

    it('should parse required terms with +', () => {
      const result = parseSearchExpression('+required1 +required2');

      expect(result.requiredTerms).toEqual(['required1', 'required2']);
      expect(result.optionalTerms).toEqual([]);
    });

    it('should parse excluded terms with -', () => {
      const result = parseSearchExpression('search -excluded');

      expect(result.optionalTerms).toContain('search');
      expect(result.excludedTerms).toEqual(['excluded']);
    });

    it('should parse quoted phrases', () => {
      const result = parseSearchExpression('"exact phrase" other');

      // Quotes preserved for phrase search semantics
      expect(result.optionalTerms).toContain('"exact phrase"');
      expect(result.optionalTerms).toContain('other');
    });

    it('should handle OR operator', () => {
      const result = parseSearchExpression('cat OR dog');

      expect(result.optionalTerms).toContain('cat');
      expect(result.optionalTerms).toContain('dog');
    });

    it('should handle mixed operators', () => {
      const result = parseSearchExpression('+golang "web framework" -deprecated');

      expect(result.requiredTerms).toContain('golang');
      // Quotes preserved for phrase search semantics
      expect(result.optionalTerms).toContain('"web framework"');
      expect(result.excludedTerms).toContain('deprecated');
    });
  });
});

describe('Client Factory', () => {
  describe('createMygramClient', () => {
    it('should create a client instance', () => {
      const client = createMygramClient({ host: '127.0.0.1', port: 11016 });

      expect(client).toBeDefined();
      expect(typeof client.connect).toBe('function');
      expect(typeof client.search).toBe('function');
      expect(typeof client.count).toBe('function');
    });

    it('should force JavaScript implementation when requested', () => {
      const client = createMygramClient({ host: '127.0.0.1', port: 11016 }, true);

      expect(getClientType(client)).toBe('javascript');
      expect(client).toBeInstanceOf(MygramClient);
    });

    it('isNativeAvailable should return boolean', () => {
      const available = isNativeAvailable();
      expect(typeof available).toBe('boolean');
    });

    it('getClientType should return correct type', () => {
      const jsClient = createMygramClient({}, true);
      expect(getClientType(jsClient)).toBe('javascript');

      const autoClient = createMygramClient({});
      expect(['javascript', 'native']).toContain(getClientType(autoClient));
    });
  });

  describe('client configuration', () => {
    it('should use default values when not specified', () => {
      const client = new MygramClient({});

      // Client should be created without errors
      expect(client).toBeDefined();
      expect(client.isConnected()).toBe(false);
    });

    it('should accept custom configuration', () => {
      const client = new MygramClient({
        host: 'custom.host.com',
        port: 12345,
        timeout: 10000
      });

      expect(client).toBeDefined();
    });
  });

  describe('simplifySearchExpression (with auto-selection)', () => {
    it('should use native if available, otherwise JS', () => {
      const expr = autoSimplifySearchExpression('hello world');

      expect(expr.mainTerm).toBe('hello');
      expect(expr.andTerms).toEqual(['world']);
      expect(expr.notTerms).toEqual([]);
    });

    it('should force JavaScript when requested', () => {
      const expr = autoSimplifySearchExpression('hello world', true);

      expect(expr.mainTerm).toBe('hello');
      expect(expr.andTerms).toEqual(['world']);
    });

    it('should match JS implementation for all expressions', () => {
      const testCases = [
        'hello world',
        'hello world test',
        '+hello +world',
        'hello -world',
        '+golang -old tutorial',
        '"machine learning" tutorial'
      ];

      for (const expression of testCases) {
        const auto = autoSimplifySearchExpression(expression);
        const js = jsSimplifySearchExpression(expression);

        expect(auto.mainTerm).toBe(js.mainTerm);
        expect(auto.andTerms).toEqual(js.andTerms);
        expect(auto.notTerms).toEqual(js.notTerms);
      }
    });

    it('should handle Japanese text with full-width space', () => {
      const expr = autoSimplifySearchExpression('機械学習　チュートリアル');

      expect(expr.mainTerm).toBe('機械学習');
      expect(expr.andTerms).toEqual(['チュートリアル']);
    });
  });
});

/**
 * Helper to build search command from parsed expression
 */
function buildSearchCommand(table: string, expr: { mainTerm: string; andTerms: string[]; notTerms: string[] }): string {
  const parts = ['SEARCH', table, expr.mainTerm];
  for (const term of expr.andTerms) {
    parts.push('AND', term);
  }
  for (const term of expr.notTerms) {
    parts.push('NOT', term);
  }
  return parts.join(' ');
}

describe('Search Command Generation', () => {
  describe('space-separated terms (AND)', () => {
    it('should convert two words to AND', () => {
      const expr = autoSimplifySearchExpression('hello world');
      const cmd = buildSearchCommand('tbl', expr);
      expect(cmd).toBe('SEARCH tbl hello AND world');
    });

    it('should convert three words to multiple AND', () => {
      const expr = autoSimplifySearchExpression('hello world test');
      const cmd = buildSearchCommand('tbl', expr);
      expect(cmd).toBe('SEARCH tbl hello AND world AND test');
    });
  });

  describe('+ prefix terms (AND)', () => {
    it('should convert +terms to AND', () => {
      const expr = autoSimplifySearchExpression('+hello +world');
      const cmd = buildSearchCommand('tbl', expr);
      expect(cmd).toBe('SEARCH tbl hello AND world');
    });

    it('should convert multiple +terms to AND', () => {
      const expr = autoSimplifySearchExpression('+hello +world +test');
      const cmd = buildSearchCommand('tbl', expr);
      expect(cmd).toBe('SEARCH tbl hello AND world AND test');
    });

    it('should handle mixed + and space-separated terms', () => {
      const expr = autoSimplifySearchExpression('+hello world');
      const cmd = buildSearchCommand('tbl', expr);
      expect(cmd).toBe('SEARCH tbl hello AND world');
    });
  });

  describe('- prefix terms (NOT)', () => {
    it('should convert -term to NOT', () => {
      const expr = autoSimplifySearchExpression('hello -world');
      const cmd = buildSearchCommand('tbl', expr);
      expect(cmd).toBe('SEARCH tbl hello NOT world');
    });

    it('should handle + and - combination', () => {
      const expr = autoSimplifySearchExpression('+hello -world');
      const cmd = buildSearchCommand('tbl', expr);
      expect(cmd).toBe('SEARCH tbl hello NOT world');
    });

    it('should handle multiple NOT terms', () => {
      const expr = autoSimplifySearchExpression('+hello +world -bad -ugly');
      const cmd = buildSearchCommand('tbl', expr);
      expect(cmd).toBe('SEARCH tbl hello AND world NOT bad NOT ugly');
    });
  });

  describe('quoted phrases', () => {
    it('should preserve quotes for phrase search', () => {
      const expr = autoSimplifySearchExpression('"hello world"');
      const cmd = buildSearchCommand('tbl', expr);
      expect(cmd).toBe('SEARCH tbl "hello world"');
    });

    it('should handle phrase with additional terms', () => {
      const expr = autoSimplifySearchExpression('"hello world" test');
      const cmd = buildSearchCommand('tbl', expr);
      expect(cmd).toBe('SEARCH tbl "hello world" AND test');
    });

    it('should handle phrase with + and - prefixes', () => {
      const expr = autoSimplifySearchExpression('+"hello world" -"bad phrase"');
      const cmd = buildSearchCommand('tbl', expr);
      expect(cmd).toBe('SEARCH tbl "hello world" NOT "bad phrase"');
    });
  });

  describe('Japanese text', () => {
    it('should handle full-width space as AND separator', () => {
      const expr = autoSimplifySearchExpression('機械学習　チュートリアル');
      const cmd = buildSearchCommand('tbl', expr);
      expect(cmd).toBe('SEARCH tbl 機械学習 AND チュートリアル');
    });

    it('should handle Japanese with + and - prefixes', () => {
      const expr = autoSimplifySearchExpression('+機械学習 -古い');
      const cmd = buildSearchCommand('tbl', expr);
      expect(cmd).toBe('SEARCH tbl 機械学習 NOT 古い');
    });
  });
});

describe('Client Configuration', () => {
  describe('Unix socket support', () => {
    it('should accept socketPath in config', () => {
      const client = new MygramClient({ socketPath: '/tmp/mygramdb.sock' });
      expect(client).toBeDefined();
      expect(client.isConnected()).toBe(false);
    });

    it('should prefer socketPath over host/port when both specified', () => {
      const client = new MygramClient({
        host: '10.0.0.1',
        port: 12345,
        socketPath: '/tmp/mygramdb.sock'
      });
      expect(client).toBeDefined();
    });

    it('should use TCP when socketPath is empty string', () => {
      const client = new MygramClient({ socketPath: '', host: '127.0.0.1', port: 11016 });
      expect(client).toBeDefined();
    });
  });
});

describe('Protocol Response Parsing', () => {
  describe('search response format', () => {
    it('should handle SEARCH command format', () => {
      // Verify the expected command format
      const table = 'articles';
      const query = 'test';
      const andTerms = ['required'];
      const notTerms = ['excluded'];

      const parts = ['SEARCH', table, query];
      for (const term of andTerms) {
        parts.push('AND', term);
      }
      for (const term of notTerms) {
        parts.push('NOT', term);
      }
      parts.push('LIMIT', '100');

      const command = parts.join(' ');
      expect(command).toBe('SEARCH articles test AND required NOT excluded LIMIT 100');
    });

    it('should handle COUNT command format', () => {
      const table = 'users';
      const query = 'active';
      const andTerms = ['verified'];

      const parts = ['COUNT', table, query];
      for (const term of andTerms) {
        parts.push('AND', term);
      }

      const command = parts.join(' ');
      expect(command).toBe('COUNT users active AND verified');
    });
  });

  describe('response line endings', () => {
    it('should normalize CRLF to LF', () => {
      const crlfResponse = 'OK RESULTS 2 pk1 pk2\r\n';
      const normalized = crlfResponse.replace(/\r\n/g, '\n').trim();

      expect(normalized).toBe('OK RESULTS 2 pk1 pk2');
      expect(normalized).not.toContain('\r');
    });

    it('should handle mixed line endings', () => {
      const mixedResponse = 'line1\r\nline2\nline3\r\n';
      const normalized = mixedResponse.replace(/\r\n/g, '\n').trim();

      expect(normalized).toBe('line1\nline2\nline3');
    });
  });

  describe('debug info parsing', () => {
    it('should parse debug info format', () => {
      const debugSection = `# DEBUG
query_time: 0.5ms
index_time: 0.3ms
terms: 2
ngrams: 6
candidates: 100
after_intersection: 50
final: 25
optimization: early-exit`;

      const lines = debugSection.split('\n').slice(1);
      const debugInfo: Record<string, string | number> = {};

      lines.forEach((line) => {
        const [key, value] = line.split(':').map((s) => s.trim());
        if (key && value) {
          if (key.endsWith('_time')) {
            debugInfo[key] = parseFloat(value);
          } else if (['terms', 'ngrams', 'candidates', 'after_intersection', 'final'].includes(key)) {
            debugInfo[key] = parseInt(value, 10);
          } else {
            debugInfo[key] = value;
          }
        }
      });

      expect(debugInfo.query_time).toBe(0.5);
      expect(debugInfo.index_time).toBe(0.3);
      expect(debugInfo.terms).toBe(2);
      expect(debugInfo.ngrams).toBe(6);
      expect(debugInfo.candidates).toBe(100);
      expect(debugInfo.optimization).toBe('early-exit');
    });

    it('should parse extended debug info with cache and sort fields', () => {
      const debugSection = `# DEBUG
query_time: 12.345ms
index_time: 5.123ms
filter_time: 0.456ms
terms: 2
ngrams: 8
candidates: 1234
after_intersection: 456
after_not: 400
after_filters: 350
final: 100
optimization: bitmap-filter
sort: id DESC
limit: 100
offset: 0
cache: hit
cache_age_ms: 123.456
cache_saved_ms: 234.567`;

      const lines = debugSection.split('\n').slice(1);
      const debugInfo: Record<string, string | number> = {};

      lines.forEach((line) => {
        const [key, value] = line.split(':').map((s) => s.trim());
        if (key && value) {
          if (key.endsWith('_time') || key.endsWith('_ms')) {
            debugInfo[key] = parseFloat(value);
          } else if (
            ['terms', 'ngrams', 'candidates', 'after_intersection', 'after_not', 'after_filters', 'final'].includes(key)
          ) {
            debugInfo[key] = parseInt(value, 10);
          } else {
            debugInfo[key] = value;
          }
        }
      });

      expect(debugInfo.optimization).toBe('bitmap-filter');
      expect(debugInfo.sort).toBe('id DESC');
      expect(debugInfo.cache).toBe('hit');
      expect(debugInfo.cache_age_ms).toBe(123.456);
      expect(debugInfo.cache_saved_ms).toBe(234.567);
      expect(debugInfo.filter_time).toBe(0.456);
      expect(debugInfo.after_not).toBe(400);
      expect(debugInfo.after_filters).toBe(350);
    });

    it('should parse cache miss debug info', () => {
      const debugSection = `# DEBUG
query_time: 5.0ms
cache: miss (not found)`;

      const lines = debugSection.split('\n').slice(1);
      const debugInfo: Record<string, string | number> = {};

      lines.forEach((line) => {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) return;
        const key = line.substring(0, colonIdx).trim();
        const value = line.substring(colonIdx + 1).trim();
        if (key && value) {
          debugInfo[key] = value;
        }
      });

      expect(debugInfo.cache).toBe('miss (not found)');
    });

    it('should parse cache disabled debug info', () => {
      const debugSection = `# DEBUG
query_time: 5.0ms
cache: disabled`;

      const lines = debugSection.split('\n').slice(1);
      const debugInfo: Record<string, string | number> = {};

      lines.forEach((line) => {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) return;
        const key = line.substring(0, colonIdx).trim();
        const value = line.substring(colonIdx + 1).trim();
        if (key && value) {
          debugInfo[key] = value;
        }
      });

      expect(debugInfo.cache).toBe('disabled');
    });
  });

  describe('INFO response parsing', () => {
    it('should parse INFO response fields', () => {
      const infoResponse = `OK INFO
version: MygramDB v1.3.7
uptime_seconds: 12345
total_requests: 1000
connected_clients: 5
used_memory_bytes: 1048576
total_documents: 500
tables: articles,users`;

      const lines = infoResponse.split('\n').slice(1);
      const info: Record<string, string | number | string[]> = {};

      lines.forEach((line) => {
        const [key, value] = line.split(':').map((s) => s.trim());
        if (key && value) {
          if (key === 'tables') {
            info[key] = value.split(',').map((s) => s.trim());
          } else if (
            ['uptime_seconds', 'total_requests', 'connected_clients', 'used_memory_bytes', 'total_documents'].includes(
              key
            )
          ) {
            info[key] = parseInt(value, 10);
          } else {
            info[key] = value;
          }
        }
      });

      expect(info.version).toBe('MygramDB v1.3.7');
      expect(info.uptime_seconds).toBe(12345);
      expect(info.tables).toEqual(['articles', 'users']);
    });
  });

  describe('REPLICATION STATUS parsing', () => {
    it('should parse multi-line format', () => {
      const response = `OK REPLICATION
status: running
current_gtid: mysql-bin.000001:12345
processed_events: 1000
END`;

      const lines = response.split('\n');
      const isMultiLine = lines[0].trim() === 'OK REPLICATION';

      expect(isMultiLine).toBe(true);

      const status: Record<string, string | boolean> = {};
      lines.slice(1).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'END') return;

        const colonIndex = trimmed.indexOf(':');
        if (colonIndex !== -1) {
          const key = trimmed.substring(0, colonIndex).trim();
          const value = trimmed.substring(colonIndex + 1).trim();
          if (key === 'status') {
            status.running = value === 'running';
          } else if (key === 'current_gtid') {
            status.gtid = value;
          }
        }
      });

      expect(status.running).toBe(true);
      expect(status.gtid).toBe('mysql-bin.000001:12345');
    });

    it('should parse single-line format', () => {
      const response = 'OK REPLICATION status=stopped gtid=';
      const isSingleLine = response.startsWith('OK REPLICATION ');

      expect(isSingleLine).toBe(true);

      const parts = response.substring(15).split(' ');
      const statusPart = parts.find((p) => p.startsWith('status='));
      const gtidPart = parts.find((p) => p.startsWith('gtid='));

      expect(statusPart?.split('=')[1]).toBe('stopped');
      expect(gtidPart?.split('=')[1]).toBe('');
    });
  });

  describe('CONFIG response parsing', () => {
    it('should parse +OK format', () => {
      const response = `+OK
api:
  port: 11016
  default_limit: 100`;

      expect(response.startsWith('+OK')).toBe(true);
      const config = response.substring('+OK\n'.length);
      expect(config).toContain('api:');
      expect(config).toContain('port: 11016');
    });

    it('should parse OK CONFIG format', () => {
      const response = `OK CONFIG
api:
  port: 11016`;

      expect(response.startsWith('OK CONFIG')).toBe(true);
      const config = response.substring('OK CONFIG\n'.length);
      expect(config).toContain('api:');
    });
  });

  describe('DUMP STATUS response parsing', () => {
    it('should parse idle dump status', () => {
      const response = `OK DUMP_STATUS
status: idle
filepath:
tables_total: 0
tables_processed: 0
current_table:
elapsed_seconds: 0`;

      const lines = response.split('\n').slice(1);
      const status: Record<string, string | number> = {};

      lines.forEach((line) => {
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) return;
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        if (key) {
          status[key] = value;
        }
      });

      expect(status.status).toBe('idle');
      expect(status.tables_total).toBe('0');
    });

    it('should parse active dump status', () => {
      const response = `OK DUMP_STATUS
status: saving
filepath: /data/dump.bin
tables_total: 3
tables_processed: 1
current_table: articles
elapsed_seconds: 12.5`;

      const lines = response.split('\n').slice(1);
      const status: Record<string, string | number> = {};

      lines.forEach((line) => {
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) return;
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        if (key) {
          status[key] = value;
        }
      });

      expect(status.status).toBe('saving');
      expect(status.filepath).toBe('/data/dump.bin');
      expect(status.current_table).toBe('articles');
    });

    it('should parse failed dump status with error', () => {
      const response = `OK DUMP_STATUS
status: failed
filepath: /data/dump.bin
tables_total: 3
tables_processed: 1
current_table: articles
elapsed_seconds: 5.0
error: disk full`;

      const lines = response.split('\n').slice(1);
      const status: Record<string, string | number> = {};

      lines.forEach((line) => {
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) return;
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        if (key) {
          status[key] = value;
        }
      });

      expect(status.status).toBe('failed');
      expect(status.error).toBe('disk full');
    });

    it('should handle DUMP SAVE async response', () => {
      const response = 'OK DUMP_STARTED /data/dump.bin';
      expect(response.startsWith('OK DUMP_STARTED ')).toBe(true);
      const filepath = response.substring('OK DUMP_STARTED '.length);
      expect(filepath).toBe('/data/dump.bin');
    });

    it('should handle legacy DUMP SAVE sync response', () => {
      const response = 'OK DUMP_SAVED /data/dump.bin';
      expect(response.startsWith('OK DUMP_SAVED ')).toBe(true);
      const filepath = response.substring('OK DUMP_SAVED '.length);
      expect(filepath).toBe('/data/dump.bin');
    });
  });

  describe('CACHE STATS response parsing', () => {
    it('should parse cache stats response', () => {
      const response = `OK CACHE_STATS
enabled: true
max_memory_mb: 32
current_memory_mb: 12.3
entries: 45
hits: 1234
misses: 567
hit_rate: 68.5%
evictions: 10
ttl_seconds: 3600`;

      const lines = response.split('\n').slice(1);
      const stats: Record<string, string | number | boolean> = {};

      lines.forEach((line) => {
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) return;
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        if (!key) return;

        switch (key) {
          case 'enabled':
            stats[key] = value === 'true';
            break;
          case 'hit_rate':
            stats[key] = parseFloat(value.replace('%', ''));
            break;
          case 'max_memory_mb':
          case 'current_memory_mb':
            stats[key] = parseFloat(value);
            break;
          default:
            stats[key] = parseInt(value, 10);
            break;
        }
      });

      expect(stats.enabled).toBe(true);
      expect(stats.max_memory_mb).toBe(32);
      expect(stats.current_memory_mb).toBe(12.3);
      expect(stats.entries).toBe(45);
      expect(stats.hits).toBe(1234);
      expect(stats.misses).toBe(567);
      expect(stats.hit_rate).toBe(68.5);
      expect(stats.evictions).toBe(10);
      expect(stats.ttl_seconds).toBe(3600);
    });

    it('should parse disabled cache stats', () => {
      const response = `OK CACHE_STATS
enabled: false
max_memory_mb: 0
current_memory_mb: 0
entries: 0
hits: 0
misses: 0
hit_rate: 0%
evictions: 0
ttl_seconds: 0`;

      expect(response.startsWith('OK CACHE_STATS')).toBe(true);
      const lines = response.split('\n').slice(1);
      const enabledLine = lines.find((l) => l.trim().startsWith('enabled:'));
      expect(enabledLine).toBeDefined();
      expect(enabledLine!.includes('false')).toBe(true);
    });
  });

  describe('CRLF handling in multi-line responses', () => {
    it('should normalize CRLF in CONFIG response', () => {
      const crlfResponse = 'OK CONFIG\r\napi:\r\n  port: 11016\r\n  host: 0.0.0.0\r\n\r\n';
      const normalized = crlfResponse.replace(/\r\n/g, '\n').trim();

      expect(normalized).toBe('OK CONFIG\napi:\n  port: 11016\n  host: 0.0.0.0');
      expect(normalized).not.toContain('\r');
    });

    it('should normalize CRLF in REPLICATION STATUS response', () => {
      const crlfResponse = 'OK REPLICATION\r\nstatus: running\r\ncurrent_gtid: mysql-bin.000001:12345\r\nEND\r\n';
      const normalized = crlfResponse.replace(/\r\n/g, '\n').trim();

      expect(normalized).toContain('status: running');
      expect(normalized).toContain('END');
      expect(normalized).not.toContain('\r');
    });

    it('should normalize CRLF in DUMP STATUS response', () => {
      const crlfResponse = 'OK DUMP_STATUS\r\nstatus: idle\r\nfilepath:\r\n\r\n';
      const normalized = crlfResponse.replace(/\r\n/g, '\n').trim();

      expect(normalized).toBe('OK DUMP_STATUS\nstatus: idle\nfilepath:');
    });

    it('should normalize CRLF in CACHE STATS response', () => {
      const crlfResponse = 'OK CACHE_STATS\r\nenabled: true\r\nhits: 100\r\n\r\n';
      const normalized = crlfResponse.replace(/\r\n/g, '\n').trim();

      expect(normalized).toBe('OK CACHE_STATS\nenabled: true\nhits: 100');
    });
  });
});
