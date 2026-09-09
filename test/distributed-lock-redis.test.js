import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

process.env.NODE_ENV = 'production';
const { createCache, RedisStore } = await import('../dist/index.js');
const { default: Redis } = await import('ioredis');

test('Redis lock renewal only extends a live lock owned by the supplied token', { skip: !process.env.REDIS_URL }, async (t) => {
  const client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
  const store = new RedisStore(client, { prefix: `renewal-test:${randomUUID()}:`, useIndex: false });
  t.after(async () => { await store.clear(); client.disconnect(); });
  await store.acquireLock('hot', 'owner', 150);
  assert.equal(await store.renewLock('hot', 'wrong', 1_000), false);
  assert.equal(await store.renewLock('hot', 'owner', 1_000), true);
  await sleep(200);
  assert.equal(await store.acquireLock('hot', 'contender', 100), false);
  await store.releaseLock('hot', 'owner');
  await store.acquireLock('hot', 'expired', 20);
  await sleep(40);
  assert.equal(await store.renewLock('hot', 'expired', 1_000), false);
  assert.equal(await store.acquireLock('hot', 'new-owner', 100), true);
  assert.equal(await store.renewLock('hot', 'expired', 1_000), false);
});

test('real Redis expiry herd shares one load without lock configuration', { skip: !process.env.REDIS_URL }, async (t) => {
  const prefix = `herd-test:${randomUUID()}:`;
  const clients = Array.from({ length: 3 }, () => new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 }));
  const stores = clients.map((client) => new RedisStore(client, { prefix, useIndex: false }));
  const caches = stores.map((l2) => createCache({ l2 }));
  t.after(async () => { await stores[0].clear(); clients.forEach((client) => client.disconnect()); });
  for (const cache of caches) await cache.set('hot', 'old', { ttlMs: 20 });
  await sleep(40);
  let calls = 0;
  const load = async () => { calls++; await sleep(2_150); return 'fresh'; };
  const results = await Promise.all(Array.from({ length: 60 }, (_, i) => caches[i % 3].getOrSet('hot', load)));
  assert.deepEqual(results, Array(60).fill('fresh'));
  assert.equal(calls, 1);
});

test('real Redis renews a slow loader beyond its original lease', { skip: !process.env.REDIS_URL }, async (t) => {
  const prefix = `slow-lock-test:${randomUUID()}:`;
  const clients = Array.from({ length: 2 }, () => new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 }));
  const stores = clients.map((client) => new RedisStore(client, { prefix, useIndex: false }));
  const caches = stores.map((l2) => createCache({ l2, distributedLock: { ttlMs: 150 } }));
  t.after(async () => { await stores[0].clear(); clients.forEach((client) => client.disconnect()); });
  let calls = 0;
  const load = async () => { calls++; await sleep(450); return 'fresh'; };
  const first = caches[0].getOrSet('hot', load);
  await sleep(250);
  assert.deepEqual(await Promise.all([first, caches[1].getOrSet('hot', load)]), ['fresh', 'fresh']);
  assert.equal(calls, 1);
  assert.equal(await stores[0].acquireLock('hot', 'after', 100), true, 'lock released after success');
});
