# Changelog

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
