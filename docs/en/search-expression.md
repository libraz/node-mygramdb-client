# Search Expression Parser

The mygram-client library includes a powerful search expression parser that converts web-style search syntax into MygramDB queries.

## Overview

The parser allows users to write intuitive search queries using familiar syntax like Google search, with support for required terms, excluded terms, OR operators, and grouping.

## Native Implementation

The parser has both JavaScript and C++ implementations. When you import from `client-factory`, the library automatically uses the native C++ implementation if available, falling back to JavaScript otherwise.

```typescript
import { simplifySearchExpression } from 'mygramdb-client';

// Uses native C++ if available, otherwise JavaScript
const expr = simplifySearchExpression('hello world');

// Force JavaScript implementation
import { simplifySearchExpressionJS } from 'mygramdb-client';
const exprJS = simplifySearchExpressionJS('hello world');
```

## Syntax

### Basic Syntax

| Syntax | Description | Example |
|--------|-------------|---------|
| `+term` | Required term (must appear) | `+golang` |
| `-term` | Excluded term (must not appear) | `-deprecated` |
| `term1 term2` | Multiple terms (implicit AND) | `golang tutorial` |
| `"phrase"` | Quoted phrase (exact match) | `"hello world"` |
| `(expr)` | Grouping | `(python OR ruby)` |
| `term1 OR term2` | Logical OR | `golang OR rust` |

### Combining Syntax

You can combine different syntax elements to create complex queries:

```typescript
+golang +(tutorial OR guide) -deprecated "best practices"
```

This searches for documents that:
- Must contain "golang"
- Must contain either "tutorial" or "guide"
- Must not contain "deprecated"
- Should contain the phrase "best practices"

## Functions

### parseSearchExpressionNative()

```typescript
function parseSearchExpressionNative(expression: string): {
  mainTerm: string;
  andTerms: string[];
  notTerms: string[];
  optionalTerms: string[];
}
```

**High-performance native C++ parser** that converts web-style search expressions into structured terms. This function automatically uses the native C++ implementation when available, falling back to the JavaScript parser if native bindings are not built.

**Parameters:**
- `expression` (string) - Web-style search expression

**Returns:** Object with parsed terms

**Throws:** Error if expression is invalid or has no positive terms

**Performance:** The native implementation provides significantly better performance for parsing complex expressions, especially useful for high-throughput applications.

**Example:**
```typescript
import { parseSearchExpressionNative } from 'mygramdb-client';

const result = parseSearchExpressionNative('+golang tutorial -old');
console.log(result);
// {
//   mainTerm: 'golang',
//   andTerms: ['tutorial'],
//   notTerms: ['old'],
//   optionalTerms: []
// }

// Use with client
const results = await client.search('articles', result.mainTerm, {
  andTerms: result.andTerms,
  notTerms: result.notTerms,
});
```

**Note:** When quotes are used in the expression, the native parser preserves them in the term strings (e.g., `"machine learning"` instead of `machine learning`). This is intentional to maintain exact phrase semantics in the query.

### parseSearchExpression()

```typescript
function parseSearchExpression(expression: string): SearchExpression
```

Parses a web-style search expression into structured format.

**Parameters:**
- `expression` (string) - Web-style search expression

**Returns:** SearchExpression object

**Throws:** Error if expression is invalid

**Example:**
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

Converts a web-style search expression into MygramDB query format.

**Parameters:**
- `expression` (string) - Web-style search expression

**Returns:** MygramDB query string

**Example:**
```typescript
import { convertSearchExpression } from 'mygram-client';

convertSearchExpression('golang tutorial');
// Returns: 'golang OR tutorial'

convertSearchExpression('+golang +tutorial');
// Returns: 'golang AND tutorial'

convertSearchExpression('+golang -old');
// Returns: 'golang AND NOT old'

convertSearchExpression('python OR ruby');
// Returns: 'python OR ruby'

convertSearchExpression('+golang +(tutorial OR guide)');
// Returns: '+golang +(tutorial OR guide)'
```

### simplifySearchExpression()

```typescript
function simplifySearchExpression(expression: string): {
  mainTerm: string;
  andTerms: string[];
  notTerms: string[];
}
```

Simplifies a search expression into basic terms that can be used with the client's search options.

