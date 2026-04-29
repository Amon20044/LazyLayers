# lazy-layers-cache

A focused TypeScript hybrid cache for Node.js with L1 memory cache, optional Redis L2, lazy loading, stampede protection, fail-open safety, stale fallback, negative caching, and distributed invalidation over Redis Pub/Sub, RabbitMQ, or NATS JetStream.

This package is built around one production-friendly idea:

```txt
Requests warm only the instance they hit.
Shared L2 lets other instances reuse loaded data later.
Invalidation is global across connected cache instances.
```

> **Note: where this can be better than BentoCache**
>
> BentoCache is a mature, broad caching framework. `lazy-layers-cache` is better when you want a smaller Node.js/TypeScript package focused specifically on L1 memory + Redis L2, lazy loading, fail-open behavior, circuit breakers, distributed stampede protection, and explicit invalidation buses across Redis Pub/Sub, RabbitMQ, and NATS JetStream. Its Redis path is intentionally optimized with MessagePack binary serialization, Redis `getBuffer`, indexed pattern invalidation, batched pipelines, and `UNLINK` deletes. That can be faster for this narrow Redis-heavy use case, but real-world speed still depends on your payloads, hit rates, Redis latency, and benchmark setup.

## Contents

- [What Is Included](#what-is-included)
- [Install](#install)
- [JavaScript And TypeScript Usage](#javascript-and-typescript-usage)
- [Quick Start](#quick-start)
- [Which API Should I Use?](#which-api-should-i-use)
- [Shared Config And Multiple Caches](#shared-config-and-multiple-caches)
- [Production Startup Flow](#production-startup-flow)
- [Logging And Environments](#logging-and-environments)
- [Cache Options](#cache-options)
- [Redis L2 Store](#redis-l2-store)
- [Event Bus Guide](#event-bus-guide)
- [Redis Event Bus](#redis-event-bus)
- [RabbitMQ Event Bus](#rabbitmq-event-bus)
- [NATS Event Bus](#nats-event-bus)
- [Which Event Bus Should I Use?](#which-event-bus-should-i-use)
- [Observability Events](#observability-events)
- [Resilience Features](#resilience-features)
- [API Reference](#api-reference)
- [Comparison Guide](#comparison-guide)
- [Production Notes](#production-notes)
- [Scripts](#scripts)

## What Is Included

| Area | Included |
| --- | --- |
| L1 cache | Default in-memory LRU via `lru-cache`; disable with `l1: false` |
| L2 cache | Optional Redis store via `ioredis`; disable explicitly with `l2: false` |
| Lazy loading | `getOrSet(key, loader)` |
| Local stampede protection | In-process inflight promise dedupe |
| Distributed stampede protection | Optional Redis-backed lock through `RedisStore` |
| Fail-open safety | L2 and event-bus failures do not break local cache operations |
| Circuit breakers | L2 circuit breaker and event-bus publish circuit breaker |
| Negative caching | Short-lived caching of known misses |
| Stale fallback | Fail-safe stale value reuse when loaders fail or time out |
| Timeouts | Soft and hard loader timeout support |
| Versioned keys | Optional generational key writes after invalidation |
| Invalidation | Delete and wildcard-pattern invalidation |
| Event buses | Redis Pub/Sub, RabbitMQ, NATS core, NATS JetStream |
| Durable invalidation | RabbitMQ durable queues or NATS JetStream durable consumers |
| Serialization | MessagePack via `msgpackr` |
| Observability | Hookable cache events |
| Startup checks | `connect()` and `healthCheck()` on event buses |
| Logging control | Environment-aware logging, quiet in production by default |

## Install

```bash
npm install lazy-layers-cache
```

Optional transports:

```bash
npm install ioredis
npm install amqplib
npm install nats
```

## JavaScript And TypeScript Usage

This package publishes both ESM and CommonJS JavaScript builds, plus TypeScript declarations.

### TypeScript

```ts
import { LazyLayersCache, type LazyLayersCacheOptions } from "lazy-layers-cache";

interface User {
  id: string;
  name: string;
}

const options: LazyLayersCacheOptions<string, User> = {
  ttlMs: 60_000,
};

const cache = new LazyLayersCache<string, User>(options);
```

### JavaScript ESM

```js
import { LazyLayersCache } from "lazy-layers-cache";

const cache = new LazyLayersCache({
  ttlMs: 60_000,
});
```

### JavaScript CommonJS

```js
const { LazyLayersCache } = require("lazy-layers-cache");

const cache = new LazyLayersCache({
  ttlMs: 60_000,
});
```

Subpath imports also work in both module systems:

```ts
import { RedisEventBus } from "lazy-layers-cache/event-bus";
import { RedisStore } from "lazy-layers-cache/cache";
```

```js
const { RedisEventBus } = require("lazy-layers-cache/event-bus");
const { RedisStore } = require("lazy-layers-cache/cache");
```

## Quick Start

```ts
import { LazyLayersCache } from "lazy-layers-cache";

interface User {
  id: string;
  name: string;
}

const cache = new LazyLayersCache<string, User>({
  // L1 is created by default. This makes Redis/L2 intentionally off.
  l2: false,

  // Controls package logs. Production is quiet by default.
  logging: {
    env: "development",
  },

  // Default TTL for writes unless a level or per-call option overrides it.
  ttlMs: 60_000,

  levels: {
    L1: {
      // Max entries in memory for this process.
      maxEntries: 1_000,
      // L1-specific TTL. Fast local freshness.
      ttlMs: 10_000,
    },
  },

  inflight: {
    // Reuses the same promise for concurrent same-key getOrSet calls.
    enabled: true,
    ttlMs: 5_000,
    maxEntries: 1_000,
  },
});

await cache.set("user:1", { id: "1", name: "Amonk" });

const user = await cache.getOrSet("user:1", async () => {
  return db.users.findById("1");
});
```

`new LazyLayersCache<string, User>()` is optional TypeScript safety, not a runtime requirement.

Passing `User` is a good pattern when the cache instance is domain-specific, for example `userCache`. Do not force `User` onto a shared cache that stores multiple shapes; use a union, `JsonValue`, or create separate cache instances per domain.

```ts
// string keys, User values. Best when one cache stores one value shape.
const users = new LazyLayersCache<string, User>();

// string keys, any JSON-like value. Better for mixed value shapes.
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const jsonCache = new LazyLayersCache<string, JsonValue>();
```

In plain JavaScript, there are no generic types:

```js
import { LazyLayersCache } from "lazy-layers-cache";

const cache = new LazyLayersCache({ ttlMs: 60_000 });

await cache.set("user:1", { id: "1", name: "Amonk" });
await cache.set("count", 42);
```

## Which API Should I Use?

`LazyLayersCache` is the primary production class. It creates L1 memory by default, accepts `l1: false` when you want no LRU allocation, and accepts `l2: false` or a real L2 store when Redis is optional.

`HybridCache` remains available as a compatibility name, and `createCache()` remains a convenience shortcut.

Under the hood, this:

```ts
const cache = createCache(options);
```

is just a shortcut for:

```ts
const cache = new LazyLayersCache(options);
```

Use this rule:

| You want | Use |
| --- | --- |
| Simple L1 memory cache | `new LazyLayersCache()` |
| L1 memory cache with lazy loading | `new LazyLayersCache()` |
| L1 memory + custom config | `new LazyLayersCache()` |
| L1 memory + Redis L2 | `new LazyLayersCache()` |
| L2 only, no in-process LRU | `new LazyLayersCache({ l1: false, l2 })` |
| L1 + L2 + Redis/RabbitMQ/NATS event bus | `new LazyLayersCache()` |
| Backward-compatible class name | `new HybridCache()` |
| Legacy convenience helper | `createCache()` |

### Simple L1 Only

```ts
import { LazyLayersCache } from "lazy-layers-cache";

export const cache = new LazyLayersCache({
  l2: false,
  ttlMs: 60_000,
});
```

### L1 + Redis L2 + NATS JetStream

Use this when you want:

```txt
L1 memory per instance
shared Redis L2
durable NATS JetStream invalidation
```

```ts
import Redis from "ioredis";
import {
  LazyLayersCache,
  NatsEventBus,
  RedisStore,
} from "lazy-layers-cache";

interface User {
  id: string;
  name: string;
}

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : undefined;

const eventBus = new NatsEventBus({
  mode: "jetstream",
  connectionOptions: {
    servers: process.env.NATS_URL,
    name: process.env.INSTANCE_ID,
  },
  subject: "cache.invalidations",
  jetstream: {
    stream: "CACHE_INVALIDATIONS",
    durableName: `${process.env.INSTANCE_ID}-cache-invalidations`,
    ensureStream: true,
    ensureConsumer: true,
    storage: "file",
  },
  logging: {
    env: "production",
  },
});

const health = await eventBus.healthCheck();

if (!health.ok) {
  throw health.error;
}

export const userCache = new LazyLayersCache<string, User>({
  // L1 memory cache is created by default.
  // Set l1: false if this process should not keep local LRU memory.

  // L2 shared cache.
  l2: new RedisStore<User>(redis, {
    prefix: "users:",
    useIndex: true,
  }),

  // Global invalidation bus.
  eventBus,

  // Unique instance identity. Used to ignore invalidation messages from itself.
  source: process.env.INSTANCE_ID,

  ttlMs: 60_000,

  levels: {
    L1: {
      maxEntries: 1_000,
      ttlMs: 10_000,
    },
    L2: {
      ttlMs: 60_000,
    },
  },

  inflight: {
    enabled: true,
    ttlMs: 5_000,
    maxEntries: 1_000,
  },

  // Cross-instance stampede protection using RedisStore lock support.
  distributedLock: {
    enabled: true,
    ttlMs: 10_000,
    waitTimeoutMs: 2_000,
    pollMs: 50,
  },

  logging: {
    env: "production",
  },
});
```

## Shared Config And Multiple Caches

Create cache configuration once, then reuse it when creating domain-specific caches.

```ts
import { LazyLayersCache, type LazyLayersCacheOptions } from "lazy-layers-cache";

interface User {
  id: string;
  name: string;
}

interface Tournament {
  id: string;
  title: string;
}

const sharedCacheConfig = {
  ttlMs: 60_000,
  logging: {
    env: process.env.NODE_ENV === "production" ? "production" : "development",
  },
  levels: {
    L1: {
      maxEntries: 1_000,
      ttlMs: 10_000,
    },
  },
  inflight: {
    enabled: true,
    ttlMs: 5_000,
    maxEntries: 1_000,
  },
} satisfies LazyLayersCacheOptions;

export const userCache = new LazyLayersCache<string, User>(sharedCacheConfig);
export const tournamentCache = new LazyLayersCache<string, Tournament>(sharedCacheConfig);
```

Use those cache instances everywhere. Do not recreate them per request.

```ts
const user = await userCache.getOrSet(`user:${id}`, () => loadUser(id));

const tournament = await tournamentCache.getOrSet(
  `tournament:${id}`,
  () => loadTournament(id),
);
```

With Redis L2, reuse the same base config but give each domain its own Redis prefix.

```ts
import Redis from "ioredis";
import { LazyLayersCache, RedisStore } from "lazy-layers-cache";

const redis = new Redis(process.env.REDIS_URL);

export const userCache = new LazyLayersCache<string, User>({
  ...sharedCacheConfig,
  l2: new RedisStore<User>(redis, {
    prefix: "users:",
  }),
});

export const tournamentCache = new LazyLayersCache<string, Tournament>({
  ...sharedCacheConfig,
  l2: new RedisStore<Tournament>(redis, {
    prefix: "tournaments:",
  }),
});
```

## Production Startup Flow

In production, initialize external dependencies before starting your HTTP server.

```ts
import Redis from "ioredis";
import {
  LazyLayersCache,
  NatsEventBus,
  RedisStore,
} from "lazy-layers-cache";

const redis = new Redis(process.env.REDIS_URL);

const eventBus = new NatsEventBus({
  mode: "jetstream",
  connectionOptions: {
    servers: process.env.NATS_URL,
    name: process.env.INSTANCE_ID,
  },
  subject: "cache.invalidations",
  jetstream: {
    stream: "CACHE_INVALIDATIONS",
    durableName: `${process.env.INSTANCE_ID}-cache-invalidations`,
    ensureStream: true,
    ensureConsumer: true,
  },
  logging: {
    env: "production",
  },
});

const eventBusHealth = await eventBus.healthCheck();

if (!eventBusHealth.ok) {
  throw eventBusHealth.error;
}

const cache = new LazyLayersCache<string, User>({
  l1: process.env.CACHE_L1 === "false" ? false : undefined,
  l2: process.env.CACHE_L2 === "false" || !redis
    ? false
    : new RedisStore<User>(redis, {
        prefix: "users:",
        useIndex: true,
      }),
  eventBus,
  source: process.env.INSTANCE_ID,
  logging: {
    env: "production",
  },
});

// Start your API server only after health checks pass.
server.listen(3000);
```

## Logging And Environments

Logs are controlled with `logging`.

```ts
const cache = new LazyLayersCache({
  logging: {
    // "production" disables logs unless enabled is true.
    // "development" and "test" enable logs unless enabled is false.
    env: process.env.NODE_ENV === "production" ? "production" : "development",

    // Optional hard override.
    // enabled: false,
  },
});
```

Use this on caches and event buses:

```ts
new RedisEventBus(redis, "cache:invalidations", {
  logging: { env: "production" },
});

new RabbitMQEventBus("cache.invalidations", {
  url: process.env.RABBITMQ_URL,
  logging: { env: "production" },
});

new NatsEventBus({
  connectionOptions: { servers: process.env.NATS_URL },
  logging: { env: "production" },
});
```

## Cache Options

```ts
const cache = new LazyLayersCache<string, User>({
  // Default: create in-process MemoryStore/LRU.
  // Use false to disable local memory allocation for this process.
  l1: undefined,

  // Default: no remote cache.
  // Use false to make that explicit, or pass RedisStore/custom CacheStore.
  l2: false,

  logging: {
    // Controls package logs.
    env: "development",
  },

  ttlMs: 60_000,

  levels: {
    L1: {
      // Number of entries kept in memory per process.
      maxEntries: 1_000,
      // Local memory TTL.
      ttlMs: 10_000,
    },
    L2: {
      // Used by RedisStore index trimming when enabled.
      maxEntries: 100_000,
      // Shared Redis TTL.
      ttlMs: 60_000,
    },
  },

  inflight: {
    // Prevents same-process stampedes.
    enabled: true,
    ttlMs: 5_000,
    maxEntries: 1_000,
  },

  distributedLock: {
    // Requires an L2 store that supports locks, such as RedisStore.
    enabled: true,
    ttlMs: 10_000,
    waitTimeoutMs: 2_000,
    pollMs: 50,
  },

  negativeCache: {
    // Caches loader misses for a short period.
    ttlMs: 5_000,
    maxEntries: 10_000,
  },

  failSafe: {
    // Reuses stale values if loaders fail or time out.
    enabled: true,
    staleTtlMs: 5 * 60_000,
  },

  timeouts: {
    // If stale exists, return it after this.
    softMs: 100,
    // Abort waiting after this.
    hardMs: 2_000,
  },

  versioning: {
    // Writes generation-suffixed storage keys after deletes.
    enabled: true,
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

  eventBus,
  source: process.env.INSTANCE_ID,
  subscribeToEvents: true,
  eventDedupeMaxEntries: 10_000,
  eventDedupeTtlMs: 5 * 60_000,
  events: [
    (event) => {
      metrics.increment(`cache.${event.type}`);
    },
  ],
});
```

Layer rules:

- Omit `l1` to create the default in-process LRU.
- Pass `l1: false` when this server process should not allocate L1 memory. On a real server restart, any old LRU data is already gone with the old process; the new cache instance will not recreate it.
- Omit `l2` or pass `l2: false` when Redis/L2 is intentionally off.
- Pass `l2: new RedisStore(redis, options)` for shared Redis L2. Runtime L2 errors fail open, so local cache and loaders can continue.

## Redis L2 Store

```ts
import Redis from "ioredis";
import { LazyLayersCache, RedisStore } from "lazy-layers-cache";

const redis = new Redis(process.env.REDIS_URL);

const cache = new LazyLayersCache<string, User>({
  l2: new RedisStore<User>(redis, {
    // Prefix all Redis keys owned by this cache.
    prefix: "users:",

    // Maintains a sorted-set index so pattern deletes scan cache keys only.
    useIndex: true,

    // Redis scan batch size.
    scanCount: 1_000,

    // Delete pipeline batch size.
    batchSize: 500,

    // "unlink" frees memory asynchronously. Use "del" only if you need sync delete.
    deleteStrategy: "unlink",
  }),
});
```

Redis store production choices:

- MessagePack values through `msgpackr`
- Binary reads via `getBuffer`
- Millisecond TTL via `PX`
- Sorted-set index for bounded pattern invalidation
- Batched deletes through Redis pipelines
- `UNLINK` by default
- Optional distributed lock support for `getOrSet`

### Why The Redis Path Is Fast

The Redis store is built for the common high-throughput L1/L2 path:

| Choice | Why it helps |
| --- | --- |
| MessagePack serialization | Keeps values binary and compact compared with plain JSON for many object shapes |
| `getBuffer` reads | Avoids unnecessary UTF-8 string conversion for binary payloads |
| Sorted-set key index | Pattern invalidation scans cache-owned keys instead of the entire Redis keyspace |
| `ZSCAN` / `SCAN` style iteration | Avoids blocking Redis with commands like `KEYS` |
| Batched pipelines | Reduces round trips when deleting many keys |
| `UNLINK` deletes | Lets Redis free memory asynchronously instead of blocking on large values |

This is one place where `lazy-layers-cache` can be better than a broader framework: it is opinionated around a fast Redis-backed cache path instead of supporting every possible storage model. The honest claim is that these choices are optimized for speed and operational safety; claiming it is always faster than BentoCache would require workload-specific benchmarks.

## Event Bus Guide

Event buses are used for invalidation, not warmup.

```txt
Instance A receives request
  -> A lazy loads
  -> A stores L1
  -> A stores shared L2

Instance B receives later request
  -> B reads L2
  -> B warms B's L1

Any instance invalidates
  -> event bus broadcasts invalidation
  -> every connected cache instance deletes local L1
  -> shared L2 is deleted too
```

All event buses support:

```ts
await eventBus.connect?.();

const health = await eventBus.healthCheck?.();

await eventBus.subscribe(async (event) => {
  // cache handles this for you when passed to LazyLayersCache
});

await eventBus.disconnect?.();
```

## Redis Event Bus

Redis Pub/Sub is fast and simple, but not durable.

```ts
import Redis from "ioredis";
import { RedisEventBus } from "lazy-layers-cache";

const redis = new Redis(process.env.REDIS_URL);

const eventBus = new RedisEventBus(redis, "cache:invalidations", {
  retryQueue: {
    // In-memory retry for transient publish failures.
    enabled: true,
    maxSize: 1_000,
  },
  logging: {
    env: "production",
  },
});

const health = await eventBus.healthCheck();

if (!health.ok) {
  throw health.error;
}
```

Options:

| Option | Why it matters |
| --- | --- |
| `channel` constructor arg | Redis Pub/Sub channel for invalidation messages |
| `retryQueue.enabled` | Keeps failed publishes in memory for later flush |
| `retryQueue.maxSize` | Prevents unbounded retry memory growth |
| `logging.env` | Keeps production quiet |

Use Redis Pub/Sub when you want low latency and can tolerate missed invalidations during disconnects because TTLs recover stale data.

## RabbitMQ Event Bus

RabbitMQ is a good fit for reliable invalidation fanout.

```ts
import { RabbitMQEventBus } from "lazy-layers-cache";

const eventBus = new RabbitMQEventBus("cache.invalidations", {
  // Lets connect() and healthCheck() initialize RabbitMQ.
  url: process.env.RABBITMQ_URL,

  // Fanout sends each invalidation to every bound queue.
  exchangeType: "fanout",

  // Durable exchange and persistent messages.
  durableInvalidationMode: true,

  // Stable unique queue per cache instance.
  // Do not share this queue between instances if every instance needs every invalidation.
  queueName: `${process.env.INSTANCE_ID}-cache-invalidations`,

  // Durable subscriber identity.
  exclusiveQueue: false,
  autoDeleteQueue: false,

  // Limits unacked messages per consumer.
  prefetch: 100,

  retryQueue: {
    enabled: true,
    maxSize: 1_000,
  },

  logging: {
    env: "production",
  },
});

const health = await eventBus.healthCheck();

if (!health.ok) {
  throw health.error;
}
```

Options:

| Option | Why it matters |
| --- | --- |
| `url` | Enables `connect()` and `healthCheck()` before server startup |
| `exchangeType` | `fanout` is easiest for invalidating all instances |
| `durableInvalidationMode` | Defaults exchange/messages/queues toward durability |
| `durable` | Explicit exchange/queue durability override |
| `persistent` | Persistent message publish override |
| `queueName` | Stable per-instance queue identity |
| `exclusiveQueue` | Use `false` for durable named queues |
| `autoDeleteQueue` | Use `false` for durable named queues |
| `prefetch` | Backpressure for message handlers |
| `routingKey` | Needed for topic/direct exchanges |
| `retryQueue` | In-memory retry for publish failures |
| `logging` | Environment-aware logs |

Use RabbitMQ when invalidation reliability matters and you already operate RabbitMQ.

## NATS Event Bus

NATS has two useful modes:

| Mode | Behavior |
| --- | --- |
| `core` | Very fast live Pub/Sub, not durable |
| `jetstream` | Durable stream, replay/resume, explicit ack/nak |

### NATS Core

```ts
import { NatsEventBus } from "lazy-layers-cache";

const eventBus = new NatsEventBus({
  mode: "core",
  connectionOptions: {
    servers: process.env.NATS_URL,
    name: process.env.INSTANCE_ID,
  },
  subject: "cache.invalidations",
  logging: {
    env: "production",
  },
});

const health = await eventBus.healthCheck();

if (!health.ok) {
  throw health.error;
}
```

### NATS JetStream

```ts
import { NatsEventBus } from "lazy-layers-cache";

const eventBus = new NatsEventBus({
  mode: "jetstream",
  connectionOptions: {
    servers: process.env.NATS_URL,
    name: process.env.INSTANCE_ID,
  },
  subject: "cache.invalidations",
  jetstream: {
    // Stream that stores invalidation messages.
    stream: "CACHE_INVALIDATIONS",

    // Stable unique durable consumer for this cache instance.
    durableName: `${process.env.INSTANCE_ID}-cache-invalidations`,

    // File storage survives server restart.
    storage: "file",

    // How long invalidation events are retained.
    maxAgeMs: 24 * 60 * 60 * 1_000,

    // Create stream/consumer if missing.
    ensureStream: true,
    ensureConsumer: true,

    // Redelivery settings.
    ackWaitMs: 30_000,
    maxDeliver: 10,
  },
  logging: {
    env: "production",
  },
});

const health = await eventBus.healthCheck();

if (!health.ok) {
  throw health.error;
}
```

Options:

| Option | Why it matters |
| --- | --- |
| `mode` | `core` for speed, `jetstream` for durable invalidation |
| `connection` | Inject an existing NATS connection |
| `connectionOptions` | Create a NATS connection internally |
| `subject` | NATS subject for invalidation messages |
| `jetstream.stream` | Stream that stores invalidations |
| `jetstream.durableName` | Required for JetStream persistent per-instance delivery |
| `jetstream.storage` | `file` for durability, `memory` for speed |
| `jetstream.maxAgeMs` | Retention window for invalidation replay |
| `jetstream.maxMsgs` | Optional stream size cap |
| `jetstream.ackWaitMs` | Redelivery wait if handler does not ack |
| `jetstream.maxDeliver` | Redelivery limit |
| `jetstream.ensureStream` | Auto-create stream |
| `jetstream.ensureConsumer` | Auto-create durable consumer |
| `retryQueue` | In-memory retry for publish failures |
| `logging` | Environment-aware logs |

Important: every cache instance that owns an L1 needs its own stable `durableName`. Shared durable names share one cursor and will not deliver every invalidation to every instance.

## Which Event Bus Should I Use?

| Transport | Use when | Avoid when |
| --- | --- | --- |
| Redis Pub/Sub | You need very low latency and can tolerate missed messages | You require durable invalidation |
| RabbitMQ | You want durable fanout with named queues | You do not want to operate RabbitMQ |
| NATS core | You want very fast connected fanout | You need replay after disconnect |
| NATS JetStream | You want durable invalidation with replay/resume | JetStream is not enabled or you cannot manage durable names |

Recommended production choices:

- Use **NATS JetStream** if you already run NATS or want a lightweight durable event log.
- Use **RabbitMQ durable queues** if RabbitMQ is already part of your platform.
- Use **Redis Pub/Sub** for simple, fast, best-effort invalidation.

## Observability Events

```ts
const cache = new LazyLayersCache({
  events: [
    (event) => {
      metrics.increment(`cache.${event.type}`);
    },
  ],
});
```

Events include:

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
- `inflight:bypass`
- `stale:hit`
- `negative:set`
- `l2:error`
- `l2:skipped`
- `event-bus:publish-error`
- `event-bus:publish-skipped`
- `invalidation:received`
- `invalidation:duplicate`

Event handlers are isolated. If a handler throws, cache behavior continues.

## Resilience Features

### Fail Open

L2 and event-bus failures are logged and swallowed where possible. Local L1 behavior continues.

### Circuit Breakers

Repeated L2 or event-bus failures open a circuit. While open, external calls are skipped until cooldown.

### Negative Caching

When a loader returns `undefined`, the miss can be cached briefly. This protects databases from repeated known-missing keys.

### Fail-Safe Stale Fallback

When enabled, successful values are remembered in a stale map. If a later loader fails or times out, the stale value can be returned.

### Soft And Hard Timeouts

- `softMs`: if stale exists, stop waiting and return stale.
- `hardMs`: stop waiting even if no stale exists.

### Distributed Lock

With `RedisStore` as L2 and `distributedLock.enabled: true`, cross-instance `getOrSet` calls can coordinate so only one instance loads a missing key.

### Versioned Keys

With `versioning.enabled: true`, deletes bump a local generation and future writes use a new storage key. This reduces stale write/delete races inside an instance.

## API Reference

```ts
await cache.set(key, value);
await cache.get(key);
await cache.getOrSet(key, loader);
await cache.has(key);
await cache.delete(key);
await cache.deleteByPattern("user:*");
await cache.clear();
await cache.size();

const unsubscribe = cache.on((event) => {});
unsubscribe();
```

Package exports:

```ts
import {
  createCache,
  HybridCache,
  LazyLayersCache,
  MemoryStore,
  RedisStore,
  RedisEventBus,
  RabbitMQEventBus,
  NatsEventBus,
} from "lazy-layers-cache";

import type {
  CacheOptions,
  CacheStore,
  LazyLayersCacheOptions,
  InvalidationEvent,
  EventBusHealth,
} from "lazy-layers-cache";
```

## Comparison Guide

| Project | Best fit | Tradeoff |
| --- | --- | --- |
| This package | Focused Node.js L1/L2 cache with explicit invalidation | Early project, fewer drivers |
| BentoCache | Full-featured caching framework | Larger API surface |
| cache-manager | General cache abstraction | Less opinionated invalidation/resilience |
| Keyv | Simple key-value abstraction | Not a full cache orchestration layer |
| Direct Redis | Maximum control | You build stampede protection, invalidation, retries, and metrics |

Further reading:

- BentoCache: https://bentocache.dev/docs/introduction
- cache-manager: https://www.npmjs.com/package/cache-manager
- Keyv: https://keyv.org/
- Redis Pub/Sub: https://redis.io/docs/latest/develop/pubsub/
- Redis SCAN: https://redis.io/docs/latest/commands/scan/
- Redis pipelining: https://redis.io/docs/latest/develop/using-commands/pipelining/
- Redis UNLINK: https://redis.io/docs/latest/commands/unlink/
- RabbitMQ AMQP concepts: https://www.rabbitmq.com/tutorials/amqp-concepts
- NATS JavaScript client: https://github.com/nats-io/nats.node
- NATS JetStream: https://docs.nats.io/nats-concepts/jetstream

## Production Notes

- Use short L1 TTLs and longer L2 TTLs.
- Use durable invalidation when stale data must be removed even after reconnects.
- Give every cache instance a unique `source`.
- For RabbitMQ, give every instance its own queue if every instance needs every invalidation.
- For NATS JetStream, give every instance its own durable consumer.
- Run `eventBus.healthCheck()` before starting the server.
- Keep production logs off with `logging.env: "production"`.
- Prefer negative caching before adding Bloom filters.
- Use distributed locks only around expensive loaders.
- Keep loader functions idempotent and timeout-aware.

## Scripts

- `npm run build` compiles TypeScript into `dist/`.
- `npm run typecheck` checks TypeScript without emitting.
- `npm test` runs the test suite.
