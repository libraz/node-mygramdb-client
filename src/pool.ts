/**
 * Connection pool for high-throughput MygramDB access.
 *
 * The underlying {@link MygramClient} owns a single socket that serializes
 * every command through a FIFO queue - one command is on the wire at a time.
 * A single client therefore tops out at roughly `1 / RTT` requests per second.
 * This pool fans requests across N clients so that up to N commands are in
 * flight concurrently, which is what lets a Node process sustain hundreds of
 * requests per second.
 *
 * Design (see docs for the full rationale):
 *   - Sizing follows Little's law: `N ≈ throughput(req/s) × RTT(s)`, with
 *     headroom for RTT variance. Each slot handles at most one in-flight
 *     command, so a free slot is by definition the least-loaded one.
 *   - Backpressure is explicit: callers that arrive when every slot is busy
 *     wait in a bounded queue with its own deadline, and once the queue is
 *     full new callers are shed immediately with {@link PoolOverloadError}
 *     instead of growing memory without bound.
 *   - A dead connection is retired without taking the pool down: it is
 *     reconnected out of band with exponential backoff while the remaining
 *     slots keep serving. Idempotent reads may be retried once on another
 *     slot.
 *
 * The pool intentionally exposes only the query surface (search / count / get
 * / facet). Administrative commands (INFO, DUMP, CACHE, ...) are low-frequency
 * and can be issued through {@link MygramPool.withClient}.
 */

import { performance } from 'node:perf_hooks';
import { createMygramClient } from './client-factory.js';
import { CircuitOpenError, ConnectionError, PoolOverloadError, TimeoutError } from './errors.js';
import type {
  ClientConfig,
  CountOptions,
  CountResponse,
  Document,
  FacetOptions,
  FacetResponse,
  SearchOptions,
  SearchRawOptions,
  SearchResponse,
  ServerInfo
} from './types.js';

/** Maximum number of recent latency samples retained for percentile reporting. */
const LATENCY_SAMPLE_CAP = 1024;

/**
 * The subset of a MygramDB client the pool depends on. Both
 * {@link MygramClient} and {@link NativeMygramClient} satisfy this structural
 * type, and tests can supply a fake via {@link MygramPoolConfig.clientFactory}.
 */
export interface PooledClient {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  search(table: string, query: string, options?: SearchOptions): Promise<SearchResponse>;
  searchWithHighlights(table: string, query: string, options?: SearchOptions): Promise<SearchResponse>;
  searchRaw(table: string, rawQuery: string, options?: SearchRawOptions): Promise<SearchResponse>;
  searchRawWithHighlights(table: string, rawQuery: string, options?: SearchRawOptions): Promise<SearchResponse>;
  count(table: string, query: string, options?: CountOptions): Promise<CountResponse>;
  get(table: string, primaryKey: string): Promise<Document>;
  facet(table: string, column: string, options?: FacetOptions): Promise<FacetResponse>;
  info(): Promise<ServerInfo>;
}

/** Factory used to create each pooled client. */
export type PooledClientFactory = (config: ClientConfig, forceJavaScript: boolean) => PooledClient;

/**
 * Discrete pool lifecycle events delivered to {@link MygramPoolConfig.onEvent}.
 *
 *   - `acquire` - a slot was handed to a caller; payload `{ waitMs }`.
 *   - `connection_discarded` - a dead slot was retired for reconnection.
 *   - `retry` - an idempotent read was retried; payload `{ attempt, error }`.
 *   - `breaker_state_change` - the circuit breaker changed state; payload
 *     `{ state }` (`'closed' | 'open' | 'half-open'`).
 */
export type PoolEvent = 'acquire' | 'connection_discarded' | 'retry' | 'breaker_state_change';

/** Circuit-breaker state as reported by the `breaker_state_change` event. */
export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Circuit-breaker configuration for {@link MygramPool}. Wraps the query path
 * outside the read-retry logic so the pool fails fast against an unreachable
 * server instead of retrying into it. Omit {@link MygramPoolConfig.circuitBreaker}
 * to disable the breaker entirely.
 */
