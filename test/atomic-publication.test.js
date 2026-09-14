import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'production';

const {
  DistributedLockLostError,
  createCache,
  deserialize,
  RedisStore,
  serialize,
} = await import('../dist/index.js');

class ScriptPipeline {
  constructor(redis) {
    this.redis = redis;
    this.operations = [];
  }

  set(...args) { this.operations.push(['set', args]); return this; }
  zadd(...args) { this.operations.push(['zadd', args]); return this; }

  async exec() {
    return Promise.all(this.operations.map(async ([name, args]) => [null, await this.redis[name](...args)]));
  }
}

/** Small Redis double that executes the registered command contracts. */
class ScriptRedis {
  constructor() {
    this.status = 'ready';
    this.values = new Map();
    this.definitions = new Map();
    this.defineCalls = [];
    this.scriptCalls = [];
    this.evalCalls = 0;
    this.failScriptOnceFor = new Set();
  }

  defineCommand(name, definition) {
    this.defineCalls.push({ name, definition });
    this.definitions.set(name, definition);
    this[name] = async (...args) => this.runScript(name, args);
    this[`${name}Buffer`] = async (...args) => this.runScript(name, args);
  }

  failScriptOnce(name) { this.failScriptOnceFor.add(name); }

  pipeline() { return new ScriptPipeline(this); }

  async runScript(name, args) {
    if (this.failScriptOnceFor.delete(name)) {
      throw new Error('NOSCRIPT No matching script');
    }

    const definition = this.definitions.get(name);
    const keys = args.slice(0, definition.numberOfKeys);
    const argv = args.slice(definition.numberOfKeys);
    this.scriptCalls.push({ name, keys, argv });

    if (name === 'lazyLayersReleaseLockV1') {
      return this.release(keys[0], argv[0]);
    }
    if (name === 'lazyLayersRenewLockV1') {
      return this.renew(keys[0], argv[0], argv[1]);
    }
    if (name === 'lazyLayersPublishIfOwnerV1') {
      return this.publish(keys[0], keys[1], argv[0], argv[1], argv[2]);
    }
    if (name === 'lazyLayersGetSnapshotV1') {
      return this.snapshot(keys[0]);
    }
    if (name === 'lazyLayersSetAndFenceV1') {
      return this.setAndFence(keys[0], keys[1], argv[0], argv[1]);
    }
    if (name === 'lazyLayersDeleteAndFenceV1') {
      return this.deleteAndFence(keys[0], keys[1]);
    }
    throw new Error(`unknown script ${name}`);
  }

  async eval(lua, keyCount, ...args) {
    this.evalCalls += 1;
    const keys = args.slice(0, keyCount);
    const argv = args.slice(keyCount);
    if (lua.includes('redis.call("set", KEYS[1]')) {
      return this.publish(keys[0], keys[1], argv[0], argv[1], argv[2]);
    }
    if (lua.includes('pexpire')) {
      return this.renew(keys[0], argv[0], argv[1]);
    }
    if (lua.includes('return redis.call("del"')) {
      return this.release(keys[0], argv[0]);
    }
    if (lua.includes('return {value')) {
      return this.snapshot(keys[0]);
    }
    if (lua.includes('redis.call("set", KEYS[1]') && lua.includes('redis.call("del", KEYS[2]')) {
      return this.setAndFence(keys[0], keys[1], argv[0], argv[1]);
    }
    if (lua.includes('local deleted') && lua.includes('redis.call("del", KEYS[2]')) {
      return this.deleteAndFence(keys[0], keys[1]);
    }
    throw new Error('unexpected script');
  }

  async evalBuffer(lua, keyCount, ...args) {
    return this.eval(lua, keyCount, ...args);
  }

  async set(key, value, ...options) {
    this.prune(key);
    if (options.includes('NX') && this.values.has(key)) return null;
    const pxIndex = options.indexOf('PX');
    const ttlMs = pxIndex >= 0 ? Number(options[pxIndex + 1]) : undefined;
    this.values.set(key, {
      value: Buffer.isBuffer(value) ? Buffer.from(value) : String(value),
      expiresAt: ttlMs === undefined ? undefined : Date.now() + ttlMs,
    });
    return 'OK';
  }

  async getBuffer(key) {
    this.prune(key);
    const entry = this.values.get(key);
    return entry ? Buffer.isBuffer(entry.value) ? Buffer.from(entry.value) : Buffer.from(entry.value) : null;
  }

