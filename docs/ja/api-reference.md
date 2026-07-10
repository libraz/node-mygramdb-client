# APIリファレンス

mygramdb-clientの完全なAPIリファレンスです。

## MygramClient クラス

MygramDBと対話するためのメインのクライアントクラスです。

### コンストラクタ

```typescript
new MygramClient(config?: ClientConfig)
```

新しいMygramDBクライアントインスタンスを作成します。

**パラメータ:**
- `config` (ClientConfig, オプション) - クライアント設定オプション

**例:**
```typescript
const client = new MygramClient({
  host: 'localhost',
  port: 11016,
  timeout: 5000,
});
```

## 接続メソッド

### connect()

```typescript
async connect(): Promise<void>
```

MygramDBサーバーへの接続を確立します。

**戻り値:** 接続完了時に解決されるPromise

**例外:**
- `ConnectionError` - 接続に失敗した場合
- `TimeoutError` - 接続がタイムアウトした場合

**例:**
```typescript
await client.connect();
```

### disconnect()

```typescript
disconnect(): void
```

サーバーへの接続を閉じます。

**例:**
```typescript
client.disconnect();
```

### isConnected()

```typescript
isConnected(): boolean
```

クライアントが現在接続されているかどうかを確認します。

**戻り値:** 接続されている場合は `true`、そうでない場合は `false`

**例:**
```typescript
if (client.isConnected()) {
  console.log('Client is connected');
}
```

## 検索メソッド

### search()

```typescript
async search(
  table: string,
  query: string,
  options?: SearchOptions
): Promise<SearchResponse>
```