export interface CircuitBreakerConfig {
  /** Consecutive network failures that trip the breaker open. Default: 5. */
  failureThreshold?: number;
  /** Time (ms) the breaker stays open before allowing a half-open trial. Default: 10000. */
  resetTimeoutMs?: number;
}

/**
 * Configuration for {@link MygramPool}.
 */
export interface MygramPoolConfig {
  /** Connection settings passed to every pooled client (host/port/socketPath/timeout). */
  connection?: ClientConfig;
  /**
   * Number of connections to open. This is the effective maximum concurrency.
   * Size with Little's law: `size ≈ targetThroughput × p95RTT`, then add
   * headroom (≈ 3x) for variance. Default: 8.
   */
  size?: number;
  /** Force the pure-JavaScript transport. Recommended for high concurrency. Default: true. */
  forceJavaScript?: boolean;
  /**
   * Maximum number of callers allowed to wait for a free slot. Once exceeded,
   * further calls reject immediately with {@link PoolOverloadError}.
   * Default: `size * 8`.
   */
  maxQueue?: number;
  /**
   * Deadline (ms) for a caller waiting in the queue. Bounds the real wait time
   * independently of the per-command timeout, which the underlying client only
   * starts counting once the command leaves its own queue. Default: the
   * connection timeout (or 5000).
   */
  queueTimeoutMs?: number;
  /** Times an idempotent read is retried on another slot after a {@link ConnectionError}. Default: 1. */
  readRetries?: number;
  /** Reconnect backoff `[initialMs, maxMs]` (exponential with jitter). Default: `[100, 5000]`. */
  reconnectBackoffMs?: [number, number];
  /** Interval (ms) for pinging idle connections to keep them warm. 0 disables. Default: 30000. */
  keepAliveIntervalMs?: number;
  /** Interval (ms) for emitting {@link MygramPoolConfig.onMetrics}. 0 disables. Default: 0. */
  metricsIntervalMs?: number;
  /** Optional metrics sink, invoked every `metricsIntervalMs` when set. */
  onMetrics?: (metrics: PoolMetrics) => void;
  /**
   * Optional sink for background errors that never surface to a caller -
   * reconnect failures, keep-alive-triggered retirements, and warm-up
   * connection failures. Without it these are silently swallowed. Never throws
   * on an absent listener (unlike an EventEmitter `'error'`).
   */
  onError?: (error: Error) => void;
  /**
   * Optional circuit breaker wrapping the query path. When the server becomes
   * unreachable the breaker opens and further calls fail fast with
   * {@link CircuitOpenError} before a slot is acquired. Omit to disable.
   */
  circuitBreaker?: CircuitBreakerConfig;
  /**
   * Optional sink for discrete lifecycle events (acquire, connection retirement,
   * read retry, breaker transition). Errors thrown by the callback are swallowed
   * so instrumentation cannot disrupt the pool. See {@link PoolEvent}.
   */
  onEvent?: (event: PoolEvent, payload: Record<string, unknown>) => void;
  /** Injectable client factory (primarily for testing). Defaults to {@link createMygramClient}. */
  clientFactory?: PooledClientFactory;
}

/**
 * A point-in-time snapshot of pool health and load.
 */
export interface PoolMetrics {
  /** Configured pool size. */
  totalConnections: number;
  /** Connections currently connected and usable. */
  healthyConnections: number;
  /** Commands currently in flight. */
  inFlight: number;
  /** Callers waiting for a free slot. */
  queueDepth: number;
  /** Cumulative calls shed because the queue was full. */
  rejectedOverload: number;
  /** Cumulative connection retirements (a dead connection being reconnected). */
  reconnects: number;
  /** Cumulative successfully completed commands. */
  completed: number;
  /** Cumulative failed commands (after any retries). */
  failed: number;
  /** Median command latency (ms) over the recent sample window. */
  latencyP50Ms: number;
  /** 99th-percentile command latency (ms) over the recent sample window. */
  latencyP99Ms: number;
}

