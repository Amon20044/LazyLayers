import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

process.env.NODE_ENV = 'production';
const { createCache, MemoryStore, DistributedLockTimeoutError, DistributedLockLostError } = await import('../dist/index.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class LockingStore extends MemoryStore {
  locks = new Map();
  renewals = 0;

  owner(key) {
    const lock = this.locks.get(key);
    if (lock && lock.expiresAt <= Date.now()) this.locks.delete(key);
    return this.locks.get(key);
  }

  async acquireLock(key, token, ttlMs) {
    if (this.owner(key)) return false;
    this.locks.set(key, { token, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async releaseLock(key, token) {
    if (this.owner(key)?.token === token) this.locks.delete(key);
  }

  async renewLock(key, token, ttlMs) {
    if (this.owner(key)?.token !== token) return false;
    this.renewals++;
    this.locks.set(key, { token, expiresAt: Date.now() + ttlMs });
    return true;
  }
}

test('default getOrSet shares a refresh after expiry even when it exceeds the old two-second wait', async () => {
  const l2 = new LockingStore();
  const caches = Array.from({ length: 3 }, () => createCache({ l2 }));
  for (const cache of caches) await cache.set('hot', 'old', { ttlMs: 10 });
  await sleep(25);
  let calls = 0;
  const loader = async () => {
    calls++;
    await sleep(2_150);
    return 'fresh';
  };
  const values = await Promise.all(Array.from({ length: 90 }, (_, i) => caches[i % 3].getOrSet('hot', loader)));
  assert.deepEqual(values, Array(90).fill('fresh'));
  assert.equal(calls, 1);
  assert.equal(l2.locks.size, 0);
});

test('expiry in L1 alone refills from L2 without invoking the loader', async () => {
  const cache = createCache({ l2: new LockingStore(), levels: { L1: { ttlMs: 10 }, L2: { ttlMs: 1_000 } } });
  await cache.set('hot', 'cached');
  await sleep(25);
  assert.equal(await cache.getOrSet('hot', () => assert.fail('L2 still has the value')), 'cached');
});

test('slow loads renew their lease automatically and release it after completion', async () => {
  const l2 = new LockingStore();
  const options = { l2, distributedLock: { ttlMs: 150 }, timeouts: { hardMs: 2_000 } };
  const a = createCache(options);
  const b = createCache(options);
  let calls = 0;
  const load = async () => { calls++; await sleep(400); return 'fresh'; };
  const first = a.getOrSet('hot', load);
  await sleep(220);
  assert.deepEqual(await Promise.all([first, b.getOrSet('hot', load)]), ['fresh', 'fresh']);
  assert.equal(calls, 1);
  assert.ok(l2.renewals >= 2);
  assert.equal(l2.locks.size, 0);
  const renewals = l2.renewals;
  await sleep(160);
  assert.equal(l2.renewals, renewals, 'renewal timer must stop');
});

test('contention timeout rejects without running the loader and exposes an exported error', async () => {
  const l2 = new LockingStore();
  await l2.acquireLock('hot', 'owner', 1_000);
  const events = [];
  const cache = createCache({ l2, distributedLock: { waitTimeoutMs: 30, pollMs: 5 }, events: [(event) => events.push(event)] });
  await assert.rejects(cache.getOrSet('hot', () => assert.fail('must not load unlocked')), (error) => {
    assert.ok(error instanceof DistributedLockTimeoutError);
    assert.equal(error.code, 'DISTRIBUTED_LOCK_TIMEOUT');
    assert.equal(error.key, 'hot');
    assert.equal(error.waitTimeoutMs, 30);
    return true;
  });
  assert.ok(events.some((event) => event.type === 'lock:timeout'));
  await l2.releaseLock('hot', 'owner');
  assert.equal(await cache.getOrSet('hot', async () => 'recovered'), 'recovered');
});

test('contention timeout serves eligible stale data without refreshing its expiry', async () => {
  const l2 = new LockingStore();
  const cache = createCache({ l2, distributedLock: { waitTimeoutMs: 10, pollMs: 5 } });
  await cache.set('hot', 'stale', { ttlMs: 10 });
  await sleep(25);
  await l2.acquireLock('hot', 'owner', 1_000);
  assert.equal(await cache.getOrSet('hot', () => assert.fail('must not load')), 'stale');
  assert.equal(await cache.get('hot'), undefined);
  await assert.rejects(cache.getOrSet('hot', () => assert.fail('must not load'), { failSafe: { enabled: false } }), DistributedLockTimeoutError);
});

test('the old unlocked fallback remains an explicit per-call opt-in', async () => {
  const l2 = new LockingStore();
  await l2.acquireLock('hot', 'owner', 1_000);
  const cache = createCache({ l2, distributedLock: { waitTimeoutMs: 0 } });
  assert.equal(await cache.getOrSet('hot', async () => 'fallback', { distributedLock: { onTimeout: 'load' } }), 'fallback');
  assert.equal(l2.owner('hot').token, 'owner', 'fallback must not release another owner');
});

test('waiters retry a released lock after the original loader fails', async () => {
  const l2 = new LockingStore();
  const a = createCache({ l2 });
  const b = createCache({ l2 });
  const started = deferred();
  const finish = deferred();
  const first = a.getOrSet('hot', async () => { started.resolve(); return finish.promise; });
  const failed = assert.rejects(first, /origin failed/);
  await started.promise;
  const second = b.getOrSet('hot', async () => 'recovered');
  finish.reject(new Error('origin failed'));
  await failed;
  assert.equal(await second, 'recovered');
  assert.equal(l2.locks.size, 0);
});

test('waiters can take over an expired lock left by a crashed owner', async () => {
  const l2 = new LockingStore();
  await l2.acquireLock('hot', 'crashed', 40);
  const cache = createCache({ l2 });
  assert.equal(await cache.getOrSet('hot', async () => 'recovered'), 'recovered');
});

test('acquisition rechecks the cache to avoid loading a result published after the original miss', async () => {
  const l2 = new LockingStore();
  const acquire = l2.acquireLock.bind(l2);
  l2.acquireLock = async (...args) => {
    await l2.set('hot', 'published');
    return acquire(...args);
  };
  const cache = createCache({ l2 });
  assert.equal(await cache.getOrSet('hot', () => assert.fail('already refreshed')), 'published');
  assert.equal(l2.locks.size, 0);
});

test('initial Redis lock failure preserves fail-open behavior', async () => {
  const l2 = new LockingStore();
  l2.acquireLock = async () => { throw new Error('Redis unavailable'); };
  const cache = createCache({ l2 });
  assert.equal(await cache.getOrSet('hot', async () => 'origin'), 'origin');
});

test('Redis errors after observed contention do not bypass the known owner', async () => {
  const l2 = new LockingStore();
  let attempts = 0;
  l2.acquireLock = async () => {
    if (++attempts === 1) return false;
    throw new Error('Redis unavailable');
  };
  const cache = createCache({ l2, distributedLock: { waitTimeoutMs: 30, pollMs: 5 } });
  await assert.rejects(cache.getOrSet('hot', () => assert.fail('must not bypass owner')), DistributedLockTimeoutError);
});

test('lost ownership aborts the loader and prevents a late result from overwriting the new owner', async () => {
  const l2 = new LockingStore();
  const cache = createCache({ l2, failSafe: { enabled: false }, distributedLock: { ttlMs: 90 } });
  const started = deferred();
  const finish = deferred();
  let signal;
  const first = cache.getOrSet('hot', async (context) => {
    signal = context.signal;
    started.resolve();
    return finish.promise;
  });
  const failed = assert.rejects(first, DistributedLockLostError);
  await started.promise;
  l2.locks.set('hot', { token: 'new-owner', expiresAt: Date.now() + 1_000 });
  await failed;
  assert.equal(signal.aborted, true);
  await l2.set('hot', 'new');
  finish.resolve('obsolete');
  await sleep(10);
  assert.equal(await l2.get('hot'), 'new');
  assert.equal(l2.owner('hot').token, 'new-owner');
});

test('a hung renewal is bounded by the current lease deadline', async () => {
  const l2 = new LockingStore();
  l2.renewLock = () => new Promise(() => {});
  const cache = createCache({ l2, distributedLock: { ttlMs: 60 } });
  await assert.rejects(cache.getOrSet('hot', () => new Promise(() => {})), DistributedLockLostError);
});

test('custom stores without renewal remain compatible but cannot publish after their lease expires', async () => {
  const l2 = new LockingStore();
  l2.renewLock = undefined;
  const cache = createCache({ l2, distributedLock: { ttlMs: 50 } });
  await assert.rejects(cache.getOrSet('hot', async () => { await sleep(100); return 'late'; }), DistributedLockLostError);
  await sleep(60);
  assert.equal(await l2.get('hot'), undefined);
});

test('invalid lock timings reject rather than creating an unbounded wait', async () => {
  for (const distributedLock of [{ waitTimeoutMs: Infinity }, { pollMs: 0 }, { ttlMs: -1 }]) {
    const cache = createCache({ l2: new LockingStore(), distributedLock });
    await assert.rejects(cache.getOrSet('hot', () => assert.fail('invalid options')), RangeError);
  }
});

test('local default dedupe survives the former five-second entry lifetime', async () => {
  const cache = createCache();
  const started = deferred();
  const finish = deferred();
  let calls = 0;
  const loader = async () => { calls++; started.resolve(); return finish.promise; };
  const first = cache.getOrSet('slow', loader);
  await started.promise;
  await sleep(5_100);
  const second = cache.getOrSet('slow', loader);
  finish.resolve('fresh');
  assert.deepEqual(await Promise.all([first, second]), ['fresh', 'fresh']);
  assert.equal(calls, 1);
});

test('an older completion does not remove a replacement in-flight entry', async () => {
  const cache = createCache({ l1: false, negativeCache: { enabled: false } });
  const started = deferred();
  const firstFinish = deferred();
  const secondFinish = deferred();
  const first = cache.getOrSet('slow', async () => { started.resolve(); return firstFinish.promise; }, { inflight: { ttlMs: 1 } });
  await started.promise;
  await sleep(10);
  const secondStarted = deferred();
  const second = cache.getOrSet('slow', async () => { secondStarted.resolve(); return secondFinish.promise; });
  await secondStarted.promise;
  firstFinish.resolve(undefined);
  await first;
  const third = cache.getOrSet('slow', () => assert.fail('replacement must still be tracked'));
  secondFinish.resolve('fresh');
  assert.deepEqual(await Promise.all([second, third]), ['fresh', 'fresh']);
});
