#!/usr/bin/env node
// Offline, bounded profiles. All retained values are deterministic synthetic data.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { writeHeapSnapshot } from 'node:v8';

const CHILD_TIMEOUT_MS = 20_000;
const PARENT_TIMEOUT_MS = 180_000;
const RSS_LIMIT_BYTES = 512 * 1024 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const VALUE_SIZES = [64, 1024, 16 * 1024, 256 * 1024, 1024 * 1024, 10 * 1024 * 1024];
// Frozen baseline six-cycle heap ranges were 46,880 and 57,536 bytes. This
// deliberately generous smoke bound is slack + rounded observed variability,
// not a statistically established long-duration leak threshold.
const WORKING_SET_HEAP_SLACK_BYTES = 512 * 1024;
const WORKING_SET_BASELINE_VARIANCE_BYTES = 64 * 1024;
const script = new URL(import.meta.url).pathname;
const isChild = process.argv.includes('--child');
const configuredModule = process.env.LAZY_AUDIT_MODULE ?? new URL('../dist/index.js', import.meta.url).href;
const moduleURL = configuredModule.startsWith('file:') ? configuredModule : pathToFileURL(resolve(configuredModule)).href;

function memory() {
  const { rss, heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
  return { rss, heapUsed, heapTotal, external, arrayBuffers, osMaxRss: process.resourceUsage().maxRSS * 1024 };
}
function difference(before, after) { return Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]])); }
function seededBytes(size, seed) {
  const value = Buffer.allocUnsafeSlow(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    value[i] = state >>> 24;
  }
  return value;
}
function quantiles(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (q) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
  return { count: sorted.length, min: sorted[0], median: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) };
}
async function fullGC(pauses) {
  if (!globalThis.gc) throw new Error('Child requires --expose-gc');
  const begin = performance.now();
  globalThis.gc(); globalThis.gc();
  pauses.push(performance.now() - begin);
  await new Promise((done) => setImmediate(done));
}
function post(session, method, params = {}) {
  return new Promise((done, fail) => session.post(method, params, (error, value) => error ? fail(error) : done(value)));
}
function allocationSummary(profile) {
  let nodes = 0; let sampledBytes = 0;
  const visit = (node) => { nodes++; sampledBytes += node.selfSize ?? 0; for (const child of node.children ?? []) visit(child); };
  visit(profile.head);
  return { samplingIntervalBytes: 2048, sampledBytes, sampledStackNodes: nodes, sampleRecords: profile.samples?.length ?? null, exactAllocationCount: 'NOT MEASURED' };
}

