#!/usr/bin/env node
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import os from 'node:os';
import process from 'node:process';
process.env.NODE_ENV ??= 'production';

const iterations = Number.parseInt(process.env.LAZY_BENCH_ITERATIONS ?? '200', 10);
const seed = Number.parseInt(process.env.LAZY_BENCH_SEED ?? '20250911', 10);
const baselinePath = process.env.LAZY_BASELINE_MODULE;
const currentPath = process.env.LAZY_CURRENT_MODULE ?? new URL('../dist/index.js', import.meta.url).href;

function rng(seedValue) { let n = seedValue >>> 0; return () => (n = (n * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
function percentile(values, p) { if (!values.length) return null; const a = [...values].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))]; }
function memory() { const m = process.memoryUsage(); return { rss: m.rss, heapUsed: m.heapUsed, external: m.external }; }
function stats(cache) { return typeof cache.getOriginLoadStats === 'function' ? cache.getOriginLoadStats() : { unavailable: true }; }
const pressureSignals = { effectiveBytes: 256 * 1024, availableBytes: 4 * 1024, available: { effectiveBytes: true, availableBytes: true } };

async function loadModule(path) { try { return await import(path); } catch (error) { return { unavailable: true, reason: `module import failed: ${error.message}` }; } }
async function workload(mod, name, random) {
  if (mod.unavailable) return { name, skipped: true, reason: mod.reason };
  if (name === 'synthetic-memory-pressure') return syntheticMemoryPressure(mod);
  const cache = new mod.LazyLayersCache({ l2: false, inflight: { maxEntries: 1_000 }, originLoad: { maxConcurrent: 16, maxQueued: 128, queueTimeoutMs: 50 } });
  const samples = []; let errors = 0; const before = memory(); const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  const start = performance.now();
  try {
    await cache.set('hot', 1);
    for (let i = 0; i < iterations; i += 1) {
      const t = performance.now();
      try {
        if (name === 'hotkey') await cache.get('hot');
        else if (name === 'distinct-miss-surge') await cache.getOrSet(`miss:${i}`, async () => i);
        else if (name === 'scan-oversized-payload') { await cache.set(`payload:${i}`, 'x'.repeat(8_192)); await cache.get(`payload:${i}`); }
        else if (name === 'shifting-hotset') await cache.getOrSet(`hot:${Math.floor(random() * 32)}`, async () => 1);
        else if (name === 'redis-outage-no-l2') await cache.get(`outage:${i}`);
        else if (name === 'uneven-three-replica') await cache.getOrSet(`replica:${random() < 0.7 ? 0 : random() < 0.67 ? 1 : 2}:${i % 32}`, async () => 1);
      } catch { errors += 1; }
      samples.push(performance.now() - t);
    }
  } finally { delay.disable(); }
  const elapsedMs = performance.now() - start;
  const origin = stats(cache);
  await cache.close();
  const after = memory();
  return { name, iterations, elapsedMs, throughputPerSec: iterations / (elapsedMs / 1_000), latencyMs: { p50: percentile(samples, .5), p95: percentile(samples, .95), p99: percentile(samples, .99) }, eventLoopDelayMs: { p50: Number(delay.percentile(50)) / 1e6, p99: Number(delay.percentile(99)) / 1e6 }, memory: { before, after, delta: { rss: after.rss - before.rss, heapUsed: after.heapUsed - before.heapUsed, external: after.external - before.external } }, errors, origin };
}

async function syntheticMemoryPressure(mod) {
  const budget = new mod.MemoryBudget({ maxMemory: 256 * 1024, sampleIntervalMs: 0 });
  const store = new mod.MemoryStore({
    memoryBudget: budget,
    levels: { L1: { maxEntries: Math.max(64, iterations), admission: { enabled: false } } },
  });
  const before = memory();
  const samples = [];
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const t = performance.now();
    await store.setEncoded(`pressure:${i}`, Buffer.alloc(4_096, i));
    samples.push(performance.now() - t);
  }
  const beforePressure = budget.snapshot();
  const pressure = budget.sample(pressureSignals);
  const after = memory();
  const elapsedMs = performance.now() - start;
  store.close();
  return {
    name: 'synthetic-memory-pressure',
    iterations,
    elapsedMs,
    throughputPerSec: iterations / (elapsedMs / 1_000),
    latencyMs: { p50: percentile(samples, .5), p95: percentile(samples, .95), p99: percentile(samples, .99) },
    memory: { before, after, delta: { rss: after.rss - before.rss, heapUsed: after.heapUsed - before.heapUsed, external: after.external - before.external } },
    errors: pressure.pressureState === 'critical' && pressure.accountedBytes <= pressure.target ? 0 : 1,
    memoryPressure: { before: beforePressure, after: pressure },
  };
}

async function run(label, path) {
  const mod = await loadModule(path); if (mod.unavailable) return { label, module: path, skipped: true, reason: mod.reason };
  const results = []; for (const name of ['hotkey', 'distinct-miss-surge', 'scan-oversized-payload', 'shifting-hotset', 'redis-outage-no-l2', 'uneven-three-replica', 'synthetic-memory-pressure']) results.push(await workload(mod, name, rng(seed)));
  return { label, module: path, results };
}

const output = { metadata: { node: process.version, platform: process.platform, arch: process.arch, os: `${os.type()} ${os.release()}`, seed, iterations, generatedAt: new Date().toISOString(), notes: ['L2/Redis workload is skipped in this deterministic no-L2 harness; use a separate live Redis run to measure transport behavior.'] }, runs: [] };
if (baselinePath) output.runs.push(await run('baseline', baselinePath)); else output.runs.push({ label: 'baseline', skipped: true, reason: 'LAZY_BASELINE_MODULE not set' });
output.runs.push(await run('current', currentPath));
const failed = output.runs
  .filter((run) => !run.skipped)
  .flatMap((run) => run.results)
  .filter((result) => !result.skipped && result.errors > 0);
output.verification = { ok: failed.length === 0, failedWorkloads: failed.map((result) => result.name) };
const serialized = JSON.stringify(output, null, 2); if (process.env.LAZY_BENCH_OUTPUT) await (await import('node:fs/promises')).writeFile(process.env.LAZY_BENCH_OUTPUT, serialized); console.log(serialized);
if (failed.length > 0) process.exitCode = 1;
