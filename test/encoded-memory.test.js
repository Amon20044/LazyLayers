import assert from 'node:assert/strict';
import { test } from 'node:test';
const { HybridCache } = await import('../dist/cache/hybridCache.js');
const { MemoryStore } = await import('../dist/cache/memoryStore.js');
const { MemoryBudget, getDefaultMemoryBudget, resetDefaultMemoryBudget } = await import('../dist/cache/memoryBudget.js');
const { serialize } = await import('../dist/utils/serializer.js');

const budget = (n = 2 * 1024 * 1024) => new MemoryBudget({ maxMemory: n, sampleIntervalMs: 0 });

test('set owns input values and get/getEncoded are defensive', async () => {
  const s = new MemoryStore({ memoryBudget: budget() }); const input = { a: 1 }; await s.set('x', input); input.a = 2; assert.equal((await s.get('x')).a, 1);
  const out = await s.get('x'); out.a = 3; assert.equal((await s.get('x')).a, 1); const encoded = await s.getEncoded('x'); encoded.buffer[0] ^= 255; assert.equal((await s.get('x')).a, 1); s.close();
});

test('two stores share cap and close releases all accounting including empty history', async () => {
  const b = budget(10000); const a = new MemoryStore({ memoryBudget: b }); const c = new MemoryStore({ memoryBudget: b }); assert.ok(b.snapshot().accountedBytes >= 8192); await a.set('a', 'x'.repeat(1000)); await c.set('c', 'x'.repeat(1000)); assert.ok(b.snapshot().accountedBytes <= 10000); a.close(); c.close(); assert.equal(b.snapshot().accountedBytes, 0);
});

test('oversize candidate does not evict existing hot entry and rejected replacement invalidates old value', async () => {
  const b = budget(50000); const s = new MemoryStore({ memoryBudget: b, levels: { L1: { admission: { maxEntryBytes: 5000 } } } }); await s.set('hot', 'ok'); await s.set('too', 'x'.repeat(10000)); assert.equal(await s.get('hot'), 'ok'); await s.setEncoded('hot', new Uint8Array(10000)); assert.equal(await s.has('hot'), false); s.close();
});

test('expiry and explicit deletion release bytes; undefined misses differ from cached null', async () => {
  const b = budget(); const s = new MemoryStore({ memoryBudget: b, ttlMs: 15 }); await s.set('n', null); assert.equal(await s.has('n'), true); assert.equal(await s.get('missing'), undefined); const before = b.snapshot().accountedBytes; await new Promise(r => setTimeout(r, 30)); assert.equal(await s.has('n'), false); assert.ok(b.snapshot().accountedBytes < before); s.close();
});

test('encoded subarray is copied and charges only owned payload plus fixed overhead', async () => {
  const b = budget(8 * 1024 * 1024); const s = new MemoryStore({ memoryBudget: b, levels: { L1: { admission: { enabled: false } } } }); const backing = Buffer.alloc(1024 * 1024); await s.setEncoded('slice', backing.subarray(1), {}, 1024 * 1024); assert.equal((await s.getEncoded('slice')).buffer.byteLength, 1024 * 1024 - 1); assert.equal(b.snapshot().categories.fresh, 1024 * 1024 - 1 + Buffer.byteLength('slice') * 2 + 160); s.close();
});

test('metadata inspection does not decode unknown original size', async () => {
  const s = new MemoryStore({ memoryBudget: budget() }); await s.setEncoded('raw', Buffer.from('not-a-known-value')); const page = await s.inspect({ includeValues: false }); assert.equal(page.keys[0].value, undefined); const withValues = await s.inspect(); assert.equal(withValues.keys[0].value, undefined); s.close();
});

test('count limit remains active when byte admission and auto eviction are disabled', async () => {
  const s = new MemoryStore({ memoryBudget: budget(), levels: { L1: { maxEntries: 1, autoEvict: { enabled: false }, admission: { enabled: false } } } }); await s.set('a', 1); await s.set('b', 2); assert.equal(await s.size(), 1); s.close();
});

test('concurrent writes never exceed byte ceiling', async () => {
  const b = budget(30000); const s = new MemoryStore({ memoryBudget: b, levels: { L1: { admission: { enabled: false } } } }); await Promise.all(Array.from({ length: 30 }, (_, i) => s.set(i, 'x'.repeat(3000)))); assert.ok(b.snapshot().accountedBytes <= 30000); s.close();
});

