# 高度な使い方

このガイドでは、mygramdb-clientの高度な使用パターンとベストプラクティスについて説明します。

## コネクションプーリング

1つの `MygramClient` は1本のソケットを持ち、すべてのコマンドをFIFOキューで直列化するため、1接続あたりのスループットはおよそ `1 / RTT` req/s が上限です。単一のNodeプロセスで秒間数百リクエストを捌くには、組み込みの `MygramPool` を使います。リクエストをN本の接続へ分散し、最大N個のコマンドを同時にワイヤへ流します。

```typescript
import { MygramPool } from 'mygramdb-client';

const pool = new MygramPool({
  connection: { host: 'localhost', port: 11016 },
  size: 12
});

// start() は任意。事前に全接続を張ってfail-fastに起動する。省略すると
// 最初のクエリでプールが遅延起動する（pg.Pool 的な使い心地）。
await pool.start();

// プールはクエリAPIを直接公開する。接続の貸し借りは内部で処理され、
// プール全体へロードバランスされる。
const results = await pool.search('articles', 'test', { limit: 100 });
console.log(results);

// 健全性と負荷はいつでも取得できる。
console.log(pool.metrics());

// close() で破棄。end() はエイリアス（pg / mysql2 の慣習）。
await pool.close();
```

### プールサイズの決め方

各スロットは同時に1コマンドしか扱わないため、プールサイズがそのまま実効的な最大同時実行数になります。リトルの法則でサイジングします。

```
size ≈ 目標スループット(req/s) × p95RTT(s)
```

これにRTTのばらつきやスパイクへのヘッドルーム（約3倍）を上乗せします。たとえばLAN内で p95 RTT 5ms、目標 500 req/s なら `500 × 0.005 = 2.5` なので、**8〜12** 接続で余裕を持って吸収できます。数値を決める前に実際の p95 RTT を計測してください。また高並行では純JavaScriptトランスポート（`forceJavaScript: true`、既定）を推奨します。ネイティブバインディングの `sendCommand` は同期実行で、往復のあいだイベントループ全体を止めるためです。

### バックプレッシャと自己回復

`MygramPool` は過負荷状態を前提に設計されています。

- **ロードシェディング**: 全スロットが埋まっている間、呼び出し側は上限付きの待機キュー（`maxQueue`）に入ります。キューが満杯になると、以降の呼び出しは `PoolOverloadError` で即座に reject され、メモリが無限に膨らむのを防ぎます。エッジ層では HTTP 503 + `Retry-After` に変換してください。
- **待機デッドライン**: 空きスロットを待つ呼び出しは `queueTimeoutMs` で上限化され、実待ち時間が青天井になりません。
- **自己回復**: 失敗した接続は退役し、他スロットが処理を続ける裏で指数バックオフにより再接続されます。冪等な読み取り（`search`・`count`・`get`・`facet`）は `ConnectionError` 発生時に別スロットで1回だけリトライされます。呼び出し側に届かないバックグラウンドのエラー（再接続失敗・keep-aliveでの退役）は `onError` で受け取れます。

```typescript
const pool = new MygramPool({
  connection: { host: 'localhost', port: 11016, timeout: 3000 },
  size: 12,
  maxQueue: 96, // これを超えたら即reject してロードシェディング
  queueTimeoutMs: 3000, // 実待ち時間の上限
  readRetries: 1, // 冪等な読み取りを別スロットで1回リトライ
  reconnectBackoffMs: [100, 5000],
  onMetrics: (m) => console.log('pool', m),
  metricsIntervalMs: 5000,
  onError: (err) => console.error('pool background error', err) // 無ければ握り潰される
});

try {
  await pool.search('articles', 'test');
} catch (error) {
  if (error instanceof PoolOverloadError) {
    // バックプレッシャ: このリクエストを捨てる（例: 503 を返す）。
  }
}
```

プールが直接公開していない管理系コマンドは、`withClient` で接続を借りて実行します。

```typescript
const info = await pool.withClient((client) => client.info(), { idempotent: true });
```

### サーキットブレーカ

