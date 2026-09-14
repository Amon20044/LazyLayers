#!/usr/bin/env node

/**
 * Compare the current opaque HC1 string representation with V8 JSON and a
 * top-level Redis HASH-shaped payload. The local run measures codec CPU and
 * payload bytes. `--live` additionally writes a short-lived namespace to a
 * controlled Redis instance and reports MEMORY USAGE for the native layouts.
 *
 * This is an experiment, not a production default selector. Redis object
 * headers, allocator fragmentation, modules, replication, and schema shape
 * all affect the live result.
 */
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';

const { serialize, deserialize } = await import('../dist/utils/serializer.js');
const { FIXTURES } = await import('./fixtures.mjs');

const iterations = positiveInteger(process.env.LAZY_REP_ITERATIONS, 2_000);
const warmup = positiveInteger(process.env.LAZY_REP_WARMUP, 25);
const live = process.argv.includes('--live');

const representations = [
  {
    name: 'hc1-string',
    encode: (value) => serialize(value),
    decode: (encoded) => deserialize(encoded),
    wireBytes: (encoded) => encoded.byteLength,
  },
  {
    name: 'json-string',
    encode: (value) => Buffer.from(JSON.stringify(value), 'utf8'),
    decode: (encoded) => JSON.parse(Buffer.from(encoded).toString('utf8')),
    wireBytes: (encoded) => encoded.byteLength,
  },
  {
    name: 'top-level-hash',
    encode: encodeHash,
    decode: decodeHash,
    wireBytes: (encoded) => encoded.reduce(
      (total, [field, value]) => total + Buffer.byteLength(field) + Buffer.byteLength(value),
      0,
    ),
  },
];

const values = new Map();
const rows = [];

for (const fixture of FIXTURES) {
  const value = fixture.build();
  values.set(fixture.name, value);
  for (const representation of representations) {
    const encoded = representation.encode(value);
    const roundTrip = representation.decode(encoded);
    const sourceBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    const wireBytes = representation.wireBytes(encoded);
    const encodeSamples = measure(representation.encode, value, iterations, warmup);
    const decodeSamples = measure(representation.decode, encoded, iterations, warmup);

    rows.push({
      fixture: fixture.name,
      representation: representation.name,
      roundTrip: JSON.stringify(roundTrip) === JSON.stringify(value),
      sourceBytes,
      wireBytes,
      encodeMs: encodeSamples,
      decodeMs: decodeSamples,
      liveMemoryBytes: undefined,
    });
  }
}

if (live) {
  const redis = await connectRedis();
  if (redis) {
    try {
      await measureLive(redis, rows);
    } finally {
      redis.disconnect();
    }
  }
}

console.log(JSON.stringify({
  benchmark: 'representations',
  node: process.version,
  v8: process.versions.v8,
  iterations,
  warmup,
  live,
  rows,
  note: 'Local bytes exclude Redis object headers and allocator overhead. Native Redis JSON is reported only when the JSON module is installed. No representation is enabled by this benchmark.',
}, null, 2));
if (rows.some((row) => !row.roundTrip)) process.exitCode = 1;

function encodeHash(value) {
  const fields = [];
  if (Array.isArray(value)) {
    fields.push(['__root', 'array']);
    value.forEach((item, index) => fields.push([String(index), JSON.stringify(item)]));
  } else if (value !== null && typeof value === 'object') {
    fields.push(['__root', 'object']);
    for (const [field, item] of Object.entries(value)) fields.push([field, JSON.stringify(item)]);
  } else {
    fields.push(['__root', 'scalar'], ['__value', JSON.stringify(value)]);
  }
  return fields;
}

function decodeHash(fields) {
  const map = new Map(fields);
  const root = map.get('__root');
  if (root === 'array') {
    return [...map.entries()]
      .filter(([field]) => field !== '__root')
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, value]) => JSON.parse(value));
  }
  if (root === 'object') {
    return Object.fromEntries([...map.entries()]
      .filter(([field]) => field !== '__root')
      .map(([field, value]) => [field, JSON.parse(value)]));
  }
  return JSON.parse(map.get('__value'));
}

function measure(encodeOrDecode, input, count, warmupCount) {
  for (let index = 0; index < warmupCount; index += 1) encodeOrDecode(input);
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    encodeOrDecode(input);
    samples.push(performance.now() - started);
  }
  return {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    max: percentile(samples, 1),
  };
}

async function connectRedis() {
  if (!process.env.REDIS_URL) {
    console.error(JSON.stringify({ skippedLive: true, reason: 'REDIS_URL is not set' }));
    return undefined;
  }
  let client;
  try {
    const { default: Redis } = await import('ioredis');
    client = new Redis(process.env.REDIS_URL, {
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
    return client;
  } catch (error) {
    client?.disconnect();
    process.exitCode = 1;
    console.error(JSON.stringify({ skippedLive: true, reason: 'Redis connection failed', code: safeCode(error) }));
    return undefined;
  }
}

async function measureLive(redis, rowsToMeasure) {
  const prefix = `lazy-layers-rep-${randomUUID()}:`;
  let jsonAvailable = false;
  try {
    const commandInfo = await redis.call('COMMAND', 'INFO', 'JSON.SET');
    jsonAvailable = Array.isArray(commandInfo) && Array.isArray(commandInfo[0]);
  } catch {
    // Redis ACLs or an uninstalled RedisJSON module make this representation
    // unavailable. The other rows remain useful and are still cleaned up.
  }

  const cleanup = [];
  try {
    for (const row of rowsToMeasure) {
      const value = values.get(row.fixture);
      if (value === undefined) continue;
      const key = `${prefix}${row.representation}:${row.fixture}`;
      cleanup.push(key);
      if (row.representation === 'top-level-hash') {
        const fields = encodeHash(value).flat();
        await redis.hset(key, ...fields);
        await redis.pexpire(key, 60_000);
        row.roundTrip = isDeepStrictEqual(decodeHash(Object.entries(await redis.hgetall(key))), value);
      } else {
        const payload = row.representation === 'hc1-string'
          ? serialize(value)
          : Buffer.from(JSON.stringify(value), 'utf8');
        await redis.set(key, payload, 'PX', 60_000);
        const stored = await redis.getBuffer(key);
        row.roundTrip = isDeepStrictEqual(row.representation === 'hc1-string'
          ? deserialize(stored) : JSON.parse(stored.toString('utf8')), value);
      }
      row.liveMemoryBytes = await redis.memory('USAGE', key);
    }

    if (jsonAvailable) {
      for (const fixture of FIXTURES) {
        const value = values.get(fixture.name);
        const key = `${prefix}redis-json:${fixture.name}`;
        cleanup.push(key);
        await redis.call('JSON.SET', key, '$', JSON.stringify(value));
        await redis.pexpire(key, 60_000);
        const readback = JSON.parse(await redis.call('JSON.GET', key));
        rows.push({
          fixture: fixture.name,
          representation: 'redis-json',
          roundTrip: isDeepStrictEqual(readback, value),
          sourceBytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
          wireBytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
          encodeMs: undefined,
          decodeMs: undefined,
          liveMemoryBytes: await redis.memory('USAGE', key),
        });
      }
    }
  } finally {
    if (cleanup.length > 0) await redis.del(...cleanup);
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return Number(sorted[Math.max(0, index)].toFixed(4));
}

function positiveInteger(raw, fallback) {
  const value = raw === undefined ? fallback : Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function safeCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}
