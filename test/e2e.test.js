import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'production';

const {
  LazyLayersCache,
  MemoryStore,
  RedisStore,
  RedisEventBus,
  CircuitBreaker,
  createObservabilityHandler,
  serialize,
  deserialize,
  serializeWithStats,
} = await import('../dist/index.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(2);
  }
  assert.fail('Condition timed out');
}

/**
 * High-fidelity Fake Redis that supports pipelines, pub/sub fanout, key indexing, and simulated latency/errors.
 */
class SharedFakeRedis {
  constructor(state = null) {
    this.status = 'ready';
    if (state) {
      this.state = state;
    } else {
      this.state = {
        storage: new Map(),
        zsets: new Map(),
        subscribers: new Map(),
        listeners: new Set(),
      };
    }
    this.failNext = null;
  }

  get storage() { return this.state.storage; }
  get zsets() { return this.state.zsets; }
  get subscribers() { return this.state.subscribers; }
  get listeners() { return this.state.listeners; }

  duplicate() {
    return new SharedFakeRedis(this.state);
  }

  async ping() {
    return 'PONG';
  }

  pipeline() {
    const ops = [];
    const self = this;
    return {
      set(...args) { ops.push(['set', args]); return this; },
      zadd(...args) { ops.push(['zadd', args]); return this; },
      zrem(...args) { ops.push(['zrem', args]); return this; },
      del(...args) { ops.push(['del', args]); return this; },
      unlink(...args) { ops.push(['unlink', args]); return this; },
      pttl(...args) { ops.push(['pttl', args]); return this; },
      getBuffer(...args) { ops.push(['getBuffer', args]); return this; },
      async exec() {
        if (self.failNext) {
          const err = self.failNext;
          self.failNext = null;
          throw err;
        }
        const results = [];
        for (const [op, args] of ops) {
          results.push([null, await self[op](...args)]);
        }
        return results;
      },
    };
  }

  async getBuffer(key) {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const val = this.storage.get(key);
    return val !== undefined ? Buffer.from(val) : null;
  }

  async get(key) {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const val = this.storage.get(key);
    return val !== undefined ? val.toString('utf8') : null;
  }

  async set(key, value, ...rest) {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const isNx = rest.includes('NX');
    if (isNx && this.storage.has(key)) {
      return null;
    }
    this.storage.set(key, Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value)));
    return 'OK';
  }

  async del(...keys) {
    let count = 0;
    for (const k of keys) {
      if (this.storage.delete(k)) count++;
    }
    return count;
  }

  async unlink(...keys) {
    return this.del(...keys);
  }

  async pttl(key) {
    return 60000;
  }

  async eval(script, numkeys, key, token) {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const val = this.storage.get(key);
    if (val && val.toString('utf8') === String(token)) {
      this.storage.delete(key);
      return 1;
    }
    return 0;
  }

  async zadd(key, score, member) {
    if (!this.zsets.has(key)) this.zsets.set(key, new Map());
    this.zsets.get(key).set(member, Number(score));
    return 1;
  }

  async zrem(key, ...members) {
    const z = this.zsets.get(key);
    if (!z) return 0;
    let count = 0;
    for (const m of members) {
      if (z.delete(m)) count++;
    }
    return count;
  }

  async zrangebyscore(key, min, max) {
    const z = this.zsets.get(key);
    if (!z) return [];
    const minVal = min === '-inf' ? -Infinity : Number(min);
    const maxVal = max === '+inf' ? Infinity : Number(max);
    const res = [];
    for (const [member, score] of z.entries()) {
      if (score >= minVal && score <= maxVal) {
        res.push(member);
      }
    }
    return res;
  }

  async zrange(key, start, stop) {
    const z = this.zsets.get(key);
    if (!z) return [];
    const members = Array.from(z.keys());
    const startIdx = Number(start);
    const stopIdx = Number(stop);
    return members.slice(startIdx, stopIdx < 0 ? undefined : stopIdx + 1);
  }

  async zcard(key) {
    const z = this.zsets.get(key);
    return z ? z.size : 0;
  }

  async *zscanStream(key, options = {}) {
    const z = this.zsets.get(key);
    if (!z) return;
    const match = options.match ? new RegExp('^' + options.match.replace(/\*/g, '.*') + '$') : null;
    const entries = [];
    for (const [member, score] of z.entries()) {
      if (!match || match.test(member)) {
        entries.push(member, String(score));
      }
    }
    if (entries.length > 0) {
      yield entries;
    }
  }

  async *scanStream(options = {}) {
    const match = options.match ? new RegExp('^' + options.match.replace(/\*/g, '.*') + '$') : null;
    const keys = [];
    for (const k of this.storage.keys()) {
      if (!match || match.test(k)) {
        keys.push(k);
      }
    }
    if (keys.length > 0) {
      yield keys;
    }
  }

  async dbsize() {
    return this.storage.size;
  }

  async publish(channel, message) {
    const msgBuf = Buffer.isBuffer(message) ? message : Buffer.from(message);
    const chanBuf = Buffer.from(channel);
    for (const fn of this.listeners) {
      queueMicrotask(() => fn(chanBuf, msgBuf));
    }
    return this.listeners.size;
  }

  async subscribe(channel) {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, new Set());
    }
  }

  on(event, listener) {
    if (event === 'message' || event === 'messageBuffer') {
      this.listeners.add(listener);
    }
  }

  off(event, listener) {
    if (event === 'message' || event === 'messageBuffer') {
      this.listeners.delete(listener);
    }
  }
}

