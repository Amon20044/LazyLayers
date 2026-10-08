import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditRedis } from './helpers/audit-redis.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const { HybridCache, RedisStore, MemoryStore, MemoryBudget, OriginLoadGate, InflightOverloadError, serialize } = await import(
  process.env.LAZY_LAYERS_AUDIT_ENTRY ?? '../dist/index.js'
);
const quiet = { enabled: false };
const limits = { timeout: 2_000 };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
function memory(overrides = {}) {
  const entries = new Map();
  return {
    entries,
    async get(key) { return entries.get(key); },
    async set(key, value) { entries.set(key, value); },
    async has(key) { return entries.has(key); },
    async delete(key) { entries.delete(key); },
    async deleteByPattern() { entries.clear(); },
    async size() { return entries.size; },
    ...overrides,
  };
}
function bus() {
  let handler;
  return {
    published: [],
    async subscribe(fn) { handler = fn; },
    async publish(event) { this.published.push(event); },
    receive(event) { return handler(event); },
  };
}
function retainedKeyBytes(map) {
  let bytes = 0;
  for (const key of map.keys()) bytes += Buffer.byteLength(String(key)) * 2;
  return bytes;
}

test('audit: a failed lease acquisition returns the origin result without overwriting a protected winner', limits, async (t) => {
  const redis = new AuditRedis();
  const store = new RedisStore(redis, { prefix: 'outage:', keyLayout: 'v2' });
  const events = bus();
  const started = deferred();
  const finish = deferred();
  const acquire = store.acquireLock.bind(store);
  store.acquireLock = async () => { throw new Error('isolated acquisition outage'); };
  const a = new HybridCache({ l2: store, logging: quiet, eventBus: events, failSafe: { enabled: false } });
  const b = new HybridCache({ l2: new RedisStore(redis, { prefix: 'outage:', keyLayout: 'v2' }), logging: quiet });
  t.after(async () => { finish.resolve('obsolete'); await Promise.all([a.close(), b.close()]); redis.values.clear(); });
  await a.ready();
  const old = a.getOrSet('row', async () => { started.resolve(); return finish.promise; });
  await started.promise;
  store.acquireLock = acquire;
  assert.equal(await b.getOrSet('row', async () => 'winner'), 'winner');
  finish.resolve('obsolete');
  assert.equal(await old, 'obsolete', 'Fail-open keeps the caller response contract');
  assert.equal(await store.get('row'), 'winner');
  assert.equal(await a.get('row'), 'winner');
  assert.equal(events.published.filter((event) => event.type === 'set').length, 0);
});

test('audit: explicitly unlocked contention fallback does not publish into protected cache state', limits, async (t) => {
  const redis = new AuditRedis();
  const store = new RedisStore(redis, { prefix: 'contention:', keyLayout: 'v2' });
  const started = deferred();
  const finish = deferred();
  const cache = new HybridCache({ l2: store, logging: quiet, failSafe: { enabled: false }, distributedLock: { waitTimeoutMs: 0, onTimeout: 'load' } });
  t.after(async () => { finish.resolve('obsolete'); await cache.close(); redis.values.clear(); });
  assert.equal(await store.acquireLock('row', 'leader', 500), true);
  const fallback = cache.getOrSet('row', async () => { started.resolve(); return finish.promise; });
  await started.promise;
  assert.equal(await store.publishIfOwner('row', 'leader', serialize('winner'), 500), 'published');
  finish.resolve('obsolete');
  assert.equal(await fallback, 'obsolete');
  assert.equal(await store.get('row'), 'winner');
});

test('audit: distinct malformed UTF-16 keys retain distinct Redis wire identities', limits, async () => {
  const redis = new AuditRedis();
  const store = new RedisStore(redis, { prefix: 'unicode:', keyLayout: 'v2' });
  try {
    await store.set('\ud800', 'first');
    await store.set('\ud801', 'second');
    const networkKeys = [...redis.values.keys()].map((key) => Buffer.from(key).toString('hex'));
    assert.equal(new Set(networkKeys).size, 2, 'UTF-8 replacement must not collapse the complete physical keys');
    await store.set('hello:☃', 'valid');
    assert.ok(redis.values.has(`lazy-layers:v2:{${encodeURIComponent('hello:☃')}}:unicode:hello:☃`),
      'Well-formed Unicode retains the existing v2 protocol layout');
  } finally { redis.values.clear(); }
});

