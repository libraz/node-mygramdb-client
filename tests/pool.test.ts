import { afterEach, describe, expect, it, vi } from 'vitest';
import { CircuitOpenError, ConnectionError, PoolOverloadError, ProtocolError, TimeoutError } from '../src/errors';
import { MygramPool, type PoolEvent, type PooledClient } from '../src/pool';
import type { SearchResponse, ServerInfo } from '../src/types';

interface Counters {
  active: number;
  maxActive: number;
  order: string[];
}

function serverInfo(): ServerInfo {
  return {
    version: '1.0',
    uptimeSeconds: 0,
    totalRequests: 0,
    activeConnections: 0,
    indexSizeBytes: 0,
    docCount: 0,
    tables: []
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function searchResponse(): SearchResponse {
  return { results: [], totalCount: 0 };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

/**
 * Configurable fake that stands in for a real MygramDB client. Behaviour is
 * driven per-instance so tests can steer individual pooled connections.
 */
class FakeClient implements PooledClient {
  connected = false;
  connectShouldFail = false;
  /** Overrides the search behaviour; defaults to an immediate empty response. */
  searchHandler: (() => Promise<SearchResponse>) | null = null;

  /** Overrides the info() behaviour; used to exercise keep-alive failures. */
  infoHandler: (() => Promise<ServerInfo>) | null = null;

  constructor(private readonly counters: Counters) {}

  async connect(): Promise<void> {
    if (this.connectShouldFail) {
      throw new ConnectionError('connect failed');
    }
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async search(_table: string, query: string): Promise<SearchResponse> {
    this.counters.active += 1;
    this.counters.maxActive = Math.max(this.counters.maxActive, this.counters.active);
    this.counters.order.push(query);
    try {
      if (this.searchHandler) {
        return await this.searchHandler();
      }
      return searchResponse();
    } finally {
      this.counters.active -= 1;
    }
  }

  searchWithHighlights(): Promise<SearchResponse> {
    return this.search();
  }

  searchRaw(): Promise<SearchResponse> {
    return this.search();
  }

  searchRawWithHighlights(): Promise<SearchResponse> {
    return this.search();
  }

  async count() {
    return { count: 0 };
  }

  async get() {
    return { primaryKey: 'x', fields: {} };
  }

  async facet() {
    return { results: [] };
  }

  async info(): Promise<ServerInfo> {
    if (this.infoHandler) {
      return this.infoHandler();
    }
    return serverInfo();
  }
}

interface Harness {
  pool: MygramPool;
  created: FakeClient[];
  counters: Counters;
}

function makePool(
  config: Partial<ConstructorParameters<typeof MygramPool>[0]> = {},
  setup?: (fake: FakeClient, index: number) => void
): Harness {
  const counters: Counters = { active: 0, maxActive: 0, order: [] };
  const created: FakeClient[] = [];
  const pool = new MygramPool({
    keepAliveIntervalMs: 0,
    ...config,
    clientFactory: () => {
      const fake = new FakeClient(counters);
      setup?.(fake, created.length);
      created.push(fake);
      return fake;
    }
  });
  return { pool, created, counters };
}

describe('MygramPool', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens `size` connections on start and reports them healthy', async () => {
    const { pool, created } = makePool({ size: 3 });
    await pool.start();

    expect(created).toHaveLength(3);
    const metrics = pool.metrics();
    expect(metrics.totalConnections).toBe(3);
    expect(metrics.healthyConnections).toBe(3);
    await pool.close();
  });

  it('lazily starts the pool on the first query without an explicit start()', async () => {
    const { pool, created } = makePool({ size: 1 });

    const res = await pool.search('t', 'q'); // no pool.start() call
    expect(res).toEqual(searchResponse());
    expect(created[0].isConnected()).toBe(true);
    expect(pool.metrics().healthyConnections).toBe(1);
    await pool.close();
  });

  it('exposes end() as an alias for close()', async () => {
    const { pool, created } = makePool({ size: 1 });
    await pool.start();
    await pool.end();
    expect(created[0].isConnected()).toBe(false);
    expect(pool.metrics().healthyConnections).toBe(0);
  });

  it('delegates search to a pooled client', async () => {
    const { pool } = makePool({ size: 2 });
    await pool.start();

    const res = await pool.search('articles', 'hello');
    expect(res).toEqual(searchResponse());
    expect(pool.metrics().completed).toBe(1);
    await pool.close();
  });

  it('caps concurrency at the pool size', async () => {
    const gate = deferred<SearchResponse>();
    const { pool, counters } = makePool({ size: 2 }, (fake) => {
      fake.searchHandler = () => gate.promise;
    });
    await pool.start();

    const inflight = [pool.search('t', 'a'), pool.search('t', 'b'), pool.search('t', 'c'), pool.search('t', 'd')];
    await flushMicrotasks();

    // Only two slots exist, so only two searches can run at once; the other
    // two wait in the queue.
    expect(counters.active).toBe(2);
    const mid = pool.metrics();
    expect(mid.inFlight).toBe(2);
    expect(mid.queueDepth).toBe(2);

    gate.resolve(searchResponse());
    await Promise.all(inflight);

    expect(counters.maxActive).toBe(2);
    await pool.close();
  });

  it('sheds load with PoolOverloadError when the queue is full', async () => {
    const gate = deferred<SearchResponse>();
    const { pool } = makePool({ size: 1, maxQueue: 1 }, (fake) => {
      fake.searchHandler = () => gate.promise;
    });
    await pool.start();

    const running = pool.search('t', 'a'); // occupies the single slot
    running.catch(() => {});
    const queued = pool.search('t', 'b'); // fills the wait queue (depth 1)
    queued.catch(() => {});
    await flushMicrotasks();

    await expect(pool.search('t', 'c')).rejects.toBeInstanceOf(PoolOverloadError);
    expect(pool.metrics().rejectedOverload).toBe(1);
    await pool.close();
  });

  it('times out a caller that waits past the queue deadline', async () => {
    vi.useFakeTimers();
    const gate = deferred<SearchResponse>();
    const { pool } = makePool({ size: 1, queueTimeoutMs: 50 }, (fake) => {
      fake.searchHandler = () => gate.promise;
    });
    await pool.start();

    const running = pool.search('t', 'a');
    running.catch(() => {});
    await flushMicrotasks();

    const queued = pool.search('t', 'b');
    const assertion = expect(queued).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    await pool.close();
  });

  it('retries an idempotent read on another slot after a connection error', async () => {
    const { pool, created } = makePool({ size: 2, readRetries: 1 }, (fake, index) => {
      if (index === 0) {
        fake.searchHandler = () => Promise.reject(new ConnectionError('socket died'));
      }
    });
    await pool.start();

    const res = await pool.search('t', 'q');
    expect(res).toEqual(searchResponse());
    // The first slot was retired and reconnected; the retry landed on slot 1.
    expect(pool.metrics().reconnects).toBe(1);
    expect(created[0].isConnected()).toBe(false);
    await pool.close();
  });

  it('does not retry or retire on a protocol error', async () => {
    const { pool } = makePool({ size: 1 }, (fake) => {
      fake.searchHandler = () => Promise.reject(new ProtocolError('bad query'));
    });
    await pool.start();

    await expect(pool.search('t', 'q')).rejects.toBeInstanceOf(ProtocolError);
    const metrics = pool.metrics();
    expect(metrics.reconnects).toBe(0); // connection reused, not retired
    expect(metrics.failed).toBe(1);
    expect(metrics.healthyConnections).toBe(1);
    await pool.close();
  });

  it('reconnects a retired connection with backoff', async () => {
    vi.useFakeTimers();
    let failNextSearch = true;
    const { pool } = makePool({ size: 1, readRetries: 0, reconnectBackoffMs: [100, 1000] }, (fake) => {
      fake.searchHandler = () => {
        if (failNextSearch) {
          failNextSearch = false;
          return Promise.reject(new ConnectionError('socket died'));
        }
        return Promise.resolve(searchResponse());
      };
    });
    await pool.start();

    await expect(pool.search('t', 'q')).rejects.toBeInstanceOf(ConnectionError);
    expect(pool.metrics().healthyConnections).toBe(0);

    // Advance past the initial backoff (100ms + up to 20% jitter).
    await vi.advanceTimersByTimeAsync(130);
    expect(pool.metrics().healthyConnections).toBe(1);

    const res = await pool.search('t', 'q');
    expect(res).toEqual(searchResponse());
    await pool.close();
  });

  it('throws when no connection can be established', async () => {
    const { pool } = makePool({ size: 2 }, (fake) => {
      fake.connectShouldFail = true;
    });
    await expect(pool.start()).rejects.toBeInstanceOf(ConnectionError);
    await pool.close();
  });

  it('rejects queued callers and disconnects on close', async () => {
    const gate = deferred<SearchResponse>();
    const { pool, created } = makePool({ size: 1 }, (fake) => {
      fake.searchHandler = () => gate.promise;
    });
    await pool.start();

    const running = pool.search('t', 'a');
    running.catch(() => {});
    await flushMicrotasks();
    const queued = pool.search('t', 'b');

    await pool.close();
    await expect(queued).rejects.toBeInstanceOf(ConnectionError);
    expect(created[0].isConnected()).toBe(false);
    expect(pool.metrics().healthyConnections).toBe(0);
  });

  it('retires a slot on timeout but does not retry (server may have executed)', async () => {
    const { pool } = makePool({ size: 2, readRetries: 1 }, (fake, index) => {
      if (index === 0) {
        fake.searchHandler = () => Promise.reject(new TimeoutError('command timeout'));
      }
    });
    await pool.start();

    await expect(pool.search('t', 'q')).rejects.toBeInstanceOf(TimeoutError);
    const metrics = pool.metrics();
    expect(metrics.reconnects).toBe(1); // slot retired
    expect(metrics.failed).toBe(1);
    await pool.close();
  });

  it('throws the connection error once retries are exhausted', async () => {
    const { pool } = makePool({ size: 2, readRetries: 1 }, (fake) => {
      fake.searchHandler = () => Promise.reject(new ConnectionError('socket died'));
    });
    await pool.start();

    // Initial attempt on slot 0 + one retry on slot 1, both fail.
    await expect(pool.search('t', 'q')).rejects.toBeInstanceOf(ConnectionError);
    const metrics = pool.metrics();
    expect(metrics.reconnects).toBe(2); // both slots retired
    expect(metrics.failed).toBe(1); // counted once, after retries
    await pool.close();
  });

  it('does not retry a non-idempotent withClient operation', async () => {
    let calls = 0;
    const { pool } = makePool({ size: 2 });
    await pool.start();

    await expect(
      pool.withClient(() => {
        calls += 1;
        return Promise.reject(new ConnectionError('socket died'));
      })
    ).rejects.toBeInstanceOf(ConnectionError);

    expect(calls).toBe(1); // no retry despite a spare slot
    expect(pool.metrics().reconnects).toBe(1);
    await pool.close();
  });

  it('treats a second start() as a no-op', async () => {
    const { pool, created } = makePool({ size: 2 });
    await pool.start();
    await pool.start();

    expect(created).toHaveLength(2); // not re-opened
    expect(pool.metrics().healthyConnections).toBe(2);
    await pool.close();
  });

  it('serves a queued caller once a retired slot reconnects', async () => {
    vi.useFakeTimers();
    let failNext = true;
    const { pool } = makePool({ size: 1, readRetries: 0, reconnectBackoffMs: [100, 1000] }, (fake) => {
      fake.searchHandler = () => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new ConnectionError('socket died'));
        }
        return Promise.resolve(searchResponse());
      };
    });
    await pool.start();

    // Kill the only slot; no free connection remains.
    await expect(pool.search('t', 'a')).rejects.toBeInstanceOf(ConnectionError);
    // This caller has to wait for the reconnect to complete.
    const queued = pool.search('t', 'b');
    await flushMicrotasks();
    expect(pool.metrics().queueDepth).toBe(1);

    await vi.advanceTimersByTimeAsync(130);
    await expect(queued).resolves.toEqual(searchResponse());
    await pool.close();
  });

  it('sheds immediately when maxQueue is 0', async () => {
    const gate = deferred<SearchResponse>();
    const { pool } = makePool({ size: 1, maxQueue: 0 }, (fake) => {
      fake.searchHandler = () => gate.promise;
    });
    await pool.start();

    const running = pool.search('t', 'a'); // occupies the single slot
    running.catch(() => {});
    await flushMicrotasks();

    await expect(pool.search('t', 'b')).rejects.toBeInstanceOf(PoolOverloadError);
    await pool.close();
  });

  it('dispatches queued callers in FIFO order', async () => {
    const gate = deferred<SearchResponse>();
    let gated = false;
    const { pool, counters } = makePool({ size: 1 }, (fake) => {
      fake.searchHandler = () => {
        if (!gated) {
          gated = true;
          return gate.promise;
        }
        return Promise.resolve(searchResponse());
      };
    });
    await pool.start();

    const first = pool.search('t', 'a'); // occupies the slot, blocked on the gate
    await flushMicrotasks();
    const second = pool.search('t', 'b');
    const third = pool.search('t', 'c');
    await flushMicrotasks();

    gate.resolve(searchResponse());
    await Promise.all([first, second, third]);

    expect(counters.order).toEqual(['a', 'b', 'c']);
    await pool.close();
  });

  it('retires an idle connection that fails a keep-alive ping', async () => {
    vi.useFakeTimers();
    const { pool } = makePool({ size: 1, keepAliveIntervalMs: 1000 }, (fake, index) => {
      if (index === 0) {
        fake.infoHandler = () => Promise.reject(new ConnectionError('idle socket died'));
      }
    });
    await pool.start();
    expect(pool.metrics().healthyConnections).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    const metrics = pool.metrics();
    expect(metrics.healthyConnections).toBe(0);
    expect(metrics.reconnects).toBe(1);
    await pool.close();
  });

  it('delegates count, get and facet to a pooled client', async () => {
    const { pool } = makePool({ size: 2 });
    await pool.start();

    await expect(pool.count('t', 'q')).resolves.toEqual({ count: 0 });
    await expect(pool.get('t', '1')).resolves.toEqual({ primaryKey: 'x', fields: {} });
    await expect(pool.facet('t', 'c')).resolves.toEqual({ results: [] });
    expect(pool.metrics().completed).toBe(3);
    await pool.close();
  });

  it('records completed commands and reports latency percentiles', async () => {
    const { pool } = makePool({ size: 2 });
    await pool.start();

    for (let i = 0; i < 5; i += 1) {
      await pool.search('t', 'q');
    }
    const metrics = pool.metrics();
    expect(metrics.completed).toBe(5);
    expect(metrics.failed).toBe(0);
    expect(metrics.latencyP50Ms).toBeGreaterThanOrEqual(0);
    expect(metrics.latencyP99Ms).toBeGreaterThanOrEqual(metrics.latencyP50Ms);
    await pool.close();
  });

  it('delegates the highlight and raw search variants', async () => {
    const { pool } = makePool({ size: 2 });
    await pool.start();

    await expect(pool.searchWithHighlights('t', 'q')).resolves.toEqual(searchResponse());
    await expect(pool.searchRaw('t', 'a OR b')).resolves.toEqual(searchResponse());
    await expect(pool.searchRawWithHighlights('t', 'a OR b')).resolves.toEqual(searchResponse());
    expect(pool.metrics().completed).toBe(3);
    await pool.close();
  });

  it('rejects new work after close()', async () => {
    const { pool } = makePool({ size: 1 });
    await pool.start();
    await pool.close();

    await expect(pool.search('t', 'q')).rejects.toBeInstanceOf(ConnectionError);
  });

  it('emits metrics on the configured interval', async () => {
    vi.useFakeTimers();
    const samples: number[] = [];
    const { pool } = makePool({
      size: 1,
      metricsIntervalMs: 1000,
      onMetrics: (m) => samples.push(m.completed)
    });
    await pool.start();
    await pool.search('t', 'q');

    await vi.advanceTimersByTimeAsync(1000);
    expect(samples.length).toBeGreaterThanOrEqual(1);
    expect(samples[samples.length - 1]).toBe(1);
    await pool.close();
  });

  it('keeps a connection healthy when a keep-alive ping succeeds', async () => {
    vi.useFakeTimers();
    const { pool } = makePool({ size: 1, keepAliveIntervalMs: 1000 });
    await pool.start();

    await vi.advanceTimersByTimeAsync(1000);
    const metrics = pool.metrics();
    expect(metrics.healthyConnections).toBe(1);
    expect(metrics.reconnects).toBe(0);
    expect(metrics.inFlight).toBe(0); // released after the ping
    await pool.close();
  });

  it('escalates the reconnect backoff after repeated connect failures', async () => {
    vi.useFakeTimers();
    let reconnectAttempts = 0;
    const { pool } = makePool({ size: 1, readRetries: 0, reconnectBackoffMs: [100, 1000] }, (fake, index) => {
      if (index === 0) {
        fake.searchHandler = () => Promise.reject(new ConnectionError('socket died'));
        return;
      }
      // Reconnect clients: fail the first two connects, then succeed.
      fake.connectShouldFail = reconnectAttempts < 2;
      reconnectAttempts += 1;
    });
    await pool.start();

    await expect(pool.search('t', 'q')).rejects.toBeInstanceOf(ConnectionError);

    await vi.advanceTimersByTimeAsync(130); // 1st backoff (~100ms) -> connect fails
    expect(pool.metrics().healthyConnections).toBe(0);
    await vi.advanceTimersByTimeAsync(260); // 2nd backoff (~200ms) -> connect fails
    expect(pool.metrics().healthyConnections).toBe(0);
    await vi.advanceTimersByTimeAsync(500); // 3rd backoff (~400ms) -> connect succeeds
    expect(pool.metrics().healthyConnections).toBe(1);
    await pool.close();
  });

  it('reports background reconnect failures through onError', async () => {
    vi.useFakeTimers();
    const errors: Error[] = [];
    let reconnectAttempts = 0;
    const { pool } = makePool(
      { size: 1, readRetries: 0, reconnectBackoffMs: [100, 1000], onError: (e) => errors.push(e) },
      (fake, index) => {
        if (index === 0) {
          fake.searchHandler = () => Promise.reject(new ConnectionError('socket died'));
          return;
        }
        fake.connectShouldFail = reconnectAttempts < 1; // first reconnect fails, next succeeds
        reconnectAttempts += 1;
      }
    );
    await pool.start();

    await expect(pool.search('t', 'q')).rejects.toBeInstanceOf(ConnectionError);
    await vi.advanceTimersByTimeAsync(130); // reconnect attempt fails -> onError
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toBeInstanceOf(ConnectionError);

    await vi.advanceTimersByTimeAsync(260); // next attempt succeeds
    expect(pool.metrics().healthyConnections).toBe(1);
    await pool.close();
  });

  it('rejects a lazy start when unreachable, then retries on a later query', async () => {
    // Keep the background reconnect timer far out so the slot client is not
    // swapped mid-test; the retry path we assert is the lazy start re-run.
    const { pool, created } = makePool({ size: 1, reconnectBackoffMs: [100000, 100000] }, (fake) => {
      fake.connectShouldFail = true;
    });

    await expect(pool.search('t', 'a')).rejects.toBeInstanceOf(ConnectionError);

    created[0].connectShouldFail = false; // "server" recovers
    const res = await pool.search('t', 'b'); // memo was cleared -> start() retried
    expect(res).toEqual(searchResponse());
    await pool.close();
  });

  it('retries an idempotent read across distinct slots up to readRetries times', async () => {
    // First two slots die; with readRetries=2 the third attempt lands on a live
    // slot, so the read still succeeds after both retries.
    const { pool } = makePool({ size: 3, readRetries: 2, reconnectBackoffMs: [100000, 100000] }, (fake, index) => {
      if (index < 2) {
        fake.searchHandler = () => Promise.reject(new ConnectionError('socket died'));
      }
    });
    await pool.start();

    const res = await pool.search('t', 'q');
    expect(res).toEqual(searchResponse());
    const metrics = pool.metrics();
    expect(metrics.reconnects).toBe(2); // both failed slots retired
    expect(metrics.completed).toBe(1);
    expect(metrics.failed).toBe(0); // never surfaced to the caller
    await pool.close();
  });

  it('retries an idempotent withClient operation on connection loss', async () => {
    let calls = 0;
    const { pool } = makePool({ size: 2, readRetries: 1 });
    await pool.start();

    const res = await pool.withClient(
      () => {
        calls += 1;
        // Fail the first borrow, succeed on the retry against another slot.
        return calls === 1 ? Promise.reject(new ConnectionError('socket died')) : Promise.resolve('ok');
      },
      { idempotent: true }
    );

    expect(res).toBe('ok');
    expect(calls).toBe(2); // one retry
    expect(pool.metrics().reconnects).toBe(1); // the failed slot was retired
    await pool.close();
  });

  it('caps the retained latency sample window', async () => {
    const { pool } = makePool({ size: 4 });
    await pool.start();

    // Drive past LATENCY_SAMPLE_CAP (1024) so the ring buffer starts shifting.
    for (let i = 0; i < 1030; i += 1) {
      await pool.search('t', 'q');
    }

    const latencies = (pool as unknown as { latencies: number[] }).latencies;
    expect(latencies.length).toBe(1024); // bounded, not unbounded growth
    expect(pool.metrics().completed).toBe(1030);
    await pool.close();
  });

  it('lets an in-flight command settle after close()', async () => {
    const gate = deferred<SearchResponse>();
    const { pool } = makePool({ size: 1 }, (fake) => {
      fake.searchHandler = () => gate.promise;
    });
    await pool.start();

    const inflight = pool.search('t', 'a');
    await flushMicrotasks(); // the command is now on the wire

    await pool.close(); // close while it is still running
    gate.resolve(searchResponse());

    // Per the close() contract, in-flight commands are left to settle rather
    // than being aborted.
    await expect(inflight).resolves.toEqual(searchResponse());
    expect(pool.metrics().completed).toBe(1);
  });
});