/* ── 1. End-to-End Multi-Node Stampede Collapse & L1 Priming ────────── */

test('E2E: 5-Node Cluster concurrent stampede & automatic L1 priming', async () => {
  const sharedRedis = new SharedFakeRedis();
  const channel = 'cache.events';

  const nodes = [];
  for (let i = 1; i <= 5; i++) {
    const bus = new RedisEventBus(sharedRedis, channel);
    await bus.connect();
    const node = new LazyLayersCache({
      source: `node-${i}`,
      l2: new RedisStore(sharedRedis, { prefix: 'test:' }),
      eventBus: bus,
      broadcastSet: true,
      ttlMs: 60_000,
      logging: { env: 'production' },
    });
    nodes.push(node);
  }

  let dbLoaderExecutions = 0;
  const expensiveLoader = async () => {
    dbLoaderExecutions++;
    await sleep(20); // simulate slow database query
    return { id: 42, username: 'octocat', plan: 'enterprise' };
  };

  // Launch 50 concurrent requests simultaneously across all 5 nodes for the exact same cold key
  const requests = [];
  for (let req = 0; req < 50; req++) {
    const node = nodes[req % nodes.length];
    requests.push(node.getOrSet('user:42', expensiveLoader));
  }

  const results = await Promise.all(requests);

  // Every single caller must receive the exact valid data
  for (const res of results) {
    assert.deepEqual(res, { id: 42, username: 'octocat', plan: 'enterprise' });
  }

  // Exactly 1 loader should have been executed on the primary node
  assert.equal(dbLoaderExecutions, 1);

  // Wait for set-priming broadcast to settle across peer nodes
  await waitFor(async () => {
    for (const n of nodes) {
      if (!(await n.l1?.has('user:42'))) return false;
    }
    return true;
  }, 1000);

  // Assert that reads on ALL peer nodes are now immediate L1 hits without calling loader or L2
  for (const node of nodes) {
    assert.equal(await node.l1.has('user:42'), true);
    const val = await node.get('user:42');
    assert.deepEqual(val, { id: 42, username: 'octocat', plan: 'enterprise' });
  }
  assert.equal(dbLoaderExecutions, 1);
});

/* ── 2. Generation Fencing & Out-of-Order Message Resilience ─────────── */

