# APIリファレンス

mygram-clientの完全なAPIリファレンスです。

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

`searchWithHighlights(table, query, options?)` は `HIGHLIGHT` 句を有効にした
同等の呼び出しで、`result.snippet` にスニペットを返します。

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

事前に組み立てたブール式で検索します（MygramDB v1.7+）。式は1つのクォート
済みトークンとして送信され、サーバーの AST パーサーが `AND`/`OR`/`NOT`/括弧を
解釈します。`search()` の AND/NOT 分解では表現できない OR・グループ化の意味を
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

`searchRawWithHighlights(table, rawQuery, options?)` は `HIGHLIGHT` 句を有効に
した同等の呼び出しで、`result.snippet` にスニペットを返します。

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
console.log(`Lag: ${status.lagSeconds} seconds`);
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

## 型定義

### ClientConfig

```typescript
interface ClientConfig {
  host?: string;           // サーバーホスト名（デフォルト: '127.0.0.1'）
  port?: number;           // サーバーポート（デフォルト: 11016）
  timeout?: number;        // 接続タイムアウト（ミリ秒、デフォルト: 5000）
  recvBufferSize?: number; // 受信バッファサイズ（バイト、デフォルト: 65536）
  maxQueryLength?: number; // クエリ式の最大文字数（デフォルト: 128）
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
  filters?: Record<string, string>;  // フィルタ条件（カラム: 値）
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

### InputValidationError

クエリやフィルタ値に改行などの制御文字が含まれている場合や、`ClientConfig.maxQueryLength`
で設定した上限を超える長さのクエリ式を送信しようとした場合に発生するクライアント側のエラーです。
入力内容を見直すか、意図的に長いクエリが必要な場合は上限値を調整してください。
```

### ServerInfo

```typescript
interface ServerInfo {
  version: string;      // サーバーバージョン
  uptimeSeconds: number;// サーバー稼働時間（秒）
  docCount: number;     // 総ドキュメント数
  tables: string[];     // テーブル名のリスト
}
```

### ReplicationStatus

```typescript
interface ReplicationStatus {
  running: boolean;     // レプリケーションが実行中かどうか
  gtid: string;         // 現在のGTID位置
  lagSeconds: number;   // レプリケーション遅延（秒）
}
```

### DebugInfo

```typescript
interface DebugInfo {
  queryTimeMs: number;  // クエリ実行時間（ミリ秒）
  indexTimeMs: number;  // インデックス検索時間（ミリ秒）
  candidates: number;   // 候補ドキュメント数
  final: number;        // 最終結果数
}
```

## エラー型

### MygramError

すべてのmygram-clientエラーの基底エラークラスです。

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
