import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

export const isChild = process.argv.includes('--child');
const configured = process.env.LAZY_AUDIT_MODULE ?? new URL('../dist/index.js', import.meta.url).href;
export const moduleURL = configured.startsWith('file:') ? configured : pathToFileURL(resolve(configured)).href;
export const childCase = () => JSON.parse(process.env.LAZY_AUDIT_CASE);
export const quantiles = (values) => {
  const ordered = Array.from(values).sort((a, b) => a - b);
  const at = (q) => ordered[Math.max(0, Math.ceil(ordered.length * q) - 1)] ?? null;
  return { count: ordered.length, min: ordered[0] ?? null, median: at(.5), p95: at(.95), p99: at(.99), max: ordered.at(-1) ?? null };
};
export const cpuMs = (start) => { const cpu = process.cpuUsage(start); return (cpu.user + cpu.system) / 1000; };
export const memory = () => ({ ...process.memoryUsage(), osMaxRssBytes: process.resourceUsage().maxRSS * 1024 });
export function random(seed = 0x51f3a27b) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; };
}
export async function gc() {
  if (!globalThis.gc) throw new Error('Experiment requires --expose-gc');
  globalThis.gc(); globalThis.gc();
  await new Promise((done) => setImmediate(done));
}

async function runChild(script, configuration) {
  return new Promise((done) => {
    const env = { NODE_ENV: 'production', LAZY_AUDIT_MODULE: moduleURL, LAZY_AUDIT_CASE: JSON.stringify(configuration) };
    for (const key of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH']) if (process.env[key] !== undefined) env[key] = process.env[key];
    const child = spawn(process.execPath, ['--expose-gc', '--max-old-space-size=256', script, '--child'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', aborted, kill;
    const abort = (reason) => {
      if (aborted) return;
      aborted = reason; child.kill('SIGTERM'); kill = setTimeout(() => child.kill('SIGKILL'), 250);
    };
    const timer = setTimeout(() => abort('20-second child deadline exceeded'), 20_000);
    const monitor = setInterval(() => {
      const sample = spawnSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8', timeout: 1000, maxBuffer: 4096 });
      if (sample.status === 0 && Number(sample.stdout.trim()) * 1024 > 512 * 1024 * 1024) abort('512 MiB child RSS budget exceeded');
    }, 200);
    const accept = (data, stream) => {
      if (stream === 'out') stdout += data; else stderr += data;
      if (stdout.length + stderr.length > 2 * 1024 * 1024) abort('2 MiB child output budget exceeded');
    };
    child.stdout.on('data', (data) => accept(data, 'out'));
    child.stderr.on('data', (data) => accept(data, 'err'));
    child.once('error', (error) => { aborted = error.message; });
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(kill); clearInterval(monitor);
      if (aborted || code !== 0) return done({ ...configuration, failed: true, reason: aborted ?? stderr.slice(-2048), code, signal });
      try {
        const result = JSON.parse(stdout);
        if (result.memory?.osMaxRssBytes > 512 * 1024 * 1024) return done({ ...configuration, failed: true, reason: 'Observed peak RSS exceeded 512 MiB' });
        done({ ...configuration, result });
      } catch { done({ ...configuration, failed: true, reason: 'Invalid child result', stderr: stderr.slice(-1024) }); }
    });
  });
}

export async function matrix(script, cases, name, notes) {
  const started = performance.now(); const rows = [];
  for (const configuration of cases) {
    if (performance.now() - started > 160_000) { rows.push({ ...configuration, failed: true, reason: '180-second matrix deadline cannot admit another 20-second child' }); break; }
    rows.push(await runChild(script, configuration));
  }
  const output = resolve(process.env.LAZY_AUDIT_OUTPUT ?? `audit/raw/${name}.json`);
  await mkdir(dirname(output), { recursive: true });
  const result = {
    metadata: { generatedAt: new Date().toISOString(), module: moduleURL, node: process.version, v8: process.versions.v8, os: `${os.type()} ${os.release()}`, arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, hostMemoryBytes: os.totalmem(), instanceCount: 1, isolation: 'fresh child per case/repetition; deterministic synthetic data; no network', limits: { heapMiB: 256, rssMiB: 512, childSeconds: 20, matrixSeconds: 180, stdoutMiB: 2 }, notes },
    completedCases: rows.filter((row) => !row.failed).length, configuredCases: cases.length, elapsedMs: performance.now() - started, rows,
  };
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ output, completedCases: result.completedCases, configuredCases: cases.length, elapsedMs: result.elapsedMs, failures: rows.filter((row) => row.failed) }));
  if (result.completedCases !== cases.length) process.exitCode = 1;
}