test('E2E: Per-key generation counters reject out-of-order stale sets', async () => {
  const sharedRedis = new SharedFakeRedis();
  const channel = 'cache.events';

  const bus1 = new RedisEventBus(sharedRedis, channel);
  const bus2 = new RedisEventBus(sharedRedis, channel);
  await bus1.connect();
  await bus2.connect();

  const node1 = new LazyLayersCache({
    source: 'node-1',
    l2: new RedisStore(sharedRedis, { prefix: 'test:' }),
    eventBus: bus1,
    broadcastSet: true,
    ttlMs: 60_000,
    logging: { env: 'production' },
  });

  const node2 = new LazyLayersCache({
    source: 'node-2',
    l2: new RedisStore(sharedRedis, { prefix: 'test:' }),
    eventBus: bus2,
    broadcastSet: true,
    ttlMs: 60_000,
    logging: { env: 'production' },
  });

  // Node 1 primes the key at generation 1
  await node1.set('user:99', { name: 'Original', version: 1 });
  await sleep(10);

  // Node 2 deletes the key (advancing generation to 2)
  await node2.delete('user:99');
  assert.equal(await node2.get('user:99'), undefined);

  // Simulate an out-of-order late arrival of a stale 'set' event with generation 0
  await bus2.publish({
    type: 'set',
    id: 'stale-event-id-1',
    keys: ['user:99'],
    value: { name: 'Stale Resurrection', version: 1 },
    source: 'node-remote',
    generation: 0, // older than current generation (which was incremented after delete)
    ts: Date.now() - 1000,
  });

  await sleep(20);

  // Node 2 must have REJECTED the stale set and the key must still be deleted
  assert.equal(await node2.get('user:99'), undefined);
});

/* ── 3. Wildcard Pattern Invalidation Under Concurrent Load ─────────── */

test('E2E: Wildcard pattern invalidation clears matching keys across all nodes', async () => {
  const sharedRedis = new SharedFakeRedis();
  const channel = 'cache.events';

  const nodes = [];
  for (let i = 1; i <= 3; i++) {
    const bus = new RedisEventBus(sharedRedis, channel);
    await bus.connect();
    nodes.push(new LazyLayersCache({
      source: `node-${i}`,
      l2: new RedisStore(sharedRedis, { prefix: 'test:' }),
      eventBus: bus,
      ttlMs: 60_000,
      logging: { env: 'production' },
    }));
  }

  // Populate 30 user keys and 30 order keys across nodes
  for (let i = 1; i <= 30; i++) {
    await nodes[0].set(`user:${i}`, { uid: i });
    await nodes[1].set(`order:${i}`, { oid: i });
  }

  // Warm L1 on all nodes
  for (let i = 1; i <= 30; i++) {
    for (const node of nodes) {
      await node.get(`user:${i}`);
      await node.get(`order:${i}`);
    }
  }

  // Node 3 triggers a wildcard wipe for user:*
  await nodes[2].deleteByPattern('user:*');

  await sleep(30);

  // All user:* keys must be invalidated across every node's L1 and shared L2
  for (let i = 1; i <= 30; i++) {
    for (const node of nodes) {
      const userVal = await node.get(`user:${i}`);
      assert.equal(userVal, undefined, `user:${i} should be deleted on node`);
      const orderVal = await node.get(`order:${i}`);
      assert.deepEqual(orderVal, { oid: i }, `order:${i} should remain intact`);
    }
  }
});

/* ── 4. Fail-Open Resilience & Circuit Breaker Transitions ──────────── */