test('audit: Redis v2 nested prefixes cannot delete another namespace by clearing a shorter prefix', limits, async () => {
  const redis = new AuditRedis();
  const parent = new RedisStore(redis, { prefix: 'tenant:', keyLayout: 'v2' });
  const child = new RedisStore(redis, { prefix: 'tenant:child:', keyLayout: 'v2' });
  try {
    await parent.set('child:row', 'parent-value');
    await child.set('row', 'child-value');
    await parent.clear();
    assert.equal(await child.get('row'), 'child-value');
    assert.equal(await parent.get('child:row'), undefined);
  } finally { redis.values.clear(); }
});

test('audit: Redis patterns use only star as wildcard and preserve literal question/bracket bytes', limits, async () => {
  const redis = new AuditRedis();
  const store = new RedisStore(redis, { prefix: 'pattern[?]:', keyLayout: 'v2' });
  try {
    await store.set('literal?row', 'question');
    await store.set('literalXrow', 'letter');
    await store.deleteByPattern('literal?*');
    assert.equal(await store.get('literal?row'), undefined);
    assert.equal(await store.get('literalXrow'), 'letter');
  } finally { redis.values.clear(); }
});

test('audit: legacy metadata key collisions are rejected before a Redis command is issued', limits, async () => {
  const redis = new AuditRedis();
  const store = new RedisStore(redis, { prefix: 'legacy:', keyLayout: 'legacy' });
  await assert.rejects(store.get('__lock:row'), /reserved|collid/i);
  await assert.rejects(store.get('__index'), /reserved|collid/i);
  assert.equal(redis.values.size, 0);
});

test('audit: scoped events reject wrong/untagged namespaces before deduplication and publish their scope', limits, async (t) => {
  const events = bus();
  const cache = new HybridCache({ logging: quiet, eventBus: events, eventNamespace: 'tenant-A' });
  t.after(() => cache.close());
  await cache.ready();
  await cache.set('row', 'current');
  const invalidation = { id: 'same-id', type: 'del', keys: ['row'], source: 'peer', ts: 1 };
  await events.receive({ ...invalidation, namespace: 'tenant-B' });
  await events.receive(invalidation);
  assert.equal(await cache.get('row'), 'current');
  await events.receive({ ...invalidation, namespace: 'tenant-A' });
  assert.equal(await cache.get('row'), undefined);
  await cache.delete('other');
  assert.equal(events.published.at(-1).namespace, 'tenant-A');
});

test('audit: negative keys cannot bypass a small shared memory budget and are released on close', limits, async (t) => {
  const ledger = new MemoryBudget({ maxMemory: 160 * 1024, sampleIntervalMs: 0 });
  const cache = new HybridCache({ l1: false, logging: quiet, memoryBudget: ledger, failSafe: { enabled: false } });
  t.after(async () => { await cache.close(); ledger.close(); });
  for (let index = 0; index < 24; index++) {
    assert.equal(await cache.getOrSet(`${index}:${'k'.repeat(16 * 1024)}`, async () => undefined), undefined);
  }
  assert.ok(cache.negative.size > 0, 'The budget still admits ordinary bounded negative entries');
  assert.ok(retainedKeyBytes(cache.negative) <= ledger.hardCap, 'Raw negative keys must not bypass B');
  assert.ok(ledger.snapshot().accountedBytes <= ledger.hardCap);
  await cache.close();
  assert.equal(ledger.snapshot().accountedBytes, 0);
});

test('audit: event deduplication keys have a byte cap and release their shared reservations', limits, async (t) => {
  const events = bus();
  const ledger = new MemoryBudget({ maxMemory: 256 * 1024, sampleIntervalMs: 0 });
  const cache = new HybridCache({ l1: false, logging: quiet, eventBus: events, memoryBudget: ledger });
  t.after(async () => { await cache.close(); ledger.close(); });
  await cache.ready();
  for (let index = 0; index < 40; index++) {
    await events.receive({ id: `${index}:${'i'.repeat(16 * 1024)}`, type: 'pattern', pattern: 'unused', source: 'peer', ts: index });
  }
  assert.ok(retainedKeyBytes(cache.seenEvents) <= ledger.hardCap);
  assert.ok(ledger.snapshot().accountedBytes <= ledger.hardCap);
  await cache.close();
  assert.equal(ledger.snapshot().accountedBytes, 0);
});

