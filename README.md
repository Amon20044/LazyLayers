# lazy-layers-cache

Simple TypeScript hybrid caching for Node.js with L1 memory, optional Redis L2, lazy loading, stampede protection, fail-open behavior, stale fallback, and distributed invalidation.

[![npm version](https://img.shields.io/npm/v/lazy-layers-cache.svg)](https://www.npmjs.com/package/lazy-layers-cache)
[![license](https://img.shields.io/npm/l/lazy-layers-cache.svg)](LICENSE)
[![types](https://img.shields.io/npm/types/lazy-layers-cache.svg)](https://www.npmjs.com/package/lazy-layers-cache)

`lazy-layers-cache` gives you a small Promise-based cache API that can start as an in-process LRU cache and grow into a multi-instance cache backed by Redis and invalidated over Redis Pub/Sub, RabbitMQ, or NATS.

It is designed around one practical production rule:

```txt
Requests warm only the instance they hit.
Shared L2 lets other instances reuse loaded data later.
Invalidation is broadcast to every connected cache instance.
```

## Features

- Simple async key-value cache API
- TypeScript declarations built in
- ESM and CommonJS builds
- L1 memory cache by default using `lru-cache`
- Optional Redis L2 store using `ioredis`
- Lazy loading with `getOrSet(key, loader)`
- In-process inflight dedupe for same-key concurrent loads
- Optional Redis-backed distributed lock for cross-instance stampede protection
- TTLs at global, layer, and per-call level
- Fail-open L2 and event-bus behavior
- Circuit breakers for L2 and invalidation publishing
- Stale fallback when loaders fail or time out
- Negative caching for short-lived known misses
- Wildcard pattern invalidation
- Redis Pub/Sub, RabbitMQ, NATS core, and NATS JetStream invalidation buses
- MessagePack serialization for Redis payloads
- Cache event hooks for metrics and logs
- Production-aware logging controls

## Table of Contents

- [Install](#install)
- [Usage](#usage)
- [Type-safe Usage](#type-safe-usage)
- [Layer Modes](#layer-modes)
- [Using Redis L2](#using-redis-l2)
- [Distributed Invalidation](#distributed-invalidation)
- [Resilience](#resilience)
- [Observability](#observability)
- [Pattern Deletes](#pattern-deletes)
- [API](#api)
- [Options](#options)
- [Runtime Notes](#runtime-notes)
- [Intelligent Serializer (HC1M / HC1G / HC1J)](#intelligent-serializer-hc1m--hc1g--hc1j)
- [Testing](#testing)
- [How to Contribute](#how-to-contribute)
- [License](#license)

## Install

```bash
npm install lazy-layers-cache
```

The package includes the clients it needs for its built-in integrations:

```txt
ioredis   - RedisStore and RedisEventBus
amqplib   - RabbitMQEventBus
nats      - NatsEventBus
lru-cache - MemoryStore
msgpackr  - Redis serialization
```

## Usage

Create a cache and use it like a small async key-value store.

```ts
import { LazyLayersCache } from "lazy-layers-cache";

const cache = new LazyLayersCache({
  ttlMs: 60_000,
});

await cache.set("user:1", { id: "1", name: "Amonk" });

const user = await cache.get("user:1");

await cache.delete("user:1");
```

Use `getOrSet()` for read-through caching.

```ts
import { LazyLayersCache } from "lazy-layers-cache";

const cache = new LazyLayersCache({
  ttlMs: 60_000,
  inflight: {
    enabled: true,
    ttlMs: 5_000,
    maxEntries: 1_000,
  },
});

const user = await cache.getOrSet("user:1", async ({ signal } = {}) => {
  return db.users.findById("1", { signal });
});
```

The first caller runs the loader. Concurrent callers for the same key reuse the same inflight promise.

## Type-safe Usage

You can bind one cache instance to one value shape.

```ts
import { LazyLayersCache, type LazyLayersCacheOptions } from "lazy-layers-cache";

interface User {
  id: string;
  name: string;
}

const options: LazyLayersCacheOptions<string, User> = {
  ttlMs: 60_000,
};

const users = new LazyLayersCache<string, User>(options);

await users.set("user:1", { id: "1", name: "Amonk" });

const user = await users.get("user:1");
// user is User | undefined
```

For mixed values, use `unknown`, a union type, or separate cache instances.

```ts
type CacheValue =
  | string
  | number
  | boolean
  | null
  | CacheValue[]
  | { [key: string]: CacheValue };

const cache = new LazyLayersCache<string, CacheValue>();
```

CommonJS works too.

```js
const { LazyLayersCache } = require("lazy-layers-cache");

const cache = new LazyLayersCache({ ttlMs: 60_000 });
```

Subpath imports are available when you want narrower imports.

```ts
import { RedisStore } from "lazy-layers-cache/cache";
import { RedisEventBus } from "lazy-layers-cache/event-bus";
```

## Layer Modes

By default, `LazyLayersCache` creates an L1 memory store and does not create an L2 store.

```ts
const cache = new LazyLayersCache();
```

Disable L2 explicitly when you want a local-only cache.

```ts
const cache = new LazyLayersCache({
  l2: false,
});
```

Use only an L2 store by disabling L1.

```ts
const cache = new LazyLayersCache({
  l1: false,
  l2: redisStore,
});
```

Use both layers for hot local reads plus shared Redis reads.

```ts
const cache = new LazyLayersCache({
  l2: redisStore,
  ttlMs: 60_000,
  levels: {
    L1: {
      ttlMs: 10_000,
      maxEntries: 1_000,
    },
    L2: {
      ttlMs: 300_000,
      maxEntries: 100_000,
    },
  },
});
```

## Using Redis L2

Pass an existing `ioredis` client to `RedisStore`.

```ts
import Redis from "ioredis";
import { LazyLayersCache, RedisStore } from "lazy-layers-cache";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

const l2 = new RedisStore(redis, {
  prefix: "app:cache:",
  ttlMs: 300_000,
  useIndex: true,
});

const cache = new LazyLayersCache({
  l2,
  ttlMs: 60_000,
  levels: {
    L1: {
      ttlMs: 10_000,
      maxEntries: 1_000,
    },
    L2: {
      ttlMs: 300_000,
      maxEntries: 100_000,
    },
  },
});
```

`RedisStore` stores values with MessagePack, reads with `getBuffer()`, supports indexed pattern invalidation, and defaults to `UNLINK` for deletes.

## Distributed Invalidation

When multiple application instances use their own L1 memory caches, connect them with an event bus. A delete in one process clears matching local entries in the others.

### Redis Pub/Sub

```ts
import Redis from "ioredis";
import { LazyLayersCache, RedisEventBus, RedisStore } from "lazy-layers-cache";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const l2 = new RedisStore(redis, { prefix: "app:cache:" });
const eventBus = new RedisEventBus(redis, "app:cache:invalidate");

await eventBus.connect();

const cache = new LazyLayersCache({
  l2,
  eventBus,
  source: process.env.INSTANCE_ID,
});
```

### RabbitMQ

```ts
import { LazyLayersCache, RabbitMQEventBus } from "lazy-layers-cache";

const eventBus = new RabbitMQEventBus("cache.invalidate", {
  url: process.env.RABBITMQ_URL ?? "amqp://localhost",
  durableInvalidationMode: true,
  queueName: process.env.INSTANCE_ID,
});

await eventBus.connect();

const cache = new LazyLayersCache({
  eventBus,
  source: process.env.INSTANCE_ID,
});
```

### NATS Core

```ts
import { LazyLayersCache, NatsEventBus } from "lazy-layers-cache";

const eventBus = new NatsEventBus({
  mode: "core",
  connectionOptions: {
    servers: process.env.NATS_URL ?? "nats://localhost:4222",
  },
  subject: "cache.invalidate",
});

await eventBus.connect();

const cache = new LazyLayersCache({
  eventBus,
  source: process.env.INSTANCE_ID,
});
```

### NATS JetStream

```ts
import { LazyLayersCache, NatsEventBus } from "lazy-layers-cache";

const eventBus = new NatsEventBus({
  mode: "jetstream",
  connectionOptions: {
    servers: process.env.NATS_URL ?? "nats://localhost:4222",
  },
  subject: "cache.invalidate",
  jetstream: {
    stream: "CACHE_INVALIDATIONS",
    durableName: process.env.INSTANCE_ID,
    ensureStream: true,
    ensureConsumer: true,
  },
});

await eventBus.connect();

const cache = new LazyLayersCache({
  eventBus,
  source: process.env.INSTANCE_ID,
});
```

## Resilience

`lazy-layers-cache` keeps the application path moving when Redis or an invalidation transport has trouble. L2 failures return safe fallbacks, event-bus publish failures are queued by the bus, and circuit breakers avoid repeatedly calling unhealthy dependencies.

```ts
const cache = new LazyLayersCache({
  l2,
  eventBus,
  failSafe: {
    enabled: true,
    staleTtlMs: 120_000,
  },
  negativeCache: {
    ttlMs: 5_000,
    maxEntries: 10_000,
  },
  timeouts: {
    softMs: 50,
    hardMs: 500,
  },
  distributedLock: {
    enabled: true,
    ttlMs: 10_000,
    waitTimeoutMs: 2_000,
    pollMs: 50,
  },
  resilience: {
    l2CircuitBreaker: {
      failureThreshold: 3,
      cooldownMs: 30_000,
    },
    eventBusCircuitBreaker: {
      failureThreshold: 3,
      cooldownMs: 30_000,
    },
  },
});
```

Resilience features are opt-in where they change behavior:

- `failSafe.enabled` returns stale values after loader errors or timeouts.
- `negativeCache.ttlMs` caches `undefined` loader results for a short period.
- `distributedLock.enabled` uses RedisStore lock methods when Redis L2 is present.
- `timeouts.softMs` can return stale data quickly when stale data exists.
- `timeouts.hardMs` aborts slow loaders with an `AbortSignal`.

## Observability

Use `cache.on()` to connect metrics, logs, or tracing.

```ts
const unsubscribe = cache.on((event) => {
  if (event.type === "hit") {
    metrics.increment("cache.hit", { level: event.level });
  }

  if (event.type === "loader:error") {
    logger.error({ key: event.key, error: event.error }, "cache loader failed");
  }
});

unsubscribe();
```

Common event types include:

- `hit`
- `miss`
- `set`
- `delete`
- `delete-pattern`
- `loader:start`
- `loader:success`
- `loader:error`
- `loader:timeout`
- `inflight:reuse`
- `stale:hit`
- `negative:set`
- `l2:error`
- `event-bus:publish-error`
- `invalidation:received`

## Pattern Deletes

Delete one key:

```ts
await cache.delete("user:1");
```

Delete by wildcard pattern:

```ts
await cache.deleteByPattern("user:*");
await cache.deleteByPattern("tenant:42:*");
await cache.clear();
```

Patterns support `*` and `?` matching. Pattern deletes also publish invalidation events when an event bus is configured.

## API

### `new LazyLayersCache([options])`

Returns a cache instance. This is the primary class.

```ts
import { LazyLayersCache } from "lazy-layers-cache";

const cache = new LazyLayersCache({
  ttlMs: 60_000,
});
```

### `createCache([options])`

Convenience helper that returns a `LazyLayersCache`.

```ts
import { createCache } from "lazy-layers-cache";

const cache = createCache({ ttlMs: 60_000 });
```

### Cache methods

| Method | Description |
| --- | --- |
| `set(key, value, options?)` | Store a value in active layers. |
| `get(key)` | Read from L1 first, then L2. L2 hits are promoted into L1. |
| `getOrSet(key, loader, options?)` | Read cached value or run a loader and store the result. |
| `has(key)` | Check whether a key exists. |
| `delete(key)` | Delete a key locally and publish invalidation when configured. |
| `deleteByPattern(pattern)` | Delete matching keys locally and publish pattern invalidation when configured. |
| `clear()` | Delete all keys using `deleteByPattern("*")`. |
| `size()` | Return the active store size. |
| `on(handler)` | Subscribe to cache events. Returns an unsubscribe function. |

### `new MemoryStore([options])`

In-memory LRU store used by L1.

```ts
import { MemoryStore } from "lazy-layers-cache";

const l1 = new MemoryStore({
  levels: {
    L1: {
      maxEntries: 2_000,
      ttlMs: 30_000,
    },
  },
});
```

### `new RedisStore(redis, [options])`

Redis-backed store used by L2.

```ts
import Redis from "ioredis";
import { RedisStore } from "lazy-layers-cache";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const store = new RedisStore(redis, {
  prefix: "app:cache:",
  ttlMs: 300_000,
});
```

`RedisStore` also exposes `acquireLock(key, token, ttlMs)` and `releaseLock(key, token)` for distributed stampede protection.

### Event buses

All built-in event buses implement the same interface.

```ts
interface EventBus {
  connect?(): Promise<void>;
  healthCheck?(): Promise<{ ok: boolean; transport: string; error?: unknown }>;
  publish(event: InvalidationEvent): Promise<void>;
  subscribe(handler: (event: InvalidationEvent) => void | Promise<void>): Promise<void>;
  disconnect?(): Promise<void>;
}
```

Built-in implementations:

| Class | Transport |
| --- | --- |
| `RedisEventBus` | Redis Pub/Sub |
| `RabbitMQEventBus` | RabbitMQ exchange and queue |
| `NatsEventBus` | NATS core or JetStream |

## Options

### Cache options

| Option | Type | Default |
| --- | --- | --- |
| `ttlMs` | `number` | `3_600_000` |
| `levels.L1.ttlMs` | `number` | `ttlMs` |
| `levels.L1.maxEntries` | `number` | `1_000` |
| `levels.L2.ttlMs` | `number` | `ttlMs` |
| `levels.L2.maxEntries` | `number` | unset |
| `inflight.enabled` | `boolean` | `true` |
| `inflight.ttlMs` | `number` | `5_000` |
| `inflight.maxEntries` | `number` | unset |
| `negativeCache.ttlMs` | `number` | unset |
| `negativeCache.maxEntries` | `number` | unset |
| `failSafe.enabled` | `boolean` | `false` |
| `failSafe.staleTtlMs` | `number` | unset |
| `timeouts.softMs` | `number` | unset |
| `timeouts.hardMs` | `number` | unset |
| `distributedLock.enabled` | `boolean` | `false` |
| `versioning.enabled` | `boolean` | `false` |

### LazyLayersCache options

| Option | Description |
| --- | --- |
| `l1` | Custom L1 store or `false` to disable L1. |
| `l2` | Custom L2 store or `false` to disable L2. |
| `eventBus` | Invalidation bus used by `delete()` and `deleteByPattern()`. |
| `source` | Instance identifier used to ignore self-published invalidations. |
| `subscribeToEvents` | Set `false` to publish invalidations without subscribing. |
| `events` | Initial cache event handlers. |
| `eventDedupeMaxEntries` | Max invalidation event IDs remembered for dedupe. |
| `eventDedupeTtlMs` | TTL for invalidation event dedupe. |
| `logging.env` | `development`, `production`, or `test`. |
| `logging.enabled` | Force package logs on or off. |

### RedisStore options

| Option | Default | Description |
| --- | --- | --- |
| `prefix` | `cache:` | Prefix for Redis keys. |
| `indexKey` | `${prefix}__index` | Sorted-set index used for pattern deletes and size. |
| `useIndex` | `true` | Use indexed pattern deletes instead of scanning keys directly. |
| `scanCount` | `1_000` | Count hint for Redis scan streams. |
| `batchSize` | `500` | Delete batch size. |
| `deleteStrategy` | `unlink` | Use `unlink` or `del`. |

### Event bus retry queue options

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Keep failed publishes in memory for a later flush. |
| `maxSize` | unset | Max events to keep after publish failures. Oldest events are dropped when full. |

## Runtime Notes

![Lazy Layers Architecture](LazyLayers.webp)

- L1 is local to the current process.
- Redis L2 is shared across processes.
- Event buses only carry invalidation events, not cached values.
- Loader results of `undefined` are not stored as normal cache values.
- Production logging is quiet by default when `NODE_ENV=production`.
- `versioning.enabled` writes generation-suffixed storage keys after deletes.
- Always use a stable `source` or `INSTANCE_ID` in multi-instance deployments.

## Intelligent Serializer (HC1M / HC1G / HC1J)

L2 values are written through an intelligent binary serializer. Each Redis payload
carries a fixed 4-byte magic prefix so decode is O(1):

| Prefix | Encoding | When used |
| --- | --- | --- |
| `HC1M` | msgpack | Default for any payload under 64 KB, or when gzip doesn't pay off. |
| `HC1G` | gzip(msgpack) | Payloads ≥ 64 KB **and** gzip saves at least 15% vs raw msgpack. |
| `HC1J` | JSON | Opt-in debug mode (`CACHE_FORMAT=json` or `CACHE_DEBUG_SERIALIZATION=true`). |

`null` and `undefined` are stored via a sentinel string (`__hybridcache_null__`) so
a cached "the value is null" is preserved as a real cache hit, not a miss.

Legacy values (pre-prefix raw msgpack buffers and JSON-as-bytes) still decode
correctly — the deserializer falls back through them in order.

### Programmatic API

```ts
import { serialize, deserialize, serializeWithStats } from 'lazy-layers-cache';

const buf = serialize({ id: 1 });               // Buffer with HC1M / HC1G / HC1J prefix
const value = deserialize(buf);                  // back to JS

const stats = serializeWithStats(largeObject);
// {
//   buffer, encoding: 'msgpack-gzip',
//   originalBytes, storedBytes, compressionRatio, compressed: true
// }
```

`RedisStore` calls `serialize` on write and `redis.getBuffer` + `deserialize` on
read automatically — you don't have to wire it in yourself.

## Testing

```bash
npm test            # node --test, runs ./test/*.test.js
npm run typecheck   # tsc --noEmit
npm run ci          # clean + typecheck + ESM/CJS build + tests
```

The suite covers:

- **Serializer** (`test/serializer.test.js`) — round-trips for plain objects, nested
  listing responses, `null`/`undefined`, strings, legacy JSON strings, legacy JSON
  buffers, legacy raw msgpack buffers; HC1M / HC1G / HC1J prefix decoding; gzip
  threshold math (`shouldGzip`, `getCompressionSavings`); JSON debug mode; corrupted
  buffer recovery; `Uint8Array` input.
- **MemoryStore / RedisStore / HybridCache** (`test/cache.test.js`,
  `test/edge-cases.test.js`) — L1/L2 layering, promotion, TTL, inflight dedupe,
  distributed locks, negative caching, fail-safe stale, circuit breakers,
  invalidation events, versioning, pattern deletes.

158 tests pass on the current branch (`npm test`).

### Size benchmark (1 MB mock listing)

`scripts/bench-serializer.mjs` generates a realistic ~1 MB player-listing response
(1500 entries, nested device / userSnapshot / infoCards / pagination) and serializes
it three ways:

```
| encoding       | bytes        | vs JSON | ms/op (n=25) |
|----------------|--------------|---------|--------------|
| JSON           | 1032.31 KB   | baseline|     3.191    |
| msgpack        |  805.50 KB   |   22.0% |     3.622    |
| msgpack + gzip |   67.57 KB   |   93.5% |     9.984    |
```

`serializeWithStats` picks `msgpack-gzip` for this payload — Redis stores 67.57 KB
instead of 1 MB, ~15× less network transfer per fetch at ~10 ms of one-time CPU on
the writer. Run it locally:

```bash
npm run build && node scripts/bench-serializer.mjs
```

### Edge cases hardened by the test suite

- Cached `null` returns `{ hit: true, value: null }`, not a miss — sentinel survives
  both the msgpack and JSON paths.
- Corrupted prefixed buffers (e.g. truncated gzip) return `null` instead of throwing.
- A plain string that fails `JSON.parse` round-trips through `deserialize` unchanged.
- `Uint8Array` input is normalized to `Buffer` before decode, so non-ioredis clients
  that return views still work.
- `hasPrefix` only inspects 4 bytes; a buffer shorter than 4 bytes is treated as
  legacy and routed to the fallback decoders.
- Large but **incompressible** payloads (random bytes) skip gzip and stay on `HC1M`
  rather than paying CPU for no savings.
- `CACHE_FORMAT=json` and `CACHE_DEBUG_SERIALIZATION=true` both flip the encoding to
  `HC1J` independently — env-var precedence is checked in the test suite.

## How to Contribute

```bash
npm install
npm test
npm run build
npm run ci
```

`npm run ci` cleans builds, type-checks, builds ESM and CommonJS output, and runs the test suite.

## License

MIT
