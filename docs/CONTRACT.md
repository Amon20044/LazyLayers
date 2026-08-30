# Docs contract — verified facts and house style

Every writer works from this file. If a claim is not derivable from here or from
`src/`, do not write it. When you need a fact this file does not cover, read the
source and add it here rather than guessing.

## Ownership

You write **page bodies only**. Do not touch `docs.json`, `docs/CONTRACT.md`,
`docs/AGENTS.md`, or any page outside your assignment. Navigation is owned by
the coordinator.

## Verified constants

| Constant | Value | Source |
|---|---|---|
| `DEFAULT_CACHE_TTL_MS` | `60 * 60 * 1000` (1 hour) | `src/cache/defaults.ts:1` |
| `DEFAULT_L1_MAX_ENTRIES` | `1_000` | `src/cache/defaults.ts:2` |
| `DEFAULT_INFLIGHT_TTL_MS` | `5_000` | `src/cache/defaults.ts:3` |
| `PRODUCTION_L1_TTL_MS` | `10_000` | `src/setup.ts` |
| `PRODUCTION_INFLIGHT_MAX_ENTRIES` | `10_000` | `src/setup.ts` |
| `PRODUCTION_BROADCAST_SET_MAX_BYTES` | `32 * 1024` | `src/setup.ts` |
| `PRODUCTION_STARTUP_TIMEOUT_MS` | `10_000` | `src/setup.ts` |
| `DEFAULT_STALE_TTL_MS` | `30_000` | `src/cache/defaults.ts` |
| `DEFAULT_NEGATIVE_TTL_MS` | `10_000` | `src/cache/defaults.ts` |
| `DEFAULT_NEGATIVE_MAX_ENTRIES` | `10_000` | `src/cache/defaults.ts` |
| `DEFAULT_LOADER_HARD_TIMEOUT_MS` | `10_000` | `src/cache/defaults.ts` |
| `GZIP_MIN_BYTES` | `64 * 1024` (64 KB) | `src/utils/serializer.ts:33` |
| Gzip kept only when it saves | at least 15% | `src/utils/serializer.ts` |
| Wire prefixes | `HC1M` msgpack, `HC1G` gzip, `HC1J` json | `src/utils/serializer.ts` |
| Observability port / route | `7077` / `/observelazyily` | `src/cache/hybridCache.ts` |
| Observability env user var | `LAZY_OBS_USER` (NOT `..._USERNAME`) | `src/observability/` |

## The single most important accuracy rule

**L1 has exactly two dials: `maxEntries` and `ttlMs`.**

`MemoryStore` wraps `lru-cache` with only `max` and `ttl` set
(`src/cache/memoryStore.ts:29`). There is:

- no configurable eviction policy (it is LRU, always)
- no byte-based sizing (`maxSize`, `sizeCalculation` are not exposed)
- no LFU, FIFO, or TTL-only mode

Never write "choose an eviction policy". Write "size the entry count". Sizing
guidance must be expressed as *entries x approximate value size = memory*, and
must say it is an estimate.

## Option surface (complete, from source)

`LazyLayersCacheOptions<K, V>` is an alias of `HybridCacheOptions<K, V>`
(`src/cache/hybridCache.ts:960`), which extends `CacheOptions`.

From `CacheOptions` (`src/types/core.types.ts:57`):
`ttlMs`, `levels` (`{ L1?: { maxEntries?, ttlMs? }, L2?: { maxEntries?, ttlMs? } }`),
`inflight` (`{ enabled?, ttlMs?, maxEntries? }`),
`negativeCache` (`{ enabled?, ttlMs?, maxEntries? }`),
`failSafe` (`{ enabled?, staleTtlMs? }`),
`timeouts` (`{ softMs?, hardMs? }`),
`versioning` (`{ enabled? }`),
`distributedLock` (`{ enabled?, ttlMs?, waitTimeoutMs?, pollMs? }`).

From `HybridCacheOptions` (`src/cache/hybridCache.ts:56`):
`l1`, `l2` (a `CacheStore` or `false` to disable), `eventBus`, `source`,
`subscribeToEvents`, `resilience` (`{ l2CircuitBreaker?, eventBusCircuitBreaker? }`,
each `{ enabled?, failureThreshold?, cooldownMs? }`), `distributedLock`, `events`,
`eventDedupeMaxEntries`, `eventDedupeTtlMs`, `logging`, `broadcastSet`,
`broadcastSetMaxBytes`, `observability`.

`RedisStoreOptions` extends `CacheOptions` with: `prefix`, `indexKey`, `useIndex`,
`scanCount`, `batchSize`, `deleteStrategy` (`'unlink' | 'del'`).

## Bus constructors (exact signatures)

```ts
new RedisEventBus(redis, channel, { retryQueue?, handlerConcurrency?, logging? })
new RabbitMQEventBus(exchange, { url?, exchangeType?, durable?, persistent?,
  durableInvalidationMode?, prefetch?, routingKey?, queueName?, exclusiveQueue?,
  autoDeleteQueue?, retryQueue?, logging? })
new NatsEventBus({ mode?, connection?, connectionOptions?, subject?, retryQueue?,
  jetstream?, logging? })
```

