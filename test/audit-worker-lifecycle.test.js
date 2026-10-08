import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const entry = process.env.LAZY_LAYERS_AUDIT_ENTRY
  ? new URL('./cloudflare/index.js', pathToFileURL(process.env.LAZY_LAYERS_AUDIT_ENTRY))
  : new URL('../dist/cloudflare/index.js', import.meta.url);
const { CloudflareWorkerCache, CloudflareWorkerMemoryStore } = await import(entry);
const budget = { timeout: 2000 };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
function namespace() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key)?.slice().buffer ?? null; },
    async put(key, value) { values.set(key, new Uint8Array(value).slice()); },
    async delete(key) { values.delete(key); },
    async list({ prefix = '' } = {}) { return { keys: [...values.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}
function fixture(t) {
  const kv = namespace(); const l1 = new CloudflareWorkerMemoryStore(32);
  const cache = new CloudflareWorkerCache(kv, { prefix: 'worker:', l1, compression: 'none' });
  const resume = deferred();
  t.after(async () => { resume.resolve(); await cache.close(); });
  return { kv, l1, cache, resume };
}

test('audit Worker: a KV read completed after deletion cannot restore L1', budget, async (t) => {
  const { kv, l1, cache, resume } = fixture(t); const started = deferred();
  await cache.l2.set('row', 'obsolete');
  const get = kv.get.bind(kv);
  kv.get = async (key) => { const value = await get(key); started.resolve(); await resume.promise; return value; };
  const reading = cache.get('row'); await started.promise;
  await cache.delete('row'); resume.resolve();
  assert.equal(await reading, 'obsolete', 'An already started caller retains its snapshot response');
  assert.equal(l1.get('worker:row'), undefined);
  kv.get = get; assert.equal(await cache.get('row'), undefined);
});

test('audit Worker: an older KV snapshot cannot replace a newer direct L1 set', budget, async (t) => {
  const { kv, l1, cache, resume } = fixture(t); const started = deferred();
  await cache.l2.set('row', 'old'); const get = kv.get.bind(kv);
  kv.get = async (key) => { const value = await get(key); started.resolve(); await resume.promise; return value; };
  const reading = cache.get('row'); await started.promise;
  await cache.set('row', 'new'); resume.resolve(); await reading;
  assert.equal(l1.get('worker:row'), 'new');
});

test('audit Worker: an in-progress KV put invalidated before completion cannot prime L1', budget, async (t) => {
  const { kv, l1, cache, resume } = fixture(t); const started = deferred(); const put = kv.put.bind(kv);
  kv.put = async (...args) => { started.resolve(); await resume.promise; return put(...args); };
  const writing = cache.set('row', 'obsolete'); await started.promise;
  await cache.delete('row'); resume.resolve(); await writing;
  assert.equal(l1.get('worker:row'), undefined);
  assert.equal(await cache.l2.get('row'), 'obsolete', 'KV has no conditional write: shared late commits remain an explicit capability limit');
});

test('audit Worker: a delayed older put cannot replace newer local publication', budget, async (t) => {
  const { kv, l1, cache, resume } = fixture(t); const started = deferred(); const put = kv.put.bind(kv); let first = true;
  kv.put = async (...args) => { if (first) { first = false; started.resolve(); await resume.promise; } return put(...args); };
  const older = cache.set('row', 'old'); await started.promise;
  await cache.set('row', 'new'); resume.resolve(); await older;
  assert.equal(l1.get('worker:row'), 'new');
  assert.equal(await cache.l2.get('row'), 'old', 'This test deliberately records the weaker shared KV mutation contract');
});

test('audit Worker: failed fill fallback respects a newer invalidation', budget, async (t) => {
  const { kv, l1, cache, resume } = fixture(t); const started = deferred(); let errors = 0;
  cache.options.onError = () => { errors++; };
  kv.put = async () => { started.resolve(); await resume.promise; throw new Error('controlled KV write failure'); };
  const filling = cache.getOrSet('row', async () => 'obsolete'); await started.promise;
  await cache.delete('row'); resume.resolve();
  assert.equal(await filling, 'obsolete'); assert.equal(errors, 1);
  assert.equal(l1.get('worker:row'), undefined);
});

test('audit Worker: failed KV fallback cannot outlive an explicit short request TTL', budget, async (t) => {
  const { kv, l1, cache } = fixture(t); let retainedTtl;
  const set = l1.set.bind(l1); l1.set = (key, value, ttlMs) => { retainedTtl = ttlMs; return set(key, value, ttlMs); };
  kv.put = async () => { throw new Error('controlled unavailable KV'); };
  assert.equal(await cache.getOrSet('short', async () => 'value', { levels: { L2: { ttlMs: 20 } } }), 'value');
  assert.ok(retainedTtl > 0 && retainedTtl <= 20, 'Failure fallback must respect requested freshness');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(l1.get('worker:short'), undefined);
});

test('audit Worker: close suppresses an outstanding read promotion', budget, async (t) => {
  const { kv, l1, cache, resume } = fixture(t); const started = deferred();
  await cache.l2.set('row', 'old'); const get = kv.get.bind(kv);
  kv.get = async (key) => { const value = await get(key); started.resolve(); await resume.promise; return value; };
  const reading = cache.get('row'); await started.promise;
  await cache.close(); resume.resolve(); await reading;
  assert.equal(l1.get('worker:row'), undefined);
});

test('audit Worker: close suppresses a loader result before any KV write', budget, async (t) => {
  const { kv, l1, cache, resume } = fixture(t); const started = deferred(); const put = kv.put.bind(kv); let puts = 0;
  kv.put = async (...args) => { puts++; return put(...args); };
  const filling = cache.getOrSet('row', async () => { started.resolve(); return resume.promise; });
  await started.promise; await cache.close(); resume.resolve('late');
  assert.equal(await filling, 'late'); assert.equal(puts, 0); assert.equal(l1.get('worker:row'), undefined);
});

test('audit Worker: close prevents a pending KV put from priming L1', budget, async (t) => {
  const { kv, l1, cache, resume } = fixture(t); const started = deferred(); const put = kv.put.bind(kv);
  kv.put = async (...args) => { started.resolve(); await resume.promise; return put(...args); };
  const writing = cache.set('row', 'old'); await started.promise;
  await cache.close(); resume.resolve(); await writing;
  assert.equal(l1.get('worker:row'), undefined);
});

test('audit Worker: new operations on a closed facade reject without loading or writing', budget, async (t) => {
  const { cache } = fixture(t); await cache.close(); let loads = 0;
  for (const operation of [
    () => cache.get('row'), () => cache.set('row', 'value'), () => cache.getOrSet('row', async () => { loads++; return 'value'; }),
    () => cache.delete('row'), () => cache.has('row'), () => cache.deleteByPattern('*'), () => cache.clear(), () => cache.size(),
    () => cache.invalidate('row'), () => cache.prewarm('row', async () => 'value'),
  ]) await assert.rejects(operation, /closed/i);
  assert.equal(loads, 0);
});

test('audit Worker: invalidated replacement flights survive older completion and release active revision state', budget, async (t) => {
  const { cache, resume, l1 } = fixture(t); const started = deferred(); const secondFinish = deferred(); let loads = 0;
  t.after(() => secondFinish.resolve('new'));
  const older = cache.getOrSet('row', async () => { loads++; started.resolve(); return resume.promise; }); await started.promise;
  await cache.delete('row');
  const newer = cache.getOrSet('row', async () => { loads++; return secondFinish.promise; }); await tick(); await tick();
  assert.equal(loads, 2, 'New requests must not join an invalidated old flight');
  resume.resolve('old'); assert.equal(await older, 'old');
  const follower = cache.getOrSet('row', async () => { loads++; return 'unexpected'; }); await tick();
  assert.equal(loads, 2, 'The older finally must not delete its replacement flight');
  secondFinish.resolve('new'); assert.deepEqual(await Promise.all([newer, follower]), ['new', 'new']);
  assert.equal(l1.get('worker:row'), 'new');
  assert.equal((cache.keyRevisions ?? cache.generations).size, 0, 'Only active operations retain per-key revision state');
});

test('audit Worker: unique absent invalidations do not retain historical generation keys', budget, async (t) => {
  const { cache } = fixture(t);
  for (let key = 0; key < 128; key++) await cache.delete(`absent:${key}`);
  assert.equal((cache.keyRevisions ?? cache.generations).size, 0);
});

test('audit Worker: pattern invalidation fences a pending KV read promotion', budget, async (t) => {
  const { kv, l1, cache, resume } = fixture(t); const started = deferred();
  await cache.l2.set('group:row', 'old'); const get = kv.get.bind(kv);
  kv.get = async (key) => { const value = await get(key); started.resolve(); await resume.promise; return value; };
  const reading = cache.get('group:row'); await started.promise;
  await cache.deleteByPattern('group:*'); resume.resolve(); await reading;
  assert.equal(l1.get('worker:group:row'), undefined);
});
