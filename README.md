# lazy-layers-cache

> Fast L1/L2 caching for Node.js services that run on more than one instance.

[![npm version](https://img.shields.io/npm/v/lazy-layers-cache.svg)](https://www.npmjs.com/package/lazy-layers-cache)
[![CI](https://github.com/Amon20044/LazyLayers/actions/workflows/ci.yml/badge.svg)](https://github.com/Amon20044/LazyLayers/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/lazy-layers-cache.svg)](LICENSE)
[![types](https://img.shields.io/npm/types/lazy-layers-cache.svg)](https://www.npmjs.com/package/lazy-layers-cache)

**[Docs](https://lazy-layers-cache.vercel.app/docs)** · **[Memory and cost calculator](https://lazy-layers-cache.vercel.app/#calculator)** · **[LLM index](https://lazy-layers-cache.vercel.app/llms.txt)** · **[Full LLM context](https://lazy-layers-cache.vercel.app/llms-full.txt)**

```bash
npm install lazy-layers-cache
```

## Why this package?

Most Node.js caches solve one part of the problem. An in-process cache is fast but private to one server. A shared cache survives restarts but adds a network hop to every read. A cache invalidation bus can keep instances aligned, but it adds failure modes of its own.

LazyLayers puts those pieces behind one TypeScript API. Start with L1 memory. Add Redis L2 and an event bus when the service needs shared state. The production setup wires the safety mechanisms for you.

## The real problem it solves

At traffic peaks, the expensive work is not the cache lookup. It is what happens on a miss:

- Many callers load the same cold key at once, creating a thundering herd.
- Every server keeps a different L1 value after a write.
- A slow cache or broker blocks the request path.
- A failed loader turns a temporary dependency problem into an application error.
- Large JSON payloads waste network bandwidth and Redis memory.
- Missing records repeatedly hit the database.

LazyLayers addresses these costs in the read and write path:

- ⚡ **Lazy loading:** `getOrSet` only loads keys that traffic requests.
- 🧩 **In-flight dedupe:** concurrent callers for one key share one loader promise.
- 🔒 **Distributed locks:** Redis-backed per-key locking prevents duplicate cold loads across instances.
- 🛡️ **Fail-open L2:** Redis failures degrade to a miss and the origin loader instead of blocking the request.
- 🚦 **Circuit breakers:** unhealthy L2 and event-bus dependencies are skipped during cooldowns.
- 🕰️ **Stale fallback:** recent values can be served when a loader fails or times out.
- 🚫 **Negative caching:** short-lived missing-key entries reduce repeated database lookups.
- 🗜️ **Compact payloads:** MessagePack with size-aware compression reduces L2 wire and storage pressure.

## System design, in request order

`setupCache` gives you the production path with one awaited call:

```ts
import { setupCache } from "lazy-layers-cache";

export const cache = await setupCache({
  namespace: "billing-api",
  redis: { required: true },
});
```

The default production path is designed for the problems in this order:

1. 🧠 **L1 memory:** an in-process LRU gives hot reads local-memory latency and bounds memory by `maxEntries` and `ttlMs`.
2. 🗄️ **L2 Redis:** shared values survive process restarts and are available to every instance. L2 hits promote back into L1.
3. 💤 **Read-through loading:** `getOrSet` checks negative cache, L1, and L2 before calling the loader.
4. 🧵 **Stampede protection:** in-flight dedupe handles callers in one process. A distributed lock handles cold loads across instances.
5. 🗜️ **Serialization:** values use MessagePack and size-aware compression before they cross the Redis connection.
6. 📡 **Event-bus synchronization:** Redis Pub/Sub, RabbitMQ, NATS Core, and NATS JetStream carry `del`, `pattern`, and bounded `set` priming events between instances.
7. 🏷️ **Namespaces and patterns:** isolate applications with a namespace, then invalidate one key with `invalidate` or a family with `invalidateByPattern("users:*")`.
8. 🔢 **Ordering and dedupe:** source identity, event IDs, and generations ignore self-echoes, duplicates, and stale invalidations.
9. 🛡️ **Resilience:** L2 and event-bus circuit breakers stop repeated calls to unhealthy dependencies. Publish retry queues absorb brief bus failures.
10. ⏳ **Graceful degradation:** stale values cover loader errors and timeouts. A missing loader result can be negative-cached.
11. ❤️ **Health and lifecycle:** configured Redis and subscriptions pass health checks before startup. `close()` performs idempotent shutdown.
12. 📊 **Observability:** optional dashboard, Prometheus metrics, and `node:diagnostics_channel` telemetry expose hit levels, stale reads, invalidations, compression, and breaker behavior.

### Minimal production usage

```ts
const user = await cache.getOrSet(`user:${id}`, ({ signal }) =>
  db.users.findById(id, { signal }),
);

await db.users.update(id, patch);
await cache.invalidate(`user:${id}`);

await cache.invalidateByPattern("tenant:42:*");
```

Invalidate after the source-of-truth write commits. Use `prewarm` for deploy hooks and background jobs. Pass the loader's `AbortSignal` to the database or HTTP client.

### Choose the event bus by delivery needs

- 🔄 **Redis Pub/Sub:** low-overhead, at-most-once fanout.
- 🐇 **RabbitMQ:** durable queues, acknowledgements, and exchange routing.
- ⚡ **NATS Core:** fast at-most-once fanout.
- 💾 **NATS JetStream:** durable consumers, replay, acknowledgements, and redelivery.

### Drivers and extension points

The package includes an L1 `MemoryStore` and an L2 `RedisStore`. You can implement the `CacheStore` interface when your service needs another backing store. The event-bus interface supports custom transports as well.

## Production defaults

For most multi-instance services, use L1 + Redis L2 + Redis Pub/Sub first:

```ts
const cache = await setupCache({
  namespace: "billing-api",
  redis: { required: true },
});
```

This path includes health checks, startup readiness, L1/L2 layering, invalidation, per-key locks, in-flight dedupe, stale fallback, negative caching, circuit breakers, bounded peer priming, and managed shutdown. Tune the numbers for your traffic rather than removing the safety mechanisms.

For memory planning, estimate:

```txt
L1 memory ≈ maxEntries × typical decoded value size + application headroom
```

Use the **[memory and cost calculator](https://lazy-layers-cache.vercel.app/#calculator)** to compare L1 sizing, Redis payload size, compression, and infrastructure costs. Payload bytes are an estimate of wire/storage pressure, not total Redis memory usage.

## Explore the docs

- 🚀 [Quickstart](https://lazy-layers-cache.vercel.app/docs/quickstart): install, configure, read, invalidate, pre-warm, and shut down.
- 🏭 [Production setup](https://lazy-layers-cache.vercel.app/docs/setups/production): L1/L2 sizing, instance identity, timeouts, stale fallback, and health behavior.
- 🧱 [System design](https://lazy-layers-cache.vercel.app/docs/learn): how a key moves through the cache.
- 🧠 [Layers](https://lazy-layers-cache.vercel.app/docs/concepts/layers): when L1, L2, or both make sense.
- 🧵 [Stampede protection](https://lazy-layers-cache.vercel.app/docs/guides/stampede-protection): in-flight dedupe and distributed locks.
- 🔄 [Invalidation](https://lazy-layers-cache.vercel.app/docs/concepts/invalidation): key, pattern, generation, and peer synchronization behavior.
- 🛡️ [Failure handling](https://lazy-layers-cache.vercel.app/docs/guides/failure-handling): circuit breakers, timeouts, stale values, and negative caching.
- 📡 [Event buses](https://lazy-layers-cache.vercel.app/docs/guides/event-buses): Redis, RabbitMQ, NATS Core, and JetStream.
- 📊 [Observability](https://lazy-layers-cache.vercel.app/docs/guides/observability): dashboard, Prometheus, and telemetry.
- ⚙️ [Configuration reference](https://lazy-layers-cache.vercel.app/docs/reference/configuration): every option and its trade-off.
- 🔌 [API reference](https://lazy-layers-cache.vercel.app/docs/reference/api): methods, stores, and custom integrations.

## Development

```bash
npm ci
npm run ci
```

The GitHub Actions workflow runs type checks, ESM/CommonJS builds, unit tests, integration tests, live Redis/RabbitMQ/NATS tests, benchmarks, the site build, and the documentation build.

## License

MIT
