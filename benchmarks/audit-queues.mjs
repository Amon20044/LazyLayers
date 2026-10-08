#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const configured = process.env.LAZY_AUDIT_MODULE ?? new URL('../dist/index.js', import.meta.url).href;
const entry = configured.startsWith('file:') ? configured : pathToFileURL(configured).href;
const root = new URL('.', entry);
if (process.env.LAZY_QUEUE_CHILD) {
  const { EventBusHandlerQueue, EventBusRetryQueue } = await import(new URL('event-bus/index.js', root));
  const { encodeInvalidationEvent } = await import(new URL('event-bus/eventCodec.js', root));
  const n = Number(process.env.LAZY_QUEUE_CHILD);
  const event = { type: 'del', keys: ['tenant:user:1'], source: 'peer', ts: 1 };
  const wire = encodeInvalidationEvent(event);
  let finish;
  const barrier = new Promise((resolve) => { finish = resolve; });
  let deliveries = 0;
  const queue = new EventBusHandlerQueue(async () => { deliveries++; await barrier; }, { concurrency: 1, maxSize: 10000, maxBytes: 8 * 1024 * 1024, onError: (error) => { throw error; } });
  const cpuStart = process.cpuUsage(); const started = performance.now();
  for (let i = 0; i < n; i++) assert.equal(queue.enqueueEncoded(wire, () => event), true);
  const enqueueMs = performance.now() - started;
  const retainedBytes = queue.retainedBytes;
  const drainStarted = performance.now(); finish();
  while (queue.pendingCount || queue.activeCount) await new Promise((resolve) => setImmediate(resolve));
  const drainMs = performance.now() - drainStarted;
  assert.equal(deliveries, n); assert.equal(queue.retainedBytes, 0);
  const retry = new EventBusRetryQueue({ maxSize: 10000, maxBytes: 8 * 1024 * 1024 });
  const retryStarted = performance.now();
  for (let i = 0; i < n; i++) assert.equal(retry.enqueue(event), true);
  const retryEnqueueMs = performance.now() - retryStarted;
  let published = 0; const flushStarted = performance.now();
  await retry.flush(async () => { published++; });
  assert.equal(published, n); assert.equal(retry.retainedBytes, 0);
  const cpu = process.cpuUsage(cpuStart);
  console.log(JSON.stringify({ operations: n, wireBytes: wire.byteLength, enqueueMs, drainMs, retainedBytes, retryEnqueueMs, retryFlushMs: performance.now() - flushStarted, cpuMs: (cpu.user + cpu.system) / 1000, peakRssBytes: process.resourceUsage().maxRSS * 1024 }));
} else {
  const rows = [];
  for (const n of [32, 1024, 8192]) {
    const runs = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      const child = spawnSync(process.execPath, ['--max-old-space-size=128', new URL(import.meta.url).pathname], { env: { ...process.env, NODE_ENV: 'production', LAZY_QUEUE_CHILD: String(n) }, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
      assert.equal(child.status, 0, child.stderr || String(child.error));
      runs.push(JSON.parse(child.stdout));
    }
    rows.push({ n, runs });
  }
  const output = process.env.LAZY_AUDIT_OUTPUT ?? 'audit/raw/queues-current.json';
  await mkdir(new URL('../audit/raw', import.meta.url), { recursive: true });
  await writeFile(output, JSON.stringify({ metadata: { node: process.version, cpu: os.cpus()[0]?.model, os: `${os.type()} ${os.release()}`, module: entry, repetitions: 5, isolation: 'offline separate subprocess per run', limits: { childSeconds: 10, childHeapMiB: 128 } }, rows }, null, 2) + '\n');
  console.log(`Queue results: ${output}`);
}
