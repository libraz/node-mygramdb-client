# 検索式パーサー

mygram-clientライブラリには、Web形式の検索構文をMygramDBクエリに変換する強力な検索式パーサーが含まれています。

## 概要

このパーサーを使用すると、ユーザーはGoogle検索のような馴染みのある構文を使用して直感的な検索クエリを記述できます。必須用語、除外用語、OR演算子、グループ化がサポートされています。

## 構文

### 基本構文

| 構文 | 説明 | 例 |
|--------|-------------|---------|
| `+term` | 必須用語(必ず出現する) | `+golang` |
| `-term` | 除外用語(出現してはいけない) | `-deprecated` |
| `term1 term2` | 複数の用語(暗黙のAND) | `golang tutorial` |
| `"phrase"` | 引用句(完全一致) | `"hello world"` |
| `(expr)` | グループ化 | `(python OR ruby)` |
| `term1 OR term2` | 論理OR | `golang OR rust` |

### 構文の組み合わせ

異なる構文要素を組み合わせて、複雑なクエリを作成できます:

```typescript
+golang +(tutorial OR guide) -deprecated "best practices"
```

この検索は以下の条件を満たすドキュメントを検索します:
- 「golang」を必ず含む
- 「tutorial」または「guide」のいずれかを必ず含む
- 「deprecated」を含まない
- 「best practices」というフレーズを含むべき

## 関数

### parseSearchExpression()

```typescript
function parseSearchExpression(expression: string): SearchExpression
```

Web形式の検索式を構造化された形式に解析します。

**パラメータ:**
- `expression` (string) - Web形式の検索式

**戻り値:** SearchExpressionオブジェクト

**例外:** 式が無効な場合はErrorをスロー

**例:**
```typescript
import { parseSearchExpression } from 'mygram-client';

const parsed = parseSearchExpression('+golang -old (tutorial OR guide)');
console.log(parsed);
// {
//   requiredTerms: ['golang'],
//   excludedTerms: ['old'],
//   optionalTerms: [],
//   orGroups: [['tutorial', 'guide']]
// }
```

### convertSearchExpression()

```typescript
function convertSearchExpression(expression: string): string
```

Web形式の検索式をMygramDBクエリ形式に変換します。

**パラメータ:**
- `expression` (string) - Web形式の検索式

**戻り値:** MygramDBクエリ文字列

**例:**
```typescript
import { convertSearchExpression } from 'mygram-client';

convertSearchExpression('golang tutorial');
// 戻り値: 'golang OR tutorial'

convertSearchExpression('+golang +tutorial');
// 戻り値: 'golang AND tutorial'

convertSearchExpression('+golang -old');
// 戻り値: 'golang AND NOT old'

convertSearchExpression('python OR ruby');
// 戻り値: 'python OR ruby'

convertSearchExpression('+golang +(tutorial OR guide)');
// 戻り値: '+golang +(tutorial OR guide)'
```

### simplifySearchExpression()

```typescript
function simplifySearchExpression(expression: string): {
  mainTerm: string;
  andTerms: string[];
  notTerms: string[];
}
```

検索式をクライアントの検索オプションで使用できる基本的な用語に簡素化します。

**パラメータ:**
- `expression` (string) - Web形式の検索式

**戻り値:** mainTerm、andTerms、notTermsを含むオブジェクト

**例:**
```typescript
import { simplifySearchExpression } from 'mygram-client';

const { mainTerm, andTerms, notTerms } = simplifySearchExpression('+golang tutorial -old -deprecated');
console.log(mainTerm);  // 'golang'
console.log(andTerms);  // ['tutorial']
console.log(notTerms);  // ['old', 'deprecated']
```

### hasComplexExpression()

```typescript
function hasComplexExpression(expression: string): boolean
```

式に簡素化できない複雑な構文(OR、グループ化)が含まれているかどうかをチェックします。

**パラメータ:**
- `expression` (string) - Web形式の検索式

**戻り値:** 複雑な場合は`true`、単純な場合は`false`

**例:**
```typescript
import { hasComplexExpression } from 'mygram-client';

hasComplexExpression('+golang tutorial -old');
// 戻り値: false (単純な式)

hasComplexExpression('golang OR rust');
// 戻り値: true (OR演算子あり)

hasComplexExpression('+(tutorial OR guide)');
// 戻り値: true (グループ化あり)
```

