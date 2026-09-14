import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

const { HybridCache, MemoryBudget, MemoryStore } = await import('../dist/index.js');

const signal = (availableBytes, psiSomeAvg10 = 0) => ({
  effectiveBytes: 100_000,
  availableBytes,
  psiSomeAvg10,
  available: { effectiveBytes: true, availableBytes: true, psiSomeAvg10: true },
});

test('synthetic critical pressure evicts L1 entries and blocks new admissions', async () => {
  const budget = new MemoryBudget({ maxMemory: 40_000, sampleIntervalMs: 0 });
  const store = new MemoryStore({
    memoryBudget: budget,
    levels: { L1: { maxEntries: 100, admission: { enabled: false } } },
  });

  for (let index = 0; index < 8; index += 1) {
    await store.setEncoded(`entry:${index}`, Buffer.alloc(4_000, index));
  }

  const before = store.stats();
  assert.ok(before.retainedBytes > 28_000);

  const pressured = budget.sample(signal(4_000));
  assert.equal(pressured.pressureState, 'critical');
  assert.equal(pressured.target, 28_000);
  assert.ok(pressured.accountedBytes <= pressured.target);
  assert.ok(store.stats().entries < before.entries);
  assert.equal(budget.permitsPromotion(1), false);

  await store.setEncoded('rejected-under-pressure', Buffer.alloc(512));
  assert.equal(await store.has('rejected-under-pressure'), false);
  assert.ok(store.stats().rejected > 0);
  store.close();
});

test('synthetic sustained pressure and recovery use hysteresis instead of flapping', async () => {
  let now = 0;
  const budget = new MemoryBudget({
    maxMemory: 100_000,
    sampleIntervalMs: 0,
    pressureWindowMs: 100,
    recoveryWindowMs: 100,
    now: () => now,
  });
  const evictions = [];
  budget.register(() => {
    evictions.push(now);
    budget.release(1_000);
    return true;
  });
  assert.equal(budget.tryReserve(100_000), true);

  budget.sample(signal(10_000, 10));
  assert.equal(budget.snapshot().pressureState, 'normal');
  assert.equal(budget.snapshot().target, 100_000);

  now = 100;
  const pressured = budget.sample(signal(10_000, 10));
  assert.equal(pressured.pressureState, 'pressure');
  assert.equal(pressured.target, 70_000);
  assert.ok(evictions.length <= 32);

  now = 150;
  budget.sample(signal(90_000));
  assert.equal(budget.snapshot().target, 70_000);

  now = 250;
  const recovering = budget.sample(signal(90_000));
  assert.equal(recovering.pressureState, 'normal');
  assert.equal(recovering.target, 75_000);
});

test('synthetic pressure can evict fail-safe snapshots from the shared byte budget', async () => {
  const budget = new MemoryBudget({ maxMemory: 100_000, minMemory: 1_000, sampleIntervalMs: 0 });
  const cache = new HybridCache({
    memoryBudget: budget,
    logging: { enabled: false },
    failSafe: { enabled: true, staleTtlMs: 60_000 },
    levels: { L1: { admission: { enabled: false } } },
  });

  for (let index = 0; index < 4; index += 1) {
    await cache.set(`entry:${index}`, randomBytes(10_000));
  }

  const staleBefore = budget.snapshot().categories.stale;
  assert.ok(staleBefore > 0);
  const pressured = budget.sample(signal(4_000));
  assert.equal(pressured.pressureState, 'critical');
  assert.ok(pressured.accountedBytes <= pressured.target);
  assert.ok((pressured.categories.stale ?? 0) < staleBefore);
  await cache.close();
  assert.equal(budget.snapshot().accountedBytes, 0);
});

test('critical pressure serves Redis-like L2 hits without promoting them into L1', async () => {
  const budget = new MemoryBudget({ maxMemory: 100_000, sampleIntervalMs: 0 });
  const l1 = new MemoryStore({ memoryBudget: budget });
  const events = [];
  const l2 = {
    async get(key) { return key === 'key' ? { source: 'L2' } : undefined; },
    async set() {},
    async has(key) { return key === 'key'; },
    async delete() {},
    async deleteByPattern() {},
    async clear() {},
    async size() { return 1; },
    async getOrSet(key, loader) { return (await this.get(key)) ?? loader(); },
  };
  const cache = new HybridCache({ l1, l2, logging: { enabled: false }, events: [(event) => events.push(event)] });
  budget.sample(signal(4_000));

  assert.deepEqual(await cache.get('key'), { source: 'L2' });
  assert.equal(await l1.has('key'), false);
  assert.equal(events.some((event) => event.type === 'promotion:bypassed' && event.reason === 'pressure'), true);

  await cache.close();
  l1.close();
});

test('peer priming under pressure removes obsolete L1 state without installing the replacement', async () => {
  const budget = new MemoryBudget({ maxMemory: 100_000, sampleIntervalMs: 0 });
  const l1 = new MemoryStore({ memoryBudget: budget });
  const events = [];
  let receive;
  const eventBus = {
    async publish() {},
    async subscribe(handler) { receive = handler; },
  };
  const cache = new HybridCache({ l1, eventBus, source: 'local', logging: { enabled: false }, events: [(event) => events.push(event)] });
  await cache.ready();
  await l1.set('key', 'obsolete');
  budget.sample(signal(4_000));

  await receive({ id: 'peer-set', type: 'set', source: 'peer', ts: Date.now(), keys: ['key'], value: 'new', generation: 1 });
  assert.equal(await l1.has('key'), false);
  assert.equal(events.some((event) => event.type === 'promotion:bypassed' && event.reason === 'pressure'), true);
  assert.equal(events.some((event) => event.type === 'set:received'), false);

  await cache.close();
  l1.close();
});