test('E2E: Circuit breaker trips on Redis failure, failing open without throwing', async () => {
  const sharedRedis = new SharedFakeRedis();
  const l2Store = new RedisStore(sharedRedis, { prefix: 'test:' });

  const cache = new LazyLayersCache({
    l2: l2Store,
    ttlMs: 60_000,
    circuitBreaker: {
      failureThreshold: 3,
      resetTimeoutMs: 50,
      halfOpenSuccessThreshold: 1,
    },
    logging: { env: 'production' },
  });

  // Successful warm write
  await cache.set('status:1', { active: true });
  assert.deepEqual(await cache.get('status:1'), { active: true });

  // Drop L1 so reads must hit L2
  cache.l1.clear();

  // Simulate repeated Redis failures
  sharedRedis.failNext = new Error('Redis connection lost ECONNREFUSED');
  let result1 = await cache.getOrSet('status:1', async () => ({ active: true, fromLoader: true }));
  assert.equal(result1.active, true);

  sharedRedis.failNext = new Error('Redis timeout ETIMEDOUT');
  let result2 = await cache.getOrSet('status:2', async () => ({ active: true, fromLoader: true }));
  assert.equal(result2.active, true);

  sharedRedis.failNext = new Error('Redis down');
  let result3 = await cache.getOrSet('status:3', async () => ({ active: true, fromLoader: true }));
  assert.equal(result3.active, true);

  // At this point, circuit breaker has recorded 3 failures and tripped OPEN
  // When OPEN, operations fail fast to origin loader without attempting Redis
  const loaderCalls = [];
  const resOpen = await cache.getOrSet('status:4', async () => {
    loaderCalls.push(4);
    return { active: true, key: 4 };
  });

  assert.deepEqual(resOpen, { active: true, key: 4 });
  assert.equal(loaderCalls.length, 1);

  // Wait for resetTimeoutMs so breaker transitions to HALF-OPEN
  await sleep(60);

  // Successful read recovers the circuit breaker to CLOSED
  const recovered = await cache.getOrSet('status:5', async () => ({ active: true, key: 5 }));
  assert.deepEqual(recovered, { active: true, key: 5 });
});

/* ── 5. Stale Fallback & Timeout AbortSignal Propagation ─────────────── */

test('E2E: Stale fallback serves previous L1 value when loader times out', async () => {
  const cache = new LazyLayersCache({
    ttlMs: 50,
    failSafe: {
      enabled: true,
      staleTtlMs: 5000,
    },
    timeouts: {
      hardMs: 40,
    },
    logging: { env: 'production' },
  });

  // Prime initial value
  await cache.set('config:api', { endpoint: 'https://api.v1.com', version: 1 });

  // Wait for TTL to expire (becomes stale)
  await sleep(60);

  let abortedSignalFired = false;
  // Slow loader that hangs past hardMs timeout
  const slowLoader = async ({ signal } = {}) => {
    if (signal) {
      signal.addEventListener('abort', () => {
        abortedSignalFired = true;
      });
    }
    await sleep(200); // Exceeds 40ms timeout
    return { endpoint: 'https://api.v2.com', version: 2 };
  };

  // getOrSet should return stale L1 value within hard timeout without throwing
  const result = await cache.getOrSet('config:api', slowLoader);
  assert.deepEqual(result, { endpoint: 'https://api.v1.com', version: 1 });

  await sleep(10);
  assert.equal(abortedSignalFired, true, 'AbortSignal should be triggered on timeout');
});

/* ── 6. Observability & Prometheus Metrics Endpoints ────────────────── */