test('audit: generation-byte saturation never exposes an older v0 entry or accepts a delayed old fill', limits, async (t) => {
  const l2 = memory();
  const events = bus();
  const started = deferred();
  const finish = deferred();
  const cache = new HybridCache({ l1: false, l2, logging: quiet, eventBus: events, versioning: { enabled: true }, failSafe: { enabled: false } });
  t.after(async () => { finish.resolve('obsolete-fill'); await cache.close(); });
  await cache.ready();
  await cache.set('row', 'old-v0');
  await events.receive({ id: 'hide-v0', type: 'del', keys: ['row'], source: 'peer', ts: 1, generation: 1 });
  assert.equal(l2.entries.get('row::v0'), 'old-v0', 'L2 intentionally retains a hidden old version');
  assert.equal(await cache.get('row'), undefined);
  const loading = cache.getOrSet('pending', async () => { started.resolve(); return finish.promise; });
  await started.promise;
  for (let index = 0; index < 18; index++) await cache.delete(`${index}:${'x'.repeat(64 * 1024)}`);
  assert.ok(retainedKeyBytes(cache.generations) <= 2 * 1024 * 1024);
  assert.equal(cache.getCoordinationStats().generationTrackingSaturated, true);
  assert.equal(await cache.get('row'), undefined, 'Exhausted tombstone memory cannot reset the key to v0');
  finish.resolve('obsolete-fill');
  assert.equal(await loading, 'obsolete-fill');
  assert.equal(l2.entries.has('pending::v0'), false, 'A fill spanning saturation cannot publish');
  await events.receive({ id: 'late-v0', type: 'set', keys: ['row'], source: 'peer', ts: 2, generation: 0, value: 'old-event' });
  assert.equal(await cache.get('row'), undefined);
});

test('audit: a restarted peer lower-generation delete cannot leave a higher-generation cache value readable', limits, async (t) => {
  const l2 = memory();
  const events = bus();
  const restartedEvents = bus();
  restartedEvents.publish = async (event) => {
    restartedEvents.published.push(event);
    await events.receive(event);
  };
  const options = { l2, logging: quiet, eventNamespace: 'tenant', versioning: { enabled: true } };
  const existing = new HybridCache({ ...options, eventBus: events });
  const restarted = new HybridCache({ ...options, eventBus: restartedEvents });
  const finish = deferred();
  const started = deferred();
  t.after(async () => { finish.resolve('obsolete'); await Promise.all([existing.close(), restarted.close()]); });
  await Promise.all([existing.ready(), restarted.ready()]);
  await existing.delete('row');
  await existing.delete('row');
  await existing.set('row', 'old-v2');
  assert.equal(await existing.get('row'), 'old-v2');
  await events.receive({ id: 'other-scope-regression', type: 'del', keys: ['row'], generation: 0, namespace: 'other-tenant', source: 'peer', ts: 1 });
  assert.equal(await existing.get('row'), 'old-v2', 'Other namespaces cannot force conservative bypass');
  const pending = existing.getOrSet('pending', async () => { started.resolve(); return finish.promise; });
  await started.promise;
  await restarted.set('row', 'new-v0');
  await restarted.delete('row');
  assert.equal(await existing.get('row'), undefined, 'A lower generation can be a real delete after peer restart');
  assert.equal(existing.getCoordinationStats().generationTrackingSaturated, true);
  assert.equal(existing.stale.size, 0);
  assert.equal(existing.negative.size, 0);
  assert.equal(await existing.getOrSet('row', async () => 'current-origin'), 'current-origin');
  assert.equal(await existing.get('row'), undefined, 'Unsafe non-durable generations permanently bypass caching');
  finish.resolve('obsolete');
  assert.equal(await pending, 'obsolete');
  assert.equal(l2.entries.has('pending::v0'), false, 'A fill spanning the generation regression cannot publish');
  assert.equal(l2.entries.get('row::v2'), 'old-v2', 'The hidden old physical record remains inaccessible');
});

test('audit: default unversioned caches evict lower-generation deletes after restart including legacy numeric aliases', limits, async (t) => {
  const l2 = memory();
  const events = bus();
  const peerEvents = bus();
  peerEvents.publish = (event) => events.receive(event);
  const options = { l2, logging: quiet, eventNamespace: 'tenant' };
  const existing = new HybridCache({ ...options, eventBus: events });
  const restarted = new HybridCache({ ...options, eventBus: peerEvents });
  t.after(() => Promise.all([existing.close(), restarted.close()]));
  await Promise.all([existing.ready(), restarted.ready()]);
  await existing.delete('row'); await existing.delete('row'); await existing.set('row', 'old');
  await restarted.set('row', 'new'); await restarted.delete('row');
  assert.equal(await existing.get('row'), undefined, 'A process-local delete counter cannot suppress a real peer delete');
  assert.equal(existing.getCoordinationStats().generationTrackingSaturated, false, 'Unversioned storage needs eviction without permanent bypass');
  await existing.delete(42); await existing.delete(42); await existing.set(42, 'numeric');
  // The publisher owns shared-tier deletion; this legacy receive exercises
  // typed local aliases after that authoritative mutation already committed.
  await l2.delete(42);
  await events.receive({ id: 'legacy-lower-delete', type: 'del', keys: ['42'], source: 'legacy-peer', namespace: 'tenant', generation: 1, ts: 1 });
  assert.equal(await existing.get(42), undefined, 'Lower legacy deletes must also evict the possible numeric key');
});

