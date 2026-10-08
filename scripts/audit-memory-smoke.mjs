#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// Synthetic, fixed working set; use the outer runner for aggregate RSS/wall limits.
const seconds = Number(process.env.LAZY_AUDIT_MEMORY_SECONDS ?? 30);
if (!Number.isSafeInteger(seconds) || seconds < 5 || seconds > 120) throw new RangeError('Smoke duration must be 5–120 seconds');
if (!globalThis.gc) throw new Error('Run with --expose-gc');
const configured = process.env.LAZY_AUDIT_MODULE ?? new URL('../dist/index.js', import.meta.url).href;
const moduleUrl = configured.startsWith('file:') ? configured : pathToFileURL(configured).href;
const { MemoryStore, MemoryBudget } = await import(moduleUrl);
const budget = new MemoryBudget({ maxMemory: 2 * 1024 * 1024, sampleIntervalMs: 0 });
const store = new MemoryStore({ memoryBudget: budget, levels: { L1: { maxEntries: 256, admission: { enabled: false }, codec: { compression: 'none' } } } });
const checkpoints = []; const began = performance.now();
let cycles = 0; let operations = 0; let nextCheckpoint = 0;
let failure;
try {
  while (performance.now() - began < seconds * 1000 && cycles < 5000) {
    for (let i = 0; i < 512; i++) {
      await store.set(`tenant:stable:${i}`, { id: i, cycle: cycles, payload: 'x'.repeat(1024) }, { ttlMs: 500 }); operations++;
    }
    for (let i = 256; i < 512; i++) { assert.equal((await store.get(`tenant:stable:${i}`))?.id, i); operations++; }
    for (let i = 448; i < 512; i++) { await store.delete(`tenant:stable:${i}`); operations++; }
    if (cycles % 20 === 19) { await store.clear(); assert.equal(await store.size(), 0); }
    if (performance.now() >= nextCheckpoint) {
      globalThis.gc(); globalThis.gc();
      const memory = process.memoryUsage(); const stats = store.stats();
      assert.ok(stats.entries <= 256); assert.ok(stats.budget.accountedBytes <= 2 * 1024 * 1024);
      assert.ok(memory.rss <= 512 * 1024 * 1024, '512 MiB child RSS cap');
      checkpoints.push({ elapsedMs: performance.now() - began, cycle: cycles, heapUsed: memory.heapUsed, rss: memory.rss, external: memory.external, entries: stats.entries, ledgerBytes: stats.budget.accountedBytes });
      nextCheckpoint = performance.now() + 1000;
    }
    cycles++; await delay(50);
  }
  await store.clear(); await store.set('expires', { payload: 'x'.repeat(1024) }, { ttlMs: 10 });
  await delay(20); assert.equal(await store.get('expires'), undefined); assert.equal(await store.size(), 0);
  // Exclude two warm-up checkpoints; fixed slack deliberately tolerates GC/JIT noise.
  const settled = checkpoints.slice(2).map((row) => row.heapUsed);
  if (settled.length >= 3) assert.ok(Math.max(...settled) - Math.min(...settled) <= 1024 * 1024 + 64 * 1024, 'Post-GC bounded working-set heap range');
} catch (error) { failure = { name: error.name, message: error.message }; process.exitCode = 1; }
finally {
  store.close();
  if (budget.snapshot().accountedBytes !== 0) { failure ??= { name: 'AssertionError', message: 'Closed ledger not released' }; process.exitCode = 1; }
  const output = process.env.LAZY_AUDIT_OUTPUT ?? `audit/raw/memory-smoke-${process.env.LAZY_AUDIT_LABEL ?? 'current'}.json`;
  await mkdir('audit/raw', { recursive: true });
  await writeFile(output, JSON.stringify({ metadata: { generatedAt: new Date().toISOString(), module: moduleUrl, node: process.version, cpu: os.cpus()[0]?.model, seconds, workingKeys: 512, residentCap: 256, payloadBytes: 1024, ledgerCapBytes: 2 * 1024 * 1024, childRssCapBytes: 512 * 1024 * 1024, maxCycles: 5000, dutyDelayMs: 50, heapRangeSlackBytes: 1024 * 1024, observedBaselineVariabilityAllowanceBytes: 64 * 1024, durationClaim: 'bounded smoke/endurance sample; not hours-long production endurance' }, elapsedMs: performance.now() - began, cycles, operations, checkpoints, closedLedgerBytes: budget.snapshot().accountedBytes, failure: failure ?? null }, null, 2) + '\n');
  console.log(JSON.stringify({ output, cycles, operations, checkpoints: checkpoints.length, failure: failure ?? null }));
}