## クライアントでの使用方法

### 単純な式

OR演算子やグループ化を含まない単純な式の場合、`simplifySearchExpression()`を使用して用語を抽出します:

```typescript
import { MygramClient, simplifySearchExpression } from 'mygram-client';

const client = new MygramClient();
await client.connect();

// ユーザー入力を解析
const userInput = '+golang tutorial -deprecated';
const { mainTerm, andTerms, notTerms } = simplifySearchExpression(userInput);

// クライアントで使用
const results = await client.search('articles', mainTerm, {
  andTerms,
  notTerms,
  limit: 50,
});
```

### 複雑な式

OR演算子やグループ化を含む複雑な式の場合、MygramDB形式に変換します:

```typescript
import { MygramClient, convertSearchExpression, hasComplexExpression } from 'mygram-client';

const client = new MygramClient();
await client.connect();

const userInput = '+golang +(tutorial OR guide) -old';

if (hasComplexExpression(userInput)) {
  // 変換されたクエリを直接使用
  const query = convertSearchExpression(userInput);
  const results = await client.search('articles', query);
} else {
  // 簡素化された用語を使用
  const { mainTerm, andTerms, notTerms } = simplifySearchExpression(userInput);
  const results = await client.search('articles', mainTerm, {
    andTerms,
    notTerms,
  });
}
```

### 自動検出

式のタイプを自動的に検出するヘルパー関数を作成します:

```typescript
import {
  MygramClient,
  convertSearchExpression,
  simplifySearchExpression,
  hasComplexExpression,
  SearchOptions,
} from 'mygram-client';

async function smartSearch(
  client: MygramClient,
  table: string,
  expression: string,
  options: SearchOptions = {}
) {
  if (hasComplexExpression(expression)) {
    // 複雑な式: 変換して検索
    const query = convertSearchExpression(expression);
    return client.search(table, query, options);
  }

  // 単純な式: 用語を抽出してオプションを使用
  const { mainTerm, andTerms, notTerms } = simplifySearchExpression(expression);
  return client.search(table, mainTerm, {
    ...options,
    andTerms: [...(options.andTerms || []), ...andTerms],
    notTerms: [...(options.notTerms || []), ...notTerms],
  });
}

// 使用例
const results = await smartSearch(client, 'articles', '+golang +(tutorial OR guide) -old', {
  limit: 50,
  sortColumn: 'created_at',
  sortDesc: true,
});
```

## 例

### 例1: 単純なANDクエリ

```typescript
const expression = '+golang +tutorial +beginner';
const { mainTerm, andTerms, notTerms } = simplifySearchExpression(expression);

// mainTerm: 'golang'
// andTerms: ['tutorial', 'beginner']
// notTerms: []

const results = await client.search('articles', mainTerm, { andTerms, notTerms });
```

### 例2: 除外クエリ

```typescript
const expression = 'golang -advanced -deprecated';
const { mainTerm, andTerms, notTerms } = simplifySearchExpression(expression);

// mainTerm: 'golang'
// andTerms: []
// notTerms: ['advanced', 'deprecated']

const results = await client.search('articles', mainTerm, { andTerms, notTerms });
```

### 例3: ORクエリ

```typescript
const expression = 'python OR ruby OR javascript';
const query = convertSearchExpression(expression);

// query: 'python OR ruby OR javascript'

const results = await client.search('articles', query);
```

### 例4: 複雑なクエリ

```typescript
const expression = '+backend +(golang OR rust) -php "best practices"';
const query = convertSearchExpression(expression);

// query: '+backend +(golang OR rust) -php "best practices"'

const results = await client.search('articles', query);
```

### 例5: フレーズ検索

```typescript
const expression = '"hello world" +golang';
const { mainTerm, andTerms, notTerms } = simplifySearchExpression(expression);

// mainTerm: 'hello world'
// andTerms: ['golang']
// notTerms: []

const results = await client.search('articles', mainTerm, { andTerms, notTerms });
```

## 型定義

### SearchExpression

```typescript
interface SearchExpression {
  requiredTerms: string[];   // +でマークされた用語
  excludedTerms: string[];   // -でマークされた用語
  optionalTerms: string[];   // プレフィックスのない用語
  orGroups: string[][];      // OR用語のグループ
}
```

## 実装の詳細