test('audit: concurrent custom reads cannot retain unlimited distinct revision-map key bytes', limits, async (t) => {
  const finish = deferred();
  const l1 = memory({ async get() { await finish.promise; return undefined; } });
  const cache = new HybridCache({ l1, logging: quiet, failSafe: { enabled: false } });
  t.after(async () => { finish.resolve(); await cache.close(); });
  const reads = Array.from({ length: 32 }, (_, index) => cache.get(`${index}:${'r'.repeat(64 * 1024)}`));
  await tick();
  assert.ok(cache.getCoordinationStats().keyRevisionBytes <= 2 * 1024 * 1024);
  finish.resolve();
  await Promise.all(reads);
  assert.equal(cache.getCoordinationStats().keyRevisionBytes, 0);
});

test('audit: a stale custom-L1 publication cannot leave an older value after a replacement write', limits, async (t) => {
  const writing = deferred();
  const resume = deferred();
  const l1 = memory();
  l1.set = async (key, value) => {
    if (value === 'obsolete') { writing.resolve(); await resume.promise; }
    l1.entries.set(key, value);
  };
  const cache = new HybridCache({ l1, logging: quiet, failSafe: { enabled: false } });
  t.after(async () => { resume.resolve(); await cache.close(); });
  const loading = cache.getOrSet('row', async () => 'obsolete');
  await writing.promise;
  await cache.set('row', 'replacement');
  resume.resolve();
  await loading;
  assert.notEqual(await cache.get('row'), 'obsolete', 'Custom adapters may conservatively evict; they must not retain stale data');
});

test('audit: built-in L1 keeps a replacement value when an older committed write resumes', limits, async (t) => {
  const l1 = new MemoryStore({ failSafe: { enabled: false } });
  const writing = deferred();
  const resume = deferred();
  const original = l1.setEncoded.bind(l1);
  let first = true;
  l1.setEncoded = async (...args) => {
    await original(...args);
    if (first) { first = false; writing.resolve(); await resume.promise; }
  };
  const cache = new HybridCache({ l1, logging: quiet, failSafe: { enabled: false } });
  t.after(async () => { resume.resolve(); await cache.close(); l1.close(); });
  const loading = cache.getOrSet('row', async () => 'obsolete');
  await writing.promise;
  await cache.set('row', 'replacement');
  resume.resolve();
  await loading;
  assert.equal(await cache.get('row'), 'replacement');
});

test('audit: corrupt Redis bytes are a miss while a legitimate null remains a cache hit', limits, async (t) => {
  const redis = new AuditRedis();
  const store = new RedisStore(redis, { prefix: 'decode:', keyLayout: 'v2' });
  const cache = new HybridCache({ l2: store, logging: quiet });
  t.after(async () => { await cache.close(); redis.values.clear(); });
  await store.set('broken', 'seed');
  const key = [...redis.values.keys()][0];
  redis.values.get(key).value = Buffer.from('HC1:malformed');
  let loads = 0;
  assert.equal(await cache.getOrSet('broken', async () => { loads++; return 'recovered'; }), 'recovered');
  assert.equal(loads, 1);
  await store.set('null', null);
  assert.equal(await cache.getOrSet('null', async () => { throw new Error('valid null must hit'); }), null);
});

test('audit: negative maxEntries zero disables retained misses', limits, async (t) => {
  const cache = new HybridCache({ l1: false, logging: quiet, negativeCache: { maxEntries: 0 } });
  t.after(() => cache.close());
  let calls = 0;
  await cache.getOrSet('row', async () => { calls++; return undefined; });
  await cache.getOrSet('row', async () => { calls++; return undefined; });
  assert.equal(calls, 2);
  assert.equal(cache.negative.size, 0);
});

test('audit: non-finite cache metadata budgets are rejected before creating resources', limits, () => {
  for (const options of [
    { inflight: { maxEntries: Infinity } },
    { inflight: { maxWaiters: NaN } },
    { inflight: { ttlMs: NaN } },
    { negativeCache: { ttlMs: Infinity } },
    { failSafe: { staleTtlMs: NaN } },
    { failSafe: { maxBytes: Infinity } },
    { eventDedupeMaxEntries: Infinity },
    { eventDedupeTtlMs: NaN },
    { timeouts: { hardMs: Infinity } },
  ]) {
    assert.throws(() => new HybridCache({ l1: false, logging: quiet, ...options }), /finite|integer|budget/i);
  }
});

