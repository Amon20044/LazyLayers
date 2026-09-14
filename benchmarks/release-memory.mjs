#!/usr/bin/env node
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import os from 'node:os';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

process.env.NODE_ENV ??= 'production';
const iterations = Number.parseInt(process.env.LAZY_BENCH_ITERATIONS ?? '200', 10);
const seed = Number.parseInt(process.env.LAZY_BENCH_SEED ?? '20250911', 10);
const baselinePath = process.env.LAZY_BASELINE_MODULE;
const currentPath = process.env.LAZY_CURRENT_MODULE ?? new URL('../dist/index.js', import.meta.url).href;
if (!Number.isSafeInteger(iterations) || iterations < 32) throw new RangeError('LAZY_BENCH_ITERATIONS must be an integer of at least 32');

function rng(initial) { let state = initial >>> 0; return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32; }
function percentile(values, fraction) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]; }
function memory() { const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage(); return { rss, heapUsed, external, arrayBuffers }; }
function delta(before, after) { return Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]])); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function loadModule(path) { try { return await import(path); } catch (error) { return { unavailable: true, reason: `module import failed: ${error.message}` }; } }
function instrumentation() {
  const events = { l1Hits: 0, l2Hits: 0, staleHits: 0, promotionBypasses: 0, overloads: 0 };
  return { events, handler(event) {
    if (event.type === 'hit' && event.level === 'L1') events.l1Hits += 1;
    if (event.type === 'hit' && event.level === 'L2') events.l2Hits += 1;
    if (event.type === 'stale:hit') events.staleHits += 1;
    if (event.type === 'promotion:bypassed') events.promotionBypasses += 1;
    if (event.type === 'origin:overload') events.overloads += 1;
  } };
}
function cacheOptions(mod, telemetry, extra = {}) {
  const options = { l2: false, inflight: { maxEntries: 1_024 }, originLoad: { maxConcurrent: 16, maxQueued: 1_024, queueTimeoutMs: 1_000 }, events: [telemetry.handler], logging: { enabled: false }, ...extra };
  if (mod.MemoryBudget && extra.byteBudget) {
    options.memoryBudget = new mod.MemoryBudget({ maxMemory: extra.byteBudget, sampleIntervalMs: 0 });
    delete options.byteBudget;
  }
  return options;
}
async function measured(name, execute) {
  globalThis.gc?.();
  const samples = [];
  const before = memory();
  const cpuBefore = process.cpuUsage();
  const peak = { ...before };
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const sampler = setInterval(() => { const sample = memory(); for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], sample[key]); }, 5);
  sampler.unref();
  const started = performance.now();
  let details; let errors = 0;
  try { details = await execute(samples); } catch (error) { errors = 1; details = { failure: error instanceof Error ? error.message : String(error) }; }
  clearInterval(sampler); delay.disable();
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const after = memory();
  for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], after[key]);
  const operations = details?.operations ?? samples.length;
  return { name, operations, elapsedMs, throughputPerSec: operations / (elapsedMs / 1_000), latencyMs: { p50: percentile(samples, .5), p95: percentile(samples, .95), p99: percentile(samples, .99) }, cpuMs: { user: cpu.user / 1_000, system: cpu.system / 1_000, total: (cpu.user + cpu.system) / 1_000 }, eventLoopDelayMs: delay.count ? { p50: delay.percentile(50) / 1e6, p99: delay.percentile(99) / 1e6 } : null, memory: { before, peak, after, delta: delta(before, after) }, errors, ...details };
}
async function hotKey(mod) {
  const telemetry = instrumentation(); const cache = new mod.LazyLayersCache(cacheOptions(mod, telemetry));
  return measured('hot-key-reads', async (samples) => {
    await cache.set('hot', { value: 1 });
    for (let i = 0; i < iterations; i += 1) { const start = performance.now(); await cache.get('hot'); samples.push(performance.now() - start); }
    const result = { operations: iterations, telemetry: telemetry.events, origin: cache.getOriginLoadStats?.(), memoryBudget: cache.getMemoryStats?.() };
    await cache.close(); return result;
  });
}
async function distinctSurge(mod) {
  const telemetry = instrumentation(); const cache = new mod.LazyLayersCache(cacheOptions(mod, telemetry));
  let active = 0; let maxActualLoaderConcurrency = 0; let loaderCalls = 0;
  return measured('concurrent-distinct-key-surge', async (samples) => {
    for (let offset = 0; offset < iterations; offset += 128) {
      await Promise.all(Array.from({ length: Math.min(128, iterations - offset) }, async (_, index) => {
        const start = performance.now();
        await cache.getOrSet(`miss:${offset + index}`, async () => { loaderCalls += 1; active += 1; maxActualLoaderConcurrency = Math.max(maxActualLoaderConcurrency, active); try { await sleep(2); return offset + index; } finally { active -= 1; } });
        samples.push(performance.now() - start);
      }));
    }
    const result = { operations: iterations, loaderCalls, maxActualLoaderConcurrency, telemetry: telemetry.events, origin: cache.getOriginLoadStats?.(), memoryBudget: cache.getMemoryStats?.() };
    await cache.close(); return result;
  });
}
async function largeScan(mod, random) {
  const telemetry = instrumentation();
  const cache = new mod.LazyLayersCache(cacheOptions(mod, telemetry, { byteBudget: 4 * 1024 * 1024, levels: { L1: { maxEntries: 8, admission: { maxEntryBytes: 256 * 1024 } } } }));
  const payload = Buffer.allocUnsafe(512 * 1024); for (let i = 0; i < payload.length; i += 1) payload[i] = Math.floor(random() * 256);
  return measured('incompressible-oversized-scan', async (samples) => {
    const count = Math.min(iterations, 64);
    for (let i = 0; i < count; i += 1) { const start = performance.now(); await cache.set(`scan:${i}`, payload); samples.push(performance.now() - start); }
    const result = { operations: count, payloadBytes: payload.byteLength, retainedEntries: await cache.size(), telemetry: telemetry.events, memoryBudget: cache.getMemoryStats?.() };
    await cache.close(); return result;
  });
}
async function shiftingHotSet(mod) {
  const telemetry = instrumentation(); const cache = new mod.LazyLayersCache(cacheOptions(mod, telemetry, { levels: { L1: { maxEntries: 32 } } }));
  return measured('changing-hot-set', async (samples) => {
    const phase = Math.floor(iterations / 2);
    for (let i = 0; i < iterations; i += 1) { const key = `${i < phase ? 'first' : 'second'}:${i % 32}`; const start = performance.now(); await cache.getOrSet(key, async () => key); samples.push(performance.now() - start); }
    const result = { operations: iterations, telemetry: telemetry.events, memoryBudget: cache.getMemoryStats?.() };
    await cache.close(); return result;
  });
}
async function unevenReplicas(mod, random) {
  const telemetry = [instrumentation(), instrumentation(), instrumentation()];
  const caches = telemetry.map((item) => new mod.LazyLayersCache(cacheOptions(mod, item, { levels: { L1: { maxEntries: 64 } } })));
  const routed = [0, 0, 0];
  return measured('uneven-three-replica-routing', async (samples) => {
    for (let i = 0; i < iterations; i += 1) { const draw = random(); const replica = draw < .7 ? 0 : draw < .9 ? 1 : 2; routed[replica] += 1; const start = performance.now(); await caches[replica].getOrSet(`key:${i % 48}`, async () => i); samples.push(performance.now() - start); }
    const result = { operations: iterations, routed, replicas: caches.map((cache, index) => ({ telemetry: telemetry[index].events, origin: cache.getOriginLoadStats?.(), memoryBudget: cache.getMemoryStats?.() })) };
    await Promise.all(caches.map((cache) => cache.close())); return result;
  });
}
async function l2FaultInjection(mod) {
  const telemetry = instrumentation();
  const fail = async () => { throw new Error('injected L2 outage'); };
  const l2 = { set: fail, get: fail, getOrSet: fail, has: fail, delete: fail, deleteByPattern: fail, clear: fail, size: fail };
  const cache = new mod.LazyLayersCache(cacheOptions(mod, telemetry, { l2 }));
  return measured('l2-outage-fault-injection', async (samples) => {
    for (let i = 0; i < iterations; i += 1) { const start = performance.now(); await cache.getOrSet(`fault:${i}`, async () => i); samples.push(performance.now() - start); }
    const result = { operations: iterations, telemetry: telemetry.events, origin: cache.getOriginLoadStats?.(), note: 'Injected CacheStore failures; live Redis compatibility is covered by integration tests.' };
    await cache.close(); return result;
  });
}
async function syntheticPressure(mod) {
  if (!mod.MemoryBudget || !mod.MemoryStore) return { name: 'synthetic-memory-pressure', skipped: true, reason: 'MemoryBudget API is unavailable in this release' };
  const budget = new mod.MemoryBudget({ maxMemory: 256 * 1024, sampleIntervalMs: 0 });
  const store = new mod.MemoryStore({ memoryBudget: budget, levels: { L1: { maxEntries: 128, admission: { enabled: false } } } });
  return measured('synthetic-memory-pressure', async (samples) => {
    for (let i = 0; i < Math.min(iterations, 128); i += 1) { const start = performance.now(); await store.setEncoded(`pressure:${i}`, Buffer.alloc(4096, i)); samples.push(performance.now() - start); }
    const beforePressure = budget.snapshot();
    const afterPressure = budget.sample({ effectiveBytes: 256 * 1024, availableBytes: 4 * 1024, available: { effectiveBytes: true, availableBytes: true } });
    if (afterPressure.pressureState !== 'critical' || afterPressure.accountedBytes > afterPressure.target) throw new Error('critical pressure did not evict to target');
    store.close(); return { operations: samples.length, memoryPressure: { before: beforePressure, after: afterPressure } };
  });
}
async function run(label, path) {
  const mod = await loadModule(path); if (mod.unavailable) return { label, module: path, skipped: true, reason: mod.reason };
  const random = rng(seed);
  const scenarios = new Map([
    ['hot-key-reads', hotKey],
    ['concurrent-distinct-key-surge', distinctSurge],
    ['incompressible-oversized-scan', (value) => largeScan(value, random)],
    ['changing-hot-set', shiftingHotSet],
    ['uneven-three-replica-routing', (value) => unevenReplicas(value, random)],
    ['l2-outage-fault-injection', l2FaultInjection],
    ['synthetic-memory-pressure', syntheticPressure],
  ]);
  const selected = process.env.LAZY_BENCH_CHILD_SCENARIO
    ? [[process.env.LAZY_BENCH_CHILD_SCENARIO, scenarios.get(process.env.LAZY_BENCH_CHILD_SCENARIO)]]
    : [...scenarios];
  const results = [];
  for (const [name, scenario] of selected) {
    if (!scenario) throw new Error(`Unknown benchmark scenario: ${name}`);
    results.push(await scenario(mod));
  }
  return { label, module: path, results };
}

