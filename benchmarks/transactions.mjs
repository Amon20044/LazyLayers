import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

const tx = await import('../dist/transactions/index.js');

const iterations = positiveInteger(process.env.LAZY_TX_ITERATIONS, 10_000);
const concurrency = positiveInteger(process.env.LAZY_TX_CONCURRENCY, 64);
const mode = process.env.REDIS_URL ? 'redis' : 'local';

function positiveInteger(raw, fallback) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return value;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Number(sorted[index].toFixed(3));
}

class LocalTransport {
  namespace = 'benchmark';
  records = new Map();
  closed = false;

  canDispatch() { return !this.closed; }

  async execute(key, args) {
    const [command, fingerprint, durableId, owner, leaseText, retentionText, resultRef] = args;
    const now = Date.now();
    const leaseMs = Number(leaseText);
    const retentionMs = Number(retentionText);
    let record = this.records.get(key);
    if (record && record.retainUntil <= now) {
      this.records.delete(key);
      record = undefined;
    }
    if (record && (record.fingerprint !== fingerprint || record.durableId !== durableId)) return ['conflict'];
    if (command === 'read') {
      if (!record) return ['missing'];
      if (record.state === 'completed') return ['completed', record.resultRef];
      const remaining = Math.max(0, record.leaseUntil - now);
      return remaining === 0 ? ['recovery_required'] : ['in_progress', String(remaining)];
    }
    if (record?.state === 'completed') {
      if (command === 'renew') return ['lost'];
      if (command === 'complete' && record.resultRef !== resultRef) return ['conflict'];
      return ['completed', record.resultRef];
    }
    if (command === 'begin') {
      if (record && record.leaseUntil > now) return ['in_progress', String(record.leaseUntil - now)];
      record = {
        fingerprint, durableId, owner, state: 'pending', leaseUntil: now + leaseMs,
        retainUntil: Math.max(record?.retainUntil ?? 0, now + retentionMs), resultRef: '',
      };
      this.records.set(key, record);
      return ['acquired', owner, String(leaseMs), 'reconcile'];
    }
    if (!record || record.owner !== owner || record.leaseUntil <= now) return ['lost'];
    if (command === 'renew') {
      record.leaseUntil = now + leaseMs;
      record.retainUntil = Math.max(record.retainUntil, now + retentionMs);
      return ['renewed', String(leaseMs)];
    }
    record.state = 'completed';
    record.resultRef = resultRef;
    record.leaseUntil = 0;
    record.retainUntil = Math.max(record.retainUntil, now + retentionMs);
    return ['completed', resultRef];
  }

  close() { this.closed = true; }
}

async function makeStore() {
  if (!process.env.REDIS_URL) {
    return { store: new tx.RedisOperationStore(new LocalTransport(), {
      namespace: 'benchmark', leaseMs: 5_000, retentionMs: 60_000,
      operationTimeoutMs: 2_000, maxConcurrent: concurrency, maxQueued: concurrency * 2,
    }), close: async () => {} };
  }
  const { default: Redis } = await import('ioredis');
  const client = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    commandTimeout: 2_000,
    connectTimeout: 2_000,
    retryStrategy: () => null,
  });
  if (client.status !== 'ready') {
    await new Promise((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const cleanup = () => {
        client.off('ready', onReady);
        client.off('error', onError);
      };
      client.once('ready', onReady);
      client.once('error', onError);
    });
  }
  const transport = new tx.RedisOperationTransport(client, {
    namespace: `benchmark-${randomUUID()}`,
    authorityId: 'benchmark-primary',
  });
  const store = new tx.RedisOperationStore(transport, {
    leaseMs: 5_000, retentionMs: 60_000, operationTimeoutMs: 2_000,
    maxConcurrent: concurrency, maxQueued: concurrency * 2,
  });
  return { store, close: async () => { await store.close(); client.disconnect(); } };
}

const { store, close } = await makeStore();
const eventLoop = monitorEventLoopDelay({ resolution: 10 });
eventLoop.enable();
const latencies = [];
let completed = 0;
let errors = 0;
let cursor = 0;
const startedAt = performance.now();

async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= iterations) return;
    const identity = {
      tenant: 'benchmark', operation: 'reserve', idempotencyKey: `request-${index}`,
      fingerprint: 'a'.repeat(64), durableId: `operation-${index}`,
    };
    const started = performance.now();
    try {
      const began = await store.begin(identity);
      if (began.kind === 'acquired') {
        const result = await store.complete(began.lease, `result:${index}`);
        if (result.kind !== 'completed') throw new Error(`unexpected completion: ${result.kind}`);
      } else if (began.kind !== 'completed') {
        throw new Error(`unexpected begin: ${began.kind}`);
      }
      completed += 1;
      latencies.push(performance.now() - started);
    } catch {
      errors += 1;
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, iterations) }, worker));
const elapsedMs = performance.now() - startedAt;
eventLoop.disable();
await close();

const memory = process.memoryUsage();
const output = {
  benchmark: 'transactions',
  mode,
  iterations,
  concurrency,
  completed,
  errors,
  throughputPerSecond: Number((completed / (elapsedMs / 1_000)).toFixed(2)),
  elapsedMs: Number(elapsedMs.toFixed(3)),
  latencyMs: {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    p999: percentile(latencies, 0.999),
  },
  eventLoopDelayMs: {
    p99: Number((eventLoop.percentile(99) / 1e6).toFixed(3)),
    max: Number((eventLoop.max / 1e6).toFixed(3)),
  },
  memoryBytes: {
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    rss: memory.rss,
  },
  note: 'Results are workload-, runtime-, Redis-, and network-specific. A completed coordination command is not a payment exactly-once guarantee.',
};

console.log(JSON.stringify(output, null, 2));
if (errors > 0 || completed !== iterations) process.exitCode = 1;