interface Slot {
  client: PooledClient;
  healthy: boolean;
  inFlight: number;
}

interface Waiter {
  resolve: (slot: Slot) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  enqueuedAt: number;
}

const DEFAULT_BACKOFF: [number, number] = [100, 5000];
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 10000;

/**
 * A pool of MygramDB connections that fans requests across N clients to
 * sustain high request rates from a single Node process.
 *
 * @example
 * ```typescript
 * const pool = new MygramPool({ connection: { host: 'localhost' }, size: 12 });
 * await pool.start(); // optional; the first query starts the pool lazily
 *
 * const res = await pool.search('articles', 'hello world', { limit: 100 });
 *
 * await pool.close();
 * ```
 */
export class MygramPool {
  private readonly connectionConfig: ClientConfig;
  private readonly forceJavaScript: boolean;
  private readonly size: number;
  private readonly maxQueue: number;
  private readonly queueTimeoutMs: number;
  private readonly readRetries: number;
  private readonly reconnectBackoffMs: [number, number];
  private readonly keepAliveIntervalMs: number;
  private readonly metricsIntervalMs: number;
  private readonly onMetrics: ((metrics: PoolMetrics) => void) | undefined;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly onEvent: ((event: PoolEvent, payload: Record<string, unknown>) => void) | undefined;
  private readonly clientFactory: PooledClientFactory;

  private readonly circuitBreakerEnabled: boolean;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private circuitState: CircuitState = 'closed';
  private circuitOpenedAt = 0;
  private circuitFailures = 0;
  private circuitHalfOpenInFlight = false;

  private readonly slots: Slot[];
  private readonly waiters: Waiter[] = [];
  private readonly reconnectTimers = new Set<NodeJS.Timeout>();
  private readonly latencies: number[] = [];

  private keepAliveTimer: NodeJS.Timeout | null = null;
  private metricsTimer: NodeJS.Timeout | null = null;
  private startPromise: Promise<void> | null = null;
  private stopping = false;

  private rejectedOverload = 0;
  private reconnects = 0;
  private completed = 0;
  private failed = 0;

  /**
   * Build a pool. No sockets are opened until {@link start} is called (or until
   * the first query lazily starts the pool).
   *
   * @param {MygramPoolConfig} [config={}] - Pool configuration
   */
  constructor(config: MygramPoolConfig = {}) {
    this.connectionConfig = config.connection ?? {};
    this.forceJavaScript = config.forceJavaScript ?? true;
    this.size = Math.max(1, config.size ?? 8);
    this.maxQueue = Math.max(0, config.maxQueue ?? this.size * 8);
    this.queueTimeoutMs = Math.max(1, config.queueTimeoutMs ?? this.connectionConfig.timeout ?? 5000);
    this.readRetries = Math.max(0, config.readRetries ?? 1);
    this.reconnectBackoffMs = config.reconnectBackoffMs ?? DEFAULT_BACKOFF;
    this.keepAliveIntervalMs = Math.max(0, config.keepAliveIntervalMs ?? 30000);
    this.metricsIntervalMs = Math.max(0, config.metricsIntervalMs ?? 0);
    this.onMetrics = config.onMetrics;
    this.onError = config.onError;
    this.onEvent = config.onEvent;
    this.circuitBreakerEnabled = config.circuitBreaker !== undefined;
    this.failureThreshold = Math.max(1, config.circuitBreaker?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
    this.resetTimeoutMs = Math.max(1, config.circuitBreaker?.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS);
    this.clientFactory = config.clientFactory ?? ((cfg, forceJs) => createMygramClient(cfg, forceJs));

    this.slots = Array.from({ length: this.size }, () => ({
      client: this.createClient(),
      healthy: false,
      inFlight: 0
    }));
  }

  /**
   * Open every connection and warm the pool. Idempotent and memoized: repeated
   * calls (and the lazy start triggered by the first query) share one attempt.
   * Resolves once at least one connection is healthy; connections that fail to
   * open are scheduled for background reconnection. A failed start clears the
   * memo so a later call can retry.
   *
   * Calling `start()` explicitly gives fail-fast warm-up; omitting it lets the
   * first query start the pool lazily (matching the ergonomics of `pg.Pool` /
   * `ioredis`).
   *
   * @returns {Promise<void>} Resolves when the pool is usable
   * @throws {ConnectionError} If no connection could be established
   */
  start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    const attempt = this.doStart();
    this.startPromise = attempt;
    attempt.catch(() => {
      // Let a subsequent call retry rather than caching the rejection forever.
      if (this.startPromise === attempt) {
        this.startPromise = null;
      }
    });
    return attempt;
  }