`NatsJetStreamOptions`: `stream`, `durableName`, `storage` (`'file' | 'memory'`),
`maxAgeMs`, `maxMsgs`, `ackWaitMs`, `maxDeliver`, `ensureStream`, `ensureConsumer`.
`EventBusRetryQueueOptions`: `enabled`, `maxSize`.

Every bus needs `await bus.connect()` before use.

## Behaviour that is on by default

State these as already-on, never as things to enable:

- **In-flight dedupe.** Concurrent callers for one key share one loader call.
- **Fail-open.** An L2 or bus failure degrades, it does not throw.
- **L1.** Created automatically when you do not pass `l1`.
- **Self-event filtering.** `event.source === this.source` returns early, so a
  server never applies its own broadcast.
- **Event dedupe by ID**, and **per-key generation counters** that drop events
  older than what already landed.
- **`broadcastSet`.** Gated on `this.options.broadcastSet !== false`, so it is on
  whenever an event bus is configured.
- **Negative caching.** A 10 second miss capped at 10,000 entries.
- **Fail-safe stale fallback.** A 30 second stale window.
- **Hard loader timeout.** A 10 second ceiling.
- **Distributed per-key locking.** Used automatically when L2 implements the
  lock interface. It is a no-op without a lock-capable L2.

## Managed setup

`setupCache` in `src/setup.ts` is the production entry point. It resolves Redis
from a passed client, a passed URL, or `REDIS_URL`; creates Redis L2 and Redis
Pub/Sub; performs health and subscription readiness checks; and returns
`ManagedLazyLayersCache` with idempotent cleanup. With no Redis configuration it
resolves to L1 only unless `redis.required` is true.

It adds bounded defaults that the low-level constructor does not: a 10 second
L1 TTL, 10,000 tracked in-flight keys, and a 32 KB set-broadcast ceiling.

## The lazy fan-out (give this prominence)

When a `getOrSet` loader resolves, the value is written locally and then
published as a `set` event carrying the value itself. Every peer runs
`applyRemoteSet`, which writes into its own L1 and clears that key's negative
entry and in-flight promise. One server pays for the query, the rest get it free.

Two caveats that must appear wherever this is explained:

1. **Only `getOrSet` broadcasts.** A direct `cache.set()` writes L1 and L2 and
   emits a local event, but never publishes to the bus.
2. **`broadcastSetMaxBytes` has no default.** Without it, a large value is
   broadcast in full to every server. Over the limit, the event is skipped and
   `set:broadcast-skipped` is emitted with `reason: 'max-bytes'`.

## Known sharp edges (do not paper over)

- The event-bus circuit breaker and the retry queue do not compose.
  `publishInvalidation` returns before `eventBus.publish` when the breaker is
  open, so the retry queue never buffers that event.
- RabbitMQ's handler does `void Promise.resolve(handler(event))`, so it does not
  await. Concurrency is bounded by `prefetch`, which has no default.

## API emphasis

`getOrSet` is the read method to show. `prewarm` is its intent-named alias for
background warm-up. `invalidate` aliases `delete`; `invalidateByPattern` aliases
`deleteByPattern`.

`get`, `set`, `delete`, and `deleteByPattern` exist and may be documented
**only** on `docs/reference/api.mdx`. Do not use them in examples elsewhere.

## Production advice rule

Never tell a reader to turn a safety feature off. Do not write
`inflight: { enabled: false }`, `failSafe: { enabled: false }`, or
`broadcastSet: false` as production advice.

Production tuning means changing **numbers**, not **booleans**: entry counts,
TTLs, byte ceilings, thresholds, and cooldowns, sized to the instance the
process runs on.

## Code sample rules

- **JavaScript is the default tab. TypeScript is the second tab.** Use
  `<CodeGroup>` with the JS block first.
- Files are split, never one mega-file. The canonical layout is in
  `docs/quickstart.mdx` and must be reused verbatim where referenced:
  `src/cache/redis.js`, `src/cache/bus.js`, `src/cache/index.js`, and for
  TypeScript additionally `src/types/user.ts`.
- **No commented-out alternative configuration.** Alternatives belong in
  `<Tabs>`, one tab per bus.
- Every fenced block gets a language tag and a filename where it is a file.
- Steps get `<Steps>`, one `<Step>` per action, small blocks.

## Prose style

- No semicolons in prose. No em dashes or en dashes anywhere.
- Sentence case headings.
- Say **server**, not node. Say **loader**, not factory. Say **store**, not
  driver. Say **L1** and **L2**.
- Do not open a page with "In this guide we will". State the thing.
- No "Note that", no "It is important to", no filler.
- Second person. Active voice.

## Cross-linking

Every page ends with a "Where to next" section: two or three links with a short
reason each. Deep links to a heading use `#the-heading-slug`.

External links open in a new tab. Internal doc links do not.
