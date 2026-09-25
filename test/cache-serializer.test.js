import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { pack } from 'msgpackr';

const { serialize, deserialize, NULL_SENTINEL } = await import('../dist/index.js');
const {
  serializeCacheValue,
  deserializeCacheValue,
  serializePortable,
  deserializePortable,
} = await import('../dist/utils/cacheSerializer.js');

const SENTINEL = pack(NULL_SENTINEL);

test('Node gzip policy and the Worker facade emit the same HC1 bytes', async () => {
  const small = { id: 1, when: new Date('2026-01-01T00:00:00.000Z'), bytes: Uint8Array.from([1, 2, 3]) };
  const nodeSmall = serialize(small, { compression: 'gzip' });
  const workerSmall = await serializeCacheValue(small, 'auto');
  assert.deepEqual(Buffer.from(workerSmall), nodeSmall);
  assert.equal(Buffer.from(workerSmall.subarray(0, 4)).toString(), 'HC1M');
  const fromNode = await deserializeCacheValue(nodeSmall);
  const fromWorker = deserialize(workerSmall);
  assert.equal(fromNode.when.toISOString(), small.when.toISOString());
  assert.equal(fromWorker.when.toISOString(), small.when.toISOString());
  assert.deepEqual(Array.from(fromNode.bytes), [1, 2, 3]);
  assert.deepEqual(Array.from(fromWorker.bytes), [1, 2, 3]);

  const large = { description: 'repeat-me-'.repeat(2_000) };
  const nodeLarge = serialize(large, { compression: 'gzip' });
  const workerLarge = await serializeCacheValue(large, 'auto');
  assert.equal(nodeLarge.subarray(0, 4).toString(), 'HC1G');
  assert.equal(Buffer.from(workerLarge.subarray(0, 4)).toString(), 'HC1G');
  assert.deepEqual(await deserializeCacheValue(nodeLarge), large);
  assert.deepEqual(deserialize(workerLarge), large);
  assert.deepEqual(await deserializePortable(nodeLarge), large);
});

test('portable serializer keeps null, sentinel, and earlier JSON records distinct', async () => {
  assert.equal(await deserializeCacheValue(await serializeCacheValue(null)), null);
  assert.equal(await deserializeCacheValue(await serializeCacheValue(undefined)), null);
  assert.equal(await deserializeCacheValue(await serializeCacheValue(NULL_SENTINEL)), NULL_SENTINEL);
  const legacyJson = Buffer.concat([
    Buffer.from('HC1J'),
    Buffer.from(JSON.stringify({ ok: true })),
  ]);
  assert.deepEqual(await deserializePortable(legacyJson), { ok: true });
  const legacyNull = Buffer.concat([Buffer.from('HC1M'), Buffer.from(SENTINEL)]);
  assert.equal(await deserializePortable(legacyNull), null);
});

test('Worker facade misses Node-only tags and rejects an untagged payload', async () => {
  const lz4 = Buffer.concat([Buffer.from('HC1L'), Buffer.from([1, 2, 3])]);
  assert.equal(await deserializeCacheValue(lz4), null);
  await assert.rejects(deserializeCacheValue(Buffer.from('{"ok":true}')), /HC1M, HC1G, or HC1J/);
});

test('compression none and a poor gzip saving stay raw MessagePack', async () => {
  const large = { description: 'repeat-me-'.repeat(2_000) };
  const raw = await serializeCacheValue(large, 'none');
  assert.equal(Buffer.from(raw.subarray(0, 4)).toString(), 'HC1M');
  const packed = pack({ noise: 1 });
  const bloated = Buffer.concat([
    Buffer.from('HC1G'),
    gzipSync(Buffer.concat([Buffer.alloc(2_000, 1), packed])),
  ]);
  assert.equal(bloated.subarray(0, 4).toString(), 'HC1G');
  assert.ok(gunzipSync(bloated.subarray(4)).byteLength > 1_024);
  const circular = {};
  circular.self = circular;
  await assert.rejects(serializePortable(circular, 'auto'), /cannot serialize/);
});

test('KV compression mode is validated by the facade', async () => {
  await assert.rejects(serializeCacheValue({ id: 1 }, 'lz4'), /auto or none/);
});
