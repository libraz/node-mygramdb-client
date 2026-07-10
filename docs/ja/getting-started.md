# mygramdb-client の始め方

このガイドでは、Node.js 用の mygramdb-client ライブラリの使い方を説明します。

## 前提条件

- Node.js 22.0.0 以上
- Yarn 4.x（Volta で管理）
- 動作中の MygramDB サーバー

## インストール

### Yarn を使用（推奨）

```bash
yarn add mygramdb-client
```

### npm を使用

```bash
npm install mygramdb-client
```

## 基本設定

### 1. クライアントをインポート

```typescript
import { MygramClient } from 'mygramdb-client';
```

### 2. クライアントインスタンスを作成

```typescript
const client = new MygramClient({
  host: 'localhost',
  port: 11016,
  timeout: 5000,
});
```

### 3. サーバーに接続

```typescript
await client.connect();
```

### 4. 操作を実行

```typescript
// ドキュメントを検索
const results = await client.search('articles', 'hello world');
console.log(`${results.totalCount} 件の結果が見つかりました`);

// マッチするドキュメントをカウント
const count = await client.count('articles', 'technology');
console.log(`合計マッチ数: ${count.count}`);

// ID でドキュメントを取得
const doc = await client.get('articles', '12345');
console.log(doc);
```

### 5. 切断

```typescript
await client.disconnect();
```

## 完全な例

```typescript
import { MygramClient } from 'mygramdb-client';

async function main() {
  const client = new MygramClient({
    host: 'localhost',
    port: 11016,
    timeout: 5000,
  });

  try {
    await client.connect();
    console.log('MygramDB に接続しました');

    // 検索を実行
    const results = await client.search('articles', 'golang tutorial', {
      limit: 10,
      sortColumn: 'created_at',
      sortDesc: true,
    });

    console.log(`${results.totalCount} 件の結果が見つかりました`);
    results.results.forEach((result) => {
      console.log(`- ${result.primaryKey}`);
    });
  } catch (error) {
    console.error('エラー:', error);
  } finally {
    client.disconnect();
  }
}

main();
```

## 設定オプション

`MygramClient` コンストラクタは、以下のオプションを持つ設定オブジェクトを受け取ります：

| オプション | 型 | デフォルト | 説明 |
|--------|------|---------|-------------|
| `host` | string | `'127.0.0.1'` | サーバーホスト名または IP アドレス |
| `port` | number | `11016` | サーバーポート番号 |
| `timeout` | number | `5000` | 接続タイムアウト（ミリ秒） |
| `recvBufferSize` | number | `65536` | 受信バッファサイズ（バイト） |

### カスタム設定の例

```typescript
const client = new MygramClient({
  host: '192.168.1.100',
  port: 11016,
  timeout: 10000,
  recvBufferSize: 131072,
});
```

## エラーハンドリング

ライブラリは、さまざまな失敗シナリオに対して特定のエラータイプを提供します：

```typescript
import { MygramClient, ConnectionError, ProtocolError, TimeoutError } from 'mygramdb-client';

try {
  await client.connect();
  const results = await client.search('articles', 'test');
} catch (error) {
  if (error instanceof ConnectionError) {
    console.error('サーバーへの接続に失敗しました:', error.message);
  } else if (error instanceof ProtocolError) {
    console.error('サーバーがエラーを返しました:', error.message);
  } else if (error instanceof TimeoutError) {
    console.error('リクエストがタイムアウトしました:', error.message);
  } else {
    console.error('予期しないエラー:', error);
  }
}
```

## 次のステップ

- すべてのメソッドの詳細なドキュメントについては [API リファレンス](./api-reference.md) を参照してください
- 高度な検索クエリについては [検索式](./search-expression.md) を学んでください
- コネクションプーリングとバッチ操作については [高度な使い方](./advanced-usage.md) を参照してください

## TypeScript サポート

このライブラリは TypeScript で書かれており、完全な型定義を提供します。TypeScript ユーザーは自動的に型チェックと IntelliSense サポートを利用できます：

```typescript
import type { ClientConfig, SearchResponse, SearchOptions } from 'mygramdb-client';

const config: ClientConfig = {
  host: 'localhost',
  port: 11016,
  maxQueryLength: 256,
};

const options: SearchOptions = {
  limit: 100,
  sortColumn: 'created_at',
  sortDesc: true,
};

const results: SearchResponse = await client.search('articles', 'test', options);
```

## トラブルシューティング

### 接続拒否

接続拒否エラーが発生した場合は、以下を確認してください：
- MygramDB サーバーが実行中である
- ホストとポートが正しい
- ファイアウォールが接続をブロックしていない

### タイムアウトエラー

リクエストがタイムアウトする場合：
- 設定で `timeout` 値を増やす
- サーバーのパフォーマンスと負荷を確認
- ネットワーク接続を確認

### プロトコルエラー

プロトコルエラーが発生した場合：
- 互換性のある MygramDB バージョンを使用していることを確認
- サーバーログでエラーの詳細を確認
- テーブル名とクエリ構文が正しいことを確認

### 入力検証エラー

`InputValidationError` が発生した場合は、クエリやフィルタ値に改行などの制御文字が含まれていないか、
あるいはクエリ式が長すぎないかを確認してください。正当な理由で長いクエリが必要な場合は、
クライアントの `ClientConfig.maxQueryLength` とサーバー側の `api.max_query_length` を増やしてください。