test('audit: invalid per-operation metadata budgets reject without invoking the loader', limits, async (t) => {
  const cache = new HybridCache({ l1: false, logging: quiet });
  t.after(() => cache.close());
  await assert.rejects(cache.getOrSet('row', () => assert.fail('invalid options cannot invoke origin'), { negativeCache: { ttlMs: NaN } }), RangeError);
  await assert.rejects(cache.set('row', 'value', { failSafe: { maxBytes: Infinity } }), RangeError);
});

test('audit: tracked in-flight key bytes are finite even when callers use large distinct keys', limits, async (t) => {
  const finish = deferred();
  const cache = new HybridCache({ l1: false, logging: quiet, failSafe: { enabled: false } });
  t.after(async () => { finish.resolve('result'); await cache.close(); });
  const operations = Array.from({ length: 32 }, (_, index) => cache.getOrSet(`${index}:${'f'.repeat(64 * 1024)}`, async () => finish.promise));
  await tick();
  assert.ok(retainedKeyBytes(cache.inflight) <= 2 * 1024 * 1024);
  finish.resolve('result');
  await Promise.all(operations);
  assert.equal(cache.getCoordinationStats().inflightBytes, 0);
});

test('audit: queued origin keys are byte bounded and cancellation releases their ledger reservations', limits, async () => {
  const ledger = new MemoryBudget({ maxMemory: 160 * 1024, sampleIntervalMs: 0 });
  const gate = new OriginLoadGate({ maxConcurrent: 1, maxQueued: 100, queueTimeoutMs: 500 }, ledger);
  const first = await gate.acquire('active');
  const controller = new AbortController();
  try {
    const queued = gate.acquire('q'.repeat(64 * 1024), controller.signal).then(() => assert.fail('cancelled work must not receive a slot'), (error) => error);
    await assert.rejects(gate.acquire('another'.repeat(16 * 1024)), /queue|overload|budget/i);
    assert.ok(ledger.snapshot().accountedBytes <= ledger.hardCap);
    controller.abort(new Error('cancelled by audit'));
    assert.match((await queued).message, /cancelled/);
    assert.equal(gate.stats().queued, 0);
    assert.equal(gate.stats().queuedBytes, 0);
    assert.equal(ledger.snapshot().accountedBytes, 0);
  } finally { controller.abort(); gate.close(); first(); ledger.close(); }
});

test('audit: a generation-zero restart cannot see a deleted old version when a v1 write queued concurrently', limits, async (t) => {
  const started = deferred();
  const finish = deferred();
  const l2 = memory();
  const get = l2.get;
  l2.get = async (key) => {
    if (key === 'occupier::v0') { started.resolve(); await finish.promise; }
    return get(key);
  };
  const options = { l1: false, l2, logging: quiet, versioning: { enabled: true }, failSafe: { enabled: false }, resilience: { l2OperationGate: { maxConcurrent: 1, maxQueued: 8 } } };
  const cache = new HybridCache(options);
  const restarted = new HybridCache(options);
  t.after(async () => { finish.resolve(); await Promise.all([cache.close(), restarted.close()]); });
  await cache.set('row', 'old-v0');
  const occupying = cache.get('occupier');
  await started.promise;
  const deleting = cache.delete('row');
  await tick();
  const replacing = cache.set('row', 'new-v1');
  await tick();
  finish.resolve();
  await Promise.all([occupying, deleting, replacing]);
  assert.equal(l2.entries.get('row::v1'), 'new-v1');
  assert.equal(l2.entries.has('row::v0'), false, 'A superseding v1 write cannot cancel deletion of disjoint v0');
  assert.equal(await restarted.get('row'), undefined);
});

test('audit: subscription completion cannot restore trust after an immediate transport loss', limits, async (t) => {
  let report;
  const events = bus();
  events.onStatus = (fn) => { report = fn; return () => {}; };
  const subscribe = events.subscribe.bind(events);
  events.subscribe = async (handler) => { await subscribe(handler); report('disconnected'); };
  const cache = new HybridCache({ logging: quiet, eventBus: events });
  t.after(() => cache.close());
  await cache.ready();
  assert.equal(cache.isInvalidationTrusted(), false);
});

