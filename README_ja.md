# mygramdb-client

[![CI](https://img.shields.io/github/actions/workflow/status/libraz/node-mygramdb-client/ci.yml?branch=main&label=CI)](https://github.com/libraz/node-mygramdb-client/actions)
[![npm](https://img.shields.io/npm/v/mygramdb-client)](https://www.npmjs.com/package/mygramdb-client)
[![codecov](https://codecov.io/gh/libraz/node-mygramdb-client/branch/main/graph/badge.svg)](https://codecov.io/gh/libraz/node-mygramdb-client)
[![License](https://img.shields.io/github/license/libraz/node-mygramdb-client)](https://github.com/libraz/node-mygramdb-client/blob/main/LICENSE)

[MygramDB](https://github.com/libraz/mygram-db/) 用の Node.js クライアントライブラリ — MySQL レプリケーション対応の高性能インメモリ全文検索エンジン。

MygramDB v1.10.2 までに追従（型付きエラーコード、管理コマンドの `AUTH`、`INFO` のレディネス、ブールクエリモード、比較フィルタ、ファセットのページネーション）。v1.6 以降のサーバーとの互換性も維持しています。

## 概要

MygramDB は、ディスク上の MySQL FULLTEXT インデックスではなくメモリから全文検索に応答します。どれだけ速くなるかはクエリとデータセット次第で、実測値と測定条件は[公開ベンチマーク](https://mygramdb.libraz.net/ja/benchmarks)に載せています。本クライアントは純粋な JavaScript 実装に加え、オプションの C++ ネイティブバインディングもサポートしています。

| | MySQL FULLTEXT | MygramDB |
|---|---|---|
| **検索速度** | ベースライン | [実測値](https://mygramdb.libraz.net/ja/benchmarks) |
| **ストレージ** | ディスク | インメモリ |
| **レプリケーション** | — | MySQL binlog |
| **プロトコル** | MySQL | TCP (memcached 形式) |

### 特徴

- **デュアル実装** — オプションの C++ ネイティブバインディング（JavaScript 自動フォールバック）
- **検索式パーサー** — Web スタイルの検索構文（+必須、-除外、"フレーズ"、OR、グループ化）
- **完全なプロトコルサポート** — すべての MygramDB コマンド（SEARCH、COUNT、GET、INFO など）
- **コネクションプール** — 秒間数百リクエスト向けの組み込み `MygramPool`。バックプレッシャ、ロードシェディング、自己回復する再接続、任意のサーキットブレーカを備える
- **レジリエンス** — プールのサーキットブレーカ（サーバー到達不能時に fail-fast）と単体クライアントの `autoReconnect`
- **型安全性** — 完全な TypeScript 型定義
- **Promise ベース API** — モダンな async/await インターフェース

## インストール

```bash
npm install mygramdb-client
```

yarn/pnpm の場合:
```bash
yarn add mygramdb-client
pnpm add mygramdb-client
```

## クイックスタート

```typescript
import { createMygramClient, simplifySearchExpression } from 'mygramdb-client';

const client = createMygramClient({
  host: 'localhost',
  port: 11016
});

await client.connect();

// 検索
const results = await client.search('articles', 'hello');
console.log(`${results.totalCount} 件の結果`);

// カウント
const count = await client.count('articles', 'technology');

// ID でドキュメントを取得
const doc = await client.get('articles', '12345');

client.disconnect();
```

### コネクションプーリング

1つのクライアントはすべてのコマンドを1本のソケットで直列化します。高スループット（秒間数百リクエスト）には組み込みの `MygramPool` を使います。バックプレッシャと自己回復する再接続を備え、リクエストをN本の接続へ分散します。

```typescript
import { MygramPool } from 'mygramdb-client';

const pool = new MygramPool({ connection: { host: 'localhost' }, size: 12 });
await pool.start(); // 任意のウォームアップ。最初のクエリで遅延起動もされる

const results = await pool.search('articles', 'hello', { limit: 100 });
console.log(pool.metrics());

await pool.close();
```

`circuitBreaker` を設定すると、サーバー到達不能時にプールが `CircuitOpenError` で即座に失敗します。`onEvent` で個別のライフサイクルイベントを受け取れます。単体の `MygramClient` では `autoReconnect` を設定すると、書き込み前に死んだソケットを検出したときに1回だけ再接続して再送します。サイジングの指針は[コネクションプーリング](docs/ja/advanced-usage.md#コネクションプーリング)を、レジリエンス機能は[サーキットブレーカ](docs/ja/advanced-usage.md#サーキットブレーカ)を参照してください。

## 検索式

Web スタイルの検索クエリを構造化された検索パラメータにパースします:

```typescript
import { simplifySearchExpression } from 'mygramdb-client';

// スペース = AND、- = NOT、"" = フレーズ、OR = OR、() = グループ化
const expr = simplifySearchExpression('hello world -spam');
// → { mainTerm: 'hello', andTerms: ['world'], notTerms: ['spam'] }

const results = await client.search('articles', expr.mainTerm, {
  andTerms: expr.andTerms,
  notTerms: expr.notTerms,
  limit: 100,
  offset: 50,
  filters: { status: 'published', lang: 'ja' },
  sortColumn: 'created_at',
  sortDesc: true
});
```

## MygramDB v1.6 の機能

### BM25 関連度スコアリング

特殊なソートカラム名 `_score` を指定すると関連度順でソートできます
（サーバー側で `verify_text: ascii|all` の設定が必要）:

```typescript
const results = await client.search('articles', 'machine learning', {
  sortColumn: '_score',
  sortDesc: true,
  limit: 10
});
```

### あいまい検索（Levenshtein）

```typescript
// 編集距離 1（デフォルト）または 2 を許容
const results = await client.search('articles', 'machne', {
  fuzzy: 1,
  limit: 10
});
```

### ハイライト

```typescript
const results = await client.search('articles', 'golang', {
  highlight: {
    openTag: '<strong>',
    closeTag: '</strong>',
    snippetLen: 200,
    maxFragments: 3
  },
  sortColumn: '_score',
  sortDesc: true,
  limit: 10
});

for (const r of results.results) {
  console.log(r.primaryKey, r.snippet);
}
```

`{}` を渡すとサーバーのデフォルト設定（`<em>`/`</em>`、100 コードポイント、
最大 3 フラグメント）でハイライトされます。

### ファセット

フィルタ列の値と件数を集計します。検索結果の範囲に絞り込むことも可能です:

```typescript
// テーブル全体での値分布:
const all = await client.facet('articles', 'status');

// "machine learning" にマッチするドキュメント内のカテゴリ上位:
const top = await client.facet('articles', 'category', {
  query: 'machine learning',
  filters: { status: '1' },
  limit: 10
});

for (const v of top.results) {
  console.log(`${v.value}: ${v.count}`);
}
```

## MygramDB v1.7 の機能

### マルチデータベース（修飾テーブル識別子）

v1.7+ のインスタンスは複数のデータベースのテーブルをインデックスできます。
テーブルは `database.table` 形式で参照します。単一データベースのサーバーでは
従来どおり bare な名前も使用できます。

```typescript
await client.search('app_db.articles', 'hello');

import { qualifyTableIdentity, parseTableIdentity } from 'mygramdb-client';
qualifyTableIdentity('articles', 'app_db'); // 'app_db.articles'
parseTableIdentity('app_db.articles');      // { database: 'app_db', table: 'articles' }
```

### ブール検索

`search()` はクエリを1つの（自動クォートされた）トークンとして送信します。
ブール（`AND`/`OR`/`NOT`/グループ化）には式を組み立てて `searchRaw()` に渡します:

```typescript
import { convertSearchExpression } from 'mygramdb-client';

const raw = convertSearchExpression('python OR (ruby AND rails)');
const res = await client.searchRaw('articles', raw, { limit: 50 });
```

`searchRaw()` は式をそのまま（クォートせず）送信するため、サーバーのブールパーサーが `AND`/`OR`/`NOT`/グループ化を解釈します。これらのキーワードを含むクォート済みフレーズはリテラルとして扱われます（MygramDB v1.8+）。

### ランタイム変数とオンデマンド SYNC

```typescript
await client.setVariable('logging.level', 'info');
console.log(await client.showVariables('logging%'));

await client.sync('app_db.articles');
console.log(await client.syncStatus());
await client.syncStop('app_db.articles');
```

## MygramDB v1.9 の機能

### 型付き句と組み合わせるブールクエリモード

`searchRaw()` は式だけを送ります。式にフィルタ・ソート・あいまい検索・ハイライトを組み合わせたい場合は、`search()` に `queryMode: 'boolean'` を渡します。既定は `literal` のままなので、通常のユーザー入力はこれまでどおりフレーズとしてマッチします。

```typescript
await client.search('articles', 'alpha AND (xqz OR jkv)', {
  queryMode: 'boolean',
  filters: { status: 'published' },
  sortColumn: '_score'
});
```

### 比較フィルタ

フィルタは `=`・`!=`・`<>`・`>`・`>=`・`<`・`<=` を受け付けます。1つのカラムに2つの条件が必要な場合は配列形式を使います。

```typescript
await client.search('products', 'laptop', {
  filters: [
    { column: 'price', op: '>=', value: '100' },
    { column: 'price', op: '<=', value: '500' }
  ]
});
```

### ファセットのページネーション

```typescript
const page = await client.facet('articles', 'category', { limit: 20, offset: 40 });
console.log(`${page.totalCount} カテゴリ中 ${page.results.length} 件`);
```

## MygramDB v1.10 の機能

### 管理コマンドの認証

v1.10 のサーバーは管理コマンド（`DUMP *`・`REPLICATION *`・`SYNC *`・`CONFIG *`・`OPTIMIZE`・`DEBUG *`・`CACHE *`・`SET`・`SHOW VARIABLES`）を `AUTH` の背後に置きます。`adminToken` を設定すれば、再接続やプールの各接続も含め、接続のたびにクライアントが認証します。

```typescript
const client = new MygramClient({ adminToken: process.env.MYGRAM_ADMIN_TOKEN });
await client.connect();
await client.dumpSave('/var/lib/mygramdb/dump.mgd');
```

通常の検索トラフィックにトークンは不要です。

### 型付きエラーコード

`ERROR` フレームが数値コードを持つようになり、メッセージ文字列を照合せずに失敗を分類できます。サーバー側の拒否は `ProtocolError` のサブクラスである `ServerError` として届きます。

```typescript
import { ErrorCode, ServerError, isRetryableErrorCode } from 'mygramdb-client';

try {
  await client.search('articles', 'hello');
} catch (error) {
  if (error instanceof ServerError && isRetryableErrorCode(error.code)) {
    // 6028 ロード中 / 6029 未レディ / 6030 ビジー — バックオフしてリトライ
  }
}
```

### INFO のレディネス

```typescript
const info = await client.info();
if (info.ready === false) {
  // サーバーは起動しているが、まだクエリを処理できる状態ではない
}
```

### レプリケーション遅延と操作ごとのデッドライン

`getReplicationStatus()` は `secondsSinceLastApplied` を返します。これはレプリ
ケーション位置が進んだ地点で記録されるため、単なる疎通ではなく実際の進捗を表し
ます。これは管理コマンドなので、トークンを設定した v1.10 サーバーから取得するには
`adminToken` が必要です（`INFO` のレディネス項目とは異なります）。ダンプと
`OPTIMIZE` は専用のデッドラインを持つので、`timeout` は停止したクエリを検知できる
短さのまま維持できます。

```typescript
const client = new MygramClient({ timeout: 3000, dumpSaveTimeout: 900_000 });

const status = await client.getReplicationStatus();
if ((status.secondsSinceLastApplied ?? 0) > 60) {
  console.warn(`レプリケーションが ${status.secondsSinceLastApplied} 秒遅延しています`, status.lastError);
}
```

## MygramDB v1.10.2 の機能

v1.10.2 のサーバーは、クライアントとサーバーで値の意味の解釈が食い違っていた箇所をいくつか修正しました。このクライアントはそのすべてに追従しています。

### ワイヤーに乗るすべての文字列が同じクォート規則に従う

検索語、フィルタ値、`AND`/`NOT` の項、ハイライトタグ、プライマリキー、コマンド引数はすべて同じクォート判定を通ります。値が空、予約済みの句キーワード（`AND`・`OR`・`NOT`・`FILTER`・`SORT`・`LIMIT`・`OFFSET`・`HIGHLIGHT`・`FUZZY`・`FACET`・`ORDER` — 大文字小文字を区別せず照合）、ASCII またはUnicodeの空白（貼り付けた値や全角IMEが含みうる全角スペースやノーブレークスペースを含む）、制御文字、クォート、バックスラッシュ、括弧のいずれかを含む場合にクォートされます。呼び出し側は常に生のクォートなしテキストを渡すだけで、必要に応じてクライアントがクォートします。

```typescript
// 全角スペースが意図しない2つの項に分割されなくなりました。
await client.search('articles', '機械学習　チュートリアル');

// 予約キーワードと一致するフィルタ値もリテラルとして一致します。
await client.search('articles', 'q', { filters: { status: 'AND' } });
```

### クォートされたプライマリキー

`get()` は空白や予約語を含むプライマリキーを拒否せずにクォートするようになりました — キーは識別子ではなくデータなので、`search()` が返したキーはそのまま `get()` に渡せます。検索結果と `get()` のドキュメントは、サーバーがクォートしたプライマリキーや文字列値を同じ規則でデコードします。

### IPv6 サーバー

IPv6 リテラル、または `AAAA` レコードにのみ解決されるホスト名でしか到達できないサーバーにも接続できるようになりました。クライアントはホスト名が解決するすべてのアドレスを順に試します。

### マルチライン応答を最後まで読み切る

`HIGHLIGHT` の行や `DEBUG` ブロックを伴う `SEARCH`/`COUNT` の応答、および空でない `SHOW VARIABLES` のテーブルは、チャンクの境界がヘッダー行の直後に来た場合でも最後まで読み切られるようになりました。以前はヘッダー行だけで完了した応答に見えてしまい、残りが切り捨てられていました。

### `simplifySearchExpression()` が OR / グルーピングを拒否する

`simplifySearchExpression()` と `parseSearchExpressionNative()` は、OR やグルーピングを含む式を単一の `mainTerm` として括弧で暗黙的に包むのではなく、例外を投げるようになりました。その合成された項はその後 `search()` 自身のエスケープで再クォートされ、`(python OR ruby)` はブールの OR ではなく1つの不透明なリテラルフレーズになってしまっていました。OR やグルーピングを含みうる式には `convertSearchExpression()` と `searchRaw()` を使ってください。

```typescript
import { convertSearchExpression, hasComplexExpression, parseSearchExpression } from 'mygramdb-client';

const parsed = parseSearchExpression(userInput);
let results;
if (hasComplexExpression(parsed)) {
  // ブール式なのでそのまま送信する。search() は自身のクエリをリテラルテキストとしてクォートしてしまうため。
  results = await client.searchRaw('articles', convertSearchExpression(userInput));
} else {
  const { mainTerm, andTerms, notTerms } = simplifySearchExpression(userInput);
  results = await client.search('articles', mainTerm, { andTerms, notTerms });
}
```

## TypeScript

完全な型定義を同梱しています:

```typescript
import type {
  ClientConfig,
  SearchResponse,
  CountResponse,
  Document,
  ServerInfo,
  SearchOptions
} from 'mygramdb-client';
```

## 開発

```bash
yarn install      # 依存関係をインストール
yarn build        # ライブラリをビルド
yarn test         # テストを実行
yarn lint         # リント・フォーマットチェック
yarn lint:fix     # リント・フォーマットを自動修正
```

## ライセンス

[MIT](LICENSE)
