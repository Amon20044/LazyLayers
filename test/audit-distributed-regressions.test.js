import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { AuditRedis } from './helpers/audit-redis.mjs';

const { HybridCache, RedisStore, serialize } = await import(
  process.env.LAZY_LAYERS_AUDIT_ENTRY ?? '../dist/index.js'
);
const quiet = { enabled: false };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const budget = { timeout: 2_000 };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function memory(overrides = {}) {
  const entries = new Map();
  return {
    entries,
    async get(key) { return entries.get(key); },
    async set(key, value) { entries.set(key, value); },
    async has(key) { return entries.has(key); },
    async delete(key) { entries.delete(key); },
    async deleteByPattern() { entries.clear(); },
    async size() { return entries.size; },
    ...overrides,
  };
}

function bus() {
  let handler;
  let status;
  return {
    published: [],
    async subscribe(fn) { handler = fn; },
    async publish(event) { this.published.push(event); },
    onStatus(fn) { status = fn; return () => { status = undefined; }; },
    receive(event) { return handler(event); },
    status(value) { status?.(value); },
  };
}

function setEvent(value, extra = {}) {
  return { id: `set-${value}`, type: 'set', source: 'peer', ts: 1, keys: ['key'], generation: 0, value, ...extra };
}

test('audit: distinct concurrent fills all retain their own values', budget, async (t) => {
  const finish = deferred();
  const started = deferred();
  let active = 0;
  const cache = new HybridCache({ logging: quiet, failSafe: { enabled: false } });
  t.after(async () => { finish.resolve(); await cache.close(); });
  const operations = ['alpha', 'beta', 'gamma', 'delta'].map((key) => cache.getOrSet(key, async () => {
    if (++active === 4) started.resolve();
    await finish.promise;
    return key;
  }));
  await started.promise;
  finish.resolve();
  assert.deepEqual(await Promise.all(operations), ['alpha', 'beta', 'gamma', 'delta']);
  assert.deepEqual(await Promise.all(['alpha', 'beta', 'gamma', 'delta'].map((key) => cache.get(key))),
    ['alpha', 'beta', 'gamma', 'delta']);
});

test('audit: invalidation fences an origin fill already inside asynchronous L1 set', budget, async (t) => {
  const writing = deferred();
  const resume = deferred();
  const l1 = memory();
  l1.set = async (key, value) => { writing.resolve(); await resume.promise; l1.entries.set(key, value); };
  const cache = new HybridCache({ l1, logging: quiet, failSafe: { enabled: false } });
  t.after(async () => { resume.resolve(); await cache.close(); });
  const loading = cache.getOrSet('key', async () => 'obsolete');
  await writing.promise;
  await cache.delete('key');
  resume.resolve();
  await loading;
  assert.equal(await cache.get('key'), undefined);
});

test('audit: close aborts an active leader and its late result cannot repopulate state', budget, async (t) => {
  const started = deferred();
  const finish = deferred();
  let signal;
  const l1 = memory();
  const cache = new HybridCache({ l1, logging: quiet });
  t.after(async () => { finish.resolve('late'); await cache.close(); });
  const outcome = cache.getOrSet('key', async (context) => {
    signal = context.signal;
    started.resolve();
    return finish.promise;
  }).then((value) => ({ value }), (error) => ({ error }));
  await started.promise;
  await cache.close();
  finish.resolve('late');
  const result = await outcome;
  assert.equal(signal.aborted, true);
  assert.equal(result.value, 'late', 'An active loader that ignores abort keeps its caller response contract');
  assert.equal(l1.entries.has('key'), false);
  assert.equal(cache.getOriginLoadStats().closed, true);
});

test('audit: closed caches reject subsequent reads and writes', budget, async () => {
  const cache = new HybridCache({ logging: quiet });
  await cache.close();
  await assert.rejects(cache.set('key', 'value'), /closed/i);
  await assert.rejects(cache.get('key'), /closed/i);
  await assert.rejects(cache.delete('key'), /closed/i);
  await assert.rejects(cache.has('key'), /closed/i);
});

test('audit: numeric remote deletion clears numeric L1 state', budget, async (t) => {
  const events = bus();
  const cache = new HybridCache({ logging: quiet, eventBus: events });
  t.after(() => cache.close());
  await cache.ready();
  await cache.set(42, 'obsolete');
  await events.receive({ id: 'delete-number', type: 'del', keys: ['42'], keyTypes: ['number'], source: 'peer', ts: 1, generation: 1 });
  assert.equal(await cache.get(42), undefined);
});

