# mygramdb-client

[![CI](https://img.shields.io/github/actions/workflow/status/libraz/node-mygramdb-client/ci.yml?branch=main&label=CI)](https://github.com/libraz/node-mygramdb-client/actions)
[![npm](https://img.shields.io/npm/v/mygramdb-client)](https://www.npmjs.com/package/mygramdb-client)
[![codecov](https://codecov.io/gh/libraz/node-mygramdb-client/branch/main/graph/badge.svg)](https://codecov.io/gh/libraz/node-mygramdb-client)
[![License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/libraz/node-mygramdb-client/blob/main/LICENSE)

[MygramDB](https://github.com/libraz/mygram-db/) 用の Node.js クライアントライブラリです。MygramDB は MySQL レプリケーションに対応した高性能なインメモリ全文検索エンジンです。

**対応サーバー:** MygramDB 1.6 以降に対応し、1.10.2 までのプロトコルを実装しています。サーバーは自身より新しいオプションを拒否し、古いサーバーの `ERROR` には数値コードが付きません。新しいサーバーを必要とするオプションは [API リファレンス](https://github.com/libraz/node-mygramdb-client/blob/main/docs/ja/api-reference.md)に明記しています。

<img src="https://raw.githubusercontent.com/libraz/node-mygramdb-client/main/docs/images/request-path-ja.svg" alt="検索の呼び出しがアプリケーションからクライアントの検証とクォート処理を経て TCP で MygramDB サーバーに届き、応答がデコードされて戻る流れと、MySQL が binlog レプリケーションでサーバーを更新する関係を示した図です。" width="960">

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
- **コネクションプール** — 秒間数百リクエスト向けの組み込み `MygramPool`。バックプレッシャ、ロードシェディング、自己回復する再接続、任意のサーキットブレーカを備えます
- **レジリエンス** — プールのサーキットブレーカ（サーバー到達不能時に即座に失敗）と単体クライアントの `autoReconnect`
- **型付きエラー** — `ServerError` がサーバーの数値エラーコードを持つため、リトライ判定がメッセージ文字列に依存しません
- **IPv4 と IPv6** — IPv6 リテラルや `AAAA` レコードにのみ解決されるホスト名にも接続し、解決されたアドレスを順に試します
- **型安全性** — 完全な TypeScript 型定義
- **Promise ベース API** — async/await のインターフェース

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
import { createMygramClient } from 'mygramdb-client';

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

## コネクションプーリング

1 つのクライアントはすべてのコマンドを 1 本のソケットで直列化します。高スループット（秒間数百リクエスト）には組み込みの `MygramPool` を使います。バックプレッシャと自己回復する再接続を備え、リクエストを N 本の接続へ分散します。

```typescript
import { MygramPool } from 'mygramdb-client';

const pool = new MygramPool({ connection: { host: 'localhost' }, size: 12 });
await pool.start(); // 任意のウォームアップ。最初のクエリで遅延起動もされる

const results = await pool.search('articles', 'hello', { limit: 100 });
console.log(pool.metrics());

await pool.close();
```

`circuitBreaker` を設定すると、サーバー到達不能時にプールが `CircuitOpenError` で即座に失敗します。`onEvent` で個別のライフサイクルイベントを受け取れます。単体の `MygramClient` では `autoReconnect` を設定すると、書き込み前に切断済みのソケットを検出したときに 1 回だけ再接続して再送します。サイジングの指針は[コネクションプーリング](https://github.com/libraz/node-mygramdb-client/blob/main/docs/ja/advanced-usage.md#コネクションプーリング)を、レジリエンス機能は[サーキットブレーカ](https://github.com/libraz/node-mygramdb-client/blob/main/docs/ja/advanced-usage.md#サーキットブレーカ)を参照してください。

## 検索式

`convertSearchExpression()` は Web 形式の入力をサーバーのブールクエリに変換します。接頭辞のない語と `+` の語は `AND` で結合され、`-` の語は `AND NOT` になり、OR の連なりは括弧で囲まれたまま残ります。

<img src="https://raw.githubusercontent.com/libraz/node-mygramdb-client/main/docs/images/search-expression-ja.svg" alt="Web 形式の入力 golang &quot;machine learning&quot; -php +(tutorial OR guide) を 4 つの項に分け、サーバーへ送るクエリ golang AND &quot;machine learning&quot; AND (tutorial OR guide) AND NOT php に組み立てる過程を示した図です。" width="960">

`search()` はクエリをリテラルテキストとして送るため、ブール式は `searchRaw()` で送ります。フィルタ、ソート、あいまい検索、ハイライトも組み合わせる場合は、`search()` に `queryMode: 'boolean'` を渡します。

```typescript
import { convertSearchExpression } from 'mygramdb-client';

const raw = convertSearchExpression('golang "machine learning" -php +(tutorial OR guide)');
// → 'golang AND "machine learning" AND (tutorial OR guide) AND NOT php'

const res = await client.searchRaw('articles', raw, { limit: 50 });

await client.search('articles', raw, {
  queryMode: 'boolean',
  filters: { status: 'published' },
  sortColumn: '_score'
});
```

既定の `literal` モードでは、通常のユーザー入力はフレーズとしてマッチします。OR やグループ化を含まない入力は、`simplifySearchExpression()` で主項と `AND`/`NOT` の項に分けて `search()` に渡せます。この関数は OR やグループ化を含む式では例外を投げるため、どちらかを含みうる入力は先に `hasComplexExpression()` で判定します。

```typescript
import {
  convertSearchExpression,
  hasComplexExpression,
  parseSearchExpression,
  simplifySearchExpression
} from 'mygramdb-client';

const parsed = parseSearchExpression(userInput);
let results;
if (hasComplexExpression(parsed)) {
  results = await client.searchRaw('articles', convertSearchExpression(userInput));
} else {
  const { mainTerm, andTerms, notTerms } = simplifySearchExpression(userInput);
  results = await client.search('articles', mainTerm, {
    andTerms,
    notTerms,
    limit: 100,
    filters: { status: 'published', lang: 'ja' },
    sortColumn: 'created_at',
    sortDesc: true
  });
}
```

## 検索機能

### BM25 関連度スコアリング

特殊なソートカラム名 `_score` を指定すると関連度順でソートできます（サーバー側で `verify_text: ascii|all` の設定が必要です）。

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

`{}` を渡すと、サーバーのデフォルト設定（`<em>`/`</em>`、100 コードポイント、最大 3 フラグメント）でハイライトされます。

### 比較フィルタ

フィルタは `=`・`!=`・`<>`・`>`・`>=`・`<`・`<=` を受け付けます。1 つのカラムに 2 つの条件が必要な場合は配列形式を使います。

```typescript
await client.search('products', 'laptop', {
  filters: [
    { column: 'price', op: '>=', value: '100' },
    { column: 'price', op: '<=', value: '500' }
  ]
});
```

### ファセット

フィルタ列の値ごとの件数を集計します。検索結果の範囲に絞り込むことも、`limit`/`offset` でページ送りすることもできます。

```typescript
// "machine learning" にマッチするドキュメント内のカテゴリ上位:
const top = await client.facet('articles', 'category', {
  query: 'machine learning',
  filters: { status: '1' },
  limit: 10
});

for (const v of top.results) {
  console.log(`${v.value}: ${v.count}`);
}

const page = await client.facet('articles', 'category', { limit: 20, offset: 40 });
console.log(`${page.totalCount} カテゴリ中 ${page.results.length} 件`);
```

### マルチデータベースのテーブル

サーバーは複数のデータベースのテーブルをインデックスできます。テーブルは `database.table` 形式で参照します。単一データベースのサーバーでは、データベース名を付けないテーブル名も使えます。

```typescript
await client.search('app_db.articles', 'hello');

import { qualifyTableIdentity, parseTableIdentity } from 'mygramdb-client';
qualifyTableIdentity('articles', 'app_db'); // 'app_db.articles'
parseTableIdentity('app_db.articles');      // { database: 'app_db', table: 'articles' }
```

## ワイヤー上のクォート

検索語、フィルタ値、`AND`/`NOT` の項、ハイライトタグ、プライマリキー、コマンド引数は、すべて同じクォート判定を通ります。次のいずれかに当てはまる値はクォートされます。

- 空文字列
- 予約済みの句キーワード（`AND`・`OR`・`NOT`・`FILTER`・`SORT`・`LIMIT`・`OFFSET`・`HIGHLIGHT`・`FUZZY`・`FACET`・`ORDER`。大文字小文字を区別せずに照合します）
- ASCII または Unicode の空白を含む値（貼り付けた値や全角 IME が含みうる全角スペースやノーブレークスペースも対象です）
- 制御文字、クォート、バックスラッシュ、括弧を含む値

呼び出し側は常にクォートなしの生のテキストを渡します。

```typescript
// 全角スペースは 1 つの項の中に残ります。
await client.search('articles', '機械学習　チュートリアル');

// 予約キーワードと一致するフィルタ値もリテラルとして一致します。
await client.search('articles', 'q', { filters: { status: 'AND' } });
```

`get()` は、空白を含むプライマリキーや予約語と一致するプライマリキーをクォートします。そのため、`search()` が返したキーは常にそのまま `get()` に渡せます。検索結果と `get()` のドキュメントは、サーバーがクォートしたプライマリキーや文字列値を同じ規則でデコードします。

## 認証とエラーコード

### 管理コマンドの認証

サーバーは管理コマンド（`DUMP *`・`REPLICATION *`・`SYNC *`・`CONFIG *`・`OPTIMIZE`・`DEBUG *`・`CACHE *`・`SET`・`SHOW VARIABLES`）の実行前に `AUTH` を要求します。`adminToken` を設定すると、再接続やプールの各接続も含め、接続のたびにクライアントが認証します。

```typescript
const client = new MygramClient({ adminToken: process.env.MYGRAM_ADMIN_TOKEN });
await client.connect();
await client.dumpSave('/var/lib/mygramdb/dump.mgd');
```

通常の検索トラフィックにトークンは不要です。

### 型付きエラーコード

`ERROR` フレームは数値コードを持つため、メッセージ文字列を照合せずに失敗を分類できます。サーバー側の拒否は、`ProtocolError` のサブクラスである `ServerError` として届きます。

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

### レディネス

```typescript
const info = await client.info();
if (info.ready === false) {
  // サーバーは起動しているが、まだクエリを処理できる状態ではない
}
```

## サーバー管理

### レプリケーション遅延と操作ごとのデッドライン

`getReplicationStatus()` は `secondsSinceLastApplied` を返します。この値はレプリケーション位置が進んだ時点で記録されるため、疎通ではなく実際の進捗を表します。`getReplicationStatus()` は管理コマンドなので、トークンを設定したサーバーから取得するには `adminToken` が必要です（`INFO` のレディネス項目は不要です）。ダンプと `OPTIMIZE` には専用のデッドラインがあるため、`timeout` は停止したクエリを検知できる短さに保てます。

```typescript
const client = new MygramClient({ timeout: 3000, dumpSaveTimeout: 900_000 });

const status = await client.getReplicationStatus();
if ((status.secondsSinceLastApplied ?? 0) > 60) {
  console.warn(`レプリケーションが ${status.secondsSinceLastApplied} 秒遅延しています`, status.lastError);
}
```

### ランタイム変数とオンデマンド SYNC

```typescript
await client.setVariable('logging.level', 'info');
console.log(await client.showVariables('logging%'));

await client.sync('app_db.articles');
console.log(await client.syncStatus());
await client.syncStop('app_db.articles');
```

## TypeScript

完全な型定義を同梱しています。

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

## ドキュメント

- [はじめに](https://github.com/libraz/node-mygramdb-client/blob/main/docs/ja/getting-started.md) — インストール、設定、エラー処理
- [検索式](https://github.com/libraz/node-mygramdb-client/blob/main/docs/ja/search-expression.md) — Web 形式の検索入力のパースと変換
- [API リファレンス](https://github.com/libraz/node-mygramdb-client/blob/main/docs/ja/api-reference.md) — すべてのメソッド、オプション、型
- [高度な使い方](https://github.com/libraz/node-mygramdb-client/blob/main/docs/ja/advanced-usage.md) — コネクションプーリング、レジリエンス、認証、エラーコード

## 開発

```bash
yarn install      # 依存関係をインストール
yarn build        # ライブラリをビルド
yarn test         # テストを実行
yarn lint         # リント・フォーマットチェック
yarn lint:fix     # リント・フォーマットを自動修正
```

## ライセンス

[MIT](https://github.com/libraz/node-mygramdb-client/blob/main/LICENSE)
