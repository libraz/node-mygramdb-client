# mygramdb-client

[![CI](https://img.shields.io/github/actions/workflow/status/libraz/node-mygramdb-client/ci.yml?branch=main&label=CI)](https://github.com/libraz/node-mygramdb-client/actions)
[![npm](https://img.shields.io/npm/v/mygramdb-client)](https://www.npmjs.com/package/mygramdb-client)
[![codecov](https://codecov.io/gh/libraz/node-mygramdb-client/branch/main/graph/badge.svg)](https://codecov.io/gh/libraz/node-mygramdb-client)
[![License](https://img.shields.io/github/license/libraz/node-mygramdb-client)](https://github.com/libraz/node-mygramdb-client/blob/main/LICENSE)

[MygramDB](https://github.com/libraz/mygram-db/) 用の Node.js クライアントライブラリ — MySQL レプリケーション対応の高性能インメモリ全文検索エンジン。

MygramDB v1.6 互換（BM25 スコアリング、HIGHLIGHT、FUZZY、FACET 対応）。

## 概要

MygramDB は MySQL FULLTEXT より **25〜200倍高速** な全文検索を提供します。本クライアントは純粋な JavaScript 実装に加え、オプションの C++ ネイティブバインディングもサポートしています。

| | MySQL FULLTEXT | MygramDB |
|---|---|---|
| **検索速度** | ベースライン | 25〜200倍高速 |
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
