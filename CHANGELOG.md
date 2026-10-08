# Changelog

## 0.6.2 (unreleased)

### Changed

- Centralized portable cache value encoding behind `serializeCacheValue` and `deserializeCacheValue`, sharing HC1 tags, null handling, gzip thresholds, and Worker-safe decoding between Node.js and Workers.
- Cloudflare KV adapters now call the shared serializer facade instead of maintaining their own encoding implementations.
- Built-in L1 uses dynamically growing, count-bounded LRU storage, per-key expiry checks, and incremental accounting. Closing the store drops its owned cache structures.
- Same-key followers join existing work before another cache read. In-flight maintenance and admission sampling use bounded work.
- Event handler and retry queues retain owned wire snapshots with incremental byte accounting. Telemetry snapshots and SSE clients have finite retention and backpressure limits.

### Added

- Cache-wide `inflight.maxWaiters` protection, defaulting to 10,000, with `InflightOverloadError` and reservations held until the accepted work actually settles.
- Bounded internal decoding through `decodeLimits`, including encoded/expanded size, nesting and collection checks, strict UTF-8 validation, and owned binary results.
- Scoped invalidation metadata and typed numeric-key propagation. Shared-L2 peer hints verify authoritative data before local promotion.
- Isolated Docker correctness, multi-process load and fault harnesses; memory snapshots, admission/codec experiments, raw results, and metrics configurations under `audit/`.
- PR and scheduled performance workflows with repeated comparisons, variance-aware regression gates, resource limits and cleanup.

### Fixed

- An unleased loader fallback can no longer overwrite protected Redis v2 state or publish an unsafe peer success event after coordination failure.
- Pattern invalidation fences matching lease-only keys. Redis v2 namespace filtering and escaped patterns preserve nested/foreign tenants and distinguish malformed Unicode keys.
- Per-key mutation guards protect fills and promotions without suppressing unrelated writes. Lower-generation deletes conservatively invalidate local state rather than resurrecting forgotten versions.
- Loader cancellation, queue admission rechecks, close guards, and remaining-TTL propagation prevent obsolete local publication and unintended TTL extension.
- Corrupt internal records are cache misses; legitimate null remains a hit. Redis snapshots check encoded size before transferring an oversized value.
- Decoded binary views no longer expose the retained cache bytes through ordinary reads or inspection.
- Event queue overflow, malformed delivery and transport gaps trigger conservative reconciliation; reconnect must restore subscription trust after cleanup.
- Worker local lifecycle guards prevent obsolete completion from restoring local state after invalidation or close.

### Validation and measured trade-offs

- The full isolated live-service suite passes 480 tests on Node 20, 22 and 24. The final 15-case fault matrix and 93 focused independent checks pass.
- Paired Apple M5 / Node 24 measurements show 97.56% lower heap-plus-external retention for 20 empty stores and 99.83% faster membership/expiry checks at 8,192 entries.
- Warm-read microbenchmarks take 30.46% longer, and the performance gate rejects warm-read and large accepted-herd regressions. Safety controls remain in place; this is not a universal speedup or production-readiness claim.
- See the [full comparison](audit/10-before-after-comparison.md), [reproduction guide](audit/README.md), and [readiness gates](audit/12-production-readiness.md) for workload definitions, raw evidence and limitations.

### Compatibility and rollout

- Public signatures, exports, HC1 tags and permissive one-argument public decoding remain compatible. New resource errors, terminal close behavior, stricter internal decoding, Redis ACL requirements and scoped-event migration are documented in [migration notes](audit/migration.md).
- Production dependencies and the lockfile are unchanged. This development version has not been published to npm.
- Node 20 passes the tested runtime suite, but the current NATS transitive dependency declares Node 22 or newer; use Node 22+ for that integration.
- Redis failover/Cluster, durable source fencing and invalidation, legacy/custom non-atomic adapters, Worker aggregate resource budgets, tenant-wide origin fairness and long-duration RSS guarantees remain open gates. Redis owner tokens do not fence external database effects, and KV remains eventually consistent.

## 0.6.1

### Added

