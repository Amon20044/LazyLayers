import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (!entry) throw new Error('Expected frozen module path');
const moduleUrl = entry.startsWith('file:') ? entry : pathToFileURL(entry).href;
const { MemoryStore, MemoryBudget, serialize, deserialize, decodeCacheRecord, serializeCacheValue, deserializeCacheValue, decodePortableCacheRecord } = await import(moduleUrl);
const results = [];
const samples = [process.memoryUsage()];
const expected = [17, 34, 51];
async function check(name, run) {
  const observed = await run();
  samples.push(process.memoryUsage());
  results.push({ name, status: 'PASS', observed });
}
function makeStore() {
  const budget = new MemoryBudget({ maxMemory: 65536, sampleIntervalMs: 0 });
  const store = new MemoryStore({ memoryBudget: budget, levels: { L1: { codec: { compression: 'none' }, admission: { enabled: false } } } });
  return { store, budget };
}
await check('direct MemoryStore.get nested Buffer mutation preserves resident bytes', async () => {
  const { store, budget } = makeStore();
  try {
    await store.set('key', { nested: { body: Buffer.from(expected) } });
    const first = await store.get('key');
    assert.equal(Buffer.isBuffer(first.nested.body), true);
    first.nested.body[0] = 99;
    const second = await store.get('key');
    assert.deepEqual(Array.from(second.nested.body), expected);
    return { mutatedReturnedValue: Array.from(first.nested.body), retainedValue: Array.from(second.nested.body), bufferTypePreserved: true };
  } finally { store.close(); budget.close(); }
});
await check('direct MemoryStore.inspect Buffer preview mutation preserves resident bytes', async () => {
  const { store, budget } = makeStore();
  try {
    await store.set('key', { body: Buffer.from(expected) });
    const preview = (await store.inspect({ includeValues: true, maxValueBytes: 1024 })).keys[0].value;
    assert.equal(Buffer.isBuffer(preview.body), true);
    preview.body[1] = 88;
    const second = await store.get('key');
    assert.deepEqual(Array.from(second.body), expected);
    return { mutatedPreview: Array.from(preview.body), retainedValue: Array.from(second.body), bufferTypePreserved: true };
  } finally { store.close(); budget.close(); }
});
await check('strict Node binary decoder owns its result and public legacy decoder remains a view', async () => {
  const raw = serialize({ body: Buffer.from(expected) }, { compression: 'none' });
  const before = Buffer.from(raw);
  const record = decodeCacheRecord(raw);
  assert.equal(record.hit, true);
  assert.equal(Buffer.isBuffer(record.value.body), true);
  record.value.body.fill(77);
  assert.deepEqual(raw, before);
  assert.deepEqual(Array.from(deserialize(raw).body), expected);
  const legacy = deserialize(raw);
  legacy.body[0] = 66;
  assert.equal(deserialize(raw).body[0], 66);
  return { strictInputUnchanged: true, legacyViewObserved: true, bufferTypePreserved: true };
});
await check('strict portable binary decoder owns its result and public legacy decoder remains a view', async () => {
  const raw = Buffer.from(await serializeCacheValue({ body: Buffer.from(expected) }, 'none'));
  const before = Buffer.from(raw);
  const record = await decodePortableCacheRecord(raw);
  assert.equal(record.hit, true);
  record.value.body.fill(77);
  assert.deepEqual(raw, before);
  assert.deepEqual(Array.from((await deserializeCacheValue(raw)).body), expected);
  const legacy = await deserializeCacheValue(raw);
  legacy.body[0] = 66;
  assert.equal((await deserializeCacheValue(raw)).body[0], 66);
  return { strictInputUnchanged: true, legacyViewObserved: true };
});
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), entry, node: process.version, cases: results, sampleCount: samples.length, maximumPointSampleRssBytes: Math.max(...samples.map((sample) => sample.rss)), note: 'RSS sampled at test boundaries; not a continuous peak or retained-heap profile.' }, null, 2));
