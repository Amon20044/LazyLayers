import assert from "node:assert/strict";
import { test } from "node:test";

const { MemoryBudget } = await import("../dist/cache/memoryBudget.js");
const { resolveEffectiveMemory } = await import("../dist/cache/memorySignals.js");

test("percentage and units resolve against effective runtime capacity", () => {
  const budget = new MemoryBudget({ maxMemory: "50%", minMemory: "1MiB", sampleIntervalMs: 0,
    memory: { hostMemoryBytes: 100 * 1024 * 1024, cgroupPaths: ["/nested"], readFile: p => p === "/nested/memory.max" ? String(80 * 1024 * 1024) : undefined } });
  assert.equal(budget.hardCap, 40 * 1024 * 1024);
});

test("nested cgroup limits use the smallest valid constraint", () => {
  const values = new Map([["/sys/fs/cgroup/memory.max", "max"], ["/a/memory.max", "900"], ["/b/memory.limit_in_bytes", "700"]]);
  assert.equal(resolveEffectiveMemory({ hostMemoryBytes: 1000, cgroupPaths: ["/a", "/b"], readFile: p => values.get(p) }), 700);
});

test("shared ledger never exceeds target and release is idempotently bounded", () => {
  const budget = new MemoryBudget({ maxMemory: 100, sampleIntervalMs: 0 });
  assert.equal(budget.tryReserve(70, "fresh"), true);
  assert.equal(budget.tryReserve(40, "stale"), false);
  budget.release(1000, "fresh");
  assert.equal(budget.snapshot().accountedBytes, 0);
  assert.equal(budget.snapshot().categories.fresh, 0);
});

test("sampling pressure shrinks target and bounds round-robin maintenance", () => {
  let now = 0; let evicted = 0;
  const budget = new MemoryBudget({ maxMemory: 1000, sampleIntervalMs: 0, now: () => now, pressureWindowMs: 5000, recoveryWindowMs: 30000 });
  budget.register(() => { evicted++; return true; });
  budget.tryReserve(1000);
  budget.sample({ availableBytes: 100, available: { available: true } });
  now = 5000;
  budget.sample({ availableBytes: 100, available: { available: true } });
  assert.equal(budget.snapshot().target, 700);
  assert.ok(evicted <= 32);
});
