/**
 * Client factory with automatic fallback
 *
 * This module provides a factory function that automatically selects
 * the best available client implementation:
 * 1. Try to use native C++ binding (if available)
 * 2. Fall back to pure JavaScript implementation
 */

import { ClientConfig } from './types';
import { MygramClient } from './client';
import { NativeMygramClient, SimplifiedExpression } from './native-client';
import { tryLoadNative as loadNativeModule } from './native-loader';
import { simplifySearchExpression as jsSimplifySearchExpression } from './search-expression';

// Native binding interface for simplifySearchExpression
interface NativeBindingWithParser {
  simplifySearchExpression(expression: string): SimplifiedExpression;
}

let nativeBinding: unknown = null;
let nativeAvailable = false;
let loadAttempted = false;

/**
 * Try to load native binding with comprehensive fallback
 */
function tryLoadNative(): boolean {
  if (loadAttempted) {
    return nativeAvailable;
  }

  loadAttempted = true;

  try {
    nativeBinding = loadNativeModule();
    nativeAvailable = nativeBinding !== null;
    return nativeAvailable;
  } catch (error) {
    // Native binding not available, will use pure JS fallback
    nativeAvailable = false;
    return false;
  }
}

/**
 * Create MygramDB client with automatic fallback
 *
 * This function will try to use the native C++ binding if available,
 * and fall back to the pure JavaScript implementation if not.
 *
 * @param {ClientConfig} [config={}] - Client configuration
 * @param {boolean} [forceJavaScript=false] - Force use of pure JavaScript implementation
 * @returns {MygramClient | NativeMygramClient} Client instance
 *
 * @example
 * ```typescript
 * // Automatic selection (native or JS)
 * const client = createMygramClient({ host: 'localhost', port: 11016 });
 *
 * // Force pure JavaScript
 * const jsClient = createMygramClient({ host: 'localhost' }, true);
 * ```
 */
export function createMygramClient(
  config: ClientConfig = {},
  forceJavaScript = false
): MygramClient | NativeMygramClient {
  if (!forceJavaScript && tryLoadNative()) {
    return new NativeMygramClient(nativeBinding as never, config);
  }
  return new MygramClient(config);
}

/**
 * Check if native binding is available
 *
 * @returns {boolean} True if native C++ binding is available
 *
 * @example
 * ```typescript
 * if (isNativeAvailable()) {
 *   console.log('Using high-performance native C++ binding');
 * } else {
 *   console.log('Using pure JavaScript implementation');
 * }
 * ```
 */
export function isNativeAvailable(): boolean {
  return tryLoadNative();
}

/**
 * Get client implementation type
 *
 * @param {MygramClient | NativeMygramClient} client - Client instance
 * @returns {'native' | 'javascript'} Client implementation type
 *
 * @example
 * ```typescript
 * const client = createMygramClient();
 * console.log(`Using ${getClientType(client)} implementation`);
 * ```
 */
export function getClientType(client: MygramClient | NativeMygramClient): 'native' | 'javascript' {
  return client instanceof NativeMygramClient ? 'native' : 'javascript';
}

/**
 * Parse web-style search expression into structured terms
 *
 * Uses native C++ implementation if available, otherwise falls back to JavaScript.
 * This function converts expressions like "hello world" or "+required -excluded"
 * into structured format for use with search() method.
 *
 * @param {string} expression - Web-style search expression
 * @param {boolean} [forceJavaScript=false] - Force use of pure JavaScript implementation
 * @returns {SimplifiedExpression} Parsed expression with mainTerm, andTerms, notTerms
 *
 * @example
 * ```typescript
 * // Parse space-separated terms as AND
 * const expr = simplifySearchExpression('hello world');
 * // expr = { mainTerm: 'hello', andTerms: ['world'], notTerms: [] }
 *
 * // Use with search
 * const result = await client.search(table, expr.mainTerm, {
 *   andTerms: expr.andTerms,
 *   notTerms: expr.notTerms
 * });
 * ```
 */
export function simplifySearchExpression(expression: string, forceJavaScript = false): SimplifiedExpression {
  if (!forceJavaScript && tryLoadNative()) {
    const binding = nativeBinding as NativeBindingWithParser;
    return binding.simplifySearchExpression(expression);
  }
  return jsSimplifySearchExpression(expression);
}