### 解析プロセス

1. **トークン化**: 式をトークン(用語、演算子、括弧)に分割
2. **正規化**: 全角スペースと文字をASCIIに正規化
3. **分類**: トークンを必須(+)、除外(-)、または任意として分類
4. **グループ化**: 括弧を解析してORグループを識別
5. **変換**: 解析された式をMygramDBクエリ形式に変換

### 制限事項

- ネストされた括弧は妥当な深さまでサポート
- 引用句は適切に閉じる必要がある
- OR演算子は両側にオペランドが必要
- 空の式やグループは許可されない

### エラーハンドリング

以下の場合、パーサーはエラーをスローします:
- 括弧のバランスが取れていない
- 引用符が閉じられていない
- OR演算子が誤って使用されている
- 式が空または無効

```typescript
import { parseSearchExpression } from 'mygram-client';

try {
  const parsed = parseSearchExpression('(unbalanced');
} catch (error) {
  console.error('Parse error:', error.message);
}
```

## ベストプラクティス

1. **ユーザー入力の検証**: 解析前に必ずユーザー入力を検証する
2. **適切なメソッドの使用**: 複雑さに応じて`simplifySearchExpression()`と`convertSearchExpression()`を使い分ける
3. **エラー処理**: 解析呼び出しをtry-catchブロックでラップする
4. **フィードバックの提供**: 検索で使用されている用語をユーザーに表示する
5. **エッジケースのテスト**: 空文字列、特殊文字、不正な入力でテストする

## パフォーマンスに関する考慮事項

- 単純な式(OR/グループ化なし)は`simplifySearchExpression()`を使用する方が効率的
- 複雑な式は完全なクエリ解析が必要で、処理が遅くなる可能性がある
- パーサーは軽量でリアルタイムのユーザー入力に適している
- バルク操作の場合、解析された式のキャッシュを検討する

## 高度なクエリ機能

### FILTER構文

MygramDBはフィールド値による結果のフィルタリングをサポートしています。各フィルタは独立した`FILTER`句として送信されます:

```typescript
const results = await client.search('articles', 'golang', {
  filters: {
    status: 'published',
    category: 'programming',
    lang: 'ja'
  }
});

// 生成されるコマンド:
// SEARCH articles golang FILTER status = published FILTER category = programming FILTER lang = ja
```

**重要**:

- 各フィルタのキー・バリューペアは独立した`FILTER key = value`句を生成します
- 複数のフィルタは`AND`で結合されず、独立した句として扱われます
- クライアントはC++クライアントとの一貫性と可読性のため3トークン形式(`FILTER key = value`)を使用します
- サーバーはコンパクト形式(`FILTER key=value`)もサポートしていますが、3トークン形式が推奨されます

### MySQL互換LIMIT構文

MygramDBはMySQL形式の`LIMIT offset,count`構文をサポートしています:

```typescript
// offsetとlimitを別々に指定する標準形式
const results = await client.search('articles', 'golang', {
  limit: 50,    // 取得する結果の数
  offset: 100   // 最初の100件をスキップ
});

// 生成されるコマンド: LIMIT 100,50 (MySQL互換形式)
```

**形式**:

- `LIMIT count` - offsetが0または未指定の場合
- `LIMIT offset,count` - offsetとlimitの両方が指定されている場合
- 未指定の場合のデフォルトlimitは1000

### SORT構文

ソートには`SORT`コマンドを使用します(`ORDER BY`ではありません):

```typescript
const results = await client.search('articles', 'golang', {
  sortColumn: 'created_at',
  sortDesc: false  // 昇順
});

// 生成されるコマンド: SORT created_at ASC
```

**オプション**:

- `sortColumn` - ソートするカラム名(空の場合は主キー)
- `sortDesc` - `true`でDESC(デフォルト)、`false`でASC

### 高度なクエリの組み合わせ

```typescript
const results = await client.search('articles', 'hello world', {
  andTerms: ['programming'],
  notTerms: ['deprecated'],
  filters: {
    status: 'published',
    lang: 'ja'
  },
  sortColumn: 'score',
  sortDesc: true,
  limit: 20,
  offset: 40
});

// 生成されるコマンド:
// SEARCH articles hello world AND programming NOT deprecated
// FILTER status = published FILTER lang = ja
// SORT score DESC LIMIT 40,20
```