async function valueProfile(mod, configuration, explicitGcPauses) {
  const { size, entropy, repeat } = configuration;
  const value = entropy === 'compressible' ? { payload: 'x'.repeat(size) } : seededBytes(size, 0x53af4d31 + repeat);
  const writes = Math.min(256, Math.max(1, Math.floor(16 * 1024 * 1024 / size)));
  const iterations = Math.min(100, Math.max(1, Math.floor(8 * 1024 * 1024 / size)));
  for (let warm = 0; warm < 2; warm++) mod.deserialize(mod.serialize(value));
  const codecCpuStart = process.cpuUsage();
  const encodeTimes = []; const decodeTimes = [];
  let encoded;
  for (let i = 0; i < iterations; i++) {
    const started = performance.now(); encoded = mod.serializeWithStats(value); encodeTimes.push(performance.now() - started);
    const decodedAt = performance.now(); mod.deserialize(encoded.buffer); decodeTimes.push(performance.now() - decodedAt);
  }
  const codecCpu = process.cpuUsage(codecCpuStart);
  const afterCodecs = memory();
  const encodeInfo = { encoding: encoded.encoding, originalBytes: encoded.originalBytes, storedBytes: encoded.storedBytes, compressed: encoded.compressed, savedFraction: encoded.compressionRatio };
  const options = { levels: { L1: { maxEntries: 2048, admission: { enabled: false, maxEntryBytes: 32 * 1024 * 1024 } } } };
  let warmStore = new mod.MemoryStore({ ...options, memoryBudget: new mod.MemoryBudget({ maxMemory: 64 * 1024 * 1024, sampleIntervalMs: 0 }) });
  await warmStore.setEncoded('warm', encoded.buffer, {}, encoded.originalBytes);
  await warmStore.delete('warm'); warmStore.close(); warmStore = undefined;
  await fullGC(explicitGcPauses);
  const budget = new mod.MemoryBudget({ maxMemory: 64 * 1024 * 1024, sampleIntervalMs: 0 });
  const before = memory();
  let store = new mod.MemoryStore({ ...options, memoryBudget: budget });
  await fullGC(explicitGcPauses);
  const empty = memory();
  const fillCpuStart = process.cpuUsage();
  const fillStarted = performance.now();
  for (let i = 0; i < writes; i++) await store.setEncoded(`profile-key:${String(i).padStart(4, '0')}`, encoded.buffer, {}, encoded.originalBytes);
  const fillMs = performance.now() - fillStarted;
  const fillCpu = process.cpuUsage(fillCpuStart);
  await fullGC(explicitGcPauses);
  const filled = memory();
  const stats = store.stats();
  for (let i = 0; i < writes; i++) await store.delete(`profile-key:${String(i).padStart(4, '0')}`);
  await fullGC(explicitGcPauses);
  const deleted = memory();
  const afterDeleteLedger = budget.snapshot();
  store.close();
  await fullGC(explicitGcPauses);
  const closedWhileHeld = memory();
  const closedLedger = budget.snapshot();
  store = undefined;
  await fullGC(explicitGcPauses);
  const released = memory();
  encoded = undefined;
  const retainedDelta = difference(empty, filled);
  return {
    name: 'value-profile', ...configuration, writes, admittedEntries: stats.entries, keyBytes: 16,
    residentPayloadBudgetBytes: 16 * 1024 * 1024, ledgerCapBytes: 64 * 1024 * 1024, configuredMaxEntries: 2048,
    codec: { ...encodeInfo, encodeMs: quantiles(encodeTimes), decodeMs: quantiles(decodeTimes), cpuMs: (codecCpu.user + codecCpu.system) / 1000 },
    fill: { elapsedMs: fillMs, cpuMs: (fillCpu.user + fillCpu.system) / 1000 },
    memory: { before, empty, afterCodecs, filled, deleted, closedWhileHeld, released, retainedDelta },
    approximateEntryDeltas: stats.entries ? { heapBytes: retainedDelta.heapUsed / stats.entries, externalBytes: retainedDelta.external / stats.entries, heapPlusExternalBytes: (retainedDelta.heapUsed + retainedDelta.external) / stats.entries } : null,
    ledgers: { filled: stats.budget, afterDelete: afterDeleteLedger, closed: closedLedger },
    assertions: {
      noFreshBytesAfterDelete: (afterDeleteLedger.categories.fresh ?? 0) === 0,
      closedBudgetReleased: closedLedger.accountedBytes === 0,
      ledgerWithinCap: stats.budget.accountedBytes <= stats.budget.target,
    },
    exactPeakTemporaryAllocation: 'NOT MEASURED', nativeAllocatorFragmentation: 'NOT MEASURED',
  };
}

