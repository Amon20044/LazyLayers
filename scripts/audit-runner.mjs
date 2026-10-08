#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Runs only local subprocesses. --redis creates a disposable loopback Redis;
// ambient service URLs are always removed from the child environment.
const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 0 || !args[separator + 1]) throw new Error('Usage: audit-runner.mjs [--redis] [--seconds=180] [--rss-mib=768] [--output=file] -- command args');
const flags = args.slice(0, separator);
for (const flag of flags) {
  if (flag !== '--redis' && !/^--(?:seconds|rss-mib|heap-mib|output)=.+$/.test(flag)) {
    throw new Error(`Unknown or incomplete audit-runner option: ${flag}. Use --name=value.`);
  }
}
const names = flags.map((flag) => flag.split('=')[0]);
if (new Set(names).size !== names.length) throw new Error('Duplicate audit-runner option');
const read = (name, fallback) => flags.find((flag) => flag.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const seconds = Number(read('seconds', '180'));
const rssMiB = Number(read('rss-mib', '768'));
const heapMiB = Number(read('heap-mib', '512'));
if (!(seconds > 0 && seconds <= 600 && rssMiB >= 64 && rssMiB <= 2048 && Number.isSafeInteger(heapMiB) && heapMiB >= 64 && heapMiB <= 1536 && heapMiB <= rssMiB)) throw new RangeError('Budget exceeds local harness limits');
const output = read('output', '');
const env = { ...process.env, NODE_ENV: 'production' };
for (const key of ['REDIS_URL', 'RABBITMQ_URL', 'NATS_URL']) delete env[key];
env.NODE_OPTIONS = `--max-old-space-size=${heapMiB}`;
let redis;
let directory;
let child;
let interval;
let timer;
let aborted;
let peakRssBytes = 0;
let rssMonitoringAvailable = false;
const started = Date.now();
const chunks = [];
let outputBytes = 0;
const maxOutputBytes = 16 * 1024 * 1024;
const stop = (reason) => {
  aborted ??= reason;
  if (child?.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
};
const onSignal = () => stop('interrupted');
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
try {
  if (flags.includes('--redis')) {
    directory = await mkdtemp(path.join(os.tmpdir(), 'lazy-layers-audit-redis-'));
    const listener = net.createServer();
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    redis = spawn('redis-server', ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no', '--protected-mode', 'yes', '--maxmemory', '64mb', '--maxmemory-policy', 'noeviction', '--dir', directory], { stdio: ['ignore', 'pipe', 'pipe'] });
    redis.on('error', () => {});
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (redis.exitCode !== null) throw new Error('Isolated redis-server exited before readiness');
      const probe = spawnSync('redis-cli', ['-h', '127.0.0.1', '-p', String(port), 'PING'], { encoding: 'utf8', timeout: 1000 });
      if (probe.status === 0 && probe.stdout.trim() === 'PONG') { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error('Isolated Redis readiness exceeded 4 seconds');
    env.REDIS_URL = `redis://127.0.0.1:${port}`;
    console.log('Disposable Redis ready on loopback; persistence disabled, 64 MiB cap.');
  }
  child = spawn(args[separator + 1], args.slice(separator + 2), { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => {
    outputBytes += data.byteLength;
    if (outputBytes > maxOutputBytes) { stop('output budget exceeded'); return; }
    chunks.push(data); if (!output) process.stdout.write(data);
  });
  timer = setTimeout(() => stop('wall-time budget exceeded'), seconds * 1000);
  interval = setInterval(() => {
    // Include every descendant, so Node test workers are part of the budget.
    const result = spawnSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0) { stop('RSS monitoring unavailable'); return; }
    rssMonitoringAvailable = true;
    const rows = result.stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
    const owned = new Set([child.pid]);
    for (let pass = 0; pass < 12; pass++) for (const [pid, ppid] of rows) if (owned.has(ppid)) owned.add(pid);
    const rss = rows.reduce((sum, [pid, , kib]) => sum + (owned.has(pid) || pid === redis?.pid ? kib * 1024 : 0), 0);
    peakRssBytes = Math.max(peakRssBytes, rss);
    if (rss > rssMiB * 1024 * 1024) stop('aggregate RSS budget exceeded');
  }, 250);
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  clearInterval(interval); clearTimeout(timer);
  const summary = { command: args.slice(separator + 1), wallTimeMs: Date.now() - started, budgets: { seconds, rssMiB, maxOutputBytes, childHeapMiB: heapMiB }, rssMonitoringAvailable, peakSampledRssBytes: rssMonitoringAvailable ? peakRssBytes : 'NOT MEASURED', isolatedRedis: Boolean(redis), ...result, aborted: aborted ?? null };
  if (output) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, Buffer.concat(chunks));
    await writeFile(`${output}.meta.json`, JSON.stringify(summary, null, 2) + '\n');
  }
  console.log(JSON.stringify(summary));
  process.exitCode = aborted ? 1 : result.code ?? 1;
} finally {
  clearInterval(interval); clearTimeout(timer);
  // A normally exiting leader can leave descendants in its owned process group.
  if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  if (redis && redis.exitCode === null) {
    const stopped = new Promise((resolve) => redis.once('exit', resolve));
    redis.kill('SIGTERM');
    const killTimer = setTimeout(() => redis.kill('SIGKILL'), 1500);
    await stopped;
    clearTimeout(killTimer);
  }
  if (directory) await rm(directory, { recursive: true, force: true });
  process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
}
