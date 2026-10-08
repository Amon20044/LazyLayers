#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, symlink, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';

const base = process.env.LAZY_AUDIT_BASE_REF;
if (!base) throw new Error('Set LAZY_AUDIT_BASE_REF to an available base commit');
const revision = execFileSync('git', ['rev-parse', '--verify', `${base}^{commit}`], { encoding: 'utf8', timeout: 5000 }).trim();
const directory = await mkdtemp(join(os.tmpdir(), 'lazy-layers-perf-ci-'));
const baseline = join(directory, 'baseline'); const children = new Set();
let cancelled = false;
const stop = () => { for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } };
const abort = () => { cancelled = true; stop(); };
process.on('SIGINT', abort); process.on('SIGTERM', abort);
const deadline = setTimeout(abort, 240000);
async function run(command, args, options = {}) {
  if (cancelled) throw new Error('CI audit interrupted or exceeded 240-second budget');
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: 'inherit', detached: true }); children.add(child);
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, options.timeout ?? 60000);
    child.once('error', (error) => { clearTimeout(timer); children.delete(child); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); try { process.kill(-child.pid, 'SIGKILL'); } catch {} children.delete(child); code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)); });
  });
}
try {
  await mkdir(baseline);
  execFileSync('git', ['archive', '--format=tar', `--output=${join(directory, 'base.tar')}`, revision], { timeout: 10000 });
  execFileSync('tar', ['-xf', join(directory, 'base.tar'), '-C', baseline], { timeout: 10000 });
  const sharedLock = (await readFile('package-lock.json')).equals(await readFile(join(baseline, 'package-lock.json')));
  if (sharedLock) await symlink(resolve('node_modules'), join(baseline, 'node_modules'), 'dir');
  else await run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: baseline, timeout: 60000 });
  await mkdir('audit/raw', { recursive: true });
  await writeFile('audit/raw/ci-provenance.json', JSON.stringify({ baselineCommit: revision, baselineDependencies: sharedLock ? 'identical lockfile; shared installed modules' : 'independent npm ci from baseline lockfile', node: process.version }, null, 2) + '\n');
  await run(process.execPath, [resolve('scripts/audit-runner.mjs'), '--seconds=30', '--rss-mib=768', `--output=${resolve('audit/raw/ci-base-build.log')}`, '--', 'npm', 'run', 'build'], { cwd: baseline, timeout: 35000 });
  const shared = { ...process.env, LAZY_AUDIT_REPETITIONS: '7' };
  await run(process.execPath, ['scripts/audit-runner.mjs', '--seconds=60', '--rss-mib=768', '--output=audit/raw/ci-before.log', '--', process.execPath, 'benchmarks/audit.mjs', '--quick'], { env: { ...shared, LAZY_AUDIT_MODULE: join(baseline, 'dist/index.js'), LAZY_AUDIT_OUTPUT: 'audit/raw/ci-before.json' }, timeout: 70000 });
  await run(process.execPath, ['scripts/audit-runner.mjs', '--seconds=60', '--rss-mib=768', '--output=audit/raw/ci-after.log', '--', process.execPath, 'benchmarks/audit.mjs', '--quick'], { env: { ...shared, LAZY_AUDIT_MODULE: resolve('dist/index.js'), LAZY_AUDIT_OUTPUT: 'audit/raw/ci-after.json' }, timeout: 70000 });
  await run(process.execPath, ['scripts/audit-compare.mjs', 'audit/raw/ci-before.json', 'audit/raw/ci-after.json', '--gate'], { timeout: 5000, env: { ...process.env, LAZY_AUDIT_COMPARISON_OUTPUT: 'audit/raw/ci-performance-comparison.json' } });
} finally {
  clearTimeout(deadline); stop(); await rm(directory, { recursive: true, force: true });
  process.off('SIGINT', abort); process.off('SIGTERM', abort);
}