interface EventRecord {
  event: PoolEvent;
  payload: Record<string, unknown>;
}

describe('MygramPool circuit breaker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens after failureThreshold consecutive connection errors and then fails fast', async () => {
    // Ample slots and a far-out reconnect keep a healthy slot available for each
    // failing attempt, so the breaker - not slot exhaustion - drives the outcome.
    const { pool, counters } = makePool(
      { size: 5, readRetries: 0, reconnectBackoffMs: [100000, 100000], circuitBreaker: { failureThreshold: 2 } },
      (fake) => {
        fake.searchHandler = () => Promise.reject(new ConnectionError('socket died'));
      }
    );
    await pool.start();

    await expect(pool.search('t', 'a')).rejects.toBeInstanceOf(ConnectionError);
    await expect(pool.search('t', 'b')).rejects.toBeInstanceOf(ConnectionError);
    expect(counters.order).toHaveLength(2);

    // The breaker is open: the next call fails fast before acquiring a slot, so
    // the underlying search is never invoked and no third slot is retired.
    await expect(pool.search('t', 'c')).rejects.toBeInstanceOf(CircuitOpenError);
    expect(counters.order).toHaveLength(2);
    expect(pool.metrics().reconnects).toBe(2);
    await pool.close();
  });

  it('goes half-open after resetTimeoutMs and closes on a successful trial', async () => {
    let shouldFail = true;
    const states: string[] = [];
    const { pool } = makePool(
      {
        size: 5,
        readRetries: 0,
        reconnectBackoffMs: [100000, 100000],
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 20 },
        onEvent: (event, payload) => {
          if (event === 'breaker_state_change') states.push(payload.state as string);
        }
      },
      (fake) => {
        fake.searchHandler = () =>
          shouldFail ? Promise.reject(new ConnectionError('socket died')) : Promise.resolve(searchResponse());
      }
    );
    await pool.start();

    await expect(pool.search('t', 'a')).rejects.toBeInstanceOf(ConnectionError);
    await expect(pool.search('t', 'b')).rejects.toBeInstanceOf(ConnectionError);
    await expect(pool.search('t', 'c')).rejects.toBeInstanceOf(CircuitOpenError);

    shouldFail = false;
    await new Promise((resolve) => setTimeout(resolve, 40)); // reset window elapses

    // The half-open trial runs and succeeds, closing the breaker; later calls flow.
    await expect(pool.search('t', 'd')).resolves.toEqual(searchResponse());
    await expect(pool.search('t', 'e')).resolves.toEqual(searchResponse());

    expect(states).toEqual(['open', 'half-open', 'closed']);
    await pool.close();
  });

  it('re-opens when the half-open trial fails', async () => {
    const states: string[] = [];
    const { pool } = makePool(
      {
        size: 5,
        readRetries: 0,
        reconnectBackoffMs: [100000, 100000],
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 20 },
        onEvent: (event, payload) => {
          if (event === 'breaker_state_change') states.push(payload.state as string);
        }
      },
      (fake) => {
        fake.searchHandler = () => Promise.reject(new ConnectionError('socket died'));
      }
    );
    await pool.start();

    await expect(pool.search('t', 'a')).rejects.toBeInstanceOf(ConnectionError);
    await expect(pool.search('t', 'b')).rejects.toBeInstanceOf(ConnectionError);
    await new Promise((resolve) => setTimeout(resolve, 40));

    // The half-open trial fails, so the breaker re-opens and fails fast again.
    await expect(pool.search('t', 'c')).rejects.toBeInstanceOf(ConnectionError);
    await expect(pool.search('t', 'd')).rejects.toBeInstanceOf(CircuitOpenError);

    expect(states).toEqual(['open', 'half-open', 'open']);
    await pool.close();
  });

  it('allows only a single trial while half-open', async () => {
    const gate = deferred<SearchResponse>();
    let mode: 'fail' | 'gate' | 'ok' = 'fail';
    const { pool } = makePool(
      {
        size: 5,
        readRetries: 0,
        reconnectBackoffMs: [100000, 100000],
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 20 }
      },
      (fake) => {
        fake.searchHandler = () => {
          if (mode === 'fail') return Promise.reject(new ConnectionError('socket died'));
          if (mode === 'gate') return gate.promise;
          return Promise.resolve(searchResponse());
        };
      }
    );
    await pool.start();

    await expect(pool.search('t', 'a')).rejects.toBeInstanceOf(ConnectionError);
    await expect(pool.search('t', 'b')).rejects.toBeInstanceOf(ConnectionError);
    await new Promise((resolve) => setTimeout(resolve, 40));

    mode = 'gate';
    const trial = pool.search('t', 'c'); // becomes the single in-flight half-open trial
    await flushMicrotasks();

    // A concurrent call while the trial is in flight is rejected fast.
    await expect(pool.search('t', 'd')).rejects.toBeInstanceOf(CircuitOpenError);

    gate.resolve(searchResponse());
    await expect(trial).resolves.toEqual(searchResponse());
    await pool.close();
  });

  it('does not trip the breaker on a ProtocolError', async () => {
    const { pool } = makePool({ size: 1, circuitBreaker: { failureThreshold: 1 } }, (fake) => {
      fake.searchHandler = () => Promise.reject(new ProtocolError('bad query'));
    });
    await pool.start();

    await expect(pool.search('t', 'a')).rejects.toBeInstanceOf(ProtocolError);
    // Would be CircuitOpenError if the ProtocolError had tripped the breaker.
    await expect(pool.search('t', 'b')).rejects.toBeInstanceOf(ProtocolError);
    await pool.close();
  });

  it('does not trip the breaker on a PoolOverloadError', async () => {
    const gate = deferred<SearchResponse>();
    const { pool } = makePool({ size: 1, maxQueue: 0, circuitBreaker: { failureThreshold: 1 } }, (fake) => {
      fake.searchHandler = () => gate.promise;
    });
    await pool.start();

    const running = pool.search('t', 'a'); // occupies the single slot
    running.catch(() => {});
    await flushMicrotasks();

    await expect(pool.search('t', 'b')).rejects.toBeInstanceOf(PoolOverloadError);
    // Still closed: another overload, not a fast-fail CircuitOpenError.
    await expect(pool.search('t', 'c')).rejects.toBeInstanceOf(PoolOverloadError);

    gate.resolve(searchResponse());
    await running;
    await pool.close();
  });
});