- Added Cloudflare KV as an L2 choice in `setupCache`, with a Workers KV binding adapter and a Node.js REST namespace client.
- Added a Worker-safe `lazy-layers-cache/cloudflare` entrypoint with HC1 MessagePack L2, optional isolate L1, `getOrSet`, and pattern invalidation.
- Added a separate `lazy-layers-cache/cloudflare-events` entrypoint and Queue consumer example for Workers Builds and KV namespace lifecycle events.
- Added application invalidation publication from both Worker bindings and Node.js REST, with a separate Queue consumer that retries KV deletions.
- Added Hono examples for both Cloudflare Workers and Node.js, plus a Cloudflare KV guide in the Fumadocs site.
- Added Worker/Node interoperable HC1 MessagePack and adaptive gzip for KV values, using the existing serializer's 1 KiB gzip floor and 15% minimum saving. The Worker decoder is bounded and compression can be disabled. Compression changes stored bytes, not KV operation counts.

### Changed

- Removed the duplicate Mintlify documentation tree and configuration. `documentation/content/docs` is the only documentation source.

### Compatibility

- Redis remains available. An explicit KV selection replaces Redis L2 and does not implicitly connect to `REDIS_URL`. An explicit Redis configuration may still provide the Redis event bus.
- Cloudflare KV is eventually consistent and has no atomic lease or key-level Event Subscription. The transaction API remains Redis-only.

## 0.5.3

### Added

- Added the opt-in `lazy-layers-cache/transactions` subpath with a primary-only
  Redis operation store, bounded dispatch gate, canonical payment fingerprints,
  explicit coordination outcomes, and a versioned cached-Lua state machine.
- Added a ticketing example and recovery tests covering independent seat
  resource locking, provider idempotency, crash recovery, and duplicate retries.
- Added bounded, read-only Redis capability discovery with supported,
  unavailable, and unknown states plus reconnect invalidation.
- Added `bench:representations` to compare HC1, V8 JSON, HASH-shaped payloads,
  and optional live Redis memory usage without changing server configuration.
- Added `bench:transactions` for coordination latency, throughput, event-loop,
  and memory observations against a local adapter or an explicitly supplied
  Redis primary.

### Changed

- Redis cache lease release, renewal, publication, and coherent snapshots use
  registered scripts when the client supports them, with `NOSCRIPT` recovery
  and no replay of ambiguous transport failures.
- Redis L2 now prefers native TTL and operator-managed eviction. The sorted-set
  namespace catalogue is opt-in with `useIndex: true`, or selected when
  `levels.L2.maxEntries` is explicitly configured. Its entry limit is a
  bounded, best-effort namespace cache policy under concurrent writers, not a
  transaction quota.
- L1 and L2 write codecs can be selected independently with `levels.L1.codec`
  and `levels.L2.codec`. Existing tagged HC1 values remain readable and no
  native HASH/JSON representation is enabled by default.
- Cache publication rejects a stale lease without promoting the value to L1,
  stale state, or a peer success event. Redis failures remain ordinary cache
  fail-open outcomes.

### Compatibility and safety

- Transaction coordination never consults or populates L1, uses cache events,
  or falls back to `getOrSet`. All instances handling one operation must share
  one authoritative Redis primary/shard and durable database.
- A Redis lease, Lua script, or provider idempotency key cannot provide
  exactly-once effects across Redis, a database, and an external payment
  provider. Unknown outcomes require durable/provider reconciliation.
- Existing deployments that depend on the namespace index can retain
  `useIndex: true` during migration. The library never changes Redis `CONFIG`
  or the server-wide eviction policy.

## 0.5.2

### Added

- L1 now retains serializer wire values, applies byte-aware admission, and
  participates in a shared, pressure-aware process memory budget.
- Added bounded origin-loader and L2-operation queues to keep dependency
  outages from creating unbounded local work.
- Added release regressions plus reproducible memory, herd, and synthetic
  pressure benchmarks that run in CI.
- Managed Redis setup now validates the Redis 6+ core baseline through
  `INFO server` and returns classified version, ACL, command, or transport
  failures without copying raw server responses into errors.

### Changed