function isolatedRun(label, modulePath) {
  const names = ['hot-key-reads', 'concurrent-distinct-key-surge', 'incompressible-oversized-scan', 'changing-hot-set', 'uneven-three-replica-routing', 'l2-outage-fault-injection', 'synthetic-memory-pressure'];
  const results = [];
  for (const name of names) {
    const child = spawnSync(process.execPath, ['--expose-gc', new URL(import.meta.url).pathname], {
      encoding: 'utf8',
      env: { ...process.env, LAZY_BENCH_CHILD_LABEL: label, LAZY_BENCH_CHILD_MODULE: modulePath, LAZY_BENCH_CHILD_SCENARIO: name, LAZY_BENCH_OUTPUT: '' },
    });
    if (child.status !== 0) results.push({ name, errors: 1, failure: child.stderr || child.stdout });
    else results.push(JSON.parse(child.stdout).results[0]);
  }
  return { label, module: modulePath, results };
}

if (process.env.LAZY_BENCH_CHILD_LABEL) {
  console.log(JSON.stringify(await run(process.env.LAZY_BENCH_CHILD_LABEL, process.env.LAZY_BENCH_CHILD_MODULE)));
  process.exit(0);
}

const output = { metadata: { node: process.version, platform: process.platform, arch: process.arch, os: `${os.type()} ${os.release()}`, seed, iterations, generatedAt: new Date().toISOString(), processIsolation: 'per release and workload' }, runs: [] };
if (baselinePath) output.runs.push(isolatedRun('v0.5.1', baselinePath)); else output.runs.push({ label: 'v0.5.1', skipped: true, reason: 'Set LAZY_BASELINE_MODULE to an installed v0.5.1 ESM entry point' });
output.runs.push(isolatedRun('v0.5.2', currentPath));
const failed = output.runs.filter((run) => !run.skipped).flatMap((run) => run.results).filter((result) => !result.skipped && result.errors > 0);
const current = output.runs.find((run) => run.label === 'v0.5.2');
const byName = new Map(current.results.map((result) => [result.name, result]));
const failedGates = [];
const surge = byName.get('concurrent-distinct-key-surge');
if (!(surge.maxActualLoaderConcurrency <= 16)) failedGates.push('origin concurrency exceeded 16');
const scan = byName.get('incompressible-oversized-scan');
if (scan.retainedEntries !== 0) failedGates.push('oversized scan polluted L1');
const pressure = byName.get('synthetic-memory-pressure');
if (pressure.skipped || pressure.memoryPressure?.after?.pressureState !== 'critical' || pressure.memoryPressure.after.accountedBytes > pressure.memoryPressure.after.target) failedGates.push('critical pressure gate failed');
for (const result of current.results) {
  if (!result.skipped && (!Number.isFinite(result.latencyMs?.p95) || !Number.isFinite(result.latencyMs?.p99) || !Number.isFinite(result.cpuMs?.total) || !Number.isFinite(result.memory?.peak?.rss))) failedGates.push(`${result.name} omitted required release metrics`);
}
output.verification = { ok: failed.length === 0 && failedGates.length === 0, failedWorkloads: failed.map((result) => result.name), failedGates };
const serialized = JSON.stringify(output, null, 2);
if (process.env.LAZY_BENCH_OUTPUT) await (await import('node:fs/promises')).writeFile(process.env.LAZY_BENCH_OUTPUT, serialized);
console.log(serialized);
if (!output.verification.ok) process.exitCode = 1;
