#!/usr/bin/env node
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { isChild, moduleURL, childCase, quantiles, cpuMs, memory, random, gc, matrix } from './audit-experiment-utils.mjs';

const WORKLOADS = ['uniform', 'zipf', 'scan', 'repeated-scan', 'scan-pollution', 'burst', 'shifting-hot-set', 'read-heavy', 'write-heavy', 'large-values'];
const OPERATIONS = 16_000;
function trace(workload) {
  const rng = random();
  const cdf = []; let total = 0;
  for (let rank = 1; rank <= 1024; rank++) { total += 1 / rank ** 1.1; cdf.push(total); }
  const zipf = () => { const target = rng() * total; let lo = 0, hi = cdf.length - 1; while (lo < hi) { const mid = (lo + hi) >>> 1; if (cdf[mid] < target) lo = mid + 1; else hi = mid; } return lo; };
  return Array.from({ length: OPERATIONS }, (_, i) => {
    let id;
    if (workload === 'zipf') id = zipf();
    else if (workload === 'scan') id = i;
    else if (workload === 'repeated-scan') id = i % 1024;
    else if (workload === 'scan-pollution') id = rng() < .8 ? Math.floor(rng() * 64) : 1024 + i;
    else if (workload === 'burst') id = rng() < .9 ? Math.floor(i / 500) * 8 + Math.floor(rng() * 8) : 1024 + Math.floor(rng() * 1024);
    else if (workload === 'shifting-hot-set') id = Math.floor(i / 2000) * 128 + Math.floor(rng() * 32);
    else id = Math.floor(rng() * 1024);
    const bytes = workload === 'large-values' ? [128 * 1024, 16 * 1024, 1024, 64][id % 16 < 3 ? id % 16 : 3] : 1024;
    const writeProbability = workload === 'write-heavy' ? .8 : workload === 'read-heavy' ? .05 : 0;
    return { key: `tenant:synthetic:row:${id}`, bytes, write: rng() < writeProbability };
  });
}

async function experiment(mod, configuration) {
  const accesses = trace(configuration.workload);
  const payloads = new Map([64, 1024, 16 * 1024, 128 * 1024].map((bytes) => [bytes, 'x'.repeat(bytes)]));
  const budget = new mod.MemoryBudget({ maxMemory: 256 * 1024, sampleIntervalMs: 0 });
  const options = { memoryBudget: budget, levels: { L1: { maxEntries: 128, ttlMs: 60_000, admission: { enabled: configuration.admission, maxEntryBytes: 192 * 1024 }, codec: { compression: 'none' } } }, logging: { enabled: false } };
  const warm = new mod.MemoryStore(options);
  try { for (let i = 0; i < 256; i++) { await warm.set(`warm:${i % 16}`, { payload: payloads.get(1024) }); await warm.get(`warm:${i % 16}`); } }
  finally { warm.close(); }
  await gc();
  const store = new mod.MemoryStore(options);
  const before = memory(); const samples = new Float64Array(accesses.length);
  let reads = 0, writes = 0, hits = 0, hitBytes = 0, requestedBytes = 0, originLoads = 0, cacheSets = 0;
  const startCpu = process.cpuUsage(); const started = performance.now();
  try {
    for (let i = 0; i < accesses.length; i++) {
      const access = accesses[i]; const at = performance.now();
      if (access.write) {
        writes++; cacheSets++;
        await store.set(access.key, { key: access.key, version: i, payload: payloads.get(access.bytes) });
      } else {
        reads++; requestedBytes += access.bytes;
        const value = await store.get(access.key);
        if (value !== undefined) { hits++; hitBytes += access.bytes; assert.equal(value.payload.length, access.bytes); }
        else {
          originLoads++; cacheSets++;
          await store.set(access.key, { key: access.key, version: i, payload: payloads.get(access.bytes) });
        }
      }
      samples[i] = performance.now() - at;
    }
    const elapsedMs = performance.now() - started; const cpu = cpuMs(startCpu); const peak = memory();
    await gc(); const retained = memory(); const stats = store.stats();
    assert.ok(stats.budget.accountedBytes <= stats.budget.target);
    return { operations: accesses.length, readRequests: reads, writeRequests: writes, hits, originLoads, objectHitRatio: hits / Math.max(1, reads), byteHitRatio: hitBytes / Math.max(1, requestedBytes), originLoadsAvoided: hits, cacheSets, cacheApiOperations: reads + cacheSets, elapsedMs, cpuMs: cpu, cpuMsPerMillionRequests: cpu / accesses.length * 1e6, closedLoopCompletedPerSec: accesses.length * 1000 / elapsedMs, latencyMs: quantiles(samples), beforeMemory: before, retainedMemory: retained, memory: peak, stats, payloadBytes: configuration.workload === 'large-values' ? [64, 1024, 16384, 131072] : [1024], cacheBudgetBytes: 256 * 1024, maxEntries: 128, traceSeed: 0x51f3a27b, keyLengthBytes: { min: 22, max: 26 }, internalPolicyOperationsPerAccess: 'NOT MEASURED', evictionCount: 'NOT MEASURED', exactAllocatedBytes: 'NOT MEASURED', semantics: 'actual MemoryStore; loader is a local value construction, not a database or server' };
  } finally { store.close(); assert.equal(budget.snapshot().accountedBytes, 0); budget.close(); }
}

if (isChild) {
  const mod = await import(moduleURL);
  console.log(JSON.stringify(await experiment(mod, childCase())));
} else {
  const cases = [];
  for (let repeat = 0; repeat < 3; repeat++) for (const workload of WORKLOADS) for (const admission of [false, true]) cases.push({ repeat, workload, admission });
  await matrix(new URL(import.meta.url).pathname, cases, 'policies', ['Actual MemoryStore admission enabled vs disabled; both retain common lookup-history bookkeeping.', 'Identical cold traces and seeds; values are fixed-size plain objects except heterogeneous-value workload.', 'Closed-loop sequential access timings include cache calls and local value construction; no offered RPS or remote origin throughput is measured.', 'No FIFO, CLOCK, LFU, TinyLFU or W-TinyLFU implementation is claimed by this control experiment.']);
}