test('audit: numeric peer priming clears the matching numeric negative cache', budget, async (t) => {
  const events = bus();
  const cache = new HybridCache({ logging: quiet, eventBus: events });
  t.after(() => cache.close());
  await cache.ready();
  await cache.getOrSet(42, async () => undefined);
  await events.receive(setEvent('fresh', { keys: ['42'], keyTypes: ['number'] }));
  assert.equal(await cache.get(42), 'fresh');
  assert.equal(await cache.get('42'), undefined, 'A numeric event must not write a separate string L1 key');
});

test('audit: equal-generation obsolete peer priming reconciles the authoritative L2 value', budget, async (t) => {
  const events = bus();
  const l2 = memory();
  l2.entries.set('key', 'winner');
  const cache = new HybridCache({ l2, logging: quiet, eventBus: events });
  t.after(() => cache.close());
  await cache.ready();
  await events.receive(setEvent('obsolete'));
  assert.equal(await cache.get('key'), 'winner');
});

test('audit: a fill started before subscription readiness cannot publish across initial reconciliation', budget, async (t) => {
  const acknowledgement = deferred(); const started = deferred(); const finish = deferred();
  const events = bus(); const subscribe = events.subscribe.bind(events);
  events.subscribe = async (handler) => { await subscribe(handler); await acknowledgement.promise; };
  const redis = new AuditRedis(); const store = new RedisStore(redis, { prefix: 'startup:', keyLayout: 'v2' });
  const cache = new HybridCache({ l2: store, eventBus: events, logging: quiet, failSafe: { enabled: false } });
  t.after(async () => { acknowledgement.resolve(); finish.resolve('before-ready'); await cache.close(); });
  let loads = 0;
  const early = cache.getOrSet('row', async () => { loads++; started.resolve(); return finish.promise; });
  await started.promise; acknowledgement.resolve(); await cache.ready(); finish.resolve('before-ready');
  assert.equal(await early, 'before-ready');
  assert.equal(await store.get('row'), undefined, 'Subscription reconciliation invalidates an earlier publication guard');
  assert.equal(await cache.getOrSet('row', async () => { loads++; return 'after-ready'; }), 'after-ready');
  assert.equal(loads, 2, 'Before-ready origin work may be uncached; initialize before a one-loader guarantee');
  assert.equal(await store.get('row'), 'after-ready');
});

test('audit: a key filled while waiting for an origin slot skips the queued loader', budget, async (t) => {
  const started = deferred();
  const finish = deferred();
  let queuedLoads = 0;
  const cache = new HybridCache({ logging: quiet, originLoad: { maxConcurrent: 1, maxQueued: 2, queueTimeoutMs: 500 } });
  t.after(async () => { finish.resolve('first'); await cache.close(); });
  const first = cache.getOrSet('first', async () => { started.resolve(); return finish.promise; });
  await started.promise;
  const queued = cache.getOrSet('queued', async () => { queuedLoads++; return 'unnecessary-origin'; });
  await tick();
  assert.equal(cache.getOriginLoadStats().queued, 1);
  await cache.set('queued', 'filled-while-queued');
  finish.resolve('first');
  await first;
  assert.equal(await queued, 'filled-while-queued');
  assert.equal(queuedLoads, 0);
  assert.equal(cache.getOriginLoadStats().active, 0);
});

test('audit: a queued leader whose lease expired leaves the queue without invoking origin', budget, async (t) => {
  const started = deferred();
  const finish = deferred();
  let queuedLoads = 0;
  let queuedOutcome;
  const l2 = memory();
  const locks = new Map();
  l2.acquireLock = async (key, token, ttlMs) => {
    const lock = locks.get(key);
    if (lock && lock.until > Date.now()) return false;
    locks.set(key, { token, until: Date.now() + ttlMs });
    return true;
  };
  l2.releaseLock = async (key, token) => { if (locks.get(key)?.token === token) locks.delete(key); };
  const cache = new HybridCache({
    l2, logging: quiet, failSafe: { enabled: false },
    originLoad: { maxConcurrent: 1, maxQueued: 2, queueTimeoutMs: 500 },
    distributedLock: { ttlMs: 40, waitTimeoutMs: 0, pollMs: 1 },
  });
  t.after(async () => { finish.resolve('first'); await cache.close(); });
  const first = cache.getOrSet('first', async () => { started.resolve(); return finish.promise; }, { distributedLock: { enabled: false } });
  await started.promise;
  const queued = cache.getOrSet('queued', async () => { queuedLoads++; return 'late'; })
    .then((value) => { queuedOutcome = { value }; }, (error) => { queuedOutcome = { error }; });
  await sleep(85);
  const queuedAfterExpiry = cache.getOriginLoadStats().queued;
  finish.resolve('first');
  await Promise.all([first, queued]);
  assert.equal(queuedAfterExpiry, 0, 'A lease-lost request must not remain queued until the origin slot opens');
  assert.ok(queuedOutcome.error);
  assert.equal(queuedLoads, 0);
});