指定されたテーブル内のドキュメントを検索します。複数語のクエリは自動的に
クォートされ、1つのフレーズトークンとしてサーバーへ送信されます。ブール
（`AND`/`OR`/`NOT`/グループ化）式には [`searchRaw()`](#searchraw) を使用します。

**パラメータ:**
- `table` (string) - 検索対象のテーブル名。MygramDB v1.7+ のマルチデータベース
  構成では `database.table` 形式（例: `app_db.articles`）を指定します。単一
  データベースのサーバーでは従来どおり bare な名前も使用できます。
- `query` (string) - 検索クエリテキスト
- `options` (SearchOptions, オプション) - 検索オプション

**戻り値:** SearchResponseに解決されるPromise

**例外:**
- `InputValidationError` - クエリに制御文字が含まれる、または設定した長さ制限を超えた場合
- `ConnectionError` - 接続されていない場合
- `TimeoutError` - リクエストがタイムアウトした場合
- `ProtocolError` - サーバーがエラーを返した場合

**例:**
```typescript
const results = await client.search('articles', 'golang tutorial', {
  limit: 50,
  offset: 0,
  andTerms: ['beginner'],
  notTerms: ['advanced'],
  filters: { status: '1', category: 'tech' },
  sortColumn: 'created_at',
  sortDesc: true,
});

console.log(`Found ${results.totalCount} results`);
results.results.forEach((result) => {
  console.log(`ID: ${result.primaryKey}`);
});
```

### searchWithHighlights()

```typescript
async searchWithHighlights(
  table: string,
  query: string,
  options?: SearchOptions
): Promise<SearchResponse>
```

[`search()`](#search) と同等の呼び出しで `HIGHLIGHT` 句を有効にします。`options`
に渡した `highlight` オプションは保持され、指定しない場合はサーバー既定値
（`<em>`/`</em>`、100 コードポイント、最大 3 フラグメント）が使われます。スニペット
は `result.snippet` に返されます。

**例:**
```typescript
const results = await client.searchWithHighlights('articles', 'golang', {
  highlight: { openTag: '<strong>', closeTag: '</strong>' },
});
for (const r of results.results) {
  console.log(r.primaryKey, r.snippet);
}
```

### count()

```typescript
async count(
  table: string,
  query: string,
  options?: CountOptions
): Promise<CountResponse>
```

ドキュメントのIDを取得せずに、マッチするドキュメント数をカウントします。

**パラメータ:**
- `table` (string) - 検索対象のテーブル名
- `query` (string) - 検索クエリテキスト
- `options` (CountOptions, オプション) - カウントオプション

**戻り値:** CountResponseに解決されるPromise

**例外:**
- `InputValidationError` - クエリに制御文字が含まれる、または設定した長さ制限を超えた場合
- `ConnectionError` - 接続されていない場合
- `TimeoutError` - リクエストがタイムアウトした場合
- `ProtocolError` - サーバーがエラーを返した場合

**例:**
```typescript
const count = await client.count('articles', 'machine learning', {
  filters: { status: '1' },
});
console.log(`Total matches: ${count.count}`);
```

### searchRaw()

```typescript
async searchRaw(
  table: string,
  rawQuery: string,
  options?: SearchRawOptions
): Promise<SearchResponse>
```

事前に組み立てたブール式で検索します（MygramDB v1.7+）。式はそのまま（クォート
せず）送信され、サーバーの AST パーサーが `AND`/`OR`/`NOT`/括弧を解釈します。
これらのキーワードを含むクォート済みフレーズはリテラルフレーズとして扱われます
（MygramDB v1.8+）。`search()` の AND/NOT 分解では表現できない OR・グループ化の意味を
保持したい場合は、[`convertSearchExpression()`](#エクスポートされた関数) と
組み合わせて使用します。

**パラメータ:**
- `table` (string) - テーブル名（bare または `database.table`）
- `rawQuery` (string) - 事前に組み立てたブール式
- `options` (SearchRawOptions, オプション) - `limit` / `offset` / `highlight`

**戻り値:** SearchResponseに解決されるPromise

**例:**
```typescript
const raw = convertSearchExpression('python OR (ruby AND rails)');
const results = await client.searchRaw('articles', raw, { limit: 50 });
```

### searchRawWithHighlights()

```typescript
async searchRawWithHighlights(
  table: string,
  rawQuery: string,
  options?: SearchRawOptions
): Promise<SearchResponse>
```

[`searchRaw()`](#searchraw) と同等の呼び出しで `HIGHLIGHT` 句を有効にします。
`options` に渡した `highlight` オプションは保持され、指定しない場合はサーバー
既定値が使われます。スニペットは `result.snippet` に返されます。

**例:**
```typescript
const raw = convertSearchExpression('python OR (ruby AND rails)');
const results = await client.searchRawWithHighlights('articles', raw, { highlight: {} });
```

## ファセットメソッド

### facet()

```typescript
async facet(
  table: string,
  column: string,
  options?: FacetOptions
): Promise<FacetResponse>
```

フィルタ列の distinct な値とそのドキュメント件数を集計します（MygramDB v1.6+）。
`query` を指定しない場合はテーブル全体を集計し、`query`（および任意の
`andTerms`/`notTerms`/`filters` による絞り込み）を指定するとマッチしたドキュメント
に範囲を絞ります。

**パラメータ:**
- `table` (string) - テーブル名（bare または `database.table`）
- `column` (string) - 集計対象のフィルタ列
- `options` (FacetOptions, オプション) - 任意のクエリ範囲・絞り込み・`limit`

**戻り値:** FacetResponseに解決されるPromise

**例外:**
- `InputValidationError` - 引数に制御文字が含まれる、またはクエリが設定した長さ制限を超えた場合
- `ConnectionError` - 接続されていない場合
- `TimeoutError` - リクエストがタイムアウトした場合
- `ProtocolError` - サーバーがエラーを返した場合

**例:**
```typescript
// テーブル全体での status の値分布:
const all = await client.facet('articles', 'status');

// "machine learning" にマッチするドキュメント内のカテゴリ上位:
const top = await client.facet('articles', 'category', {
  query: 'machine learning',
  filters: { status: '1' },
  limit: 10,
});
for (const v of top.results) {
  console.log(`${v.value}: ${v.count}`);
}
```

## ドキュメントメソッド

### get()

```typescript
async get(table: string, primaryKey: string): Promise<Document>
```

プライマリキーでドキュメントを取得します。

**パラメータ:**
- `table` (string) - テーブル名
- `primaryKey` (string) - ドキュメントのプライマリキー

**戻り値:** Documentに解決されるPromise

**例外:**
- `ConnectionError` - 接続されていない場合
- `TimeoutError` - リクエストがタイムアウトした場合
- `ProtocolError` - ドキュメントが見つからない、またはサーバーエラーの場合

**例:**
```typescript
const doc = await client.get('articles', '12345');
console.log(doc.primaryKey);
console.log(doc.fields); // { status: '1', category: 'tech', ... }
```

## サーバー情報メソッド

### info()

```typescript
async info(): Promise<ServerInfo>
```

バージョン、稼働時間、ドキュメント数、テーブルリストを含む包括的なサーバー情報を取得します。

**戻り値:** ServerInfoに解決されるPromise

**例外:**
- `ConnectionError` - 接続されていない場合
- `TimeoutError` - リクエストがタイムアウトした場合
- `ProtocolError` - サーバーがエラーを返した場合

**例:**
```typescript
const info = await client.info();
console.log(`Version: ${info.version}`);
console.log(`Uptime: ${info.uptimeSeconds} seconds`);
console.log(`Total documents: ${info.docCount}`);
console.log(`Tables: ${info.tables.join(', ')}`);
```

### getConfig()

```typescript
async getConfig(): Promise<string>
```

YAML形式でサーバー設定を取得します。

**戻り値:** 設定文字列（YAML形式）に解決されるPromise

**例外:**
- `ConnectionError` - 接続されていない場合
- `TimeoutError` - リクエストがタイムアウトした場合
- `ProtocolError` - サーバーがエラーを返した場合

**例:**
```typescript
const config = await client.getConfig();
console.log(config);
```

## レプリケーションメソッド

### getReplicationStatus()

```typescript
async getReplicationStatus(): Promise<ReplicationStatus>
```

現在のMySQLバイナリログレプリケーションのステータスを取得します。

**戻り値:** ReplicationStatusに解決されるPromise

**例外:**
- `ConnectionError` - 接続されていない場合
- `TimeoutError` - リクエストがタイムアウトした場合
- `ProtocolError` - サーバーがエラーを返した場合

**例:**
```typescript
const status = await client.getReplicationStatus();
console.log(`Running: ${status.running}`);
console.log(`GTID: ${status.gtid}`);
console.log(`Status: ${status.statusStr}`);
```

### stopReplication()

```typescript
async stopReplication(): Promise<void>
```

MySQLバイナリログレプリケーションを停止します。

**戻り値:** レプリケーション停止時に解決されるPromise

**例外:**
- `ConnectionError` - 接続されていない場合
- `TimeoutError` - リクエストがタイムアウトした場合
- `ProtocolError` - サーバーがエラーを返した場合

**例:**
```typescript
await client.stopReplication();
console.log('Replication stopped');
```

### startReplication()

```typescript
async startReplication(): Promise<void>
```

MySQLバイナリログレプリケーションを開始します。

**戻り値:** レプリケーション開始時に解決されるPromise

**例外:**
- `ConnectionError` - 接続されていない場合
- `TimeoutError` - リクエストがタイムアウトした場合
- `ProtocolError` - サーバーがエラーを返した場合

**例:**
```typescript
await client.startReplication();
console.log('Replication started');
```

## デバッグメソッド

### enableDebug()

```typescript
async enableDebug(): Promise<void>
```

デバッグモードを有効にして、検索結果と共に詳細なクエリパフォーマンスメトリクスを受信します。

**戻り値:** デバッグモード有効化時に解決されるPromise

**例外:**
- `ConnectionError` - 接続されていない場合
- `TimeoutError` - リクエストがタイムアウトした場合
- `ProtocolError` - サーバーがエラーを返した場合

**例:**
```typescript
await client.enableDebug();

const results = await client.search('articles', 'test');
if (results.debug) {
  console.log(`Query time: ${results.debug.queryTimeMs}ms`);
  console.log(`Index time: ${results.debug.indexTimeMs}ms`);
  console.log(`Candidates: ${results.debug.candidates}`);
  console.log(`Final results: ${results.debug.final}`);
}
```

### disableDebug()

```typescript
async disableDebug(): Promise<void>
```

デバッグモードを無効にします。

**戻り値:** デバッグモード無効化時に解決されるPromise

**例外:**
- `ConnectionError` - 接続されていない場合
- `TimeoutError` - リクエストがタイムアウトした場合
- `ProtocolError` - サーバーがエラーを返した場合

**例:**
```typescript
await client.disableDebug();
```

## キャッシュメソッド

### cacheStats()

```typescript
async cacheStats(): Promise<CacheStats>
```

クエリキャッシュの統計（有効状態、メモリ使用量、エントリ数、ヒット率、退避数、
TTL）を返します。

```typescript
const stats = await client.cacheStats();
console.log(`Hit rate: ${stats.hitRate}%, entries: ${stats.entries}`);
```

### cacheClear()

```typescript
async cacheClear(table?: string): Promise<void>
```

クエリキャッシュをクリアします。引数なしの場合は全テーブルのキャッシュエントリを、
テーブルを指定した場合はそのテーブルのエントリのみをクリアします。

### cacheEnable()

```typescript
async cacheEnable(): Promise<void>
```

クエリキャッシュを有効にします。

### cacheDisable()

```typescript
async cacheDisable(): Promise<void>
```

クエリキャッシュを無効にします。

## インデックスメンテナンスメソッド

### optimize()

```typescript
async optimize(table?: string): Promise<void>
```

インデックスを最適化（再構築）します。引数なしの場合は全テーブルを、テーブルを
指定した場合はそのテーブルのみを最適化します。

```typescript
await client.optimize('articles');
```

## ダンプメソッド

### dumpSave()

```typescript
async dumpSave(filepath: string): Promise<string>
```

サーバー上の `filepath` へインデックスのダンプ保存を開始します。書き込み先の
filepath で解決します。進捗の監視には [`dumpStatus()`](#dumpstatus) を使います。

### dumpLoad()

```typescript
async dumpLoad(filepath: string): Promise<void>
```

サーバー上の `filepath` からインデックスのダンプを読み込みます。

### dumpStatus()

```typescript
async dumpStatus(): Promise<DumpStatus>
```

現在のダンプ操作のステータス（状態、filepath、テーブル進捗、経過時間、エラー）を
返します。

### dumpVerify()

```typescript
async dumpVerify(filepath: string): Promise<string>
```

ダンプファイルの整合性を検証し、サーバーの生の結果メッセージで解決します。

### dumpInfo()

```typescript
async dumpInfo(filepath: string): Promise<string>
```

ダンプファイルのメタデータをサーバーの生のレスポンス文字列として返します。

```typescript
const path = await client.dumpSave('/var/lib/mygramdb/snapshot.dump');
console.log((await client.dumpStatus()).status);
console.log(await client.dumpInfo(path));
```

## ランタイム変数メソッド（v1.7+）

### setVariable()

```typescript
async setVariable(name: string, value: string): Promise<void>
```

ランタイム変数を設定します（MySQL 互換の `SET`）。空白を含む値は自動的に
クォートされます。

```typescript
await client.setVariable('logging.level', 'info');
```

### showVariables()

```typescript
async showVariables(likePattern?: string): Promise<string>
```

ランタイム変数の一覧（`SHOW VARIABLES [LIKE <pattern>]`）をサーバーの生の
レスポンス文字列として返します。

```typescript
const table = await client.showVariables('logging%');
```

## SYNC メソッド（v1.7+）

### sync()

```typescript
async sync(table: string): Promise<string>
```

テーブルのオンデマンド全リロードを開始します（`SYNC <table>`）。bare または
`database.table` 形式を受け付け、サーバーの確認応答で解決します。

### syncStatus()

```typescript
async syncStatus(): Promise<string>
```

`SYNC STATUS` レポート（実行中・直近の SYNC 操作）をサーバーの生のレスポンス
文字列として返します。

### syncStop()

```typescript
async syncStop(table?: string): Promise<string>
```

実行中の SYNC を停止します。テーブルを指定しない場合はすべての実行中 SYNC を、
指定した場合はそのテーブルの SYNC のみを停止します。

```typescript
await client.sync('app_db.articles');
console.log(await client.syncStatus());
await client.syncStop('app_db.articles');
```

## MygramPool クラス

リクエストをN本のクライアントへ分散し、単一のNodeプロセスで高いリクエストレートを維持するコネクションプールです。サイジングと使い方は[コネクションプーリング](./advanced-usage.md#コネクションプーリング)を参照してください。

### コンストラクタ

```typescript
new MygramPool(config?: MygramPoolConfig)
```

`MygramPoolConfig` のフィールド（すべて任意）:

| フィールド | 既定値 | 説明 |
| --- | --- | --- |
| `connection` | `{}` | 各接続へ渡す `ClientConfig` |
| `size` | `8` | 接続数。実効的な最大同時実行数 |
| `forceJavaScript` | `true` | 純JSトランスポートを使う（高並行では推奨） |
| `maxQueue` | `size * 8` | `PoolOverloadError` でシェッドする前に待機できる呼び出しの上限 |
| `queueTimeoutMs` | 接続タイムアウト / `5000` | 空きスロットを待つ呼び出しのデッドライン |
| `readRetries` | `1` | `ConnectionError` 後に冪等な読み取りを別スロットでリトライする回数 |
| `reconnectBackoffMs` | `[100, 5000]` | 再接続バックオフ `[初期ms, 上限ms]`（指数＋ジッタ） |
| `keepAliveIntervalMs` | `30000` | アイドル接続をpingする間隔。`0` で無効 |
| `metricsIntervalMs` | `0` | `onMetrics` を発行する間隔。`0` で無効 |
| `onMetrics` | — | `metricsIntervalMs` ごとに呼ばれるメトリクスシンク |
| `onError` | — | 呼び出し側に届かないバックグラウンドエラー（再接続 / keep-alive）のシンク |
| `circuitBreaker` | — （無効） | クエリパスを包む `CircuitBreakerConfig`。open のブレーカはスロット確保前に `CircuitOpenError` で即座に失敗する |
| `onEvent` | — | 個別のライフサイクルイベント（`PoolEvent`）のシンク。例外を投げても握り潰される |
| `clientFactory` | `createMygramClient` | 注入可能なクライアントファクトリ（主にテスト用） |

### メソッド

```typescript
start(): Promise<void>   // 任意のウォームアップ。メモ化され冪等
close(): Promise<void>   // グレースフルな破棄
end(): Promise<void>     // close() のエイリアス
metrics(): PoolMetrics

// クエリAPI（ロードバランスされ、冪等な読み取りは ConnectionError 時にリトライ）
search(table, query, options?): Promise<SearchResponse>
searchWithHighlights(table, query, options?): Promise<SearchResponse>
searchRaw(table, rawQuery, options?): Promise<SearchResponse>
searchRawWithHighlights(table, rawQuery, options?): Promise<SearchResponse>
count(table, query, options?): Promise<CountResponse>
get(table, primaryKey): Promise<Document>
facet(table, column, options?): Promise<FacetResponse>

// 管理系コマンド用のエスケープハッチ
withClient<T>(operation: (client) => Promise<T>, options?: { idempotent?: boolean }): Promise<T>
```

`start()` は全接続を開き、1つ以上が健全になった時点で resolve します（失敗した接続は裏で再接続されます）。呼び出しは任意で、最初のクエリがプールを遅延起動します（遅延起動が失敗した場合はそのクエリが reject され、次のクエリで再試行されます）。`close()`（エイリアス `end()`）は待機中の呼び出しを reject し、全接続を切断します。

### PoolMetrics

```typescript
interface PoolMetrics {
  totalConnections: number;    // 設定したプールサイズ
  healthyConnections: number;  // 接続済みで利用可能
  inFlight: number;            // 実行中のコマンド数
  queueDepth: number;          // スロット待ちの呼び出し数
  rejectedOverload: number;    // ロードシェッドした累計呼び出し数
  reconnects: number;          // 接続退役の累計
  completed: number;           // 成功コマンドの累計
  failed: number;              // 失敗コマンドの累計
  latencyP50Ms: number;        // コマンドレイテンシの中央値
  latencyP99Ms: number;        // コマンドレイテンシの99パーセンタイル
}
```

### CircuitBreakerConfig

```typescript
interface CircuitBreakerConfig {
  failureThreshold?: number; // ブレーカを open にする連続ネットワーク失敗回数（既定: 5）
  resetTimeoutMs?: number;   // half-open 試行までブレーカが open のままの時間（既定: 10000）
}
```

ネットワーク失敗として数えられるのは `ConnectionError` と `TimeoutError` だけです。
`ProtocolError` と `PoolOverloadError` はブレーカをトリップさせません。
[サーキットブレーカ](./advanced-usage.md#サーキットブレーカ)を参照してください。

### PoolEvent

```typescript
type PoolEvent = 'acquire' | 'connection_discarded' | 'retry' | 'breaker_state_change';
```

`onEvent(event, payload)` へ配信されます。

| イベント | ペイロード |
| --- | --- |
| `acquire` | `{ waitMs }` |
| `retry` | `{ attempt, error }` |
| `connection_discarded` | `{}` |
| `breaker_state_change` | `{ state }`（`CircuitState` を参照） |

### CircuitState

```typescript
type CircuitState = 'closed' | 'open' | 'half-open';
```

`breaker_state_change` イベントのペイロードで報告されるサーキットブレーカの状態です。
`closed`（正常）、`open`（フェイルファスト中）、`half-open`（試行呼び出しで probe 中）。

## 型定義

### ClientConfig

```typescript
interface ClientConfig {
  host?: string;           // サーバーホスト名（デフォルト: '127.0.0.1'）
  port?: number;           // サーバーポート（デフォルト: 11016）
  timeout?: number;        // 接続タイムアウト（ミリ秒、デフォルト: 5000）
  recvBufferSize?: number; // 受信バッファサイズ（バイト、デフォルト: 65536）
  maxQueryLength?: number; // クエリ式の最大文字数（デフォルト: 128）
  autoReconnect?: boolean; // 書き込み前に死んだソケットを検出したら1回だけ再接続して再送。純JSトランスポートのみ（デフォルト: false）
}
```

### SearchOptions

```typescript
interface SearchOptions {
  limit?: number;                    // 最大結果数（デフォルト: 1000）
  offset?: number;                   // ページネーションオフセット（デフォルト: 0）
  andTerms?: string[];               // 追加の必須検索語
  notTerms?: string[];               // 除外する検索語
  filters?: Record<string, string>;  // フィルタ条件（カラム: 値）
  sortColumn?: string;               // ソートカラム（デフォルト: プライマリキー）
  sortDesc?: boolean;                // 降順ソート（デフォルト: true）
  fuzzy?: number;                    // あいまい検索の編集距離（0 = 完全一致）
  highlight?: HighlightOptions;      // ハイライトスニペットを有効化
}
```

### SearchRawOptions

```typescript
interface SearchRawOptions {
  limit?: number;               // 最大結果数（デフォルト: 0 = サーバー既定値）
  offset?: number;              // ページネーションオフセット（デフォルト: 0）
  highlight?: HighlightOptions; // {} を渡すと既定設定でハイライト有効化
}
```

### CountOptions

```typescript
interface CountOptions {
  andTerms?: string[];               // 追加の必須検索語
  notTerms?: string[];               // 除外する検索語
  filters?: Record<string, string>;  // フィルタ条件（カラム: 値）
}
```

### HighlightOptions

```typescript
interface HighlightOptions {
  openTag?: string;       // 開始タグ（closeTag と併せて指定）
  closeTag?: string;      // 終了タグ（openTag と併せて指定）
  snippetLen?: number;    // スニペット長（コードポイント、0 = サーバー既定値）
  maxFragments?: number;  // ドキュメントあたりの最大フラグメント数（0 = サーバー既定値）
}
```

### FacetOptions

```typescript
interface FacetOptions {
  query?: string;                    // 集計を絞り込む任意のクエリ
  andTerms?: string[];               // 追加の必須検索語
  notTerms?: string[];               // 除外する検索語
  filters?: Record<string, string>;  // フィルタ条件（カラム: 値）
  limit?: number;                    // ファセット値の最大数（0 = 無制限）
}
```

### FacetResponse

```typescript
interface FacetResponse {
  results: FacetValue[]; // サーバー定義順のファセット値
}

interface FacetValue {
  value: string;  // ファセット列の distinct な値
  count: number;  // その値を持つドキュメント数
}
```

### SearchResponse

```typescript
interface SearchResponse {
  results: SearchResult[];  // 検索結果の配列
  totalCount: number;       // マッチした総ドキュメント数
  debug?: DebugInfo;        // デバッグ情報（デバッグモードが有効な場合）
}
```

### SearchResult

```typescript
interface SearchResult {
  primaryKey: string;  // ドキュメントのプライマリキー
  snippet?: string;    // ハイライトされたスニペット、ハイライト有効時のみ存在（MygramDB v1.6+）
}
```

### CountResponse

```typescript
interface CountResponse {
  count: number;       // マッチした総ドキュメント数
  debug?: DebugInfo;   // デバッグ情報（デバッグモードが有効な場合）
}
```

### Document

```typescript
interface Document {
  primaryKey: string;                // プライマリキー
  fields: Record<string, string>;    // ドキュメントフィールド（カラム: 値）
}
```

### InputValidationError

クエリやフィルタ値に改行などの制御文字が含まれている場合や、`ClientConfig.maxQueryLength`
で設定した上限を超える長さのクエリ式を送信しようとした場合に発生するクライアント側のエラーです。
入力内容を見直すか、意図的に長いクエリが必要な場合は上限値を調整してください。

### ServerInfo

```typescript
interface ServerInfo {
  version: string;           // サーバーバージョン
  uptimeSeconds: number;     // サーバー稼働時間（秒）
  totalRequests: number;     // 累計リクエスト処理数
  activeConnections: number; // 現在アクティブな接続数
  indexSizeBytes: number;    // インデックスサイズ（バイト）
  docCount: number;          // 総ドキュメント数
  tables: string[];          // テーブル名のリスト
}
```

### ReplicationStatus

```typescript
interface ReplicationStatus {
  running: boolean;          // レプリケーションが実行中かどうか
  gtid: string;              // 現在のGTID位置
  statusStr: string;         // 生のステータス文字列
  processedEvents?: number;  // これまでに処理したイベント数（MygramDB v1.6+）
  queueSize?: number;        // レプリケーションキューのサイズ、実行中のみ存在（MygramDB v1.6+）
}
```

### DebugInfo

```typescript
interface DebugInfo {
  queryTimeMs: number;       // クエリ実行の総時間（ミリ秒）
  indexTimeMs: number;       // インデックス検索時間（ミリ秒）
  filterTimeMs: number;      // フィルタ処理時間（ミリ秒）
  terms: number;             // 検索語の数
  ngrams: number;            // 生成された n-gram の数
  candidates: number;        // インデックスからの初期候補数
  afterIntersection: number; // AND 積集合後の結果数
  afterNot: number;          // NOT フィルタ後の結果数
  afterFilters: number;      // FILTER 条件適用後の結果数
  final: number;             // LIMIT/OFFSET 適用前の最終結果数
  optimization: string;      // 使用された最適化戦略
  sort?: string;             // ソート指定（例: "id DESC"）
  cache?: string;            // キャッシュ状態（hit, miss, disabled）
  cacheAgeMs?: number;       // キャッシュの経過時間（ミリ秒、キャッシュヒット時）
  cacheSavedMs?: number;     // キャッシュヒットで短縮された時間（ミリ秒）
  limit?: number;            // limit 値
  offset?: number;           // offset 値
}
```

### CacheStats

```typescript
interface CacheStats {
  enabled: boolean;         // キャッシュが有効かどうか
  maxMemoryMb: number;      // 最大キャッシュメモリ（MB）
  currentMemoryMb: number;  // 現在のキャッシュメモリ使用量（MB）
  entries: number;          // キャッシュエントリ数
  hits: number;             // キャッシュヒット数
  misses: number;           // キャッシュミス数
  hitRate: number;          // キャッシュヒット率（パーセント）
  evictions: number;        // キャッシュ退避数
  ttlSeconds: number;       // キャッシュTTL（秒）
}
```

### DumpStatus

```typescript
interface DumpStatus {
  status: string;           // saving, loading, idle, completed, failed
  filepath: string;         // ダンプのファイルパス
  tablesTotal: number;      // テーブル総数
  tablesProcessed: number;  // 処理済みテーブル数
  currentTable: string;     // 現在処理中のテーブル名
  elapsedSeconds: number;   // 経過時間（秒）
  error?: string;           // status が failed のときのエラーメッセージ
}
```

## エラー型

### MygramError

すべてのmygramdb-clientエラーの基底エラークラスです。

```typescript
class MygramError extends Error {
  constructor(message: string);
}
```

### ConnectionError

サーバーへの接続が失敗した場合にスローされます。

```typescript
class ConnectionError extends MygramError {
  constructor(message: string);
}
```

### ProtocolError

サーバーが無効なレスポンスまたはエラーを返した場合にスローされます。

```typescript
class ProtocolError extends MygramError {
  constructor(message: string);
}
```

### TimeoutError

リクエストがタイムアウトした場合にスローされます。

```typescript
class TimeoutError extends MygramError {
  constructor(message: string);
}
```

### PoolOverloadError

待機キューが満杯のときに `MygramPool` がスローします。ロードシェディングのシグナルです。追加の処理をキューへ積むのではなく、HTTP 503 + `Retry-After` に対応付けてください。

```typescript
class PoolOverloadError extends MygramError {
  constructor(message: string);
}
```

### CircuitOpenError

`MygramPool` のサーキットブレーカが open のとき（または試行が既に進行中の half-open のとき）にスローされます。到達不能なサーバーを保護するため、スロットを確保する前にプールが即座に失敗していることを示します。[サーキットブレーカ](./advanced-usage.md#サーキットブレーカ)を参照してください。

```typescript
class CircuitOpenError extends MygramError {
  constructor(message: string);
}
```

## エクスポートされた関数

検索式のパースユーティリティについては、[検索式](./search-expression.md)を参照してください。

### テーブル識別子ヘルパー（v1.7+）

```typescript
qualifyTableIdentity(table: string, database?: string): string
parseTableIdentity(identity: string): { database: string | null; table: string }
```

`qualifyTableIdentity` は `database.table` 形式の識別子を組み立てます（database
を指定しない場合は bare なテーブル名を返します）。`parseTableIdentity` は識別子を
各パーツへ分解します。いずれも識別子を検証し、空白・制御文字を拒否します。

```typescript
qualifyTableIdentity('articles', 'app_db'); // 'app_db.articles'
parseTableIdentity('app_db.articles');      // { database: 'app_db', table: 'articles' }
```

### クライアントファクトリとランタイム検出

```typescript
createMygramClient(config?: ClientConfig, forceJavaScript?: boolean): MygramClient | NativeMygramClient
getClientType(client: MygramClient | NativeMygramClient): 'native' | 'javascript'
isNativeAvailable(): boolean
```

`createMygramClient` は、ネイティブ C++ バインディングが利用可能で `forceJavaScript`
が指定されていない場合はネイティブクライアントを、そうでない場合は純粋 JavaScript の
`MygramClient` を返します。どちらも同じ API を公開します。`isNativeAvailable` は
ネイティブバインディングが読み込まれたかを返し、`getClientType` はインスタンスが
どちらの実装かを返します。

```typescript
const client = createMygramClient({ host: 'localhost', port: 11016 });
isNativeAvailable();       // コンパイル済みアドオンが存在すれば true
getClientType(client);     // 'native' | 'javascript'
```

`NativeMygramClient` はネイティブ実装のクライアントクラスです。通常は直接
インスタンス化せず、自動選択する `createMygramClient` の使用を推奨しますが、型注釈
のためにエクスポートされており、`MygramClient` の全メソッドをミラーしています。

### その他のエクスポート型

これらは型注釈のためにエクスポートされる補助型で、実際の形状は使用箇所にインラインで
示されています。

```typescript
// プール対象クライアントが満たすべき構造的インターフェース（search/count/get/... の面）。
interface PooledClient { /* 両クライアントが共有するクエリ + ライフサイクルメソッド */ }

// MygramPoolConfig.clientFactory で注入するファクトリ。
type PooledClientFactory = (config: ClientConfig, forceJavaScript: boolean) => PooledClient;

// ネイティブ版 simplifySearchExpression の戻り値（simplifySearchExpression() と同じ形状）。
interface SimplifiedExpression {
  mainTerm: string;
  andTerms: string[];
  notTerms: string[];
}
```
