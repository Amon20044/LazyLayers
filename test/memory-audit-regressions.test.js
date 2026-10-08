import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LRUCache } from 'lru-cache';

const { MemoryStore, MemoryBudget, serialize } = await import(process.env.LAZY_AUDIT_MODULE ?? '../dist/index.js');
const budget = () => new MemoryBudget({ maxMemory: 100_000, sampleIntervalMs: 0 });

test('a direct L1 has check performs no global expiration sweep', { timeout: 2000 }, async () => {
  const b = budget(); const store = new MemoryStore({ memoryBudget: b });
  const original = LRUCache.prototype.purgeStale; let sweeps = 0;
  try {
    for (let i = 0; i < 64; i++) await store.set(`key:${i}`, i);
    LRUCache.prototype.purgeStale = function (...args) { sweeps++; return original.apply(this, args); };
    assert.equal(await store.has('key:31'), true);
    assert.equal(await store.has('absent'), false);
    assert.equal(sweeps, 0, 'one-key presence checks must not visit the entire cache');
  } finally { LRUCache.prototype.purgeStale = original; store.close(); b.close(); }
});

test('a queried expired key releases its bytes without purging other entries', { timeout: 2000 }, async () => {
  const b = budget(); const store = new MemoryStore({ memoryBudget: b });
  try {
    await store.set('expired', 'value', { ttlMs: 5 });
    await store.set('live', 'value', { ttlMs: 1000 });
    const before = b.snapshot().categories.fresh;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await store.has('expired'), false);
    assert.ok(b.snapshot().categories.fresh < before);
    assert.equal(await store.get('live'), 'value');
  } finally { store.close(); b.close(); }
});

test('a large configured count cannot preallocate storage before byte admission', { timeout: 2000 }, async () => {
  const b = budget(); let store;
  const original = Array.from;
  try {
    // Abort a dangerous baseline allocation before it happens. The requested
    // count is only a logical upper bound; this test never allocates 10M slots.
    Array.from = function (input, ...args) {
      if (input?.length === 10_000_000) throw new Error('Configured-capacity preallocation blocked by test resource budget');
      return original.call(this, input, ...args);
    };
    assert.doesNotThrow(() => { store = new MemoryStore({ memoryBudget: b, levels: { L1: { maxEntries: 10_000_000 } } }); });
    Array.from = original;
    await store.set('key', 'value');
    assert.equal(await store.get('key'), 'value');
    assert.ok(b.snapshot().accountedBytes <= b.snapshot().target);
  } finally { Array.from = original; store?.close(); b.close(); }
});

test('closed L1 stores do not invoke serialization hooks or resurrect entries', { timeout: 2000 }, async () => {
  const b = budget(); const store = new MemoryStore({ memoryBudget: b }); let hooks = 0;
  try {
    await store.set('key', 'value'); store.close();
    await store.set('ignored', { get value() { hooks++; return 'should not encode'; } });
    await store.setEncoded('ignored', serialize('value'));
    assert.equal(hooks, 0);
    assert.equal(await store.get('ignored'), undefined);
    assert.equal(await store.has('ignored'), false);
    let loads = 0;
    assert.equal(await store.getOrSet('ignored', async () => { loads++; return 'value'; }), undefined);
    assert.equal(loads, 0);
    assert.equal(b.snapshot().accountedBytes, 0);
  } finally { store.close(); b.close(); }
});

test('expired entries cannot create an unbounded victim-search scan on admission', { timeout: 2000 }, async () => {
  const b = new MemoryBudget({ maxMemory: 2 * 1024 * 1024, sampleIntervalMs: 0 });
  const store = new MemoryStore({ memoryBudget: b, ttlMs: 5, levels: { L1: { maxEntries: 512 } } });
  const original = Map.prototype.get; let lookups = 0;
  try {
    for (let i = 0; i < 512; i++) await store.set(`expired:${i}`, i);
    await new Promise((resolve) => setTimeout(resolve, 20));
    Map.prototype.get = function (...args) { lookups++; return original.apply(this, args); };
    await store.set('candidate', 'fresh');
    assert.ok(lookups < 128, `one admission performed ${lookups} map lookups across expired residents`);
  } finally { Map.prototype.get = original; store.close(); b.close(); }
});

test('corrupt records reload while a legitimate cached null remains a hit', { timeout: 2000 }, async () => {
  const b = budget(); const store = new MemoryStore({ memoryBudget: b });
  try {
    await store.setEncoded('corrupt', Buffer.from([72, 67, 49, 77, 193]));
    await store.set('null', null);
    let calls = 0;
    assert.equal(await store.getOrSet('corrupt', async () => { calls++; return 'fresh'; }), 'fresh');
    assert.equal(calls, 1);
    assert.equal(await store.getOrSet('null', async () => { calls++; return 'incorrect'; }), null);
    assert.equal(calls, 1);
  } finally { store.close(); b.close(); }
});

test('inspection limits constrain actual decode despite forged expanded-size metadata', { timeout: 2000 }, async () => {
  const b = budget(); const store = new MemoryStore({ memoryBudget: b });
  try {
    await store.setEncoded('large', serialize({ value: 'x'.repeat(32 * 1024) }), {}, 1);
    const page = await store.inspect({ maxValueBytes: 128 });
    assert.equal(page.keys[0].value === undefined, true, 'preview must reject actual expanded output above its cap');
    assert.equal(page.keys[0].truncated, true);
  } finally { store.close(); b.close(); }
});
