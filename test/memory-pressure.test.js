import assert from 'node:assert/strict';
import { test } from 'node:test';

const { MemoryBudget, MemoryStore } = await import('../dist/index.js');

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