  async pttl(key) {
    this.prune(key);
    const entry = this.values.get(key);
    if (!entry) return -2;
    return entry.expiresAt === undefined ? -1 : Math.max(0, entry.expiresAt - Date.now());
  }

  async exists(key) {
    this.prune(key);
    return this.values.has(key) ? 1 : 0;
  }

  async del(...keys) {
    let deleted = 0;
    for (const key of keys) deleted += this.values.delete(key) ? 1 : 0;
    return deleted;
  }

  async unlink(...keys) { return this.del(...keys); }
  async zadd() { return 1; }
  async zrem() { return 1; }
  async zcard() { return 0; }

  release(key, token) {
    this.prune(key);
    const entry = this.values.get(key);
    if (!entry || String(entry.value) !== String(token)) return 0;
    this.values.delete(key);
    return 1;
  }

  renew(key, token, ttlMs) {
    this.prune(key);
    const entry = this.values.get(key);
    if (!entry || String(entry.value) !== String(token)) return 0;
    entry.expiresAt = Date.now() + Number(ttlMs);
    return 1;
  }

  publish(dataKey, lockKey, token, payload, ttlMs) {
    this.prune(lockKey);
    const lock = this.values.get(lockKey);
    if (!lock || String(lock.value) !== String(token)) return 0;
    this.values.set(dataKey, { value: Buffer.from(payload), expiresAt: Date.now() + Number(ttlMs) });
    return 1;
  }

  setAndFence(dataKey, lockKey, payload, ttlMs) {
    this.values.set(dataKey, { value: Buffer.from(payload), expiresAt: Date.now() + Number(ttlMs) });
    this.values.delete(lockKey);
    return 1;
  }

  deleteAndFence(dataKey, lockKey) {
    const deleted = this.values.delete(dataKey) ? 1 : 0;
    this.values.delete(lockKey);
    return deleted;
  }

  snapshot(key) {
    this.prune(key);
    const entry = this.values.get(key);
    if (!entry) return [false, -2];
    const ttl = entry.expiresAt === undefined ? -1 : Math.max(0, entry.expiresAt - Date.now());
    return [Buffer.isBuffer(entry.value) ? Buffer.from(entry.value) : Buffer.from(entry.value), ttl];
  }

  prune(key) {
    const entry = this.values.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) this.values.delete(key);
  }
}

function hashTag(key) {
  const start = key.indexOf('{');
  const end = key.indexOf('}', start + 1);
  return start >= 0 && end > start ? key.slice(start + 1, end) : undefined;
}

test('RedisStore registers cached scripts and keeps data/lease keys in one slot', async () => {
  const redis = new ScriptRedis();
  const store = new RedisStore(redis, { prefix: 'atomic:' });

  assert.equal(redis.defineCalls.length, 6);
  await store.acquireLock('seat:1', 'owner', 1_000);
  const result = await store.publishIfOwner('seat:1', 'owner', serialize({ held: true }), 500);

  assert.equal(result, 'published');
  const publication = redis.scriptCalls.find(({ name }) => name === 'lazyLayersPublishIfOwnerV1');
  assert.ok(publication);
  assert.equal(hashTag(publication.keys[0]), hashTag(publication.keys[1]));
  assert.notEqual(hashTag(publication.keys[0]), hashTag('other-key'));
  assert.deepEqual(deserialize((await store.getEncoded('seat:1')).buffer), { held: true });
  assert.ok((await store.getEncoded('seat:1')).ttlRemainingMs > 0);

  const rejected = await store.publishIfOwner('seat:1', 'other-owner', serialize('stale'), 500);
  assert.equal(rejected, 'not-owner');
  assert.deepEqual(await store.get('seat:1'), { held: true });
});

test('v2 direct writes and deletes fence an outstanding fill lease', async () => {
  const redis = new ScriptRedis();
  const store = new RedisStore(redis, { prefix: 'fence:' });

  assert.equal(await store.acquireLock('seat:2', 'loader', 1_000), true);
  await store.set('seat:2', 'operator-update', { ttlMs: 500 });
  assert.equal(await store.acquireLock('seat:2', 'replacement', 1_000), true);
  assert.equal(await store.get('seat:2'), 'operator-update');

  await store.set('seat:3', 'to-delete', { ttlMs: 500 });
  assert.equal(await store.acquireLock('seat:3', 'loader', 1_000), true);
  await store.delete('seat:3');
  assert.equal(await store.acquireLock('seat:3', 'replacement', 1_000), true);
  assert.equal(await store.get('seat:3'), undefined);
});

