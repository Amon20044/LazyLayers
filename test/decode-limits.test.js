import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { pack, Packr } from 'msgpackr';

const mod = await import(process.env.LAZY_AUDIT_MODULE ?? '../dist/index.js');

function decode(record, options) {
  assert.equal(typeof mod.decodeCacheRecord, 'function', 'built-in consumers need a strict bounded record decoder');
  return mod.decodeCacheRecord(record, options);
}

test('strict decode distinguishes malformed records from cached null', { timeout: 2000 }, () => {
  assert.deepEqual(decode(mod.serialize(null)), { hit: true, value: null });
  assert.deepEqual(decode(mod.serialize('__hybridcache_null__')), { hit: true, value: '__hybridcache_null__' });
  assert.deepEqual(decode(Buffer.from([72, 67, 49, 77, 193])), { hit: false });
  assert.deepEqual(decode(Buffer.from('HC1Qfuture')), { hit: false });
});

test('strict readers reject malformed UTF-8 while public legacy defaults remain compatible', { timeout: 2000 }, async () => {
  const jsonBody = Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]);
  const msgpackBody = Buffer.from([161, 255]);
  for (const [tag, body] of [['HC1J', jsonBody], ['HC1M', msgpackBody]]) {
    const record = Buffer.concat([Buffer.from(tag), body]);
    assert.deepEqual(decode(record), { hit: false });
    assert.deepEqual(decode(body), { hit: false });
    assert.equal(mod.deserialize(record, {}) === null, true);
    // Both old public readers accepted replacement-character decoding.
    assert.deepEqual(await mod.deserializeCacheValue(record), mod.deserialize(record));
    assert.deepEqual(await mod.decodePortableCacheRecord(record), { hit: false });
  }
  for (const value of ['ASCII', 'café', 'தமிழ்', '😀', '\u{10ffff}', { 'clé': ['中文', '🙃'] }]) {
    const record = mod.serialize(value, { compression: 'none' });
    assert.deepEqual(decode(record), { hit: true, value });
    assert.deepEqual(await mod.decodePortableCacheRecord(record), { hit: true, value });
  }
  for (const bytes of [[192, 175], [237, 160, 128], [244, 144, 128, 128], [240, 159, 140], [128]]) {
    const record = Buffer.from([72, 67, 49, 77, 160 + bytes.length, ...bytes]);
    assert.deepEqual(decode(record), { hit: false });
    assert.deepEqual(await mod.decodePortableCacheRecord(record), { hit: false });
  }
});

test('L1 rejects corrupt wire UTF-8 rather than returning replacement data', { timeout: 2000 }, async () => {
  const budget = new mod.MemoryBudget({ maxMemory: 50_000, sampleIntervalMs: 0 });
  const store = new mod.MemoryStore({ memoryBudget: budget });
  try {
    await store.setEncoded('corrupt', Buffer.from([72, 67, 49, 77, 161, 255]));
    assert.equal(await store.get('corrupt'), undefined);
    assert.equal(await store.has('corrupt'), false);
    assert.equal(budget.snapshot().categories.fresh ?? 0, 0);
  } finally { store.close(); budget.close(); }
});

test('explicit exported decode limits preserve unbounded-default compatibility', { timeout: 2000 }, () => {
  const value = { payload: 'x'.repeat(32 * 1024) };
  const record = mod.serialize(value, { compression: 'gzip' });
  assert.deepEqual(mod.deserialize(record), value);
  assert.equal(mod.deserialize(record, { maxDecodedBytes: 1024 }) === null, true, 'explicit limits must bound actual expanded output');
  assert.deepEqual(decode(record, { maxDecodedBytes: 1024 }), { hit: false });
  assert.deepEqual(decode(record, { maxDecodedBytes: 64 * 1024 }), { hit: true, value });
});

test('raw JSON and MessagePack honor encoded and expanded byte limits', { timeout: 2000 }, () => {
  const value = { payload: 'x'.repeat(4096) };
  for (const format of ['json', 'msgpack']) {
    const record = mod.serialize(value, { format, compression: 'none' });
    assert.deepEqual(decode(record, { maxEncodedBytes: 1024 }), { hit: false });
    assert.deepEqual(decode(record, { maxDecodedBytes: 1024 }), { hit: false });
    assert.deepEqual(decode(record, { maxEncodedBytes: 8192, maxDecodedBytes: 8192 }), { hit: true, value });
  }
});