test('default singleton rejects conflicting configuration and can be reset cleanly', () => { resetDefaultMemoryBudget(); const a = getDefaultMemoryBudget({ maxMemory: 10000, sampleIntervalMs: 0 }); assert.throws(() => getDefaultMemoryBudget({ maxMemory: 20000, sampleIntervalMs: 0 })); resetDefaultMemoryBudget(); assert.notEqual(getDefaultMemoryBudget({ maxMemory: 10000, sampleIntervalMs: 0 }), a); resetDefaultMemoryBudget(); });

test('fail-safe retains one encoded snapshot and releases its shared budget on close', async () => {
  const b = budget();
  const cache = new HybridCache({
    memoryBudget: b,
    logging: { enabled: false },
    levels: { L1: { ttlMs: 5 } },
    failSafe: { enabled: true, staleTtlMs: 1_000 },
  });
  const value = { nested: { count: 1 } };
  await cache.set('profile', value);
  value.nested.count = 2;
  assert.ok(b.snapshot().categories.stale > 0);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(await cache.getOrSet('profile', async () => { throw new Error('origin down'); }), { nested: { count: 1 } });
  await cache.close();
  assert.equal(b.snapshot().accountedBytes, 0);
});

test('custom L1 stores can use fail-safe without exposing a memory budget', async () => {
  const entries = new Map();
  const l1 = {
    async get(key) { return entries.get(key); },
    async set(key, value) { entries.set(key, value); },
    async has(key) { return entries.has(key); },
    async delete(key) { entries.delete(key); },
    async deleteByPattern() { entries.clear(); },
    async clear() { entries.clear(); },
    async size() { return entries.size; },
    async getOrSet(key, loader, options) {
      const existing = await this.get(key);
      if (existing !== undefined) return existing;
      const value = await loader();
      if (value !== undefined) await this.set(key, value, options);
      return value;
    },
  };
  const cache = new HybridCache({ l1, logging: { enabled: false }, failSafe: { enabled: true, staleTtlMs: 1_000 } });
  await cache.set('profile', 'old');
  entries.clear();
  assert.equal(await cache.getOrSet('profile', async () => { throw new Error('origin down'); }), 'old');
  await cache.close();
});

test('encoded fast path requires the Lazy Layers wire-format marker', async () => {
  const entries = new Map();
  const store = {
    async get(key) { return entries.get(key); },
    async set(key, value) { entries.set(key, value); },
    async has(key) { return entries.has(key); },
    async delete(key) { entries.delete(key); },
    async deleteByPattern() { entries.clear(); },
    async clear() { entries.clear(); },
    async size() { return entries.size; },
    async getOrSet(key, loader, options) {
      const existing = await this.get(key);
      if (existing !== undefined) return existing;
      const value = await loader();
      if (value !== undefined) await this.set(key, value, options);
      return value;
    },
    async getEncoded() { throw new Error('foreign encoded format must not be read'); },
    async setEncoded() { throw new Error('foreign encoded format must not be written'); },
  };
  const cache = new HybridCache({ l1: store, logging: { enabled: false } });
  await cache.set('key', { value: 1 });
  assert.deepEqual(await cache.get('key'), { value: 1 });
  await cache.close();
});

test('encoded L2 promotion preserves a shorter remaining TTL', async () => {
  const b = budget();
  // Keep enough headroom for this test to run alongside the full suite while
  // still exercising the shorter-than-L1 promotion path.
  const l2 = new MemoryStore({ memoryBudget: b, ttlMs: 250 });
  const cache = new HybridCache({ memoryBudget: b, l2, logging: { enabled: false }, levels: { L1: { ttlMs: 1_000 } } });
  await l2.set('short', 'value');
  assert.equal(await cache.get('short'), 'value');
  await l2.delete('short');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await cache.get('short'), undefined);
  await cache.close();
  l2.close();
});

test('persistent encoded L2 values use the configured L1 TTL instead of one millisecond', async () => {
  let available = true;
  const l2 = {
    encodedFormat: 'lazy-layers-hc1',
    async getEncoded() { return available ? { buffer: serialize('value'), ttlRemainingMs: -1 } : undefined; },
    async setEncoded() {},
    async get() { return available ? 'value' : undefined; },
    async set() {},
    async has() { return available; },
    async delete() { available = false; },
    async deleteByPattern() { available = false; },
    async clear() { available = false; },
    async size() { return available ? 1 : 0; },
    async getOrSet(key, loader) { return (await this.get(key)) ?? loader(); },
  };
  const cache = new HybridCache({ l2, logging: { enabled: false }, levels: { L1: { ttlMs: 250 } } });
  assert.equal(await cache.get('persistent'), 'value');
  available = false;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await cache.get('persistent'), 'value');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await cache.get('persistent'), undefined);
  await cache.close();
});
