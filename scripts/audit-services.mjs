#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// This owns its entire Compose project; ambient service URLs are never reused.
const action = process.argv[2] ?? 'test';
if (!['test', 'benchmark', 'chaos', 'runtime'].includes(action)) throw new Error('Usage: audit-services.mjs test|benchmark|chaos|runtime');
const nodeMajor = Number(process.env.LAZY_AUDIT_NODE_MAJOR ?? 20);
if (action === 'runtime' && ![20, 22, 24].includes(nodeMajor)) throw new Error('Isolated runtime must be Node 20, 22 or 24');
const project = `lazy-layers-audit-${randomUUID().slice(0, 8)}`;
const compose = ['compose', '--project-name', project, '--file', 'audit/compose.yml'];
const label = process.env.LAZY_AUDIT_LABEL ?? 'current';
const output = process.env.LAZY_AUDIT_SERVICE_OUTPUT ?? `audit/raw/${label}-docker-${action}.log`;
const children = new Set();
const runtimeName = `${project}-runtime-${nodeMajor}`;
let stopReason;
let deadline;
function killGroup(child) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
const signals = () => { stopReason = 'interrupted'; for (const child of children) killGroup(child); };
process.on('SIGINT', signals); process.on('SIGTERM', signals);
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  children.add(child);
  let stdout = ''; let stderr = '';
  let aborted;
  let peakRssBytes = 0;
  const abort = (reason) => { aborted ??= reason; killGroup(child); };
  child.stdout.on('data', (data) => { stdout += data; if (options.show) process.stdout.write(data); if (stdout.length + stderr.length > 16 * 1024 * 1024) abort('output budget'); });
  child.stderr.on('data', (data) => { stderr += data; if (options.show) process.stderr.write(data); if (stdout.length + stderr.length > 16 * 1024 * 1024) abort('output budget'); });
  const timer = setTimeout(() => abort('wall-time budget'), options.timeout ?? 90000);
  const monitor = setInterval(() => {
    const usage = spawnSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
    if (usage.status !== 0) { abort('RSS monitoring unavailable'); return; }
    const rows = usage.stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
    const owned = new Set([child.pid]);
    for (let pass = 0; pass < 12; pass++) for (const [pid, ppid] of rows) if (owned.has(ppid)) owned.add(pid);
    const rss = rows.reduce((sum, [pid, , kib]) => sum + (owned.has(pid) ? kib * 1024 : 0), 0);
    peakRssBytes = Math.max(peakRssBytes, rss);
    if (rss > 768 * 1024 * 1024) abort('aggregate RSS budget');
  }, 250);
  child.once('error', (error) => { clearTimeout(timer); clearInterval(monitor); children.delete(child); reject(error); });
  child.once('exit', (code, signal) => { clearTimeout(timer); clearInterval(monitor); killGroup(child); children.delete(child); resolve({ code, signal, stdout, stderr, peakSampledRssBytes: peakRssBytes, aborted: aborted ?? null }); });
});
function checked(result, name) { if (result.code !== 0) throw new Error(`${name} failed (${result.code}/${result.signal}): ${result.stderr.slice(-3000)}`); return result.stdout.trim(); }
try {
  deadline = setTimeout(signals, 360000);
  console.log(`Starting disposable Compose project ${project}; service memory caps total 736 MiB.`);
  checked(await run('docker', [...compose, 'up', '--detach', '--wait', '--wait-timeout', '90'], { timeout: 180000, show: true }), 'Compose startup');
  const ports = {};
  for (const [name, port] of [['redis', 6379], ['rabbitmq', 5672], ['nats', 4222]]) ports[name] = checked(await run('docker', [...compose, 'port', name, String(port)]), `${name} port`);
  const env = { ...process.env, NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=512', REDIS_URL: `redis://${ports.redis}`, RABBITMQ_URL: `amqp://audit:audit-local-only@${ports.rabbitmq}`, NATS_URL: `nats://${ports.nats}`, LAZY_AUDIT_PROJECT: project };
  const containers = checked(await run('docker', [...compose, 'ps', '--format', 'json']), 'Compose inventory');
  const started = Date.now();
  const testRoot = process.env.LAZY_AUDIT_TEST_ROOT ?? 'test';
  const tests = action === 'test' ? (await readdir(testRoot)).filter((name) => name.endsWith('.test.js')).sort().map((name) => path.join(testRoot, name)) : [];
  const args = action === 'test'
    ? ['--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=15000', ...tests]
    : [action === 'benchmark' ? 'benchmarks/audit-e2e.mjs' : 'benchmarks/audit-chaos.mjs'];
  const result = action === 'runtime'
    ? await run('docker', ['run', '--rm', '--name', runtimeName, '--label', 'lazy-layers.audit=disposable', '--memory=1024m', '--memory-swap=1024m', '--cpus=1.5', '--pids-limit=128', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--network', `${project}_default`, '--tmpfs', '/work:rw,exec,size=536870912', '--mount', `type=bind,source=${process.cwd()},target=/input,readonly`, '--env', 'NODE_OPTIONS=--max-old-space-size=512', '--env', 'NODE_ENV=production', '--env', 'REDIS_URL=redis://redis:6379', '--env', 'RABBITMQ_URL=amqp://audit:audit-local-only@rabbitmq:5672', '--env', 'NATS_URL=nats://nats:4222', `node:${nodeMajor}-bookworm-slim`, 'bash', '/input/scripts/audit-runtime.sh'], { timeout: 240000 })
    : await run(process.execPath, args, { env, timeout: action === 'test' ? 180000 : 120000 });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, result.stdout + result.stderr);
  const dockerVersion = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 10000 }).stdout.trim();
  const inventory = containers.startsWith('[') ? JSON.parse(containers) : containers.split('\n').filter(Boolean).map((row) => JSON.parse(row));
  const metadata = { action, label, project, generatedAt: new Date().toISOString(), elapsedMs: Date.now() - started, node: process.version, testedContainerNodeMajor: action === 'runtime' ? nodeMajor : null, os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, dockerVersion, ports, containers: inventory, budgets: { redisMiB: 96, rabbitmqMiB: 512, natsMiB: 128, cpus: 2.5, runtimeContainerMiB: action === 'runtime' ? 1024 : 0, runtimeContainerCpus: action === 'runtime' ? 1.5 : 0, runtimeTmpfsMiB: action === 'runtime' ? 512 : 0, childHeapMiB: 512, aggregateChildRssMiB: 768, maxOutputBytes: 16 * 1024 * 1024, operationDeadlineMs: action === 'runtime' ? 240000 : action === 'test' ? 180000 : 120000, totalDeadlineMs: 360000 }, peakSampledRssBytes: result.peakSampledRssBytes, aborted: result.aborted, code: result.code, signal: result.signal, interrupted: stopReason ?? null };
  await writeFile(`${output}.meta.json`, JSON.stringify(metadata, null, 2) + '\n');
  console.log(result.stdout.slice(-2500));
  if (result.stderr) console.log(result.stderr.slice(-1500));
  console.log(`Raw live-service results: ${output}`);
  process.exitCode = result.code ?? 1;
} finally {
  clearTimeout(deadline);
  for (const child of children) killGroup(child);
  if (action === 'runtime') await run('docker', ['rm', '--force', runtimeName], { timeout: 10000 });
  // A fault harness killed by its deadline may leave the owned service paused.
  await run('docker', [...compose, 'unpause', 'redis'], { timeout: 10000 });
  const cleanup = await run('docker', [...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '5'], { timeout: 30000 });
  console.log(`Disposed ${project}: ${cleanup.code === 0 ? 'clean' : 'cleanup failed'}`);
  if (cleanup.code !== 0) process.exitCode = 1;
  process.off('SIGINT', signals); process.off('SIGTERM', signals);
}
