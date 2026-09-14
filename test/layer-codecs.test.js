import assert from 'node:assert/strict';
import { test } from 'node:test';

const { HybridCache, MemoryStore } = await import('../dist/index.js');

class CapturedL2 {
  encodedFormat = 'lazy-layers-hc1';
  values = new Map();

  async set(key, value, options) {
    const { serialize } = await import('../dist/index.js');
    await this.setEncoded(key, serialize(value, options?.levels?.L2?.codec), options);
  }

  async setEncoded(key, buffer) { this.values.set(String(key), Buffer.from(buffer)); }
  async get(key) { return this.values.has(String(key)) ? (await import('../dist/index.js')).deserialize(this.values.get(String(key))) : undefined; }
  async getEncoded(key) {
    const buffer = this.values.get(String(key));
    return buffer ? { buffer: Buffer.from(buffer), ttlRemainingMs: 60_000 } : undefined;
  }
  async getOrSet() { throw new Error('not used'); }
  async has(key) { return this.values.has(String(key)); }
  async delete(key) { this.values.delete(String(key)); }
  async deleteByPattern() { this.values.clear(); }
  async clear() { this.values.clear(); }
  async size() { return this.values.size; }
}

test('L1 and L2 can select independent write codecs without changing reads', async () => {
  const l1 = new MemoryStore({ logging: { env: 'production' } });
  const l2 = new CapturedL2();
  const cache = new HybridCache({ l1, l2, logging: { env: 'production' } });
  await cache.set('record', { id: 7, status: 'held' }, {
    levels: {
      L1: { codec: { format: 'json' } },
      L2: { codec: { compression: 'none' } },
    },
  });

  const l1Wire = await l1.getEncoded('record');
  const l2Wire = await l2.getEncoded('record');
  assert.equal(l1Wire?.buffer.subarray(0, 4).toString('ascii'), 'HC1J');
  assert.equal(l2Wire?.buffer.subarray(0, 4).toString('ascii'), 'HC1M');
  assert.deepEqual(await cache.get('record'), { id: 7, status: 'held' });
  await cache.close();
  l1.close();
});

test('re-encoding a promotion preserves the source expiry budget', async () => {
  const l2 = new CapturedL2();
  await l2.set('record', { id: 7 });
  const originalRead = l2.getEncoded.bind(l2);
  l2.getEncoded = async (key) => {
    const result = await originalRead(key);
    return result ? { ...result, ttlRemainingMs: 100 } : undefined;
  };
  const l1 = new MemoryStore();
  let promotedTtl;
  const originalWrite = l1.setEncoded.bind(l1);
  l1.setEncoded = async (key, buffer, options) => {
    promotedTtl = options.ttlMs;
    assert.equal(buffer.subarray(0, 4).toString(), 'HC1J');
    return originalWrite(key, buffer, options);
  };
  const cache = new HybridCache({ l1, l2, logging: { enabled: false }, levels: {
    L1: { ttlMs: 10_000, codec: { format: 'json' } },
    L2: { codec: { compression: 'none' } },
  } });
  try {
    assert.deepEqual(await cache.get('record'), { id: 7 });
    assert.ok(promotedTtl > 0 && promotedTtl <= 100);
  } finally {
    await cache.close();
    l1.close();
  }
});
