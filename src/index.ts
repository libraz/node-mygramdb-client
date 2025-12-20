/**
 * MygramDB Client for Node.js
 *
 * A high-performance client library for MygramDB - an in-memory full-text search engine
 * that is 25-200x faster than MySQL FULLTEXT with MySQL replication support.
 *
 * @packageDocumentation
 */

export { MygramClient } from './client';
export { NativeMygramClient } from './native-client';
export { createMygramClient, isNativeAvailable, getClientType, simplifySearchExpression } from './client-factory';
export {
  parseSearchExpression,
  convertSearchExpression,
  simplifySearchExpression as simplifySearchExpressionJS,
  parseSearchExpressionNative,
  hasComplexExpression,
  toQueryString
} from './search-expression';
export type { SearchExpression } from './search-expression';
export type { SimplifiedExpression } from './native-client';
export type {
  ClientConfig,
  SearchResult,
  SearchResponse,
  CountResponse,
  Document,
  ServerInfo,
  ReplicationStatus,
  SearchOptions,
  CountOptions,
  DebugInfo
} from './types';
export { MygramError, ConnectionError, ProtocolError, TimeoutError } from './errors';