test('RedisStore recovers a definite NOSCRIPT without replaying through another mutation', async () => {
  const redis = new ScriptRedis();
  const store = new RedisStore(redis, { prefix: 'noscript:' });
  await store.acquireLock('seat', 'owner', 1_000);
  redis.failScriptOnce('lazyLayersRenewLockV1');
  assert.equal(await store.renewLock('seat', 'owner', 1_000), true);
  redis.failScriptOnce('lazyLayersPublishIfOwnerV1');

  assert.equal(await store.publishIfOwner('seat', 'owner', serialize('fresh'), 500), 'published');
  assert.equal(redis.evalCalls, 2);
  redis.failScriptOnce('lazyLayersReleaseLockV1');
  await store.releaseLock('seat', 'owner');
  assert.equal(await store.acquireLock('seat', 'new-owner', 1_000), true);
  assert.equal(await store.get('seat'), 'fresh');
});

test('real Redis keeps the replacement value when a former owner resumes', { skip: !process.env.REDIS_URL }, async (t) => {
  const { default: Redis } = await import('ioredis');
  const prefix = `atomic-race:${Date.now()}:`;
  const firstClient = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
  const secondClient = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
  const first = new RedisStore(firstClient, { prefix, useIndex: false });
  const second = new RedisStore(secondClient, { prefix, useIndex: false });
  t.after(async () => {
    await first.clear();
    firstClient.disconnect();
    secondClient.disconnect();
  });

  assert.equal(await first.acquireLock('seat', 'former-owner', 1_000), true);
  await first.releaseLock('seat', 'former-owner');
  assert.equal(await second.acquireLock('seat', 'current-owner', 1_000), true);
  assert.equal(await first.publishIfOwner('seat', 'former-owner', serialize('obsolete'), 1_000), 'not-owner');
  assert.equal(await second.publishIfOwner('seat', 'current-owner', serialize('winner'), 1_000), 'published');
  assert.equal(await first.get('seat'), 'winner');
});

class AtomicLockStore {
  constructor() {
    this.atomicPublicationSupported = true;
    this.values = new Map();
    this.locks = new Map();
    this.publications = 0;
  }

  async set(key, value) { this.values.set(key, serialize(value)); }
  async get(key) { const value = this.values.get(key); return value === undefined ? undefined : deserialize(value); }
  async has(key) { return this.values.has(key); }
  async delete(key) { this.values.delete(key); }
  async deleteByPattern() { this.values.clear(); }
  async clear() { this.values.clear(); }
  async size() { return this.values.size; }

  async acquireLock(key, token) {
    if (this.locks.has(key)) return false;
    this.locks.set(key, token);
    return true;
  }

  async releaseLock(key, token) {
    if (this.locks.get(key) === token) this.locks.delete(key);
  }

  async renewLock(key, token) { return this.locks.get(key) === token; }

  async publishIfOwner(key, token, payload) {
    this.publications += 1;
    if (this.locks.get(key) !== token) return 'not-owner';
    this.values.set(key, Buffer.from(payload));
    return 'published';
  }
}

test('HybridCache never promotes or broadcasts a fill rejected by the ownership check', async () => {
  const l2 = new AtomicLockStore();
  const events = [];
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const resultPromise = new Promise((resolve) => { release = resolve; });
  const cache = createCache({
    l2,
    failSafe: { enabled: false },
    distributedLock: { ttlMs: 1_000, waitTimeoutMs: 10, pollMs: 1 },
    events: [(event) => events.push(event.type)],
  });

  const loading = cache.getOrSet('seat:1', async () => {
    started();
    return resultPromise;
  });
  await startedPromise;

  /* The local lease is still live, but Redis has already accepted a new owner. */
  l2.locks.set('seat:1', 'new-owner');
  release('old-owner-result');

  await assert.rejects(loading, (error) => error instanceof DistributedLockLostError);
  assert.equal(l2.publications, 1);
  assert.equal(l2.values.has('seat:1'), false);
  assert.equal(events.includes('set'), false);
  assert.equal(await cache.get('seat:1'), undefined);
  await cache.close();
});