describe('MygramPool onEvent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits an acquire event carrying a numeric waitMs', async () => {
    const events: EventRecord[] = [];
    const { pool } = makePool({ size: 1, onEvent: (event, payload) => events.push({ event, payload }) });
    await pool.start();

    await pool.search('t', 'q');

    const acquire = events.find((e) => e.event === 'acquire');
    expect(acquire).toBeDefined();
    expect(typeof acquire?.payload.waitMs).toBe('number');
    await pool.close();
  });

  it('emits retry and connection_discarded on an idempotent read retry', async () => {
    const events: EventRecord[] = [];
    const { pool } = makePool(
      { size: 2, readRetries: 1, onEvent: (event, payload) => events.push({ event, payload }) },
      (fake, index) => {
        if (index === 0) {
          fake.searchHandler = () => Promise.reject(new ConnectionError('socket died'));
        }
      }
    );
    await pool.start();

    await expect(pool.search('t', 'q')).resolves.toEqual(searchResponse());

    const retry = events.find((e) => e.event === 'retry');
    expect(retry?.payload.attempt).toBe(1);
    expect(retry?.payload.error).toBeInstanceOf(ConnectionError);
    expect(events.some((e) => e.event === 'connection_discarded')).toBe(true);
    await pool.close();
  });

  it('emits breaker_state_change with the new state when the breaker opens', async () => {
    const events: EventRecord[] = [];
    const { pool } = makePool(
      {
        size: 2,
        readRetries: 0,
        reconnectBackoffMs: [100000, 100000],
        circuitBreaker: { failureThreshold: 1 },
        onEvent: (event, payload) => events.push({ event, payload })
      },
      (fake) => {
        fake.searchHandler = () => Promise.reject(new ConnectionError('socket died'));
      }
    );
    await pool.start();

    await expect(pool.search('t', 'q')).rejects.toBeInstanceOf(ConnectionError);

    const change = events.find((e) => e.event === 'breaker_state_change');
    expect(change?.payload.state).toBe('open');
    await pool.close();
  });

  it('swallows errors thrown by the onEvent callback', async () => {
    const { pool } = makePool({
      size: 1,
      onEvent: () => {
        throw new Error('instrumentation boom');
      }
    });
    await pool.start();

    await expect(pool.search('t', 'q')).resolves.toEqual(searchResponse());
    await pool.close();
  });
});