test('gzip output cap prevents expanded output from becoming a cache hit', { timeout: 2000 }, () => {
  // The entire expanded fixture is 256 KiB, far inside this test's resource
  // budget. The cap still exercises decoder-side rejection before full output.
  const body = Buffer.from(pack({ payload: 'x'.repeat(256 * 1024) }));
  const gzip = gzipSync(body);
  const record = Buffer.concat([Buffer.from('HC1G'), gzip]);
  assert.deepEqual(decode(record, { maxDecodedBytes: 1024 }), { hit: false });
});

test('native length-prefixed codecs reject oversized advertised output', { timeout: 2000 }, () => {
  // Forged outputs are capped to 1 MiB even if a faulty implementation reaches
  // native code. These small headers do not request a dangerous allocation.
  const lz4 = Buffer.alloc(8); lz4.write('HC1L'); lz4.writeUInt32LE(1024 * 1024, 4);
  const snappy = Buffer.from([72, 67, 49, 83, 128, 128, 64]); // varint 1 MiB
  assert.deepEqual(decode(lz4, { maxDecodedBytes: 1024 }), { hit: false });
  assert.deepEqual(decode(snappy, { maxDecodedBytes: 1024 }), { hit: false });
});

test('every installed compressed codec enforces explicit expanded output limits', { timeout: 2000 }, () => {
  const value = { payload: 'x'.repeat(32 * 1024) };
  for (const codec of ['gzip', 'lz4', 'snappy', ...(mod.ZSTD_AVAILABLE ? ['zstd'] : [])]) {
    const record = mod.serialize(value, { compression: [{ codec }] });
    assert.deepEqual(mod.deserialize(record), value);
    assert.equal(mod.deserialize(record, { maxDecodedBytes: 1024 }) === null, true, `${codec} must bound expanded bytes`);
    assert.deepEqual(decode(record, { maxDecodedBytes: 1024 }), { hit: false });
    assert.deepEqual(decode(record, { maxDecodedBytes: 64 * 1024 }), { hit: true, value });
  }
});

test('explicit string limits reject before allocating a UTF-8 buffer', { timeout: 2000 }, () => {
  const raw = JSON.stringify({ payload: 'x'.repeat(1024) });
  const original = Buffer.from; let attempted = 0;
  try {
    Buffer.from = function (...args) {
      if (args[0] === raw) { attempted++; throw new Error('Unexpected oversized UTF-8 allocation'); }
      return Reflect.apply(original, this, args);
    };
    assert.equal(mod.deserialize(raw, { maxEncodedBytes: 64 }) === null, true);
    assert.equal(attempted, 0);
  } finally { Buffer.from = original; }
});

test('a tiny MessagePack header cannot allocate an advertised large array', { timeout: 2000 }, () => {
  const record = Buffer.from([72, 67, 49, 77, 221, 0, 2, 0, 0]); // array32: 131072, with no items
  const Original = globalThis.Array; let attempted = 0;
  function GuardedArray(...args) {
    if (args.length === 1 && args[0] === 131_072) { attempted++; throw new Error('Advertised array allocation blocked by test resource budget'); }
    return new Original(...args);
  }
  GuardedArray.prototype = Original.prototype; Object.setPrototypeOf(GuardedArray, Original);
  try {
    globalThis.Array = GuardedArray;
    assert.equal(mod.deserialize(record, { maxDecodedBytes: 64, maxCollectionLength: 200_000 }), null);
    assert.equal(attempted, 0, 'declared lengths must be checked before constructing the decoded array');
  } finally { globalThis.Array = Original; }
});

