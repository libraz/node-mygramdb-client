# mygramdb-client

[![npm version](https://img.shields.io/npm/v/mygramdb-client.svg)](https://www.npmjs.com/package/mygramdb-client)
[![CI](https://github.com/libraz/node-mygramdb-client/actions/workflows/ci.yml/badge.svg)](https://github.com/libraz/node-mygramdb-client/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[MygramDB](https://github.com/libraz/mygram-db/) 用の Node.js クライアントライブラリ - MySQL FULLTEXT の **25〜200倍高速** な高性能インメモリ全文検索エンジンで、MySQL レプリケーションをサポートしています。

## 特徴

- **デュアル実装** - オプションのC++ネイティブバインディング（JavaScript自動フォールバック）
- **完全なプロトコルサポート** - すべての MygramDB コマンド（SEARCH、COUNT、GET、INFO など）
- **検索式パーサー** - Web スタイルの検索構文（+必須、-除外、"フレーズ"、OR、グループ化）
- **型安全性** - 完全な TypeScript 型定義
- **Promise ベース API** - モダンな async/await インターフェース
- **コネクションプーリング対応** - コネクションプールとの統合が容易
- **デバッグモード** - クエリパフォーマンスメトリクスの組み込みサポート

## インストール

```bash
npm install mygramdb-client
# または
yarn add mygramdb-client
```

## クイックスタート

```typescript
import { createMygramClient, simplifySearchExpression } from 'mygramdb-client';

// ネイティブC++クライアントが利用可能なら使用、なければ純粋なJavaScript
const client = createMygramClient({
  host: 'localhost',
  port: 11016
});

await client.connect();

// Web スタイルの検索式をパース（スペース = AND、- = NOT）
const expr = simplifySearchExpression('hello world -spam');
// expr = { mainTerm: 'hello', andTerms: ['world'], notTerms: ['spam'] }

// AND/NOT 条件で検索
const results = await client.search('articles', expr.mainTerm, {
  andTerms: expr.andTerms,
  notTerms: expr.notTerms,
  limit: 100,
  offset: 50,  // MySQL互換: LIMIT 50,100
  filters: { status: 'published', lang: 'ja' },
  sortColumn: 'created_at',
  sortDesc: true
});

console.log(`${results.totalCount} 件の結果が見つかりました`);

// マッチするドキュメントをカウント
const count = await client.count('articles', 'technology');

// ID でドキュメントを取得
const doc = await client.get('articles', '12345');

client.disconnect();
```

## ドキュメント

- **[はじめに](docs/ja/getting-started.md)** - インストール、設定、基本的な使い方
- **[API リファレンス](docs/ja/api-reference.md)** - 完全な API ドキュメント
- **[検索式](docs/ja/search-expression.md)** - 高度な検索構文ガイド
- **[高度な使い方](docs/ja/advanced-usage.md)** - コネクションプーリング、エラーハンドリング、ベストプラクティス

## TypeScript サポート

このライブラリは TypeScript で書かれており、完全な型定義を提供します：

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

開発ガイドラインはこのリポジトリ内で確認できます。

```bash
# 依存関係をインストール
yarn install

# テストを実行
yarn test

# ライブラリをビルド
yarn build

# リントとフォーマット
yarn lint
yarn format
```

## ライセンス

MIT

## 作者

libraz <libraz@libraz.net>

## リンク

- [MygramDB](https://github.com/libraz/mygram-db/) - MygramDB サーバー
- [npm package](https://www.npmjs.com/package/mygramdb-client)

## コントリビューション

コントリビューションを歓迎します！お気軽に Pull Request を送信してください。