test('audit: custom-bus malformed typed keys cannot poison numeric L1 state', limits, async (t) => {
  const events = bus();
  const cache = new HybridCache({ logging: quiet, eventBus: events, eventNamespace: 'scope' });
  t.after(() => cache.close());
  await cache.ready();
  await cache.set(7, 'safe');
  await events.receive({ id: 'malformed', type: 'set', namespace: 'other', keys: ['NaN'], keyTypes: ['number'], value: 'poison', source: 'peer', ts: NaN });
  assert.equal(cache.isInvalidationTrusted(), true, 'Other scopes cannot change trust');
  await events.receive({ id: 'malformed', type: 'set', namespace: 'scope', keys: ['NaN'], keyTypes: ['number'], value: 'poison', source: 'peer', ts: 1 });
  assert.notEqual(await cache.get(NaN), 'poison');
});

test('audit: local lease expiry survives a backward clock change during an event-loop stall', limits, async () => {
  const input = process.env.LAZY_LAYERS_AUDIT_ENTRY;
  const entry = input ? pathToFileURL(input).href : new URL('../dist/index.js', import.meta.url).href;
  const { maintainLock } = await import(new URL('cache/distributedLock.js', new URL('.', entry)));
  const original = Date.now;
  const lease = maintainLock('row', 10, original());
  try {
    Date.now = () => original() - 1_000_000;
    const until = performance.now() + 20;
    while (performance.now() < until) { /* bounded 20ms stall prevents the expiry timer from running */ }
    assert.throws(() => lease.assertOwned(), /Lost|lock/i);
  } finally { Date.now = original; lease.stop(); }
  await sleep(1);
});

test('audit: read-only L2 queues charge retained key bytes and shed oversized queued work', limits, async (t) => {
  const started = deferred();
  const finish = deferred();
  const l2 = memory({ async get(key) {
    if (key === 'active') { started.resolve(); await finish.promise; }
    return undefined;
  } });
  const cache = new HybridCache({ l1: false, l2, logging: quiet, resilience: { l2OperationGate: { maxConcurrent: 1, maxQueued: 10, maxQueuedBytes: 64 * 1024 } } });
  t.after(async () => { finish.resolve(); await cache.close(); });
  const active = cache.get('active');
  await started.promise;
  const oversized = cache.get('k'.repeat(64 * 1024));
  await tick();
  assert.equal(cache.getL2OperationStats().queued, 0, 'A zero-payload GET still retains its key in the queued closure');
  assert.equal(await oversized, undefined);
  finish.resolve();
  await active;
});

test('audit: corrupt encoded L1 records are removed when Hybrid reads them', limits, async (t) => {
  const l1 = new MemoryStore();
  const cache = new HybridCache({ l1, logging: quiet });
  t.after(async () => { await cache.close(); l1.close(); });
  await l1.setEncoded('broken', Buffer.from('HC1:bad-format'));
  assert.equal(await cache.get('broken'), undefined);
  assert.equal(await l1.has('broken'), false);
});

test('audit: dashboard previews reject compressed expansion beyond their preview budget', limits, async () => {
  const redis = new AuditRedis();
  const store = new RedisStore(redis, { prefix: 'preview:', keyLayout: 'v2' });
  try {
    await store.setEncoded('large', serialize('x'.repeat(512 * 1024), { compression: 'gzip' }));
    const preview = await store.inspect({ maxValueBytes: 1024 });
    assert.equal(preview.keys[0].truncated, true);
    assert.equal(preview.keys[0].value, undefined);
  } finally { redis.values.clear(); }
});

test('audit: a poisoned Redis catalogue cannot expose another namespace through inspection', limits, async () => {
  const redis = new AuditRedis();
  const parent = new RedisStore(redis, { prefix: 'index:', keyLayout: 'v2', useIndex: true });
  const child = new RedisStore(redis, { prefix: 'index:child:', keyLayout: 'v2' });
  try {
    await child.set('secret', 'other-tenant');
    const foreign = [...redis.values.keys()][0];
    redis.zscan = async () => ['0', [foreign, '1']];
    const inspection = await parent.inspect();
    assert.equal(inspection.keys.length, 0);
  } finally { redis.values.clear(); }
});

test('audit: per-write Redis entry limits and scoped namespace metadata reject malformed configuration', limits, async () => {
  const redis = new AuditRedis();
  const store = new RedisStore(redis, { keyLayout: 'v2' });
  await assert.rejects(store.set('row', 'value', { levels: { L2: { maxEntries: NaN } } }), RangeError);
  assert.equal(redis.values.size, 0, 'Malformed admission metadata cannot commit a write first');
  assert.throws(() => new HybridCache({ l1: false, eventNamespace: '\ud800' }), /Unicode/);
  assert.throws(() => new HybridCache({ l1: false, eventNamespace: 's'.repeat(64 * 1024 + 1) }), /64 KiB/);
});