`circuitBreaker` を設定すると、サーバーが到達不能になったときにリトライを続けるのではなく、即座に fail-fast します。ブレーカは read-retry ループの**外側**に位置するため、open の間はスロットを確保する前に `CircuitOpenError` をスローします。`circuitBreaker` を省略すると無効です。

- **closed**（通常）: 呼び出しは通常どおり実行されます。`ConnectionError` / `TimeoutError` ごとにカウンタが増え、`failureThreshold` 回連続（既定 5）のネットワーク失敗でブレーカが **open** になります。
- **open**: すべての呼び出しが `CircuitOpenError` で即座に失敗します。`resetTimeoutMs`（既定 10000）経過後、次の呼び出しが1回の **half-open** 試行として通されます。
- **half-open**: 試行の呼び出しを1回だけ許可します。成功すればブレーカは closed に戻り、失敗すれば再び open になります。試行中の並行呼び出しも即座に失敗します。

ブレーカをトリップさせるのは `ConnectionError` と `TimeoutError` だけです。`ProtocolError`（到達可能なサーバーがクエリを拒否）や `PoolOverloadError`（ローカルのバックプレッシャ）では closed のままです。

```typescript
import { MygramPool, CircuitOpenError } from 'mygramdb-client';

const pool = new MygramPool({
  connection: { host: 'localhost', port: 11016 },
  circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 10000 }
});

try {
  await pool.search('articles', 'test');
} catch (error) {
  if (error instanceof CircuitOpenError) {
    // サーバーが到達不能。ブレーカがロードシェディング中。バックオフする。
  }
}
```

### プールイベント

`onEvent` は個別のライフサイクルイベントを配信します。定期的な `onMetrics` スナップショットやバックグラウンドエラー用の `onError` シンクと併存します。4種類の `PoolEvent` が発行されます。

- `acquire` — スロットが呼び出し側へ渡された。ペイロード `{ waitMs }`（即座に空きスロットがあった場合は `0`）。
- `retry` — 冪等な読み取りが別スロットでリトライされた。ペイロード `{ attempt, error }`。
- `connection_discarded` — 死んだスロットがバックグラウンド再接続のため退役した。ペイロードは空。
- `breaker_state_change` — サーキットブレーカの状態が変化した。ペイロード `{ state }`（`'closed' | 'open' | 'half-open'`）。

`onEvent` コールバックが例外を投げても握り潰されるため、計装がプールを妨げることはありません。

```typescript
const pool = new MygramPool({
  connection: { host: 'localhost', port: 11016 },
  circuitBreaker: {},
  onEvent: (event, payload) => {
    console.log('pool event', event, payload);
  }
});
```

## クライアントの自動再接続

（プールではなく）単体の `MygramClient` では、`ClientConfig` に `autoReconnect` を設定すると、アイドル中に死んだソケットから回復できます。有効な場合、コマンドがワイヤへ書き込まれる**前**にソケットが死んでいると判明したときに**限り**、クライアントは1回だけ再接続してコマンドを再送します。書き込みの**後**に発生した失敗は、コマンドが既にサーバー側へ適用済みの可能性があるため、再送せずに `ConnectionError` として表面化します。これは純JavaScriptトランスポートにのみ適用され、ネイティブバインディングは実装しません。既定値: `false`。

```typescript
const client = new MygramClient({
  host: 'localhost',
  port: 11016,
  autoReconnect: true // 書き込み前に死んだソケットを検出したら1回だけ再接続して再送
});
```

## バッチ操作

複数のクエリを効率的に処理します：

```typescript
import { MygramClient, SearchResponse } from 'mygramdb-client';

async function batchSearch(
  client: MygramClient,
  table: string,
  queries: string[]
): Promise<SearchResponse[]> {
  return Promise.all(
    queries.map((query) => client.search(table, query))
  );
}

// Usage
const client = new MygramClient();
await client.connect();

const queries = [
  'golang tutorial',
  'python guide',
  'javascript tips',
  'rust programming',
];

const results = await batchSearch(client, 'articles', queries);

results.forEach((result, index) => {
  console.log(`Query "${queries[index]}": ${result.totalCount} results`);
});
```