- Redis L2 promotions reuse the encoded payload and preserve the remaining
  Redis TTL when populating L1.
- L2 and peer values bypass L1 promotion while the local budget is pressured
  or full, emitting `promotion:bypassed` without blocking a successful L2 read.
- Redis Pub/Sub reconnects explicitly resubscribe and discard queued
  pre-disconnect deliveries before L1 trust is restored.
- Managed ioredis clients enable auto-pipelining, readiness checks, finite
  command timeouts and retries, and disable offline command queues and
  uncertain command replay. Injected clients remain caller-owned and unchanged.
- Built-in L1 reads now return a decoded copy rather than preserving object
  identity. Custom `CacheStore` implementations keep their value-based contract.

### Fixed

- Local and remote invalidations fence in-flight loads and L2 promotions so an
  older result cannot repopulate an invalidated key.
- Redis pipeline command errors now fail the surrounding cache operation.
- Retry queues preserve immutable event snapshots and never evict an event
  while it is being published.
- Expired L1 entries and stale fallbacks release their accounted memory.
- Fail-safe snapshots retain only immutable encoded bytes and participate in
  the same pressure-aware budget as fresh built-in L1 entries.
- NATS consumer and subscription teardown is deadline-bounded so a stuck
  JetStream close cannot hold process shutdown indefinitely.

### Compatibility

- Redis Search, vector indexes, embeddings, semantic caching, payload indexing,
  and AI connection setup are not part of the v0.5.2 core path.
- Redis `CLIENT TRACKING`, Redis Cluster certification, native Redis value
  layouts, and alternative L1 replacement algorithms remain later roadmap work.
- Set `levels.L1.autoEvict.enabled: false` to disable adaptive pressure sampling,
  or `levels.L1.admission.enabled: false` to disable admission competition. The
  configured byte ceiling remains enforced.

### Changed

- `getOrSet` coordinates both cold and expired keys automatically with Redis L2.
  RedisStore renews active leases with a token-checked Lua operation. Waiters retry
  released locks and recheck the cache after acquisition before loading.
- **Contention timeout behavior changed:** the default wait budget is now derived
  from `max(lock ttlMs, loader hardMs) + pollMs` (10,050 ms with defaults).
  At the deadline, eligible stale data is returned or `DistributedLockTimeoutError`
  is thrown. Set `distributedLock.onTimeout: 'load'` to restore the prior unlocked
  fallback. Explicit wait budgets are still honored.
- Detected lease loss aborts the loader signal and discards late loader results.
  `DistributedLockLostError` is exported for calls without eligible stale data.
  Custom locking stores may implement optional `renewLock` to extend their leases.
- Added `lock:timeout` events and the `lock-timeout` stale fallback reason.
- In-flight lifetime now adapts to the wait and loader budgets instead of expiring
  at five seconds during a healthy slow load. Explicit lifetimes remain supported.
- Finishing an older in-flight operation no longer removes a replacement entry.


## 0.5.0

### Breaking

- **NATS client migrated to the modular `nats.js` v3 packages.** The `nats` package
  is deprecated upstream ("Package moved. Use `@nats-io/transport-node`") and has
  been replaced by `@nats-io/transport-node` (connection) and `@nats-io/jetstream`
  (JetStream mode). If you inject your own connection via `NatsEventBus`'s
  `connection` option, build it with `connect()` from `@nats-io/transport-node`
  instead of from `nats` — a v2 `NatsConnection` is no longer accepted.
- `NatsEventBusOptions.connectionOptions` is now typed as `NodeConnectionOptions`
  (from `@nats-io/transport-node`) rather than `ConnectionOptions`. The option
  names are unchanged; only the TLS field is narrowed to the Node transport shape.
- **Minimum Node.js is now 20** (`engines: "20 || >=22"`), following `ioredis@6`
  and `lru-cache@11`.

The `NatsEventBus` public API — `mode`, `subject`, `jetstream.*`, `retryQueue`,
`connect` / `publish` / `subscribe` / `healthCheck` / `disconnect` — is unchanged.

### Dependency updates