async function skeletonProfile(mod, configuration, explicitGcPauses) {
  await fullGC(explicitGcPauses);
  const budget = new mod.MemoryBudget({ maxMemory: 100_000, sampleIntervalMs: 0 });
  const before = memory();
  let stores = Array.from({ length: 20 }, () => new mod.MemoryStore({ memoryBudget: budget, levels: { L1: { maxEntries: 10_000 } } }));
  await fullGC(explicitGcPauses);
  const emptyStores = memory();
  const liveLedger = budget.snapshot();
  for (const store of stores) store.close();
  await fullGC(explicitGcPauses);
  const closedWhileHeld = memory();
  const closedLedger = budget.snapshot();
  stores = undefined;
  await fullGC(explicitGcPauses);
  const released = memory();
  const snapshots = [];
  // Snapshots run after every memory checkpoint, on newly reconstructed stores.
  // Snapshot serialization can itself raise RSS and must not contaminate deltas.
  if (process.env.LAZY_AUDIT_SNAPSHOTS === '1' && configuration.repeat === 0) {
    const snapshotPath = resolve(process.env.LAZY_AUDIT_SNAPSHOT_DIR ?? 'audit/raw', `${process.env.LAZY_AUDIT_LABEL ?? 'profile'}-empty-stores.heapsnapshot`);
    await mkdir(dirname(snapshotPath), { recursive: true });
    const snapshotStores = Array.from({ length: 20 }, () => new mod.MemoryStore({ memoryBudget: budget, levels: { L1: { maxEntries: 10_000 } } }));
    snapshots.push(writeHeapSnapshot(snapshotPath));
    for (const store of snapshotStores) store.close();
  }
  return { name: 'empty-store-skeleton', ...configuration, storeCount: 20, configuredMaxEntriesEach: 10_000, ledgerCapBytes: 100_000, memory: { before, emptyStores, closedWhileHeld, released, liveDelta: difference(before, emptyStores), heldClosedDelta: difference(before, closedWhileHeld), releasedDelta: difference(before, released) }, ledgers: { live: liveLedger, closed: closedLedger }, assertions: { closedBudgetReleased: closedLedger.accountedBytes === 0, ledgerWithinCap: liveLedger.accountedBytes <= liveLedger.target }, snapshots };
}

async function workingSetProfile(mod, configuration, explicitGcPauses) {
  const budget = new mod.MemoryBudget({ maxMemory: 2 * 1024 * 1024, sampleIntervalMs: 0 });
  let store = new mod.MemoryStore({ memoryBudget: budget, levels: { L1: { maxEntries: 128, admission: { enabled: false } } } });
  const payload = seededBytes(1024, 0x593daa3);
  for (let i = 0; i < 128; i++) await store.set(String(i), payload);
  await fullGC(explicitGcPauses);
  const before = memory(); const cycles = [];
  for (let cycle = 0; cycle < 6; cycle++) {
    for (let i = 0; i < 512; i++) {
      await store.set(`key:${i % 128}`, payload);
      if (i % 4 === 0) await store.delete(`key:${i % 128}`);
    }
    await store.clear();
    await fullGC(explicitGcPauses);
    cycles.push({ cycle, memory: memory(), ledger: budget.snapshot() });
  }
  store.close(); store = undefined;
  await fullGC(explicitGcPauses);
  const heapValues = cycles.map((cycle) => cycle.memory.heapUsed);
  const heapRangeBytes = Math.max(...heapValues) - Math.min(...heapValues);
  const heapGrowthBytes = heapValues.at(-1) - heapValues[0];
  const closedLedger = budget.snapshot();
  return {
    name: 'bounded-working-set', ...configuration, cycles, before, after: memory(), closedLedger,
    retainedGrowthSmoke: { heapRangeBytes, heapGrowthBytes, fixedSlackBytes: WORKING_SET_HEAP_SLACK_BYTES, baselineVarianceAllowanceBytes: WORKING_SET_BASELINE_VARIANCE_BYTES, toleranceBytes: WORKING_SET_HEAP_SLACK_BYTES + WORKING_SET_BASELINE_VARIANCE_BYTES, durationScope: 'six short post-GC cycles; long-duration leak behavior NOT MEASURED' },
    assertions: {
      noFreshBytesAfterClear: cycles.every((cycle) => (cycle.ledger.categories.fresh ?? 0) === 0),
      ledgerWithinCap: cycles.every((cycle) => cycle.ledger.accountedBytes <= cycle.ledger.target),
      closedBudgetReleased: closedLedger.accountedBytes === 0,
      postGcRetainedGrowthWithinSmokeTolerance: heapRangeBytes <= WORKING_SET_HEAP_SLACK_BYTES + WORKING_SET_BASELINE_VARIANCE_BYTES,
    },
  };
}