## プールを使った並列処理

多数のクエリを同時に投げ、実際の同時実行数はプールがサイズ以内に自動で抑えます。溢れた呼び出しはキューで待機します。

```typescript
async function parallelSearch(
  pool: MygramPool,
  table: string,
  queries: string[]
): Promise<SearchResponse[]> {
  return Promise.all(queries.map((query) => pool.search(table, query)));
}

// Usage
const results = await parallelSearch(pool, 'articles', [
  'golang',
  'python',
  'javascript',
  'rust',
  'java',
  'c++',
]);
```

## ヘルスチェック

監視のためのヘルスチェックを実装します：

```typescript
import { MygramClient } from 'mygramdb-client';

interface HealthCheckResult {
  healthy: boolean;
  version?: string;
  uptime?: number;
  docCount?: number;
  replicationRunning?: boolean;
  error?: string;
}

async function healthCheck(client: MygramClient): Promise<HealthCheckResult> {
  try {
    const [info, status] = await Promise.all([
      client.info(),
      client.getReplicationStatus(),
    ]);

    return {
      healthy: true,
      version: info.version,
      uptime: info.uptimeSeconds,
      docCount: info.docCount,
      replicationRunning: status.running,
    };
  } catch (error) {
    return {
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Usage
const client = new MygramClient();
await client.connect();

const health = await healthCheck(client);
if (health.healthy) {
  console.log('Server is healthy');
  console.log(`Version: ${health.version}`);
  console.log(`Uptime: ${health.uptime} seconds`);
  console.log(`Documents: ${health.docCount}`);
} else {
  console.error('Server is unhealthy:', health.error);
}
```

## リトライロジック

一時的な障害に対する自動リトライを実装します：

```typescript
import { MygramClient, TimeoutError, ConnectionError } from 'mygramdb-client';

async function searchWithRetry(
  client: MygramClient,
  table: string,
  query: string,
  maxRetries: number = 3,
  retryDelay: number = 1000
): Promise<SearchResponse> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await client.search(table, query);
    } catch (error) {
      lastError = error as Error;

      // Only retry on timeout or connection errors
      if (
        error instanceof TimeoutError ||
        error instanceof ConnectionError
      ) {
        if (attempt < maxRetries) {
          console.log(`Attempt ${attempt} failed, retrying in ${retryDelay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, retryDelay));

          // Reconnect if connection was lost
          if (error instanceof ConnectionError && !client.isConnected()) {
            await client.connect();
          }

          continue;
        }
      }

      // Don't retry on protocol errors
      throw error;
    }
  }

  throw lastError;
}

// Usage
const results = await searchWithRetry(client, 'articles', 'test', 3, 1000);
```

## クエリパフォーマンス監視

クエリのパフォーマンスを追跡・分析します：

```typescript
import { MygramClient, SearchResponse } from 'mygramdb-client';

class PerformanceMonitor {
  private stats: Map<string, { count: number; totalMs: number; minMs: number; maxMs: number }> = new Map();

  async monitoredSearch(
    client: MygramClient,
    table: string,
    query: string
  ): Promise<SearchResponse> {
    const startTime = Date.now();
    const results = await client.search(table, query);
    const duration = Date.now() - startTime;

    this.recordMetric(query, duration);
    return results;
  }

  private recordMetric(query: string, durationMs: number): void {
    const existing = this.stats.get(query);

    if (existing) {
      existing.count++;
      existing.totalMs += durationMs;
      existing.minMs = Math.min(existing.minMs, durationMs);
      existing.maxMs = Math.max(existing.maxMs, durationMs);
    } else {
      this.stats.set(query, {
        count: 1,
        totalMs: durationMs,
        minMs: durationMs,
        maxMs: durationMs,
      });
    }
  }

  getStats(query: string) {
    const stats = this.stats.get(query);
    if (!stats) return null;

    return {
      count: stats.count,
      avgMs: stats.totalMs / stats.count,
      minMs: stats.minMs,
      maxMs: stats.maxMs,
    };
  }