**Parameters:**
- `expression` (string) - Web-style search expression

**Returns:** Object with mainTerm, andTerms, and notTerms

**Example:**
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

Checks if the expression contains complex syntax (OR, grouping) that cannot be simplified.

**Parameters:**
- `expression` (string) - Web-style search expression

**Returns:** `true` if complex, `false` if simple

**Example:**
```typescript
import { hasComplexExpression } from 'mygram-client';

hasComplexExpression('+golang tutorial -old');
// Returns: false (simple expression)

hasComplexExpression('golang OR rust');
// Returns: true (has OR operator)

hasComplexExpression('+(tutorial OR guide)');
// Returns: true (has grouping)
```

## Usage with Client

### Simple Expressions

For simple expressions without OR operators or grouping, use `simplifySearchExpression()` to extract terms:

```typescript
import { MygramClient, simplifySearchExpression } from 'mygram-client';

const client = new MygramClient();
await client.connect();

// Parse user input
const userInput = '+golang tutorial -deprecated';
const { mainTerm, andTerms, notTerms } = simplifySearchExpression(userInput);

// Use with client
const results = await client.search('articles', mainTerm, {
  andTerms,
  notTerms,
  limit: 50,
});
```

### Complex Expressions

For complex expressions with OR operators or grouping, convert to MygramDB format:

```typescript
import { MygramClient, convertSearchExpression, hasComplexExpression } from 'mygram-client';

const client = new MygramClient();
await client.connect();

const userInput = '+golang +(tutorial OR guide) -old';

if (hasComplexExpression(userInput)) {
  // Use converted query directly
  const query = convertSearchExpression(userInput);
  const results = await client.search('articles', query);
} else {
  // Use simplified terms
  const { mainTerm, andTerms, notTerms } = simplifySearchExpression(userInput);
  const results = await client.search('articles', mainTerm, {
    andTerms,
    notTerms,
  });
}
```

### Automatic Detection

Create a helper function that automatically detects the expression type:

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
    // Complex expression: convert and search
    const query = convertSearchExpression(expression);
    return client.search(table, query, options);
  }

  // Simple expression: extract terms and use options
  const { mainTerm, andTerms, notTerms } = simplifySearchExpression(expression);
  return client.search(table, mainTerm, {
    ...options,
    andTerms: [...(options.andTerms || []), ...andTerms],
    notTerms: [...(options.notTerms || []), ...notTerms],
  });
}

// Usage
const results = await smartSearch(client, 'articles', '+golang +(tutorial OR guide) -old', {
  limit: 50,
  sortColumn: 'created_at',
  sortDesc: true,
});
```

## Examples

### Example 1: Simple AND Query

```typescript
const expression = '+golang +tutorial +beginner';
const { mainTerm, andTerms, notTerms } = simplifySearchExpression(expression);

// mainTerm: 'golang'
// andTerms: ['tutorial', 'beginner']
// notTerms: []

const results = await client.search('articles', mainTerm, { andTerms, notTerms });
```

### Example 2: Exclusion Query

```typescript
const expression = 'golang -advanced -deprecated';
const { mainTerm, andTerms, notTerms } = simplifySearchExpression(expression);

// mainTerm: 'golang'
// andTerms: []
// notTerms: ['advanced', 'deprecated']

const results = await client.search('articles', mainTerm, { andTerms, notTerms });
```

### Example 3: OR Query

```typescript
const expression = 'python OR ruby OR javascript';
const query = convertSearchExpression(expression);

// query: 'python OR ruby OR javascript'

const results = await client.search('articles', query);
```

### Example 4: Complex Query

```typescript
const expression = '+backend +(golang OR rust) -php "best practices"';
const query = convertSearchExpression(expression);

// query: '+backend +(golang OR rust) -php "best practices"'

const results = await client.search('articles', query);
```

### Example 5: Phrase Search

```typescript
const expression = '"hello world" +golang';
const { mainTerm, andTerms, notTerms } = simplifySearchExpression(expression);

// mainTerm: '"hello world"'  // Quotes preserved for phrase search
// andTerms: ['golang']
// notTerms: []