  private async doStart(): Promise<void> {
    await Promise.allSettled(this.slots.map((slot) => this.connectSlot(slot)));

    if (!this.slots.some((slot) => slot.healthy)) {
      throw new ConnectionError('Failed to establish any pooled connection');
    }

    if (this.keepAliveIntervalMs > 0) {
      this.startKeepAlive();
    }
    if (this.onMetrics && this.metricsIntervalMs > 0) {
      this.startMetrics();
    }
  }

  /**
   * Search for documents. Load-balanced across the pool.
   *
   * @param {string} table - Table name (bare or `database.table`)
   * @param {string} query - Search query text
   * @param {SearchOptions} [options] - Search options
   * @returns {Promise<SearchResponse>} Search response
   * @throws {PoolOverloadError} When the wait queue is full
   * @throws {TimeoutError} When the queue wait deadline is exceeded
   */
  search(table: string, query: string, options?: SearchOptions): Promise<SearchResponse> {
    return this.run((client) => client.search(table, query, options), true);
  }

  /**
   * {@link search} variant that requests highlighted snippets.
   *
   * @param {string} table - Table name
   * @param {string} query - Search query text
   * @param {SearchOptions} [options] - Search options
   * @returns {Promise<SearchResponse>} Search response with snippets
   */
  searchWithHighlights(table: string, query: string, options?: SearchOptions): Promise<SearchResponse> {
    return this.run((client) => client.searchWithHighlights(table, query, options), true);
  }

  /**
   * Search using a pre-built boolean expression. Load-balanced across the pool.
   *
   * @param {string} table - Table name
   * @param {string} rawQuery - Pre-built boolean expression
   * @param {SearchRawOptions} [options] - Limit/offset/highlight options
   * @returns {Promise<SearchResponse>} Search response
   */
  searchRaw(table: string, rawQuery: string, options?: SearchRawOptions): Promise<SearchResponse> {
    return this.run((client) => client.searchRaw(table, rawQuery, options), true);
  }

  /**
   * {@link searchRaw} variant that requests highlighted snippets.
   *
   * @param {string} table - Table name
   * @param {string} rawQuery - Pre-built boolean expression
   * @param {SearchRawOptions} [options] - Limit/offset/highlight options
   * @returns {Promise<SearchResponse>} Search response with snippets
   */
  searchRawWithHighlights(table: string, rawQuery: string, options?: SearchRawOptions): Promise<SearchResponse> {
    return this.run((client) => client.searchRawWithHighlights(table, rawQuery, options), true);
  }

  /**
   * Count matching documents. Load-balanced across the pool.
   *
   * @param {string} table - Table name
   * @param {string} query - Search query text
   * @param {CountOptions} [options] - Count options
   * @returns {Promise<CountResponse>} Count response
   */
  count(table: string, query: string, options?: CountOptions): Promise<CountResponse> {
    return this.run((client) => client.count(table, query, options), true);
  }

  /**
   * Get a document by primary key. Load-balanced across the pool.
   *
   * @param {string} table - Table name
   * @param {string} primaryKey - Primary key value
   * @returns {Promise<Document>} Document object
   */
  get(table: string, primaryKey: string): Promise<Document> {
    return this.run((client) => client.get(table, primaryKey), true);
  }

  /**
   * Aggregate distinct values of a column. Load-balanced across the pool.
   *
   * @param {string} table - Table name
   * @param {string} column - Column to aggregate
   * @param {FacetOptions} [options] - Facet options
   * @returns {Promise<FacetResponse>} Facet response
   */
  facet(table: string, column: string, options?: FacetOptions): Promise<FacetResponse> {
    return this.run((client) => client.facet(table, column, options), true);
  }