test('audit: Redis v2 pattern invalidation fences a cold key containing only a lease', budget, async () => {
  const redis = new AuditRedis();
  const store = new RedisStore(redis, { prefix: 'isolated:', keyLayout: 'v2' });
  try {
    assert.equal(await store.acquireLock('cold:row', 'old-owner', 500), true);
    await store.deleteByPattern('cold:*');
    assert.equal(await store.publishIfOwner('cold:row', 'old-owner', serialize('obsolete'), 500), 'not-owner');
    assert.equal(await store.get('cold:row'), undefined);
  } finally { redis.values.clear(); }
});

test('audit: Redis v2 clear treats prefix glob characters as literal namespace bytes', budget, async () => {
  const redis = new AuditRedis();
  const a = new RedisStore(redis, { prefix: 'tenant*:', keyLayout: 'v2' });
  const b = new RedisStore(redis, { prefix: 'tenant-other:', keyLayout: 'v2' });
  try {
    await a.set('key', 'a');
    await b.set('key', 'b');
    await a.clear();
    assert.equal(await a.get('key'), undefined);
    assert.equal(await b.get('key'), 'b');
  } finally { redis.values.clear(); }
});

test('audit: Redis v2 direct delete removes admitted logical keys beginning with __', budget, async () => {
  const redis = new AuditRedis();
  const store = new RedisStore(redis, { prefix: 'isolated:', keyLayout: 'v2' });
  try {
    await store.set('__user:key', 'value');
    await store.delete('__user:key');
    assert.equal(await store.get('__user:key'), undefined);
  } finally { redis.values.clear(); }
});

test('audit: Redis owner rejection after lease expiration protects the newer value', budget, async () => {
  const redis = new AuditRedis();
  const a = new RedisStore(redis, { prefix: 'isolated:', keyLayout: 'v2' });
  const b = new RedisStore(redis, { prefix: 'isolated:', keyLayout: 'v2' });
  try {
    assert.equal(await a.acquireLock('key', 'former-owner', 500), true);
    const leaseKey = [...redis.values.keys()].find((key) => key.includes('__lock:'));
    redis.values.get(leaseKey).expiresAt = Date.now() - 1;
    assert.equal(await b.acquireLock('key', 'current-owner', 500), true);
    assert.equal(await b.publishIfOwner('key', 'current-owner', serialize('winner'), 500), 'published');
    assert.equal(await a.publishIfOwner('key', 'former-owner', serialize('obsolete'), 500), 'not-owner');
    assert.equal(await a.get('key'), 'winner');
  } finally { redis.values.clear(); }
});

test('audit: delivery recovery survives an unrelated write while L1 reconciliation is pending', budget, async (t) => {
  const events = bus();
  const flushing = deferred();
  let block = false;
  const l1 = memory();
  l1.deleteByPattern = async () => { if (block) await flushing.promise; l1.entries.clear(); };
  const cache = new HybridCache({ l1, logging: quiet, eventBus: events });
  t.after(async () => { flushing.resolve(); await cache.close(); });
  await cache.ready();
  events.status('disconnected');
  await tick();
  block = true;
  events.status('subscribed');
  await tick();
  await cache.set('unrelated', 'value');
  flushing.resolve();
  await tick();
  assert.equal(cache.isInvalidationTrusted(), true);
});

test('audit: unique absent-key invalidations have finite retained generation metadata', { timeout: 5_000 }, async (t) => {
  const cache = new HybridCache({ logging: quiet, failSafe: { enabled: false } });
  t.after(() => cache.close());
  for (let index = 0; index < 10_128; index++) await cache.delete(`absent-${index}`);
  assert.ok(cache.generations.size <= 10_000, 'Deletion tombstones must have a hard finite cap');
});
