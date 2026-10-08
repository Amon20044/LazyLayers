import { fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

if (!/^lazy-layers-audit-[a-f0-9]{8}$/.test(process.env.LAZY_AUDIT_PROJECT ?? '')) throw new Error('Run through scripts/audit-services.mjs benchmark with disposable resources');
const redisUrl = new URL(process.env.REDIS_URL);
if (!['127.0.0.1', 'localhost'].includes(redisUrl.hostname)) throw new Error('Only the owned loopback Redis is permitted');
const childFile = new URL('./audit-e2e-child.mjs', import.meta.url);
const children = new Set(); const rows = []; const capacity = []; const notes = [];
const suffix = randomUUID().slice(0, 8); let messageId = 0;
const repetitions = Number(process.env.LAZY_AUDIT_E2E_REPETITIONS ?? 3);
const configuredMaximumRps = Number(process.env.LAZY_AUDIT_E2E_MAX_RPS ?? 1000);
const scenarioFilter = process.env.LAZY_AUDIT_E2E_SCENARIOS?.split(',').filter(Boolean);
if (!Number.isSafeInteger(repetitions) || repetitions < 2 || repetitions > 5) throw new Error('Repetitions must be 2–5');
if (!Number.isSafeInteger(configuredMaximumRps) || configuredMaximumRps < 100 || configuredMaximumRps > 10000) throw new Error('Maximum RPS must be 100–10000');
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function start(role, extra = {}) {
  const child = fork(childFile, [], { execArgv: ['--max-old-space-size=160'], env: { ...process.env, LAZY_AUDIT_ROLE: role, ...extra }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.add(child); let stderr = ''; child.stderr.on('data', (data) => { stderr += data; if (stderr.length > 1024 * 1024) child.kill('SIGKILL'); });
  child.once('exit', () => children.delete(child));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${role} startup deadline: ${stderr.slice(-1000)}`)), 5000);
    const listener = (value) => { if (value?.ready) { clearTimeout(timer); child.off('message', listener); resolve(value.port); } };
    child.on('message', listener); child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${role} exited ${code}: ${stderr.slice(-1000)}`)); });
  });
  return { child, ready };
}
function rpc(child, method, args) {
  return new Promise((resolve, reject) => {
    const id = ++messageId;
    const timer = setTimeout(() => { child.off('message', listener); reject(new Error(`Control ${method} deadline`)); }, 6000);
    const listener = (message) => { if (message?.id !== id) return; clearTimeout(timer); child.off('message', listener); message.error ? reject(new Error(`${message.error.name}: ${message.error.message}`)) : resolve(message.value); };
    child.on('message', listener); child.send({ id, method, args });
  });
}
function load(config) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=192', childFile.pathname], { env: { ...process.env, LAZY_AUDIT_ROLE: 'load', LAZY_AUDIT_LOAD_CONFIG: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
    child.stdout.on('data', (data) => { stdout += data; if (stdout.length > 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', (data) => { stderr += data; if (stderr.length > 1024 * 1024) child.kill('SIGKILL'); });
    child.once('exit', (code) => { clearTimeout(timer); children.delete(child); if (code !== 0) reject(new Error(`Load generator ${code}: ${stderr.slice(-1000)}`)); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } });
  });
}
const abort = () => { for (const child of children) child.kill('SIGKILL'); };
process.on('SIGINT', abort); process.on('SIGTERM', abort);
const deadline = setTimeout(abort, 110000);
let origin;
let workers = [];
try {
  origin = start('origin'); const originPort = await origin.ready;
  workers = [0, 1].map((id) => start('worker', { LAZY_AUDIT_ORIGIN: `http://127.0.0.1:${originPort}`, LAZY_AUDIT_WORKER_ID: `worker-${id}` }));
  const ports = await Promise.all(workers.map((worker) => worker.ready)); const urls = ports.map((port) => `http://127.0.0.1:${port}`);
  const safe = (result) => result.clientDropped === 0 && result.errorRate < .05 && result.freshnessViolations === 0 && result.arrivalToCompletionMs.p99 < 500 && result.dispatchLagMs.p99 < 50;
  // The generator's direct HTTP ceiling is checked before cache throughput.
  for (const rps of [1000, 10000, 50000]) {
    const preceding = capacity.at(-1);
    if (rps === 50000 && (preceding.runtime.cpuMs / preceding.elapsedMs > .5 || preceding.dispatchLagMs.p99 > 3)) {
      notes.push('50000 RPS: NOT MEASURED; 10000-RPS generator CPU/dispatch headroom did not justify increasing load.');
      break;
    }
    const result = await load({ urls, noop: true, rps, durationMs: 1000, distribution: 'round-robin', payloadBytes: 1024 });
    capacity.push(result);
    console.log(`HTTP calibration ${rps}: ${result.successfulRps.toFixed(0)} successful RPS, p99=${result.arrivalToCompletionMs.p99.toFixed(2)} ms, dropped=${result.clientDropped}`);
    if (!safe(result)) { notes.push(`Load generator/HTTP calibration failed at ${rps} offered RPS; higher rates were not attempted.`); break; }
  }
  const maxRate = Math.min(configuredMaximumRps, capacity.filter(safe).at(-1)?.config.rps ?? 100);
  await tick(250);
  async function run(name, config, workload, originOptions = {}) {
    if (scenarioFilter && !scenarioFilter.includes(name)) return true;
    for (let repetition = 0; repetition < repetitions; repetition++) {
      const prefix = `audit:e2e:${suffix}:${name}:${repetition}:`;
      await rpc(origin.child, 'configure', { latencyMs: 5, maxConcurrent: 64, fail: false, version: 1, payloadBytes: 1024, ...originOptions });
      await Promise.all(workers.map((worker) => rpc(worker.child, 'configure', { prefix, ...config })));
      if (workload.warm) {
        const keys = Array.from({ length: 64 }, (_, i) => `tenant:user:${i}`);
        for (const worker of workers) await rpc(worker.child, 'warm', { keys });
      }
      if (workload.failOrigin) {
        await tick((config.ttlMs ?? 50) + 10);
        await rpc(origin.child, 'configure', { fail: true });
      }
      await rpc(origin.child, 'reset'); await Promise.all(workers.map((worker) => rpc(worker.child, 'reset')));
      const result = await load({ urls, durationMs: 1000, rps: 1000, distribution: 'zipf-like', payloadBytes: 1024, ...workload });
      await tick(30);
      const workerStats = await Promise.all(workers.map((worker) => rpc(worker.child, 'stats'))); const originStats = await rpc(origin.child, 'stats');
      const redisCommands = workerStats.reduce((sum, worker) => sum + worker.redisCommands, 0);
      const hits = workerStats.reduce((sum, worker) => sum + (worker.events['hit:L1'] ?? 0) + (worker.events['hit:L2'] ?? 0), 0);
      rows.push({ name, repetition, config, result, workers: workerStats, origin: originStats, redisOpsPerSentRequest: redisCommands / result.sent, originLoadsPerSentRequest: originStats.requests / result.sent, cacheHitEventsPerSentRequest: hits / result.sent, cpuMsPerMillion: workerStats.reduce((sum, worker) => sum + worker.runtime.cpuMs, 0) / result.sent * 1e6, aggregateWorkerPeakSampledRssBytes: workerStats.reduce((sum, worker) => sum + worker.runtime.peakSampledRssBytes, 0), originAmplification: workload.distribution === 'one-key' ? originStats.requests : null, idealMissEpisodes: workload.distribution === 'one-key' ? 1 : null });
      console.log(`${name} #${repetition + 1}: ${result.successfulRps.toFixed(0)} successful RPS, p99=${result.arrivalToCompletionMs.p99.toFixed(2)} ms, origin=${originStats.requests}, errors=${result.errors}, clientDropped=${result.clientDropped}`);
      if (result.freshnessViolations) throw new Error('Cache returned the wrong logical key/version');
      if (!workload.expectErrors && !safe(result)) { notes.push(`${name} hit automatic latency/error/client budget; larger rates are skipped.`); return false; }
    }
    return true;
  }
  for (const rps of [100, 1000, 10000, 50000]) {
    if (rps > maxRate) { notes.push(`${rps} cache RPS: NOT MEASURED; configured budget or calibration headroom insufficient.`); continue; }
    if (!await run(`warm-${rps}`, {}, { rps, warm: true })) break;
  }
  const comparisonRate = Math.min(1000, maxRate);
  await run('l1-disabled', { l1: false }, { rps: comparisonRate, warm: true });
  await run('compression-gzip', { compression: 'gzip' }, { rps: comparisonRate, warm: true });
  await run('cold-one-key-lease', {}, { burst: 1000, distribution: 'one-key' }, { latencyMs: 50 });
  await run('cold-one-key-no-lease', { lease: false }, { burst: 1000, distribution: 'one-key' }, { latencyMs: 50 });
  await run('cold-one-key-no-singleflight', { lease: false, singleflight: false }, { burst: 256, distribution: 'one-key', expectErrors: true }, { latencyMs: 50 });
  await run('cold-distinct-overload', { lease: false, originConcurrent: 4, originQueued: 16 }, { rps: comparisonRate, distribution: 'scan', expectErrors: true }, { latencyMs: 50 });
  await run('cold-distinct-limit-16', { lease: false, originConcurrent: 16, originQueued: 64 }, { rps: comparisonRate, distribution: 'scan', expectErrors: true }, { latencyMs: 50 });
  await run('stale-if-error', { stale: true, ttlMs: 50, lease: false }, { rps: comparisonRate, warm: true, failOrigin: true, expectErrors: true });
  await run('strict-origin-error', { stale: false, ttlMs: 50, lease: false }, { rps: comparisonRate, warm: true, failOrigin: true, expectErrors: true });
  notes.push('100000+ RPS: NOT MEASURED; this laptop/Docker run stops at 50000 configured RPS and calibrated capacity.');
} finally {
  clearTimeout(deadline);
  for (const worker of workers) { try { await rpc(worker.child, 'close'); } catch { worker.child.kill('SIGKILL'); } }
  if (origin) { try { await rpc(origin.child, 'close'); } catch { origin.child.kill('SIGKILL'); } }
  await tick(50); for (const child of children) child.kill('SIGKILL');
  process.off('SIGINT', abort); process.off('SIGTERM', abort);
  await mkdir('audit/raw', { recursive: true });
  const output = process.env.LAZY_AUDIT_E2E_OUTPUT ?? `audit/raw/e2e-${process.env.LAZY_AUDIT_LABEL ?? 'current'}.json`;
  await writeFile(output, JSON.stringify({ metadata: { generatedAt: new Date().toISOString(), node: process.version, os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, module: process.env.LAZY_AUDIT_MODULE ?? 'dist/index.js', project: process.env.LAZY_AUDIT_PROJECT, instances: 2, independentProcesses: { workers: 2, origin: 1, loadGenerator: 1 }, payloadBytes: 1024, requestDistribution: 'seeded skew over 64 keys unless specified', repetitions, configuredMaximumRps, scenarioFilter: scenarioFilter ?? null, budgets: { workersHeapMiBEach: 160, originHeapMiB: 160, generatorHeapMiB: 192, aggregateRssMiB: 768, totalMs: 110000, perLoadMs: 7000, requestsPerLoad: 100000, maxGeneratorOutstanding: 1500 }, coordinatedOmission: 'open-loop planned-arrival latency; unsent traffic separately counted; generator ceiling calibrated with HTTP bypass' }, capacity, rows, notes }, null, 2) + '\n');
  console.log(`Raw E2E results: ${output}`);
}