async function childMain() {
  const configuration = JSON.parse(process.env.LAZY_AUDIT_CASE);
  const mod = await import(moduleURL);
  const explicitGcPauses = []; const observedGcPauses = [];
  const observer = new PerformanceObserver((list) => { for (const event of list.getEntries()) observedGcPauses.push({ durationMs: event.duration, kind: event.detail?.kind ?? null }); });
  observer.observe({ entryTypes: ['gc'] });
  const started = performance.now();
  let result;
  try {
    result = configuration.scenario === 'skeleton' ? await skeletonProfile(mod, configuration, explicitGcPauses)
      : configuration.scenario === 'working-set' ? await workingSetProfile(mod, configuration, explicitGcPauses)
      : await valueProfile(mod, configuration, explicitGcPauses);
  } finally {
    observer.disconnect();
  }
  const sampledAllocations = await separateAllocationSample(mod, configuration);
  const finalMemory = memory();
  const failedAssertions = Object.entries(result.assertions ?? {}).filter(([, passed]) => passed !== true).map(([name]) => name);
  if (finalMemory.osMaxRss > RSS_LIMIT_BYTES) failedAssertions.push('childPeakRssWithinLimit');
  console.log(JSON.stringify({ ...result, failedAssertions, elapsedMs: performance.now() - started, explicitGcPausesMs: quantiles(explicitGcPauses), observedGcPauses, sampledAllocations, finalMemory }));
  if (failedAssertions.length > 0) process.exitCode = 1;
}