test('audit: one hot key has a finite follower budget and every accepted follower shares one load', limits, async (t) => {
  const finish = deferred();
  const started = deferred();
  const cache = new HybridCache({ l1: false, logging: quiet, inflight: { maxWaiters: 3 }, failSafe: { enabled: false } });
  t.after(async () => { finish.resolve('value'); await cache.close(); });
  let loads = 0;
  const leader = cache.getOrSet('row', async () => { loads++; started.resolve(); return finish.promise; });
  await started.promise;
  const errors = [];
  const followers = Array.from({ length: 6 }, () => cache.getOrSet('row', async () => assert.fail('followers must share'))
    .then((value) => ({ value }), (error) => { errors.push(error); return { error }; }));
  await tick();
  assert.equal(errors.length, 3, 'Followers beyond the configured budget reject immediately');
  assert.ok(errors.every((error) => error instanceof InflightOverloadError));
  assert.equal(cache.getCoordinationStats().activeFollowers, 3);
  finish.resolve('value');
  assert.equal(await leader, 'value');
  const outcomes = await Promise.all(followers);
  assert.equal(outcomes.filter((result) => result.value === 'value').length, 3);
  assert.equal(loads, 1);
  assert.equal(cache.getCoordinationStats().activeFollowers, 0);
  assert.equal(cache.getCoordinationStats().followerBytes, 0);
});

test('audit: loader errors fan out to accepted followers and release the entire follower budget', limits, async (t) => {
  const started = deferred();
  const finish = deferred();
  const cause = new Error('isolated origin error');
  const cache = new HybridCache({ l1: false, logging: quiet, inflight: { maxWaiters: 2 }, failSafe: { enabled: false } });
  t.after(async () => { finish.resolve(); await cache.close(); });
  const leader = cache.getOrSet('row', async () => { started.resolve(); await finish.promise; throw cause; }).catch((error) => error);
  await started.promise;
  const followers = Array.from({ length: 3 }, () => cache.getOrSet('row', () => assert.fail('must coalesce')).catch((error) => error));
  await tick();
  finish.resolve();
  const outcomes = await Promise.all([leader, ...followers]);
  assert.equal(outcomes.filter((result) => result === cause).length, 3);
  assert.equal(outcomes.filter((result) => result?.code === 'INFLIGHT_OVERLOADED').length, 1);
  assert.equal(cache.getCoordinationStats().activeFollowers, 0);
  assert.equal(await cache.getOrSet('row', async () => 'recovered'), 'recovered');
});

test('audit: accepted followers retain shutdown response compatibility and release B after settlement', limits, async (t) => {
  const ledger = new MemoryBudget({ maxMemory: 1024 * 1024, sampleIntervalMs: 0 });
  const started = deferred();
  const finish = deferred();
  const cache = new HybridCache({ l1: false, memoryBudget: ledger, logging: quiet, inflight: { maxWaiters: 2 } });
  t.after(async () => { finish.resolve('late'); await cache.close(); ledger.close(); });
  const first = cache.getOrSet('row', async () => { started.resolve(); return finish.promise; });
  await started.promise;
  const followers = [cache.getOrSet('row', () => assert.fail('must coalesce')), cache.getOrSet('row', () => assert.fail('must coalesce'))];
  await tick();
  await cache.close();
  finish.resolve('late');
  assert.deepEqual(await Promise.all([first, ...followers]), ['late', 'late', 'late']);
  assert.equal(cache.getCoordinationStats().activeFollowers, 0);
  assert.equal(ledger.snapshot().accountedBytes, 0);
});

test('audit: small B rejects retained L2 keys before queuing while leaving the active call bounded', limits, async (t) => {
  const ledger = new MemoryBudget({ maxMemory: 64 * 1024, sampleIntervalMs: 0 });
  const started = deferred();
  const finish = deferred();
  const l2 = memory({ async get(key) { if (key === 'active') { started.resolve(); await finish.promise; } return undefined; } });
  const cache = new HybridCache({ l1: false, l2, memoryBudget: ledger, logging: quiet, resilience: { l2OperationGate: { maxConcurrent: 1, maxQueued: 10 } } });
  t.after(async () => { finish.resolve(); await cache.close(); ledger.close(); });
  const active = cache.get('active');
  await started.promise;
  const big = cache.get('k'.repeat(40 * 1024));
  await tick();
  assert.equal(cache.getL2OperationStats().queued, 0);
  assert.equal(await big, undefined);
  finish.resolve();
  await active;
  assert.equal(ledger.snapshot().accountedBytes, 0);
});

