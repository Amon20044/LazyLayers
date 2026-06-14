# lazy-layers-cache

Simple TypeScript hybrid caching for Node.js with L1 memory, optional Redis L2, lazy loading, stampede protection, fail-open behavior, stale fallback, and distributed invalidation.

[![npm version](https://img.shields.io/npm/v/lazy-layers-cache.svg)](https://www.npmjs.com/package/lazy-layers-cache)
[![license](https://img.shields.io/npm/l/lazy-layers-cache.svg)](LICENSE)
[![types](https://img.shields.io/npm/types/lazy-layers-cache.svg)](https://www.npmjs.com/package/lazy-layers-cache)

`lazy-layers-cache` gives you a small Promise-based cache API that can start as an in-process LRU cache and grow into a multi-instance cache backed by Redis and invalidated over Redis Pub/Sub, RabbitMQ, or NATS.

It is designed around one practical production rule:

```txt
The first instance to lazily load a key broadcasts it to every peer.
Peers populate their L1 from the broadcast — no second loader call.
Deletes and pattern wipes are broadcast to every connected instance.
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
- Live observability dashboard at `/observelazyily` (opt-in, zero-dependency)
- Per-key serialized-vs-in-memory size comparison and nested key explorer
- Built-in Prometheus `/metrics` endpoint (bounded cardinality)
- OpenTelemetry/APM telemetry via `node:diagnostics_channel`
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
- [Observability Dashboard](#observability-dashboard)
- [Prometheus Metrics](#prometheus-metrics)
- [OpenTelemetry / APM Telemetry](#opentelemetry--apm-telemetry)
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

When multiple application instances use their own L1 memory caches, connect them with an event bus. The bus carries three kinds of events:

| Event | Trigger | What peers do |
| --- | --- | --- |
| `del` | `cache.delete(key)` | Drop the key from L1 / L2 / negative / stale / inflight. |
| `pattern` | `cache.deleteByPattern(p)` / `cache.clear()` | Drop every local entry that matches the pattern. |
| `set` | A loader in `getOrSet` returns a value | Populate peer L1 with the broadcast value — no peer loader call. |

`set` broadcasts are emitted from inside `getOrSet`'s loader path only. Direct `cache.set()` calls do **not** broadcast. This is the L1 priming path the rule above describes — one instance pays for the loader, every peer's L1 warms automatically. Self-published events are ignored via the `source` filter, and events are deduplicated by ID.

Turn off the L1 priming broadcast with `broadcastSet: false` if you want pure invalidation semantics (delete-only fanout, like older releases).

`del` and `set` events carry a per-key `generation`. Each cache instance ignores remote `del` / `set` events whose generation is older than the generation it has already applied for that key, so a late `set` broadcast cannot repopulate a value after a newer delete.

Large `set` broadcasts can be skipped with `broadcastSetMaxBytes`. The value is still written through the normal cache path, so peers can fall back to L2 instead of receiving a large payload over the fanout bus.

```ts
const cache = new LazyLayersCache({
  eventBus,
  source: process.env.INSTANCE_ID,
  broadcastSet: true, // default — peers populate L1 from getOrSet results
  broadcastSetMaxBytes: 256 * 1024,
});
```

### Delivery Semantics

| Transport | Delivery meaning |
| --- | --- |
| Redis Pub/Sub | At-most-once and ephemeral. Subscribers only receive messages while connected. |
| NATS Core | At-most-once. Fast fanout, but no replay for disconnected subscribers. |
| RabbitMQ durable mode | Retryable/durable when `durableInvalidationMode`, a stable `queueName`, and persistent messages are configured. |
| NATS JetStream | Durable/replayable with explicit ack, durable consumers, and redelivery. |

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

## Event Bus Initialization Options

Every transport ships with sane defaults but exposes the full surface for tuning durability, fanout, retry, and per-instance identity. The `source` field on `LazyLayersCache` is what filters self-loopback regardless of transport — every transport delivers your own publishes back to you.

### LazyLayersCache event-bus options (shared across all transports)

| Option | Default | Why it exists |
| --- | --- | --- |
| `eventBus` | unset | The bus instance used for distributed invalidation and L1 priming. Without it, the cache is local-only. |
| `source` | random per process | **Required in multi-instance setups.** Stamped on every published event; the subscribe handler discards events whose `source` matches this value so you don't invalidate yourself. Use `$HOSTNAME` / `INSTANCE_ID`. |
| `subscribeToEvents` | `true` | Set `false` to publish-only (one-way). Useful for read-only replicas that should not apply remote invalidations. |
| `broadcastSet` | `true` | When a `getOrSet` loader returns a value, broadcast it so peer L1s populate without a second loader call. Set `false` for delete-only fanout. |
| `broadcastSetMaxBytes` | unset | Optional cap for the encoded `set` event. Oversized values are stored locally/L2 but not fanned out for peer L1 priming. |
| `eventDedupeMaxEntries` | `10_000` | How many recent event IDs the cache remembers to drop duplicates. Durable buses can redeliver; this stops a redelivered event from re-applying. |
| `eventDedupeTtlMs` | `300_000` | How long each event ID stays in the dedupe map. Should comfortably exceed your worst-case redelivery window. |
| `resilience.eventBusCircuitBreaker` | unset | `{ failureThreshold, cooldownMs }`. After repeated publish failures, the circuit opens and publishes are skipped until cooldown. Keeps a broken bus from blocking your request path. |

### Shared retry queue (every transport accepts `retryQueue`)

| Option | Default | Why it exists |
| --- | --- | --- |
| `retryQueue.enabled` | `true` | If a publish throws, the event is buffered in memory and re-attempted on the next successful publish. Smooths out brief bus blips. |
| `retryQueue.maxSize` | `10_000` | Cap to prevent memory bloat when the bus stays down for a long time. Oldest event drops first with a warn log. Set a smaller value for very memory-sensitive services. |

### RedisEventBus — `new RedisEventBus(redis, channel, options)`

| Option | Default | Why it exists |
| --- | --- | --- |
| `redis` (ctor arg) | — | An existing `ioredis` client. The bus calls `.duplicate()` internally for the subscriber (Pub/Sub clients can't issue other commands). |
| `channel` (ctor arg) | — | The Pub/Sub channel name. All instances that share invalidation must use the same channel. |
| `retryQueue` | see above | Buffers failed publishes for the next attempt. Pub/Sub is fire-and-forget — without retry, a single network blip drops the event. |
| `handlerConcurrency` | `1` | Limits concurrent subscriber handler execution. The default preserves approximate message order for invalidations. |
| `logging.env` | inherits `NODE_ENV` | Force `"production"` / `"development"` / `"test"` independent of `NODE_ENV`. Production suppresses debug logs. |
| `logging.enabled` | auto from env | Hard override of the env-based switch when you want logs on or off regardless of `NODE_ENV`. |

### RabbitMQEventBus — `new RabbitMQEventBus(exchange, options)`

| Option | Default | Why it exists |
| --- | --- | --- |
| `exchange` (ctor arg) | — | Exchange name. All instances must bind to the same exchange for fanout to work. |
| `url` | — | AMQP URL (`amqp://user:pass@host:5672`). Required unless you call `init(url)` manually. |
| `exchangeType` | `"fanout"` | Use `"topic"` if you want one bus for multiple caches with routing keys; `"direct"` for exact-match routing. Default fanout broadcasts to every bound queue. |
| `durableInvalidationMode` | `false` | One switch that flips `durable`, `persistent`, names the queue, and disables auto-delete/exclusive. Pick this when you cannot afford to miss an invalidation across reconnects. |
| `durable` | follows `durableInvalidationMode` | Survives broker restarts. Required if you want messages preserved across RabbitMQ outages. |
| `persistent` | follows `durable` | Per-message delivery mode 2 — flushed to disk before ack. Pair with `durable: true` for end-to-end durability. |
| `queueName` | server-generated | **Set this to a stable per-instance value (e.g. `${INSTANCE_ID}-cache`) when using durable mode.** Anonymous queues vanish on reconnect, losing messages buffered for that instance. |
| `exclusiveQueue` | `true` unless durable mode | Exclusive queues are tied to the connection and auto-deleted on disconnect. Good for ephemeral subscribers, bad for durable per-instance invalidation queues. |
| `autoDeleteQueue` | `true` unless durable mode | Queue is removed once no consumers remain. Disable when you want messages to buffer while an instance restarts. |
| `routingKey` | `""` | Ignored for fanout; required for topic/direct exchanges to pick which messages this consumer wants. |
| `prefetch` | broker default (unlimited) | Channel-level QoS. Caps unacked messages per consumer so a single slow instance can't hoard the queue. |
| `retryQueue` | see above | Buffers failed publishes when the AMQP confirm fails. |
| `logging` | inherits env | Same shape as Redis. |

### NatsEventBus — `new NatsEventBus(options)`

| Option | Default | Why it exists |
| --- | --- | --- |
| `mode` | `"core"` | `"core"` is at-most-once, lowest latency. `"jetstream"` adds durable streams, per-instance durable consumers, redelivery, and replay. |
| `connection` | created internally | Inject a pre-built `NatsConnection` when you want to share one connection across multiple services. The bus will not own (or drain) an injected connection on `disconnect()`. |
| `connectionOptions` | — | Standard `nats.connect()` options when the bus creates the connection itself (`servers`, `name`, `token`, etc.). Set `name` to your instance ID for cleaner observability on the NATS server. |
| `subject` | `"cache.invalidations"` | NATS subject used to publish and subscribe. Same value on every instance. |
| `retryQueue` | see above | Buffers failed publishes (core mode in particular can drop on broker hiccup). |
| `jetstream.stream` | `"CACHE_INVALIDATIONS"` | JetStream stream name. The bus creates it if `ensureStream` is true. |
| `jetstream.durableName` | — | **Required in JetStream mode.** Per-instance durable consumer identity. JetStream replays from where this consumer last acked, so each instance needs its own unique value. |
| `jetstream.storage` | `"file"` | `"file"` persists across NATS restarts; `"memory"` is faster but lost on restart. |
| `jetstream.maxAgeMs` | unset (forever) | Drops messages older than this from the stream. Caps disk usage when invalidations stack up. |
| `jetstream.maxMsgs` | `-1` (unlimited) | Hard cap on stored messages. Pair with `maxAgeMs` for predictable storage. |
| `jetstream.ackWaitMs` | `30_000` | Time the server waits for an ack before redelivering. Increase if your handler is slow; decrease for tighter retries. |
| `jetstream.maxDeliver` | `10` | Maximum redelivery attempts before the message is given up on. Stops poison messages from looping forever. |
| `jetstream.ensureStream` | `true` | Auto-create the stream on `connect()` if missing. Set `false` if streams are provisioned by infra/IaC. |
| `jetstream.ensureConsumer` | `true` | Auto-create the durable consumer for this instance if missing. Set `false` when consumers are provisioned externally. |
| `logging` | inherits env | Same shape as Redis. |

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
- `invalidation:stale`
- `set:broadcast` (this instance published a `getOrSet` result to peers)
- `set:broadcast-skipped` (the encoded `set` event exceeded `broadcastSetMaxBytes`)
- `set:received` (this instance applied a peer's `getOrSet` result to its L1)

## Observability Dashboard

Set `observability: true` to get a live, zero-config dashboard at
**`/observelazyily`** — a "Redis Insight for your whole cache". It visualizes L1
(in-memory LRU) and L2 (Redis) keys as a nested tree with **deserialized values
and a per-key serialized-vs-in-memory size comparison**, a live event stream, and
the resolved configuration — all separated into navigations.

```ts
const cache = createCache({
  l2: new RedisStore(redis),
  eventBus,
  observability: true, // standalone server on http://127.0.0.1:7077/observelazyily
});
```

Default credentials are **`lazydev` / `lazydev`** (HTTP Basic auth). Open the URL
printed at startup and log in.

> ⚠️ The dashboard exposes cache contents and live activity. It is intended for
> **development/staging**. It binds to `127.0.0.1` and requires auth by default;
> secure it (token, network policy) and avoid leaving it enabled in production.
> A one-time notice is logged on enable — set `quiet: true` to silence it.

### Design goals

- **Zero performance hindrance.** Disabled by default — not a single extra
  instruction in `get`/`set`. When enabled, the only hot-path cost is one O(1)
  handler on the event stream the cache already emits, plus a bounded ring-buffer
  write. All key enumeration / Redis `SCAN` / deserialization is **pull-based and
  paginated** — it runs only while a dashboard tab is open, using `peek()` (L1)
  and `SCAN` (L2) so inspection never disturbs eviction order or blocks Redis.
- **Nothing is persisted.** The live event feed is an in-memory ring buffer
  streamed over SSE — it is never written to Redis or disk.

### Mount into your own server

Prefer your existing HTTP server? Disable the standalone server and mount the
framework-agnostic handler:

```ts
const cache = createCache({ observability: { enabled: true, server: false } });
const dashboard = cache.getObservabilityHandler();

http.createServer((req, res) => {
  if (dashboard?.(req, res)) return; // handled a /observelazyily request
  // ...your routes
}).listen(3000);
```

### Configuration

```ts
createCache({
  observability: {
    enabled: true,
    route: "/observelazyily",          // base route
    server: { host: "127.0.0.1", port: 7077, autoStart: true }, // or `false`
    auth: { username: "lazydev", password: "lazydev", token: "optional-bearer" },
    maxEvents: 1000,                    // ring-buffer size for the live feed
    maxValueBytes: 256 * 1024,         // values larger than this are truncated in the UI
    prometheus: { enabled: true, prefix: "lazycache", public: false },
    quiet: false,
  },
});
```

Everything is also configurable via **environment variables** (handy for
toggling per environment without code changes). Precedence is
`option > env > default`:

| Env var | Purpose | Default |
|---------|---------|---------|
| `LAZY_OBS_ENABLED` | Enable the dashboard | `false` |
| `LAZY_OBS_ROUTE` | Base route | `/observelazyily` |
| `LAZY_OBS_HOST` / `LAZY_OBS_PORT` | Standalone server bind | `127.0.0.1` / `7077` |
| `LAZY_OBS_USER` / `LAZY_OBS_PASSWORD` | Basic-auth credentials | `lazydev` / `lazydev` |
| `LAZY_OBS_TOKEN` | Optional bearer/query token | — |
| `LAZY_OBS_NO_SERVER` | Only expose the mountable handler | `false` |
| `LAZY_OBS_NO_AUTH` | Disable auth (not recommended) | `false` |
| `LAZY_OBS_PROMETHEUS` | Expose `/metrics` | `false` |
| `LAZY_OBS_PROMETHEUS_PREFIX` | Metric name prefix | `lazycache` |
| `LAZY_OBS_PROMETHEUS_PUBLIC` | Allow unauthenticated scrapes | `false` |
| `LAZY_OBS_MAX_EVENTS` / `LAZY_OBS_MAX_VALUE_BYTES` | Feed / value limits | `1000` / `262144` |
| `LAZY_OBS_QUIET` | Silence the startup notice | `false` |

## Prometheus Metrics

Enable a Prometheus exposition endpoint at **`{route}/metrics`** (zero extra
dependencies):

```ts
createCache({
  observability: { enabled: true, prometheus: { enabled: true, public: true } },
});
// GET http://127.0.0.1:7077/observelazyily/metrics
```

```
# TYPE lazycache_hits_total counter
lazycache_hits_total{level="l1"} 128
lazycache_hits_total{level="l2"} 17
lazycache_misses_total{level="l1"} 31
lazycache_writes_total 44
lazycache_hit_ratio 0.82
lazycache_l1_entries 950
```

Metrics are labeled by `level`/`kind`/`result` only — **never by cache key** — so
series cardinality stays bounded no matter how many keys you store. Set
`prometheus.public: true` to allow scrapers through without UI credentials (or
configure `basic_auth` in your Prometheus scrape config).

Scrape config:

```yaml
scrape_configs:
  - job_name: lazy-layers-cache
    metrics_path: /observelazyily/metrics
    static_configs:
      - targets: ["127.0.0.1:7077"]
```

## OpenTelemetry / APM Telemetry

The raw event stream is published to a Node
[`diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) named
**`lazycache:cache:event`** — the zero-dependency hook for OpenTelemetry or any
APM. Publishing is guarded by `hasSubscribers`, so it costs a single boolean
check on the hot path when nothing is attached.

```ts
import { subscribeTelemetry, TELEMETRY_CHANNEL_NAME } from "lazy-layers-cache";

const unsubscribe = subscribeTelemetry((event) => {
  // build spans/metrics, forward to OTel, etc.
  span.addEvent(event.type, event);
});
```

You can also subscribe directly via `diagnostics_channel.subscribe(TELEMETRY_CHANNEL_NAME, ...)`.

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
| `broadcastSet` | Set `false` to disable peer L1 priming after `getOrSet` loader success. Default `true` when `eventBus` is set. |
| `broadcastSetMaxBytes` | Optional encoded-size cap for `set` broadcasts. Oversized values are not fanned out; peers can still load them from L2. |
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
| `maxSize` | `10_000` | Max events to keep after publish failures. Oldest events are dropped when full. |

## Runtime Notes

![Lazy Layers Architecture](LazyLayers.webp)

- L1 is local to the current process.
- Redis L2 is shared across processes.
- Event buses carry three event types: `del`, `pattern`, and `set`. The `set` event is the L1-priming broadcast emitted from `getOrSet` loader success — it carries the loaded value so peers populate L1 without a second loader call. Disable with `broadcastSet: false` for delete-only fanout.
- Remote `del` and `set` events are generation-checked per key. Older-generation events are ignored to prevent late `set` broadcasts from repopulating values after deletes.
- Use `broadcastSetMaxBytes` for payload-heavy values; event buses are best for invalidations and small L1-warmup messages, not large-object fanout.
- Loader results of `undefined` are not stored as normal cache values and are not broadcast.
- Direct `cache.set()` calls do not broadcast — only `getOrSet` loader successes do.
- Production logging is quiet by default when `NODE_ENV=production`.
- `versioning.enabled` writes generation-suffixed storage keys after deletes.
- Always use a stable `source` or `INSTANCE_ID` in multi-instance deployments.
- Pattern invalidation scans local in-memory structures and delegates to the backing store's pattern delete. Avoid very frequent broad patterns such as `*` on large L1 maps unless you have measured the cost.

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

163 tests pass on the current branch (`npm test`).

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
