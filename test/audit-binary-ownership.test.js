import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const configuredModule = process.env.LAZY_AUDIT_MODULE;
const moduleUrl = configuredModule
  ? configuredModule.startsWith('file:') ? configuredModule : pathToFileURL(configuredModule).href
  : new URL('../dist/index.js', import.meta.url).href;
const { MemoryStore, MemoryBudget, serialize, deserialize, decodeCacheRecord, serializeCacheValue, deserializeCacheValue, decodePortableCacheRecord } = await import(moduleUrl);

function newStore() {
  const budget = new MemoryBudget({ maxMemory: 65536, sampleIntervalMs: 0 });
  const store = new MemoryStore({ memoryBudget: budget, levels: { L1: { codec: { compression: 'none' }, admission: { enabled: false } } } });
  return { store, budget };
}

test('MemoryStore.get binary fields cannot mutate retained encoded cache state', { timeout: 2000 }, async () => {
  const { store, budget } = newStore();
  try {
    await store.set('key', { nested: { body: Buffer.from([17, 34, 51]) } });
    const first = await store.get('key');
    assert.equal(Buffer.isBuffer(first.nested.body), true, 'Node Buffer output type is preserved');
    first.nested.body.fill(99);
    assert.deepEqual(Array.from((await store.get('key')).nested.body), [17, 34, 51]);
  } finally { store.close(); budget.close(); }
});

test('MemoryStore.inspect binary previews cannot mutate retained encoded cache state', { timeout: 2000 }, async () => {
  const { store, budget } = newStore();
  try {
    await store.set('key', { body: Buffer.from([17, 34, 51]) });
    const page = await store.inspect({ includeValues: true, maxValueBytes: 1024 });
    assert.equal(Buffer.isBuffer(page.keys[0].value.body), true);
    page.keys[0].value.body.fill(88);
    assert.deepEqual(Array.from((await store.get('key')).body), [17, 34, 51]);
  } finally { store.close(); budget.close(); }
});

test('strict binary decode owns its result while legacy no-option decode keeps its behavior', { timeout: 2000 }, () => {
  const raw = serialize({ body: Buffer.from([17, 34, 51]) }, { compression: 'none' });
  // The frozen baseline's built-in reader is its legacy deserialize function.
  const record = typeof decodeCacheRecord === 'function' ? decodeCacheRecord(raw) : { hit: true, value: deserialize(raw) };
  assert.equal(record.hit, true);
  assert.equal(Buffer.isBuffer(record.value.body), true);
  record.value.body.fill(77);
  assert.deepEqual(Array.from(deserialize(raw).body), [17, 34, 51]);
  const legacy = deserialize(raw);
  legacy.body[0] = 66;
  assert.equal(deserialize(raw).body[0], 66, 'legacy public input/view semantics remain unchanged');
});

test('portable strict binary decode owns its result while public legacy view semantics remain', { timeout: 2000 }, async () => {
  // Buffer uses the MessagePack bin path, not a typed-array extension that may
  // already own its bytes independently in the upstream decoder.
  const raw = Buffer.from(await serializeCacheValue({ body: Buffer.from([17, 34, 51]) }, 'none'));
  const record = typeof decodePortableCacheRecord === 'function'
    ? await decodePortableCacheRecord(raw)
    : { hit: true, value: await deserializeCacheValue(raw) };
  assert.equal(record.hit, true);
  record.value.body.fill(77);
  assert.deepEqual(Array.from((await deserializeCacheValue(raw)).body), [17, 34, 51]);
  const legacy = await deserializeCacheValue(raw);
  legacy.body[0] = 66;
  assert.equal((await deserializeCacheValue(raw)).body[0], 66);
});