  /**
   * Run an arbitrary operation against a pooled client. Escape hatch for
   * administrative commands not exposed directly by the pool.
   *
   * @param {(client: PooledClient) => Promise<T>} operation - Work to run on a borrowed client
   * @param {object} [options] - Behaviour flags
   * @param {boolean} [options.idempotent=false] - Whether the operation may be retried on connection loss
   * @returns {Promise<T>} The operation result
   */
  withClient<T>(operation: (client: PooledClient) => Promise<T>, options?: { idempotent?: boolean }): Promise<T> {
    return this.run(operation, options?.idempotent ?? false);
  }

  /**
   * Current pool metrics.
   *
   * @returns {PoolMetrics} A point-in-time snapshot
   */
  metrics(): PoolMetrics {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    let inFlight = 0;
    let healthy = 0;
    for (const slot of this.slots) {
      inFlight += slot.inFlight;
      if (slot.healthy) {
        healthy += 1;
      }
    }
    return {
      totalConnections: this.size,
      healthyConnections: healthy,
      inFlight,
      queueDepth: this.waiters.length,
      rejectedOverload: this.rejectedOverload,
      reconnects: this.reconnects,
      completed: this.completed,
      failed: this.failed,
      latencyP50Ms: percentile(sorted, 50),
      latencyP99Ms: percentile(sorted, 99)
    };
  }

