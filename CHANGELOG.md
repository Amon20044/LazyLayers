# Changelog

## Unreleased

## 0.5.2

### Added

- L1 now retains serializer wire values, applies byte-aware admission, and
  participates in a shared, pressure-aware process memory budget.
- Added bounded origin-loader and L2-operation queues to keep dependency
  outages from creating unbounded local work.
- Added release regressions and a reproducible memory benchmark.

### Changed

- Redis L2 promotions reuse the encoded payload and preserve the remaining
  Redis TTL when populating L1.
- Redis Pub/Sub reconnects explicitly resubscribe and discard queued
  pre-disconnect deliveries before L1 trust is restored.

### Fixed

- Local and remote invalidations fence in-flight loads and L2 promotions so an
  older result cannot repopulate an invalidated key.
- Redis pipeline command errors now fail the surrounding cache operation.
- Retry queues preserve immutable event snapshots and never evict an event
  while it is being published.
- Expired L1 entries and stale fallbacks release their accounted memory.

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
