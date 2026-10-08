import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Packr } from 'msgpackr';

const moduleUrl = new URL(process.env.LAZY_AUDIT_MODULE ?? '../dist/index.js', import.meta.url);
const mod = await import(moduleUrl.href);
const { CloudflareWorkerKVStore } = await import(new URL('./cloudflare/index.js', moduleUrl));
const { encodeKVRecord } = await import(new URL('./cloudflare/kvWire.js', moduleUrl));

function namespace() {
  const entries = new Map();
  return {
    entries,
    async get(key) { return entries.get(key)?.slice().buffer ?? null; },
    async put(key, bytes) { entries.set(key, Uint8Array.from(bytes)); },
    async delete(key) { entries.delete(key); },
    async list() { return { keys: [], list_complete: true }; },
  };
}

test('public portable default keeps legacy foreign records while strict reads reject them', { timeout: 2000 }, async () => {
  const value = { retained: true, count: 3 };
  const body = new Packr({ useRecords: true }).pack(value);
  const record = Buffer.concat([Buffer.from('HC1M'), Buffer.from(body)]);
  assert.deepEqual(await mod.deserializeCacheValue(record), value);
  assert.equal(typeof mod.decodePortableCacheRecord, 'function');
  assert.deepEqual(await mod.decodePortableCacheRecord(record), { hit: false });
  await assert.rejects(mod.deserializeCacheValue(record, {}), /decode|malformed/);
});

for (const [name, Store] of [['Node KV', mod.CloudflareKVStore], ['Worker KV', CloudflareWorkerKVStore]]) {
  test(`${name}: corrupt and unsupported records reload, while cached null remains a hit`, { timeout: 2000 }, async () => {
    const ns = namespace();
    const store = new Store(ns, { prefix: 'isolated:' });
    const invalid = [
      Buffer.from('HC1Zunsupported'),
      Buffer.from([72, 67, 49, 77, 193]),
      Buffer.from('HC1J{broken-json'),
      Buffer.from('foreign-outer-header'),
    ];
    let loads = 0;
    for (let i = 0; i < invalid.length; i++) {
      const raw = i === invalid.length - 1 ? invalid[i] : encodeKVRecord(invalid[i], Date.now() + 60_000);
      ns.entries.set(`isolated:key-${i}`, raw);
      assert.equal(await store.has(`key-${i}`), false);
      assert.equal(await store.getOrSet(`key-${i}`, async () => { loads++; return 'reloaded'; }), 'reloaded');
    }
    assert.equal(loads, invalid.length);
    await store.set('cached-null', null);
    assert.equal(await store.has('cached-null'), true);
    assert.equal(await store.getOrSet('cached-null', async () => { loads++; return 'wrong'; }), null);
    assert.equal(loads, invalid.length);
  });

  test(`${name}: configured expanded limits cannot turn oversized records into hits`, { timeout: 2000 }, async () => {
    const ns = namespace();
    const value = { payload: 'x'.repeat(32 * 1024) };
    ns.entries.set('isolated:large', encodeKVRecord(mod.serialize(value, { compression: 'gzip' }), Date.now() + 60_000));
    const capped = new Store(ns, { prefix: 'isolated:', decodeLimits: { maxDecodedBytes: 1024 } });
    assert.equal((await capped.get('large')) === undefined, true);
    const larger = new Store(ns, { prefix: 'isolated:', decodeLimits: { maxDecodedBytes: 64 * 1024 } });
    assert.deepEqual(await larger.get('large'), value);
    for (const maxDecodedBytes of [0, -1, Infinity]) {
      assert.throws(() => new Store(ns, { decodeLimits: { maxDecodedBytes } }), RangeError);
    }
  });
}
