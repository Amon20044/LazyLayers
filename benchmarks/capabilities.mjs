#!/usr/bin/env node

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';

const {
  REDIS_CAPABILITY_COMMANDS,
  RedisCapabilityRegistry,
} = await import('../dist/cache/redisCapabilities.js');

const args = new Set(process.argv.slice(2));
const iterations = optionInteger('--iterations', 1_000, 1, 1_000_000);
const warmup = optionInteger('--warmup', 25, 0, 100_000);
const timeoutMs = optionInteger('--timeout-ms', 250, 1, 60_000);
const live = args.has('--live');

const client = live
  ? await connectLiveRedis()
  : makeLocalClient();

if (!client) process.exit(0);

const registry = new RedisCapabilityRegistry(client, { timeoutMs });
const eventLoop = monitorEventLoopDelay({ resolution: 10 });
const latencies = [];

try {
  for (let index = 0; index < warmup; index += 1) {
    registry.invalidate();
    await registry.get();
  }

  const before = memorySnapshot();
  eventLoop.enable();
  const started = performance.now();

  for (let index = 0; index < iterations; index += 1) {
    // Invalidating per sample measures bounded discovery itself. Remove this
    // line to measure the cached registry.get() path instead.
    registry.invalidate();
    const sampleStarted = performance.now();
    await registry.get();
    latencies.push(performance.now() - sampleStarted);
  }

  const elapsedMs = performance.now() - started;
  eventLoop.disable();
  const after = memorySnapshot();

  console.log(JSON.stringify({
    benchmark: 'redis-capabilities',
    mode: live ? 'live-redis' : 'local-compatible-client',
    iterations,
    warmup,
    elapsedMs: round(elapsedMs),
    operationsPerSecond: round(iterations / Math.max(elapsedMs / 1_000, Number.EPSILON)),
    capabilityCount: REDIS_CAPABILITY_COMMANDS.length,
    bounded: true,
    latencyMs: percentileSummary(latencies),
    eventLoopLagMs: eventLoopSummary(eventLoop),
    memoryBytes: {
      heapUsedBefore: before.heapUsed,
      heapUsedAfter: after.heapUsed,
      heapUsedDelta: after.heapUsed - before.heapUsed,
      rssBefore: before.rss,
      rssAfter: after.rss,
      rssDelta: after.rss - before.rss,
      externalBefore: before.external,
      externalAfter: after.external,
    },
  }));
} finally {
  registry.close();
  if (typeof client.quit === 'function') {
    await client.quit().catch(() => client.disconnect?.());
  }
}

function makeLocalClient() {
  const client = new EventEmitter();
  client.info = async () => '# Server\r\nredis_version:7.2.4\r\n';
  client.command = async (...commandArgs) => commandArgs.slice(1).map((name) => [name, 1, [], 1, 1, 1]);
  return client;
}

async function connectLiveRedis() {
  if (!process.env.REDIS_URL) {
    console.log(JSON.stringify({
      benchmark: 'redis-capabilities',
      skipped: true,
      reason: 'REDIS_URL is not set; rerun with REDIS_URL and --live for a live Redis sample',
    }));
    return undefined;
  }

  try {
    const { default: Redis } = await import('ioredis');
    const client = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 2_000,
    });
    await client.connect();
    return client;
  } catch (error) {
    console.log(JSON.stringify({
      benchmark: 'redis-capabilities',
      skipped: true,
      reason: 'Unable to connect to REDIS_URL',
      errorCode: safeErrorCode(error),
    }));
    return undefined;
  }
}

function optionInteger(name, fallback, min, max) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  return Number.isSafeInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function percentileSummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: round(percentile(sorted, 0.50)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    'p99.9': round(percentile(sorted, 0.999)),
    min: round(sorted[0] ?? 0),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function eventLoopSummary(histogram) {
  const nsToMs = (value) => Number.isFinite(value) ? value / 1e6 : 0;
  return {
    p50: round(nsToMs(histogram.percentile(50))),
    p95: round(nsToMs(histogram.percentile(95))),
    p99: round(nsToMs(histogram.percentile(99))),
    'p99.9': round(nsToMs(histogram.percentile(99.9))),
    max: round(nsToMs(histogram.max)),
    mean: round(nsToMs(histogram.mean)),
  };
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    heapUsed: memory.heapUsed,
    rss: memory.rss,
    external: memory.external,
  };
}

function safeErrorCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}

function round(value) {
  return Number(Number(value || 0).toFixed(4));
}