  getAllStats() {
    const results: Record<string, any> = {};
    this.stats.forEach((stats, query) => {
      results[query] = {
        count: stats.count,
        avgMs: stats.totalMs / stats.count,
        minMs: stats.minMs,
        maxMs: stats.maxMs,
      };
    });
    return results;
  }

  reset(): void {
    this.stats.clear();
  }
}

// Usage
const monitor = new PerformanceMonitor();
const client = new MygramClient();
await client.connect();

for (let i = 0; i < 100; i++) {
  await monitor.monitoredSearch(client, 'articles', 'golang');
}

const stats = monitor.getStats('golang');
console.log(`Average query time: ${stats?.avgMs}ms`);
console.log(`Min: ${stats?.minMs}ms, Max: ${stats?.maxMs}ms`);
```

## キャッシング層

頻繁にアクセスされるデータのためのキャッシング層を実装します：

```typescript
import { MygramClient, SearchResponse } from 'mygramdb-client';

class CachedMygramClient {
  private cache: Map<string, { data: SearchResponse; timestamp: number }> = new Map();

  constructor(
    private client: MygramClient,
    private ttlMs: number = 60000
  ) {}

  async search(
    table: string,
    query: string,
    useCache: boolean = true
  ): Promise<SearchResponse> {
    const cacheKey = `${table}:${query}`;

    if (useCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.ttlMs) {
        return cached.data;
      }
    }

    const results = await this.client.search(table, query);
    this.cache.set(cacheKey, { data: results, timestamp: Date.now() });
    return results;
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheStats() {
    return {
      entries: this.cache.size,
      oldestEntry: Math.min(
        ...Array.from(this.cache.values()).map((v) => v.timestamp)
      ),
    };
  }
}

// Usage
const client = new MygramClient();
await client.connect();

const cachedClient = new CachedMygramClient(client, 60000);

// First call - hits server
const results1 = await cachedClient.search('articles', 'golang');

// Second call - returns cached result
const results2 = await cachedClient.search('articles', 'golang');

// Force bypass cache
const results3 = await cachedClient.search('articles', 'golang', false);
```

## ページネーションヘルパー

大きな結果セットのページネーションを実装します：

```typescript
import { MygramClient, SearchResponse } from 'mygramdb-client';

class PaginatedSearch {
  constructor(
    private client: MygramClient,
    private table: string,
    private query: string,
    private pageSize: number = 100
  ) {}

  async *pages(): AsyncIterableIterator<SearchResponse> {
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const results = await this.client.search(this.table, this.query, {
        limit: this.pageSize,
        offset,
      });

      yield results;

      offset += results.results.length;
      hasMore = offset < results.totalCount;
    }
  }

  async getAllResults(): Promise<SearchResult[]> {
    const allResults: SearchResult[] = [];

    for await (const page of this.pages()) {
      allResults.push(...page.results);
    }

    return allResults;
  }
}

// Usage
const client = new MygramClient();
await client.connect();

const paginated = new PaginatedSearch(client, 'articles', 'golang', 100);

// Iterate through pages
for await (const page of paginated.pages()) {
  console.log(`Page has ${page.results.length} results`);
  console.log(`Total available: ${page.totalCount}`);
}

// Or get all results at once
const allResults = await paginated.getAllResults();
console.log(`Retrieved ${allResults.length} total results`);
```

## エラーリカバリー

包括的なエラーリカバリーを実装します：

```typescript
import {
  MygramClient,
  ConnectionError,
  ProtocolError,
  TimeoutError,
} from 'mygramdb-client';

class ResilientClient {
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  constructor(private client: MygramClient) {}

  async search(table: string, query: string): Promise<SearchResponse> {
    try {
      return await this.client.search(table, query);
    } catch (error) {
      if (error instanceof ConnectionError) {
        return this.handleConnectionError(table, query);
      }
      if (error instanceof TimeoutError) {
        return this.handleTimeoutError(table, query);
      }
      throw error;
    }
  }

