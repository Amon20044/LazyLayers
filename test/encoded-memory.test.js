import assert from 'node:assert/strict';
import { test } from 'node:test';
const { MemoryStore } = await import('../dist/cache/memoryStore.js');
const { MemoryBudget, getDefaultMemoryBudget, resetDefaultMemoryBudget } = await import('../dist/cache/memoryBudget.js');

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
