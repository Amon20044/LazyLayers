#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'production';
const moduleUrl = process.env.LAZY_AUDIT_MODULE ?? new URL('../dist/index.js', import.meta.url).href;
const quick = process.argv.includes('--quick');
const repetitions = Number(process.env.LAZY_AUDIT_REPETITIONS ?? (quick ? 3 : 5));
if (!Number.isSafeInteger(repetitions) || repetitions < 3 || repetitions > 9) throw new RangeError('Benchmark repetitions must be 3–9');
const percentile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? null; };
const mem = () => { const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage(); return { rss, heapUsed, external, arrayBuffers }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function options(mod, maxEntries = 1000, extra = {}) {
  return { memoryBudget: new mod.MemoryBudget({ maxMemory: '64MiB', sampleIntervalMs: 0 }), levels: { L1: { maxEntries, admission: { enabled: false }, codec: { compression: 'none' } } }, failSafe: { enabled: false }, logging: { enabled: false }, ...extra };
}
async function timed(count, call) {
  const samples = [];
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < count; i++) { const at = performance.now(); await call(i); samples.push(performance.now() - at); }
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  return { operations: count, elapsedMs, throughputPerSec: count * 1000 / elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, cpuMsPerMillion: (cpu.user + cpu.system) / 1000 / count * 1e6, latencyMs: { p50: percentile(samples, .5), p95: percentile(samples, .95), p99: percentile(samples, .99), p999: percentile(samples, .999) } };
}
async function scenario(mod, name, n) {
  if (name === 'has') {
    const store = new mod.MemoryStore(options(mod, n));
    try {
      for (let i = 0; i < n; i++) await store.set(`tenant:user:${i}`, { id: i, payload: 'a'.repeat(64) });
      for (let i = 0; i < 100; i++) await store.has(`tenant:user:${i % n}`);
      return { residentEntries: n, keyBytes: { min: Buffer.byteLength('tenant:user:0'), max: Buffer.byteLength(`tenant:user:${n - 1}`) }, payloadBytes: 64, ...(await timed(quick ? 1000 : 4000, (i) => store.has(`tenant:user:${i % n}`))) };
    } finally { store.close(); }
  }
  if (name === 'lookup' || name === 'lookup-stale') {
    const cache = new mod.LazyLayersCache(options(mod, 1024, { failSafe: { enabled: name === 'lookup-stale' } }));
    try {
      for (let i = 0; i < 64; i++) await cache.set(`tenant:user:${i}`, { id: i, payload: 'a'.repeat(1024) });
      for (let i = 0; i < 1000; i++) await cache.get(`tenant:user:${i % 64}`);
      return { residentEntries: 64, payloadBytes: 1024, distribution: 'round-robin 64 keys', ...(await timed(quick ? 5000 : 20000, (i) => cache.get(`tenant:user:${i % 64}`))) };
    } finally { await cache.close(); }
  }
  if (name === 'promotion') {
    const l2 = new mod.MemoryStore(options(mod, n));
    const cache = new mod.LazyLayersCache(options(mod, n, { l2 }));
    try {
      for (let i = 0; i < n; i++) await l2.set(`tenant:user:${i}`, { id: i, payload: 'a'.repeat(1024) });
      return { residentEntries: n, payloadBytes: 1024, networkOperations: 0, ...(await timed(n, (i) => cache.get(`tenant:user:${i}`))) };
    } finally { await cache.close(); l2.close(); }
  }
  if (name === 'inflight') {
    const cache = new mod.LazyLayersCache(options(mod, 32, { l1: false, inflight: { maxEntries: n + 1 }, originLoad: { enabled: false }, timeouts: { hardMs: 20000 } }));
    let resolve;
    const barrier = new Promise((done) => { resolve = done; });
    let loads = 0;
    const leaders = Array.from({ length: n }, (_, i) => cache.getOrSet(`pending:${i}`, async () => { loads++; return barrier; }));
    try {
      await tick(); assert.equal(loads, n);
      const samples = [];
      const cpuStart = process.cpuUsage(); const at = performance.now();
      // Measure synchronous registration cost while leaders are deliberately pending.
      const followers = [];
      for (let i = 0; i < (quick ? 1000 : 4000); i++) { const start = performance.now(); followers.push(cache.getOrSet(`pending:${i % n}`, async () => { throw new Error('unexpected follower load'); })); samples.push(performance.now() - start); }
      const elapsedMs = performance.now() - at; const cpu = process.cpuUsage(cpuStart);
      resolve({ ok: true }); await Promise.all([...leaders, ...followers]);
      return { activeKeys: n, operations: samples.length, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, throughputPerSec: samples.length * 1000 / elapsedMs, latencyMs: { p50: percentile(samples, .5), p95: percentile(samples, .95), p99: percentile(samples, .99), p999: percentile(samples, .999) }, loaderInvocations: loads, note: 'registration latency only; pending loaders resolve after measurement' };
    } finally { resolve?.({ ok: true }); await Promise.allSettled(leaders); await cache.close(); }
  }
  if (name === 'herd') {
    const cache = new mod.LazyLayersCache(options(mod, 32, { l1: false, inflight: { maxWaiters: 100000 }, timeouts: { hardMs: 20000 } }));
    let done; const barrier = new Promise((resolve) => { done = resolve; });
    let loads = 0;
    globalThis.gc?.(); const before = mem(); const cpuStart = process.cpuUsage(); const at = performance.now();
    const calls = Array.from({ length: n }, () => cache.getOrSet('tenant:storm:one-key', async () => { loads++; return barrier; }));
    try {
      await tick(); globalThis.gc?.(); const pending = mem();
      done({ ok: true }); const values = await Promise.all(calls); const elapsedMs = performance.now() - at;
      assert.equal(loads, 1); assert.ok(values.every((value) => value?.ok));
      const cpu = process.cpuUsage(cpuStart);
      return { operations: n, loaderInvocations: loads, followers: n - loads, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, completedPerSec: n * 1000 / elapsedMs, originLoadsPerRequest: loads / n, originAmplification: loads, idealMissEpisodes: 1, memory: { before, pending, pendingHeapBytesPerCaller: (pending.heapUsed - before.heapUsed) / n }, simulated: true };
    } finally { done?.({ ok: true }); await Promise.allSettled(calls); await cache.close(); }
  }
  throw new Error(`Unknown scenario ${name}`);
}
if (process.env.LAZY_AUDIT_CHILD) {
  const mod = await import(moduleUrl.startsWith('file:') ? moduleUrl : pathToFileURL(moduleUrl).href);
  const pauses = [];
  const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) pauses.push(entry.duration); });
  observer.observe({ entryTypes: ['gc'] });
  const result = await scenario(mod, process.env.LAZY_AUDIT_CHILD, Number(process.env.LAZY_AUDIT_N ?? 0));
  await tick(); observer.disconnect();
  console.log(JSON.stringify({ ...result, peakRssBytes: process.resourceUsage().maxRSS * 1024, gc: { count: pauses.length, totalMs: pauses.reduce((sum, value) => sum + value, 0), maxMs: Math.max(0, ...pauses) } }));
} else {
  const specs = [['lookup', 64], ['lookup-stale', 64], ...[32, 1024, 8192].map((n) => ['has', n]), ['promotion', quick ? 512 : 2048], ...[32, 1024].map((n) => ['inflight', n]), ...[10, 100, 1000, 10000, ...(quick ? [] : [100000])].map((n) => ['herd', n])];
  const rows = [];
  for (const [name, n] of specs) {
    const runs = [];
    for (let repetition = 0; repetition < repetitions; repetition++) {
      const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=512', new URL(import.meta.url).pathname, ...(quick ? ['--quick'] : [])], { encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024, env: { ...process.env, LAZY_AUDIT_CHILD: name, LAZY_AUDIT_N: String(n) } });
      if (child.status !== 0) throw new Error(`Failed ${name}/${n}: ${child.stderr || child.error || child.stdout}`);
      const run = JSON.parse(child.stdout);
      if (run.peakRssBytes > 640 * 1024 * 1024) throw new Error('Benchmark child exceeded RSS budget');
      runs.push(run);
    }
    rows.push({ name, n, runs });
    console.log(`${name}/${n}: ${percentile(runs.map((run) => run.elapsedMs), .5).toFixed(3)} ms median, ${repetitions} isolated runs`);
  }
  const result = { metadata: { timestamp: new Date().toISOString(), node: process.version, os: `${os.type()} ${os.release()}`, arch: os.arch(), cpuModel: os.cpus()[0]?.model, logicalCpus: os.cpus().length, hostMemoryBytes: os.totalmem(), module: moduleUrl, repetitions, quick, instanceCount: 1, network: 'none', coordinatedOmission: 'closed-loop sequential timings; not arrival-to-completion service latency', limits: { childSeconds: 45, childHeapMiB: 512, peakRssMiB: 640 } }, rows };
  const output = process.env.LAZY_AUDIT_OUTPUT ?? 'audit/raw/benchmark-current.json';
  await mkdir(new URL('../audit/raw/', import.meta.url), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(`Raw results: ${output}`);
}