  private async handleConnectionError(
    table: string,
    query: string
  ): Promise<SearchResponse> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      throw new Error('Max reconnection attempts reached');
    }

    this.reconnectAttempts++;
    console.log(`Reconnecting... (attempt ${this.reconnectAttempts})`);

    await new Promise((resolve) =>
      setTimeout(resolve, this.reconnectDelay * this.reconnectAttempts)
    );

    await this.client.connect();
    this.reconnectAttempts = 0;

    return this.client.search(table, query);
  }

  private async handleTimeoutError(
    table: string,
    query: string
  ): Promise<SearchResponse> {
    console.log('Query timed out, retrying...');
    await new Promise((resolve) => setTimeout(resolve, 500));
    return this.client.search(table, query);
  }
}

// Usage
const client = new MygramClient();
await client.connect();

const resilient = new ResilientClient(client);
const results = await resilient.search('articles', 'test');
```

## ロードバランシング

複数のサーバーにクエリを分散します：

```typescript
import { MygramClient, ClientConfig } from 'mygramdb-client';

class LoadBalancedClient {
  private clients: MygramClient[] = [];
  private currentIndex = 0;

  constructor(private configs: ClientConfig[]) {}

  async init(): Promise<void> {
    for (const config of this.configs) {
      const client = new MygramClient(config);
      await client.connect();
      this.clients.push(client);
    }
  }

  private getNextClient(): MygramClient {
    const client = this.clients[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.clients.length;
    return client;
  }

  async search(table: string, query: string): Promise<SearchResponse> {
    const client = this.getNextClient();
    return client.search(table, query);
  }

  async close(): Promise<void> {
    this.clients.forEach((client) => client.disconnect());
  }
}

// Usage
const loadBalancer = new LoadBalancedClient([
  { host: 'server1.example.com', port: 11016 },
  { host: 'server2.example.com', port: 11016 },
  { host: 'server3.example.com', port: 11016 },
]);

await loadBalancer.init();

// Queries are distributed round-robin across servers
const results1 = await loadBalancer.search('articles', 'test1');
const results2 = await loadBalancer.search('articles', 'test2');
const results3 = await loadBalancer.search('articles', 'test3');

await loadBalancer.close();
```

## ベストプラクティス

### 1. 本番環境では常にコネクションプーリングを使用する

```typescript
// 良い例 - リクエストをN本の接続へ分散する
const pool = new MygramPool({ connection: config, size: 12 });
await pool.start();

// 悪い例 - 1接続はすべてのコマンドを1本のソケットで直列化する
const client = new MygramClient(config);
await client.connect();
```

### 2. エラーを適切に処理する

```typescript
// 良い例
try {
  const results = await client.search('articles', 'test');
} catch (error) {
  if (error instanceof TimeoutError) {
    // リトライロジック
  } else if (error instanceof ConnectionError) {
    // 再接続ロジック
  } else {
    // ログと報告
  }
}

// 悪い例 - エラー処理なし
const results = await client.search('articles', 'test');
```

### 3. 適切なタイムアウトを使用する

```typescript
// 良い例 - ユースケースに応じた適切なタイムアウト
const client = new MygramClient({ timeout: 5000 });

// 悪い例 - 短すぎる、誤ったタイムアウトを引き起こす可能性がある
const client = new MygramClient({ timeout: 100 });

// 悪い例 - 長すぎる、障害時に長時間ブロックされる
const client = new MygramClient({ timeout: 60000 });
```

### 4. パフォーマンスを監視する

```typescript
// 良い例 - クエリパフォーマンスを追跡する
const monitor = new PerformanceMonitor();
await monitor.monitoredSearch(client, 'articles', 'test');

// 定期的に統計をログに記録する
setInterval(() => {
  console.log(monitor.getAllStats());
}, 60000);
```

### 5. リソースをクリーンアップする

```typescript
// 良い例
try {
  await client.connect();
  // 作業を実行
} finally {
  client.disconnect();
}

// 悪い例 - 接続リーク
await client.connect();
// 作業を実行
// 切断を忘れる
```
