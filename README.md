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

## Planned for v0.5.3

v0.5.3 is unreleased. It adds two deliberately separate paths: ordinary
read-through caching and centralized transaction coordination.

- `getOrSet` remains a cache API. It never charges a payment account or decides
  a durable business result.
- `lazy-layers-cache/transactions` exposes a primary-only Redis operation store
  with bounded dispatch, explicit `acquired`/`in_progress`/`completed`/`unknown`
  outcomes, canonical idempotency fingerprints, and a cached Lua state machine.
  It never reads, writes, primes, or falls back through L1. Every cluster using
  one operation must share the same Redis authority and durable database.
- The ticketing example models a movie-seat hold, payment-provider idempotency,
  crash recovery, and a race between two buyers. The seat row is claimed in the
  durable database independently of the request idempotency key.
- Redis cache publication checks the lease token and writes the encoded value and
  TTL in one bounded operation. A clean ownership rejection is distinct from a
  Redis transport error.
- Capability discovery is bounded and read-only. It reports supported,
  unavailable, and unknown commands without running `CONFIG` or creating an
  index.
- Redis L2 uses native TTL and operator-managed eviction by default. The
  namespace index is opt-in via `useIndex: true`, or is selected when an explicit
  `levels.L2.maxEntries` policy needs it. That limit is a bounded, best-effort
  namespace cache policy under concurrent writers, not a transaction quota or a
  cross-region authority. Existing indexed deployments should keep
  `useIndex: true` during migration, then remove the catalogue after the
  namespace is drained.
- Real Redis clients default to the v2 per-entry same-slot key layout. During a
  rolling upgrade, set `keyLayout: "legacy"` on every old writer, drain or
  backfill the legacy namespace, then move all writers to `keyLayout: "v2"`.
  The layouts are intentionally not dual-read.
- L1 and L2 may select different write codecs with
  `levels.L1.codec` and `levels.L2.codec`. Reads remain backward-compatible with
  all tagged HC1 payloads. Native Redis HASH/JSON records are not enabled by
  default because the equal-volume benchmark decision is still deployment and
  schema specific.

Compression is lossless. Explicit JSON format follows JSON value semantics;
use it for JSON-compatible records, since types such as Date, Map, and typed
arrays do not retain their JavaScript types through JSON serialization.

Payment-provider idempotency and the durable database remain authoritative. A
  Redis lease or Lua script cannot provide exactly-once effects across Redis, a
  database, and an external provider.

