/**
 * MygramDB Client for Node.js
 *
 * A high-performance client library for MygramDB - an in-memory full-text search engine
 * that is 25-200x faster than MySQL FULLTEXT with MySQL replication support.
 *
 * @packageDocumentation
 */

export { MygramClient } from './client.js';
export { createMygramClient, getClientType, isNativeAvailable, simplifySearchExpression } from './client-factory.js';
export { ConnectionError, InputValidationError, MygramError, ProtocolError, TimeoutError } from './errors.js';
export type { SimplifiedExpression } from './native-client.js';
export { NativeMygramClient } from './native-client.js';
export type { SearchExpression } from './search-expression.js';
export {
  convertSearchExpression,
  hasComplexExpression,
  parseSearchExpression,
  parseSearchExpressionNative,
  simplifySearchExpression as simplifySearchExpressionJS,
  toQueryString
} from './search-expression.js';
export type {
  CacheStats,
  ClientConfig,
  CountOptions,
  CountResponse,
  DebugInfo,
  Document,
  DumpStatus,
  FacetOptions,
  FacetResponse,
  FacetValue,
  HighlightOptions,
  ReplicationStatus,
  SearchOptions,
  SearchResponse,
  SearchResult,
  ServerInfo
} from './types.js';