test('E2E: Observability handler serves UI, JSON APIs, and Prometheus metrics', async () => {
  const cache = new LazyLayersCache({
    observability: {
      enabled: true,
      server: false,
      auth: { username: 'admin', password: 'secretpassword' },
      prometheus: { enabled: true, endpoint: '/__lazylayers/metrics' },
    },
    logging: { env: 'production' },
  });

  const handler = cache.getObservabilityHandler();
  assert.ok(handler, 'Observability handler should be defined');

  // Perform some cache activity
  await cache.set('sample:1', { text: 'Hello Observability' });
  await cache.get('sample:1'); // Hit
  await cache.get('sample:nonexistent'); // Miss

  // Helper for mock HTTP requests
  const mockReq = (url, headers = {}) => {
    return new Promise((resolve) => {
      const authHeader = 'Basic ' + Buffer.from('admin:secretpassword').toString('base64');
      const req = {
        url,
        method: 'GET',
        headers: { authorization: authHeader, ...headers },
        on() {},
      };
      let status = 200;
      let respHeaders = {};
      let body = '';
      const res = {
        writeHead(st, hdrs) { status = st; respHeaders = hdrs; return this; },
        end(data) { body = data ?? ''; resolve({ status, headers: respHeaders, body }); },
        setHeader(k, v) { respHeaders[k] = v; },
        write(data) { body += data ?? ''; return true; },
        headersSent: false,
        writable: true,
        writableEnded: false,
        on() {},
      };
      const handled = handler(req, res);
      if (!handled) {
        resolve({ status: 404, headers: {}, body: 'Not handled' });
      }
    });
  };

  // Test HTML Dashboard
  const dashRes = await mockReq('/__lazylayers');
  assert.equal(dashRes.status, 200);
  assert.match(dashRes.body, /observability/);

  // Test Dashboard Alias Route
  const aliasRes = await mockReq('/observelazyily');
  assert.equal(aliasRes.status, 200);
  assert.match(aliasRes.body, /observability/);

  // Test JSON Overview API
  const apiRes = await mockReq('/__lazylayers/api/overview');
  assert.equal(apiRes.status, 200);
  const data = JSON.parse(apiRes.body);
  assert.equal(data.hits >= 1, true);
  assert.equal(data.misses >= 1, true);

  // Test Prometheus Metrics Endpoint
  const promRes = await mockReq('/__lazylayers/metrics');
  assert.equal(promRes.status, 200);
  assert.match(promRes.body, /_hits_total/);
  assert.match(promRes.body, /_misses_total/);
});

/* ── 7. Serializer & Tiered Codec Integrity ─────────────────────────── */

test('E2E: Serializer size-tiering and 100% roundtrip fidelity across types', async () => {
  // Test case 1: Small payload (< 256 B) -> raw MessagePack (HC1M)
  const small = { id: 10, tag: 'micro' };
  const smallStats = serializeWithStats(small);
  assert.equal(smallStats.encoding, 'msgpack');
  assert.equal(smallStats.buffer.subarray(0, 4).toString('utf8'), 'HC1M');
  assert.deepEqual(deserialize(smallStats.buffer), small);

  // Test case 2: Medium payload (256 B - 4 KB) -> LZ4 (HC1L)
  const med = {
    records: Array.from({ length: 15 }, (_, i) => ({ id: i, label: `Item name ${i}`, desc: 'Detailed repeated text value for compression test' })),
  };
  const medStats = serializeWithStats(med);
  assert.equal(medStats.encoding, 'msgpack-lz4');
  assert.equal(medStats.buffer.subarray(0, 4).toString('utf8'), 'HC1L');
  assert.deepEqual(deserialize(medStats.buffer), med);

  // Test case 3: Large payload (>= 4 KB) -> Zstd (HC1Z) or LZ4 fallback
  const large = {
    catalog: Array.from({ length: 150 }, (_, i) => ({
      sku: `PROD-${i}`,
      title: `Super Fast Wireless Controller Model #${i}`,
      features: ['Bluetooth 5.3', 'Haptic Feedback', 'Low Latency', 'Rechargeable 20hr battery'],
      specs: { weightGrams: 280, color: 'Obsidian Black', warrantyMonths: 24 },
    })),
  };
  const largeStats = serializeWithStats(large);
  assert.match(largeStats.encoding, /msgpack-(zstd|lz4)/);
  const prefix = largeStats.buffer.subarray(0, 4).toString('utf8');
  assert.equal(prefix === 'HC1Z' || prefix === 'HC1L', true);
  assert.deepEqual(deserialize(largeStats.buffer), large);
  assert.equal(largeStats.compressed, true);
  assert.equal(largeStats.storedBytes < largeStats.originalBytes, true);
});