- `nats@2` → `@nats-io/transport-node@3` + `@nats-io/jetstream@3`
- `amqplib@1` → `@2`. Note the upstream breaking change: `heartbeat: 0` now
  *disables* heartbeats instead of deferring to the server's suggested value.
  amqplib now bundles its own TypeScript types, so the `@types/amqplib`
  devDependency was dropped.
- `ioredis@5` → `@6`. ioredis 6 defaults to **RESP3** (`protocol: 3`). Reply
  shapes are unchanged by default because `replyMapping` defaults to `"legacy"`,
  but RESP3 requires Redis 6.0+ — pass `protocol: 2` to your own client if you
  talk to an older server. `lazy-layers-cache` never constructs a Redis client
  itself, so this only affects the instance you pass in.
- `msgpackr@1` → `@2`, `lru-cache@11.3` → `@11.5`
- Dev: `typescript@5` → `@7`, `@types/node@25` → `@26`

### Fixes

- `RedisStore.trimIndex` now passes the `zrange` stop index as a string, matching
  ioredis 6's narrowed typings.
- The CommonJS build uses `moduleResolution: "Bundler"`. The previous `"Node"`
  (node10) setting could not read the `exports` maps the `@nats-io` packages ship,
  and node10 resolution was removed outright in TypeScript 7.
- `redisEventBus` imported `ioredis`'s default export without using it, pulling
  the client into the runtime graph for a type-only need. It is now `import type`.

## 0.4.0

### Observability dashboard (opt-in, zero new dependencies)

- New `observability` option. Set `observability: true` to serve a live dashboard
  at `/observelazyily` (standalone `node:http` server on `127.0.0.1:7077` by
  default), or pass an options object. Disabled by default — zero hot-path cost
  when off.
- Five navigations: **Overview** (live metrics), **L1/LRU**, **L2/Redis**
  (Redis-Insight-style nested key tree), **Event Stream** (live SSE feed), and
  **Config**.
- **Per-key serialized-vs-in-memory size comparison** with compression ratio and
  wire encoding, for both L1 and L2.
- Live event feed is an in-memory, bounded ring buffer streamed over SSE — it is
  **never persisted** to Redis or disk.
- HTTP Basic auth with default credentials `lazydev` / `lazydev`. A one-time
  "dev/staging only" notice is logged on enable (`quiet: true` to silence).
- Mountable handler via `cache.getObservabilityHandler()` for existing
  Express/Fastify/raw-http servers (use `server: false`).
- Full environment-variable configuration (`LAZY_OBS_*`), precedence
  `option > env > default`.

### Prometheus

- Built-in Prometheus exposition endpoint at `{route}/metrics` (enable with
  `observability.prometheus`). Metrics are labeled by `level`/`kind`/`result`
  only — never by cache key — keeping series cardinality bounded. `public: true`
  allows unauthenticated scrapes.

### Telemetry

- Raw event stream published to a `node:diagnostics_channel` named
  `lazycache:cache:event` for OpenTelemetry/APM, guarded by `hasSubscribers` so it
  is a single boolean check on the hot path when nothing is attached. New
  `subscribeTelemetry` / `publishTelemetry` / `TELEMETRY_CHANNEL_NAME` exports.

### Store introspection

- New `InspectableStore` interface and `inspect()` on `MemoryStore` (via `peek()`
  — never disturbs LRU order) and `RedisStore` (cursor-paginated `SCAN`).
- New serializer helpers: `inspectBuffer`, `estimateValueBytes`, `sizeSavings`.
- New `./observability` package export subpath.

## 0.3.0

- New `set` invalidation event type. When a `getOrSet` loader returns a value, the cache broadcasts the value over the event bus so every connected peer populates its L1 — peers no longer need to repeat the loader call.
- New `HybridCacheOptions.broadcastSet` (default `true` when an `eventBus` is configured). Set `false` to keep the older delete-only fanout semantics.
- New observability events: `set:broadcast` and `set:received`.
- Direct `cache.set()` calls still do not broadcast — only `getOrSet` loader successes do.
- Public type export: `SetEvent`.

## 0.1.6

- Relaxed lru-cache dependency to avoid ETARGET install failures on deploy environments.
- No runtime API changes.