test('audit: timed-out L2 calls hold their retained-byte reservation until actual settlement', limits, async (t) => {
  const ledger = new MemoryBudget({ maxMemory: 32 * 1024, sampleIntervalMs: 0 });
  const finish = deferred();
  const l2 = memory({ async get() { await finish.promise; return undefined; } });
  const cache = new HybridCache({ l1: false, l2, memoryBudget: ledger, logging: quiet, resilience: { l2OperationGate: { operationTimeoutMs: 5 } } });
  t.after(async () => { finish.resolve(); await cache.close(); ledger.close(); });
  assert.equal(await cache.get('k'.repeat(4096)), undefined);
  assert.ok(ledger.snapshot().accountedBytes >= 8192, 'A caller-facing timeout must not free retained work');
  finish.resolve();
  await tick();
  assert.equal(ledger.snapshot().accountedBytes, 0);
});

test('audit: delayed authoritative set hints cannot extend L1 past the snapshot TTL', limits, async (t) => {
  const events = bus();
  let first = true;
  const l2 = memory({
    encodedFormat: 'lazy-layers-hc1',
    async setEncoded() {},
    async getEncoded() {
      if (!first) return undefined;
      first = false;
      await sleep(40);
      return { buffer: serialize('expired'), ttlRemainingMs: 20 };
    },
  });
  const cache = new HybridCache({ l2, eventBus: events, logging: quiet, failSafe: { enabled: false } });
  t.after(() => cache.close());
  await cache.ready();
  await events.receive({ id: 'late-ttl', type: 'set', keys: ['row'], source: 'peer', ts: 1, value: 'hint', generation: 0 });
  assert.equal(await cache.get('row'), undefined);
});

test('audit: nonencoded custom L1 promotion receives the authoritative remaining TTL for reads and peer hints', limits, async (t) => {
  const events = bus();
  const writes = [];
  const l1 = memory({ async set(key, value, options) { writes.push({ key, value, options }); } });
  const l2 = memory({
    encodedFormat: 'lazy-layers-hc1',
    async setEncoded() {},
    async getEncoded() { return { buffer: serialize('current'), ttlRemainingMs: 20 }; },
  });
  const cache = new HybridCache({ l1, l2, eventBus: events, logging: quiet, ttlMs: 1000, levels: { L1: { ttlMs: 900 } }, failSafe: { enabled: false } });
  t.after(() => cache.close());
  await cache.ready();
  assert.equal(await cache.get('read'), 'current');
  assert.ok(writes[0].options.ttlMs > 0 && writes[0].options.ttlMs <= 20, 'A custom L1 cannot inherit a longer normal-read TTL');
  assert.ok(writes[0].options.levels.L1.ttlMs <= 20, 'An explicit L1 TTL cannot override the cap');
  await events.receive({ id: 'ttl-hint', type: 'set', source: 'peer', ts: 1, keys: ['hint'], ttlMs: 800, value: 'obsolete' });
  assert.equal(writes[1].value, 'current');
  assert.ok(writes[1].options.ttlMs > 0 && writes[1].options.ttlMs <= 20, 'Peer hint promotion follows the same TTL cap');
  assert.ok(writes[1].options.levels.L1.ttlMs <= 20);
});

test('audit: Redis snapshot rejects oversized network payloads before GET and inspection uses its preview cap', limits, async () => {
  const redis = new AuditRedis();
  const store = new RedisStore(redis, { prefix: 'bounded:', keyLayout: 'v2', decodeLimits: { maxEncodedBytes: 1024 } });
  try {
    await store.setEncoded('row', serialize('x'.repeat(8192), { compression: 'none' }));
    let transferred = 0;
    const execute = redis.execute.bind(redis);
    redis.execute = (name, args) => {
      const result = execute(name, args);
      if (name === 'lazyLayersGetSnapshotV1' && Buffer.isBuffer(result[0])) transferred += result[0].byteLength;
      return result;
    };
    assert.ok((await store.getEncoded('row')) === undefined, 'an oversized encoded record must be rejected before transfer');
    assert.equal(transferred, 0, 'The protocol double models the server returning metadata, not full rejected bytes');
    const inspection = await store.inspect({ maxValueBytes: 512 });
    assert.equal(inspection.keys[0].truncated, true);
    assert.equal(inspection.keys[0].value, undefined);
    assert.equal(transferred, 0);
  } finally { redis.values.clear(); }
});