const results = await client.search('articles', mainTerm, { andTerms, notTerms });
```

> **Note**: Quotes are preserved in the parsed terms to maintain phrase search semantics.
> The server treats `"hello world"` as an exact phrase match.

## Type Definitions

### SearchExpression

```typescript
interface SearchExpression {
  requiredTerms: string[];   // Terms marked with +
  excludedTerms: string[];   // Terms marked with -
  optionalTerms: string[];   // Terms without prefix
  orGroups: string[][];      // Groups of OR terms
}
```

## Implementation Details

### Parsing Process

1. **Tokenization**: The expression is split into tokens (terms, operators, parentheses)
2. **Normalization**: Full-width spaces and characters are normalized to ASCII
3. **Classification**: Tokens are classified as required (+), excluded (-), or optional
4. **Grouping**: Parentheses are parsed to identify OR groups
5. **Conversion**: The parsed expression is converted to MygramDB query format

### Limitations

- Nested parentheses are supported up to reasonable depth
- Quoted phrases must be properly closed
- OR operators must have operands on both sides
- Empty expressions or groups are not allowed

### Error Handling

The parser will throw an error if:
- Parentheses are unbalanced
- Quotes are unclosed
- OR operator is used incorrectly
- Expression is empty or invalid

```typescript
import { parseSearchExpression } from 'mygram-client';

try {
  const parsed = parseSearchExpression('(unbalanced');
} catch (error) {
  console.error('Parse error:', error.message);
}
```

## Best Practices

1. **Validate User Input**: Always validate user input before parsing
2. **Use Appropriate Method**: Choose between `simplifySearchExpression()` and `convertSearchExpression()` based on complexity
3. **Handle Errors**: Wrap parsing calls in try-catch blocks
4. **Provide Feedback**: Show users which terms are being used in the search
5. **Test Edge Cases**: Test with empty strings, special characters, and malformed input

## Performance Considerations

- Simple expressions (without OR/grouping) are more efficient when using `simplifySearchExpression()`
- Complex expressions require full query parsing and may be slower
- The parser is lightweight and suitable for real-time user input
- For bulk operations, consider caching parsed expressions

## Advanced Query Features

### FILTER Syntax

MygramDB supports filtering results by field values. Each filter is sent as a separate `FILTER` clause:

```typescript
const results = await client.search('articles', 'golang', {
  filters: {
    status: 'published',
    category: 'programming',
    lang: 'en'
  }
});

// Generated command:
// SEARCH articles golang FILTER status = published FILTER category = programming FILTER lang = en
```

**Important**:

- Each filter key-value pair generates a separate `FILTER key = value` clause
- Multiple filters are independent clauses, not combined with `AND`
- The client uses the three-token format (`FILTER key = value`) for consistency with the C++ client and better readability
- The server also supports compact format (`FILTER key=value`), but the three-token format is recommended

### MySQL-Compatible LIMIT Syntax

MygramDB supports MySQL-style `LIMIT offset,count` syntax for pagination:

```typescript
// Standard format with separate offset and limit
const results = await client.search('articles', 'golang', {
  limit: 50,    // How many results to return
  offset: 100   // Skip first 100 results
});

// Generates: LIMIT 100,50 (MySQL-compatible format)
```

**Formats**:

- `LIMIT count` - When offset is 0 or not specified
- `LIMIT offset,count` - When both offset and limit are specified
- Default limit is 1000 if not specified

### SORT Syntax

Sorting uses the `SORT` command (not `ORDER BY`):

```typescript
const results = await client.search('articles', 'golang', {
  sortColumn: 'created_at',
  sortDesc: false  // ASC order
});

// Generates: SORT created_at ASC
```

**Options**:

- `sortColumn` - Column name to sort by (empty for primary key)
- `sortDesc` - `true` for DESC (default), `false` for ASC

### Combined Advanced Query

```typescript
const results = await client.search('articles', 'hello world', {
  andTerms: ['programming'],
  notTerms: ['deprecated'],
  filters: {
    status: 'published',
    lang: 'en'
  },
  sortColumn: 'score',
  sortDesc: true,
  limit: 20,
  offset: 40
});

// Generated command:
// SEARCH articles hello world AND programming NOT deprecated
// FILTER status = published FILTER lang = en
// SORT score DESC LIMIT 40,20
```