See the [unreleased v0.5.3 changelog](CHANGELOG.md#053-unreleased), the
[transaction example](examples/transaction-coordination/README.md), and the
[release verification commands](#v053-release-checks).

## Released in v0.5.2

v0.5.2 is the released baseline. It makes the built-in L1 an encoded,
byte-aware cache instead of a map of live object references. The safe behavior
is on by default and remains configurable:

- A shared `maxMemory: "20%"` ceiling resolves against effective host or container memory. Sustained pressure lowers the active target, critical pressure evicts immediately, and recovery grows gradually.
- Size-aware admission rejects oversized scan traffic before it can evict a useful hot set. Redis L2 hits are still returned during pressure but skip L1 promotion until the local budget is healthy.
- Same-key callers share one in-flight loader. Different-key misses pass through a bounded origin gate, and a timed-out caller does not release capacity while uncancelled origin work is still running.
- Fail-safe snapshots, L2 work, event queues, Redis retries, and reconnect recovery are bounded and observable. Stale invalidation state is flushed before Redis Pub/Sub trust is restored.
- Managed setup validates the Redis 6 through 8 core path and ACL access without enabling Search, vectors, embeddings, semantic caching, or payload indexes.

See the [full changelog](CHANGELOG.md#052) and the [release verification commands](#v052-stress-and-release-checks). The byte ceiling covers cache-owned retained allocations, not total process RSS, and encoded L1 reads deliberately spend decode CPU to make retained payload memory measurable and bounded.

## Why this package?

Most Node.js caches solve one part of the problem. An in-process cache is fast but private to one server. A shared cache survives restarts but adds a network hop to every read. A cache invalidation bus can keep instances aligned, but it adds failure modes of its own.

LazyLayers puts those pieces behind one TypeScript API. Start with L1 memory. Add Redis L2 and an event bus when the service needs shared state. The production setup wires the safety mechanisms for you.

### How instances stay warm and consistent

`getOrSet` does not make a synchronous request to validate another instance. Each instance checks its own L1, then shared L2, and only runs the loader on a miss. When a loader succeeds, the result is written locally and, when an event bus is configured, published as a bounded `set` event so peer L1 caches can be prewarmed without running the loader again. This is push-based peer priming, not request-time validation.

Writes and invalidations travel through the same event-bus path:

- `invalidate(key)` publishes a generation-aware `del` event so every subscribed instance drops that key.
- `deleteByPattern(pattern)` / `invalidateByPattern(pattern)` publishes a `pattern` event so every instance repeats the scoped deletion locally.
- `prewarm(key, loader)` uses the full protected `getOrSet` path, so a successful warm-up also primes peer L1 caches.
- Redis Pub/Sub, RabbitMQ, NATS Core, and NATS JetStream are supported transports. The transport determines delivery semantics; LazyLayers handles source filtering, duplicate suppression, and stale single-key event ordering.

Pattern deletion is optimized per layer: L1 removes matching keys from its bounded LRU, while indexed Redis L2 streams matches with `ZSCAN` and deletes them in pipelines using `UNLINK` or `DEL` plus index cleanup. The pattern event is small; each instance performs the same namespace-scoped scan against its local state and shared L2.

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
- 🔒 **Distributed locks:** Redis-backed per-key locking coordinates cold and expired keys across instances, with automatic lease renewal.
- 🛡️ **Fail-open L2:** Redis failures degrade to a miss and the origin loader instead of blocking the request.
- 🚦 **Circuit breakers:** unhealthy L2 and event-bus dependencies are skipped during cooldowns.
- 🕰️ **Stale fallback:** recent values can be served when a loader fails or times out.
- 🚫 **Negative caching:** short-lived missing-key entries reduce repeated database lookups.
- 🗜️ **Compact payloads:** MessagePack with size-aware compression reduces L1/L2 memory, wire, and storage pressure.
- 🧠 **Memory-aware L1:** encoded LRU entries share a process memory budget with byte-aware admission and pressure-driven eviction.

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

1. 🧠 **L1 memory:** an in-process encoded LRU gives hot reads local-memory latency and bounds retention by `maxEntries`, TTL, byte-aware admission, and a shared memory budget.
2. 🗄️ **L2 Redis:** shared values survive process restarts and are available to every instance. L2 hits promote back into L1 when the local pressure and byte budget permit.
3. 💤 **Read-through loading:** `getOrSet` checks negative cache, L1, and L2 before calling the loader.
4. 🧵 **Stampede protection:** in-flight dedupe handles callers in one process. A distributed lock handles cold loads across instances.
5. 🗜️ **Serialization:** built-in L1 and Redis L2 use tagged, lossless wire values. Set `levels.L1.codec` and `levels.L2.codec` independently when their workloads need different compression or JSON interoperability. Matching policies reuse immutable bytes.
6. 📡 **Event-bus synchronization:** successful `getOrSet` loads and explicit `prewarm` can broadcast bounded `set` events to prime peer L1 caches; `invalidate` and `deleteByPattern` broadcast `del` and `pattern` events to keep instances aligned.
7. 🏷️ **Namespaces and patterns:** isolate applications with a namespace, then invalidate one key with `invalidate` or a family with `invalidateByPattern("users:*")`.
8. 🔢 **Ordering and dedupe:** source identity, event IDs, and generations ignore self-echoes, duplicates, and stale invalidations.
9. 🛡️ **Resilience:** bounded L2 and origin queues plus circuit breakers stop unhealthy dependencies from accumulating unbounded local work. Publish retry queues absorb brief bus failures.
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

Invalidate after the source-of-truth write commits. Use `prewarm` for deploy hooks and background jobs when a known key should be warm on every instance. Pass the loader's `AbortSignal` to the database or HTTP client. If a primed value exceeds `broadcastSetMaxBytes`, it is still stored on the originating instance and in L2, but peers load it on demand instead of receiving the payload.

### Cache expiry and slow loaders

The same `getOrSet(key, loader)` call protects cold starts and cache expiry. With Redis L2, locking and lease renewal are automatic. Concurrent callers wait for the shared result, and waiters retry a released lock if the original loader fails. No lock settings are required.

The contention wait budget adapts to the lock TTL and loader hard timeout, initially 10,050 ms. If it expires, the cache serves eligible stale data or throws the exported `DistributedLockTimeoutError`. It no longer starts an unlocked load just because another instance is slow. `distributedLock.onTimeout: 'load'` explicitly restores that older behavior.

If ownership is lost, the loader signal is aborted and late loader results are discarded. Without eligible stale data, the call rejects with `DistributedLockLostError`. Pass the signal to your database or HTTP client when supported. This is not an exactly-once guarantee: Redis outages before contention still fail open, and failover, process pauses or work that ignores cancellation can allow overlap. Redis client command timeouts still bound network operations.

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

### Redis 6 through 8 compatibility

The cache core supports Redis 6, 7, and 8 with ordinary Redis commands. During managed setup, `setupCache` calls `INFO server` and rejects unsupported versions, malformed version replies, and ACL denials with classified errors that do not expose the raw server response.

Grant the cache user `+info` for that startup check, together with the commands used by the configured store and event bus. Scope key and channel patterns to your namespace. Redis Search, vector indexes, embeddings, semantic caching, and AI features are not initialized or required by the v0.5.2 cache core.

For memory planning, estimate:

```txt
L1 accounted bytes ≈ encoded payloads + estimated key/metadata overhead + bounded stale snapshots
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

### v0.5.3 release checks

Run the complete release gate on the branch before publishing:

```bash
npm ci
npm run ci
npm run bench:representations
npm run bench:transactions
```

The transaction benchmark runs a bounded coordination workload without a
service by default. Set `REDIS_URL` to measure the cached Lua path against a
controlled Redis primary. It reports p50, p95, p99, and p99.9 latency,
throughput, event-loop delay, and heap/external/RSS observations. These numbers
are workload-specific and do not establish a universal fastest implementation.

The representation benchmark records Node/V8 codec timing and compares HC1,
V8 JSON, and HASH-shaped payloads. Add `--live` with `REDIS_URL` to measure
Redis `MEMORY USAGE` for a temporary namespace, including native JSON when the
module is available. It never changes Redis `CONFIG` and does not select a
production representation.

The seat/payment example is runnable after `npm run build`:

```bash
node --import tsx examples/transaction-coordination/index.ts
```

It demonstrates recovery and idempotency. Replace its in-memory durable adapter
with a database primary and use the provider's documented idempotency and
reconciliation API before handling real payments.

### v0.5.2 stress and release checks

`v0.5.2` adds stress coverage for the new memory, queue, and invalidation
controls. Run the focused safety suite while changing those paths:

```bash
npm run test:release-safety
```

It covers encoded-L1 ownership and expiry accounting, shared memory-budget
pressure, bounded origin and L2 work, delayed L2 promotion, local and remote
invalidation fencing, Redis reconnects, and retry-queue overflow or mutation.

For hot-key pressure, use the herd benchmark:

```bash
npm run bench:herd
# Optional: raise the concurrent caller count.
LAZY_HERD_CALLERS=50000 npm run bench:herd
```

The default run creates 10,000 simultaneous `getOrSet` calls for one cold key.
It reports loader calls, in-flight reuses, elapsed time, and result correctness
for the default path and an explicitly unsafe comparison with both in-flight
dedupe and the origin guard disabled. A healthy default run makes one loader
call and reuses it for the remaining 9,999 callers.

The release-memory harness exercises hot reads, concurrent distinct-key surges,
incompressible oversized scans, changing hot sets, injected L2 failures, and uneven
three-replica traffic. It also injects a deterministic critical-memory signal
into an encoded L1 store and verifies that the shared budget enters `critical`,
evicts to its reduced target, and reports no workload error:

```bash
npm run bench:release-memory
LAZY_BENCH_ITERATIONS=10000 LAZY_BENCH_SEED=20250911 \
  LAZY_BENCH_OUTPUT=benchmarks/release-memory.json npm run bench:release-memory
```

Its JSON records Node and OS metadata, seed, throughput, latency percentiles,
CPU time, event-loop delay, before/peak/after process memory, errors, cache
telemetry, byte accounting, and origin-gate statistics. Executable gates require
origin concurrency to stay at or below its configured limit, rejected oversized
objects to stay out of L1, critical pressure to evict below target, and required
metrics to be present.
Set `LAZY_BASELINE_MODULE` to compare the current build with a published
baseline. The default harness intentionally has no L2, so Redis transport
performance must be measured separately against a controlled Redis service.
All benchmark results are workload- and machine-specific, not universal
performance guarantees.

For the full release gate, including real Redis when available:

```bash
npm ci
npm run ci
REDIS_URL=redis://127.0.0.1:6379 npm run ci
```

The GitHub Actions workflow runs type checks, ESM/CommonJS package checks, unit
and release-safety tests, integration tests, live Redis/RabbitMQ/NATS tests,
the 10,000-caller herd benchmark, synthetic memory-pressure benchmark,
serializer benchmarks, the site build, and the documentation build.

## License

MIT