async function separateAllocationSample(mod, configuration) {
  const profiler = new Session(); profiler.connect();
  try {
    await post(profiler, 'HeapProfiler.startSampling', { samplingInterval: 2048, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    if (configuration.scenario === 'value') {
      const value = configuration.entropy === 'compressible' ? { payload: 'x'.repeat(configuration.size) } : seededBytes(configuration.size, 0x53af4d31 + configuration.repeat);
      const operations = Math.min(32, Math.max(1, Math.floor(4 * 1024 * 1024 / configuration.size)));
      for (let i = 0; i < operations; i++) mod.deserialize(mod.serialize(value));
    } else {
      const budget = new mod.MemoryBudget({ maxMemory: 100_000, sampleIntervalMs: 0 });
      const stores = Array.from({ length: 20 }, () => new mod.MemoryStore({ memoryBudget: budget, levels: { L1: { maxEntries: 10_000 } } }));
      for (const store of stores) store.close();
    }
    return { ...allocationSummary((await post(profiler, 'HeapProfiler.stopSampling')).profile), phase: 'separate workload after retained-memory checkpoints' };
  } catch { return 'NOT MEASURED: inspector allocation sampling unavailable'; }
  finally { profiler.disconnect(); }
}

function runChild(configuration) {
  return new Promise((done) => {
    // Heap snapshots must not capture unrelated inherited credentials.
    const env = { NODE_ENV: 'production', LAZY_AUDIT_CASE: JSON.stringify(configuration), LAZY_AUDIT_MODULE: moduleURL };
    for (const key of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'DYLD_LIBRARY_PATH', 'LD_LIBRARY_PATH', 'LAZY_AUDIT_LABEL', 'LAZY_AUDIT_SNAPSHOTS', 'LAZY_AUDIT_SNAPSHOT_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key];
    const child = spawn(process.execPath, ['--expose-gc', '--max-old-space-size=256', script, '--child'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let reason; let forceKill;
    const abort = (message) => {
      if (reason) return;
      reason = message; child.kill('SIGTERM'); forceKill = setTimeout(() => child.kill('SIGKILL'), 250);
    };
    const deadline = setTimeout(() => abort('child wall deadline exceeded'), CHILD_TIMEOUT_MS);
    const monitor = setInterval(() => {
      if (!child.pid) return;
      const usage = spawnSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8', timeout: 500, maxBuffer: 4096 });
      const rssBytes = Number.parseInt(usage.stdout, 10) * 1024;
      if (Number.isFinite(rssBytes) && rssBytes > RSS_LIMIT_BYTES) abort('child RSS limit exceeded');
    }, 200);
    child.stdout.on('data', (chunk) => { stdout += chunk; if (Buffer.byteLength(stdout) > MAX_STDOUT_BYTES) abort('child output limit exceeded'); });
    child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk; });
    child.once('error', (error) => { reason = `child spawn failed: ${error.code ?? error.name}`; });
    child.once('close', (code, signal) => {
      clearTimeout(deadline); clearInterval(monitor); if (forceKill) clearTimeout(forceKill);
      let parsed;
      try { parsed = JSON.parse(stdout); } catch { /* reported below */ }
      const failures = parsed?.failedAssertions ?? Object.entries(parsed?.assertions ?? {}).filter(([, passed]) => passed !== true).map(([name]) => name);
      if (reason || code !== 0 || failures.length > 0) {
        done({ ...configuration, ...parsed, failed: true, reason: reason ?? (failures.length ? `profile assertions failed: ${failures.join(', ')}` : `child exit ${code}/${signal}`), stderr });
        return;
      }
      if (parsed) done(parsed);
      else done({ ...configuration, failed: true, reason: 'child returned invalid JSON', stderr });
    });
  });
}

async function parentMain() {
  const repeats = Number(process.env.LAZY_AUDIT_REPEATS ?? '2');
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 3) throw new RangeError('LAZY_AUDIT_REPEATS must be 1 through 3');
  const parentStarted = performance.now(); const results = [];
  const cases = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    cases.push({ scenario: 'skeleton', repeat }, { scenario: 'working-set', repeat });
    for (const size of VALUE_SIZES) for (const entropy of ['compressible', 'incompressible']) cases.push({ scenario: 'value', repeat, size, entropy });
  }
  for (const configuration of cases) {
    if (performance.now() - parentStarted > PARENT_TIMEOUT_MS - CHILD_TIMEOUT_MS) { results.push({ ...configuration, failed: true, reason: 'parent resource deadline reached; case not run' }); break; }
    results.push(await runChild(configuration));
  }
  const output = {
    metadata: { label: process.env.LAZY_AUDIT_LABEL ?? 'profile', module: moduleURL, generatedAt: new Date().toISOString(), node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model, logicalCpuCount: os.cpus().length, hostMemoryBytes: os.totalmem(), repeats, isolation: 'fresh child per scenario and repeat; offline synthetic data', budgets: { childHeapMiB: 256, childTimeoutMs: CHILD_TIMEOUT_MS, childRssBytes: RSS_LIMIT_BYTES, parentTimeoutMs: PARENT_TIMEOUT_MS, residentExpandedPayloadBytes: 16 * 1024 * 1024 }, notes: ['Forced GC checkpoint differences are approximate process deltas, not exact heap retained sizes.', 'External and arrayBuffers overlap; do not add both.', 'Checkpoint OS max RSS includes synchronous peaks before that checkpoint.', 'Heap snapshots and allocation sampling run after retained-memory checkpoints; finalMemory includes their overhead.', 'Inspector samples are not exact allocation counts.', 'Allocator fragmentation and exact temporary-allocation peak are NOT MEASURED.', 'Any false accounting/lifecycle/smoke assertion fails both child and parent with exit1.', 'Six-cycle growth tolerance is 512KiB fixed slack + 64KiB rounded baseline variability; long-duration leaks remain NOT MEASURED.'] },
    completedCases: results.filter((row) => !row.failed).length, configuredCases: cases.length, results,
  };
  const outputPath = resolve(process.env.LAZY_AUDIT_OUTPUT ?? 'audit/raw/memory-profile.json');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ output: outputPath, completedCases: output.completedCases, configuredCases: cases.length, failed: results.filter((row) => row.failed).map((row) => ({ scenario: row.scenario, size: row.size, entropy: row.entropy, repeat: row.repeat, reason: row.reason })), elapsedMs: performance.now() - parentStarted }));
  if (results.some((row) => row.failed) || output.completedCases !== cases.length) process.exitCode = 1;
}

if (isChild) await childMain(); else await parentMain();