test('strict depth, per-collection and aggregate-value budgets bound parser work', { timeout: 2000 }, () => {
  let nested = 0;
  for (let i = 0; i < 20; i++) nested = [nested];
  const grouped = Array.from({ length: 10 }, () => Array.from({ length: 10 }, (_, i) => i));
  for (const format of ['msgpack', 'json']) {
    const deep = mod.serialize(nested, { format, compression: 'none' });
    assert.deepEqual(decode(deep, { maxDepth: 8 }), { hit: false });
    assert.deepEqual(decode(deep, { maxDepth: 64 }), { hit: true, value: nested });
    const record = mod.serialize(grouped, { format, compression: 'none' });
    assert.deepEqual(decode(record, { maxCollectionLength: 4 }), { hit: false });
    assert.deepEqual(decode(record, { maxTotalValues: 30 }), { hit: false });
    assert.deepEqual(decode(record, { maxCollectionLength: 16, maxTotalValues: 300 }), { hit: true, value: grouped });
  }
});

test('known emitted MessagePack extensions keep their legacy round-trip values', { timeout: 2000 }, () => {
  const packr = new Packr({ useRecords: false, moreTypes: true, useBigIntExtension: true });
  const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const fixtures = [
    new Set(['first', 'second']), new TypeError('synthetic-error'), /synthetic-pattern/gi,
    new Date('2026-01-01T00:00:00.000Z'), new Date('invalid'),
    bytes, new Float64Array([1.25, -2.5]), new BigInt64Array([1n, -2n]),
    bytes.buffer, new DataView(bytes.buffer), 1n << 200n,
    { optional: undefined, list: [undefined, null] },
  ];
  for (const fixture of fixtures) {
    const record = Buffer.concat([Buffer.from('HC1M'), Buffer.from(packr.pack(fixture))]);
    const result = decode(record);
    assert.equal(result.hit, true, `strict preflight rejected ${Object.prototype.toString.call(fixture)}`);
    const legacy = mod.deserialize(record);
    // Node 20 treats two invalid Dates as unequal; compare the preserved value.
    if (fixture instanceof Date && Number.isNaN(fixture.getTime())) {
      assert.ok(result.value instanceof Date && Number.isNaN(result.value.getTime()));
      assert.ok(legacy instanceof Date && Number.isNaN(legacy.getTime()));
    } else assert.deepEqual(result.value, legacy);
  }
});

test('foreign record/reference/bundled extensions become reloadable misses', { timeout: 2000 }, () => {
  for (const type of [0x72, 0x69, 0x70, 0x62]) {
    const record = Buffer.from([72, 67, 49, 77, 212, type, 0, 192]);
    assert.deepEqual(decode(record), { hit: false });
  }
});

test('portable raw and gzip records enforce the configured decoded cap', { timeout: 2000 }, async () => {
  const value = { payload: 'x'.repeat(32 * 1024) };
  for (const options of [{ format: 'json' }, { compression: 'none' }, { compression: 'gzip' }]) {
    const record = mod.serialize(value, options);
    await assert.rejects(mod.deserializeCacheValue(record, { maxDecodedBytes: 512 }), /decode|limit/);
  }
  assert.equal(typeof mod.decodePortableCacheRecord, 'function');
  assert.deepEqual(await mod.decodePortableCacheRecord(mod.serialize(null)), { hit: true, value: null });
  assert.deepEqual(await mod.decodePortableCacheRecord(Buffer.from('HC1Lunknown')), { hit: false });
});

test('invalid decode limits fail at configuration boundaries', { timeout: 2000 }, () => {
  assert.equal(typeof mod.decodeCacheRecord, 'function');
  for (const maxDecodedBytes of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => mod.decodeCacheRecord(mod.serialize('value'), { maxDecodedBytes }), RangeError);
  }
});

test('L1 uses configured strict limits and cleans up rejected decoded records', { timeout: 2000 }, async () => {
  const budget = new mod.MemoryBudget({ maxMemory: 100_000, sampleIntervalMs: 0 });
  const store = new mod.MemoryStore({ memoryBudget: budget, decodeLimits: { maxDecodedBytes: 1024 } });
  try {
    await store.setEncoded('oversized', mod.serialize({ payload: 'x'.repeat(32 * 1024) }));
    const before = budget.snapshot().categories.fresh;
    assert.equal((await store.get('oversized')) === undefined, true, 'oversized decoded output must become a miss');
    assert.equal(await store.has('oversized'), false);
    assert.ok((budget.snapshot().categories.fresh ?? 0) < before);
  } finally { store.close(); budget.close(); }
});