  /**
   * Gracefully close the pool: stop timers, reject waiting callers, and
   * disconnect every connection. In-flight commands are left to settle on
   * their own. Idempotent.
   *
   * @returns {Promise<void>} Resolves once teardown is complete
   */
  async close(): Promise<void> {
    this.stopping = true;

    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.metricsTimer !== null) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    for (const timer of this.reconnectTimers) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    const pending = this.waiters.splice(0);
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new ConnectionError('Pool is closing'));
    }

    for (const slot of this.slots) {
      slot.healthy = false;
      try {
        slot.client.disconnect();
      } catch {
        // Best-effort teardown; ignore disconnect failures.
      }
    }
  }

  /**
   * Alias for {@link close}, matching the `pg` / `mysql2` pool convention.
   *
   * @returns {Promise<void>} Resolves once teardown is complete
   */
  end(): Promise<void> {
    return this.close();
  }

  private async run<T>(operation: (client: PooledClient) => Promise<T>, idempotent: boolean): Promise<T> {
    // The circuit breaker sits outside the read-retry loop and fails fast
    // before a slot is acquired, so an open breaker never queues or retries.
    this.breakerBeforeOperation();
    try {
      const result = await this.runWithRetry(operation, idempotent);
      this.breakerOnSuccess();
      return result;
    } catch (error) {
      if (isNetworkFailure(error)) {
        this.breakerOnNetworkFailure();
      }
      throw error;
    }
  }

  private async runWithRetry<T>(
    operation: (client: PooledClient) => Promise<T>,
    idempotent: boolean,
    attempt = 0
  ): Promise<T> {
    // Lazily warm the pool on first use so callers need not call start().
    if (!this.stopping) {
      await this.start();
    }
    const slot = await this.acquire();
    const startedAt = performance.now();
    try {
      const result = await operation(slot.client);
      this.recordLatency(performance.now() - startedAt);
      this.completed += 1;
      this.release(slot);
      return result;
    } catch (error) {
      // ConnectionError/TimeoutError mean the socket may be dead or the wire
      // desynchronised, so the connection cannot be safely reused.
      const desync = error instanceof ConnectionError || error instanceof TimeoutError;
      if (desync) {
        this.retireSlot(slot);
        // Only a lost connection is safe to retry; a timeout may have already
        // executed server-side.
        if (idempotent && error instanceof ConnectionError && attempt < this.readRetries) {
          this.emitEvent('retry', { attempt: attempt + 1, error });
          return this.runWithRetry(operation, idempotent, attempt + 1);
        }
      } else {
        this.release(slot);
      }
      this.failed += 1;
      throw error;
    }
  }

  private breakerBeforeOperation(): void {
    if (!this.circuitBreakerEnabled) {
      return;
    }
    if (this.circuitState === 'open') {
      const elapsed = performance.now() - this.circuitOpenedAt;
      if (elapsed >= this.resetTimeoutMs) {
        // Reset window elapsed: allow a single half-open trial.
        this.setCircuitState('half-open');
        this.circuitHalfOpenInFlight = true;
        return;
      }
      throw new CircuitOpenError('Circuit breaker is open');
    }
    if (this.circuitState === 'half-open') {
      if (this.circuitHalfOpenInFlight) {
        throw new CircuitOpenError('Circuit breaker is half-open; a trial is already in flight');
      }
      this.circuitHalfOpenInFlight = true;
    }
  }

  private breakerOnSuccess(): void {
    if (!this.circuitBreakerEnabled) {
      return;
    }
    if (this.circuitState === 'half-open') {
      this.circuitHalfOpenInFlight = false;
      this.setCircuitState('closed');
    }
    this.circuitFailures = 0;
  }

  private breakerOnNetworkFailure(): void {
    if (!this.circuitBreakerEnabled) {
      return;
    }
    if (this.circuitState === 'half-open') {
      this.circuitHalfOpenInFlight = false;
      this.openCircuit();
      return;
    }
    if (this.circuitState === 'closed') {
      this.circuitFailures += 1;
      if (this.circuitFailures >= this.failureThreshold) {
        this.openCircuit();
      }
    }
  }

  private openCircuit(): void {
    this.circuitOpenedAt = performance.now();
    this.circuitFailures = 0;
    this.setCircuitState('open');
  }

  private setCircuitState(state: CircuitState): void {
    if (this.circuitState === state) {
      return;
    }
    this.circuitState = state;
    this.emitEvent('breaker_state_change', { state });
  }

  private emitEvent(event: PoolEvent, payload: Record<string, unknown>): void {
    if (!this.onEvent) {
      return;
    }
    try {
      this.onEvent(event, payload);
    } catch {
      // Instrumentation must never disrupt the pool.
    }
  }

  private acquire(): Promise<Slot> {
    return new Promise<Slot>((resolve, reject) => {
      if (this.stopping) {
        reject(new ConnectionError('Pool is closed'));
        return;
      }
      const free = this.findFreeSlot();
      if (free) {
        free.inFlight = 1;
        this.emitEvent('acquire', { waitMs: 0 });
        resolve(free);
        return;
      }
      if (this.waiters.length >= this.maxQueue) {
        this.rejectedOverload += 1;
        reject(new PoolOverloadError(`Pool wait queue is full (maxQueue=${this.maxQueue})`));
        return;
      }
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer);
        if (index !== -1) {
          this.waiters.splice(index, 1);
        }
        reject(new TimeoutError(`Timed out after ${this.queueTimeoutMs}ms waiting for a pooled connection`));
      }, this.queueTimeoutMs);
      this.waiters.push({ resolve, reject, timer, enqueuedAt: performance.now() });
    });
  }

  private release(slot: Slot): void {
    slot.inFlight = 0;
    this.pump();
  }

  private pump(): void {
    while (this.waiters.length > 0) {
      const slot = this.findFreeSlot();
      if (!slot) {
        return;
      }
      const waiter = this.waiters.shift();
      if (!waiter) {
        return;
      }
      clearTimeout(waiter.timer);
      slot.inFlight = 1;
      this.emitEvent('acquire', { waitMs: performance.now() - waiter.enqueuedAt });
      waiter.resolve(slot);
    }
  }

  private findFreeSlot(): Slot | null {
    for (const slot of this.slots) {
      if (slot.healthy && slot.inFlight === 0) {
        return slot;
      }
    }
    return null;
  }

  private retireSlot(slot: Slot): void {
    if (!slot.healthy) {
      return;
    }
    slot.healthy = false;
    slot.inFlight = 0;
    this.reconnects += 1;
    this.emitEvent('connection_discarded', {});
    try {
      slot.client.disconnect();
    } catch {
      // Ignore; we are discarding this connection anyway.
    }
    this.scheduleReconnect(slot, this.reconnectBackoffMs[0]);
  }

  private scheduleReconnect(slot: Slot, delay: number): void {
    if (this.stopping) {
      return;
    }
    const jitter = Math.floor(Math.random() * delay * 0.2);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(timer);
      void this.attemptReconnect(slot, delay);
    }, delay + jitter);
    this.reconnectTimers.add(timer);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  private async attemptReconnect(slot: Slot, previousDelay: number): Promise<void> {
    if (this.stopping) {
      return;
    }
    const client = this.createClient();
    try {
      await client.connect();
      if (this.stopping) {
        // The pool was stopped while this connection was being established;
        // drop it rather than leaking an open socket past teardown.
        client.disconnect();
        return;
      }
      slot.client = client;
      slot.inFlight = 0;
      slot.healthy = true;
      this.pump();
    } catch (error) {
      try {
        client.disconnect();
      } catch {
        // Ignore teardown failures for the freshly created client.
      }
      this.emitError(error);
      const next = Math.min(this.reconnectBackoffMs[1], previousDelay * 2);
      this.scheduleReconnect(slot, next);
    }
  }

  private async connectSlot(slot: Slot): Promise<void> {
    try {
      await slot.client.connect();
      slot.healthy = true;
    } catch (error) {
      this.emitError(error);
      this.scheduleReconnect(slot, this.reconnectBackoffMs[0]);
      throw error;
    }
  }

  private emitError(error: unknown): void {
    if (!this.onError) {
      return;
    }
    const normalized = error instanceof Error ? error : new Error(String(error));
    try {
      this.onError(normalized);
    } catch {
      // A throwing error sink must not break the background task that reported.
    }
  }

  private createClient(): PooledClient {
    return this.clientFactory(this.connectionConfig, this.forceJavaScript);
  }

  private startKeepAlive(): void {
    this.keepAliveTimer = setInterval(() => {
      this.pingIdleSlots();
    }, this.keepAliveIntervalMs);
    if (typeof this.keepAliveTimer.unref === 'function') {
      this.keepAliveTimer.unref();
    }
  }

  private pingIdleSlots(): void {
    for (const slot of this.slots) {
      if (!slot.healthy || slot.inFlight !== 0) {
        continue;
      }
      slot.inFlight = 1;
      slot.client
        .info()
        .then(() => {
          this.release(slot);
        })
        .catch((error: unknown) => {
          if (error instanceof ConnectionError || error instanceof TimeoutError) {
            this.emitError(error);
            this.retireSlot(slot);
          } else {
            this.release(slot);
          }
        });
    }
  }

  private startMetrics(): void {
    const sink = this.onMetrics;
    if (!sink) {
      return;
    }
    this.metricsTimer = setInterval(() => {
      sink(this.metrics());
    }, this.metricsIntervalMs);
    if (typeof this.metricsTimer.unref === 'function') {
      this.metricsTimer.unref();
    }
  }

  private recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > LATENCY_SAMPLE_CAP) {
      this.latencies.shift();
    }
  }
}

/**
 * Nearest-rank percentile over a pre-sorted ascending array.
 *
 * @param {number[]} sorted - Ascending latency samples
 * @param {number} p - Percentile in the range 0..100
 * @returns {number} The sample at the requested percentile, or 0 when empty
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

/**
 * Whether an error represents an unreachable server (the only failures that
 * trip the circuit breaker). PoolOverloadError, CircuitOpenError,
 * ProtocolError, and InputValidationError deliberately do not qualify.
 *
 * @param {unknown} error - The error thrown by a pooled operation
 * @returns {boolean} True for {@link ConnectionError} / {@link TimeoutError}
 */
function isNetworkFailure(error: unknown): boolean {
  return error instanceof ConnectionError || error instanceof TimeoutError;
}
