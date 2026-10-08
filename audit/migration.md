# Compatibility, configuration and rollout

Existing package entrypoints, cache/store/loader signatures and HC1 write formats are preserved. No production dependency is added. The changes address incorrect publication, decoding and resource-retention behavior; callers must review the following operational changes before release.

## Operational changes

- `inflight.maxWaiters` is additive and defaults to 10,000 outstanding same-key followers across one cache. Overflow throws `InflightOverloadError`; it does not start another loader. A per-call value can tighten, but cannot exceed, the constructor budget. Configured 100,000-caller simulations explicitly provision 100,000 followers and remain subject to test heap/time/RSS limits.
- In-flight lookup occurs before the asynchronous L1/L2 miss path when a same-key leader already exists, and is rechecked after the read. It coalesces followers' L2 work as well as origin work. Expiry pruning is lazy per queried key with bounded maintenance.
- Initialized multi-instance stampede guarantees assume `await cache.ready()` before serving traffic. Startup/subscription recovery can fence an in-progress fill and cause another load; the original caller can still receive its result. The pre-coordination leader count remains bounded even when the origin queue is explicitly disabled; configure finite counts to provision a larger authorized experiment.
- Cache closure is terminal for new operations (`CacheClosedError`). Already active loaders that ignore abort may return their original result within the original hard deadline; closed caches never publish that result. Existing origin queued-close error behavior is preserved. Active origin/L2/follower reservations remain visible until the actual retained work settles.
- `decodeLimits` configures built-in internal reads: default encoded and expanded limits 25 MiB, maximum depth 128, maximum collection length/aggregate values 1,000,000. Invalid UTF-8, malformed MessagePack/JSON/HC1/LLK, unsupported codec records and oversized records become internal misses. Valid encoded `null` remains a hit. Public one-argument Node/portable deserialization retains its legacy compatibility behavior; pass limits/use strict hit/miss helpers at untrusted boundaries.
- Strict internal binary decoding copies returned bytes. Mutating a binary field returned by standalone MemoryStore `get` or `inspect` no longer changes retained cache state. The public no-option legacy readers keep their original input-view behavior.
- Standalone store `getOrSet` methods are low-level read/load/write helpers. They do not inherit HybridCache's singleflight or origin/follower bounds; route application loading through `setupCache`/`HybridCache` for those controls.
- Redis v2 snapshot Lua now requires `STRLEN` in addition to the existing GET/PTTL/script permissions. It rejects oversized values server-side before returning their bytes. Legacy/minimal/custom clients cannot promise the same network-buffer protection. Rolling deployments should update ACLs before upgrading readers.
- `eventNamespace` and `keyTypes` are additive event metadata. Managed `setupCache` sends and accepts its normalized namespace. Two managed namespaces sharing a custom channel no longer exchange unscoped values. Low-level clients can explicitly choose a scope. A scoped receiver rejects old untagged events: upgrade/tag publishers before relying on scoped propagation, or use separate channels and clear old L1 state during rollout.
- L2-backed peer set broadcasts are hints: subscribers read their own current authoritative L2 snapshot and apply its remaining TTL. The supplied event value cannot overwrite newer protected state. This adds a bounded Redis read on peer priming and intentionally rejects peer-only values absent from that receiver's L2. L1-only peers retain their existing payload-based semantics within the configured event scope.
- Event decoding bounds fanout at 4,096 keys and key/pattern/source/id/scope text at 64 KiB by default. Invalid deliveries, queue overflow, handler failures and observed subscription gaps invalidate local trust; recovery conservatively flushes before trusting L1 again.
- Queue settings now reject non-finite, fractional or negative limits where unsupported. RabbitMQ prefetch must be 1–65,535; zero no longer silently enables unlimited deliveries. Retry `maxSize` retains its waiting-backlog meaning plus at most one active publisher; `maxBytes` includes both waiting and active records. Clear retains active accounting until actual settlement.
- `EventBusHandlerQueue.enqueue(event, encoded)` reconstructs an owned wire snapshot. If supplied, `encoded` must match `encodeInvalidationEvent(event)`; corrupt supplied bytes do not dispatch the original object. Custom encodings use the additive `enqueueEncoded(raw, decoder)` entrypoint. This prevents mutable or inflated caller objects bypassing the queue's retained-byte bound.
- Version tombstones cap at 10,000 entries and 2 MiB and participate in shared accounting. If safe generation tracking cannot be retained, `generationTrackingSaturated` becomes true and that cache object stops versioned caching until recreated. Evicting tombstones back to generation zero would resurrect stale data, so saturation is deliberately conservative.
- Accepted lower-generation deletes invalidate local copies even when versioning is disabled. With versioned storage, a restarted peer's lower counter is ambiguous and triggers the same conservative bypass until the cache instance is recreated.
- Observability SSE defaults to 64 clients per handler and 64 KiB per frame (`maxStreamClients`, `maxStreamEventBytes`; environment overrides `LAZY_OBS_MAX_STREAM_CLIENTS`, `LAZY_OBS_MAX_STREAM_EVENT_BYTES`). Slow streams drop events until `drain`, and additional clients receive 503. Collector events default to a 64 KiB snapshot cap; oversized metadata is visibly marked `data.truncated`. These bounds are not process RSS limits.
- The Worker facade now has terminal close and guards delayed read/fill/write promotions against local invalidation. Borrowed reusable L1 stores remain usable after facade close. Workers KV does not provide conditional publication: shared delayed writes can still complete out of order, and Worker origin/waiter/byte budgets remain deployment limitations.
- Redis v2 preserves unusual logical key identity (including lone UTF-16 surrogates) without accidental UTF-8 replacement aliases. Redis prefixes/event scopes must be well-formed Unicode. Legacy numeric/string and reserved lock namespace behavior remains a documented weaker path; migrate to v2 for stronger isolation/publication guarantees.

## Explicit bounded configuration

```ts
import { MemoryBudget, setupCache } from 'lazy-layers-cache';

const cache = await setupCache({
  namespace: 'orders-v1',
  redis: { url: process.env.REDIS_URL!, required: true },
  memoryBudget: new MemoryBudget({ maxMemory: '64MiB' }),
  inflight: { maxEntries: 1024, maxWaiters: 10000 },
  originLoad: { maxConcurrent: 16, maxQueued: 128, queueTimeoutMs: 100 },
  timeouts: { hardMs: 1000 },
  decodeLimits: { maxEncodedBytes: 4 * 1024 * 1024, maxDecodedBytes: 8 * 1024 * 1024, maxDepth: 64 },
  failSafe: { enabled: false },
});
```

Use the actual `SetupCacheOptions` shape when integrating; options are top-level, matching the managed constructor. `failSafe:false` is appropriate when stale data is not permitted by the application's freshness/security contract. Origin limits apply to each cache process; database pool limits and tenant fairness require application/deployment controls. A ledger of 64 MiB is not a promise that process RSS is 64 MiB.

## Deployment and rollback

1. Run the documented bounded suites against the same Node/native-codec/platform versions as the deployment. Review failed readiness gates and baseline/after CPU/latency trade-offs.
2. Add required Redis ACL command permissions and preserve the existing v2 key layout; do not mix legacy/v2 writers assuming dual reads. The pre-existing staged layout migration still applies.
3. Stage publishers/scopes first, then receivers. For strict applications use disjoint channels/prefixes, clear process-local state during replacement, and retain an authoritative freshness policy. Ordinary Pub/Sub is not a durable outbox.
4. Canary the unchanged API with explicit memory/origin/follower/decode budgets. Monitor overload/decoder misses, active retained work, L1/L2 hits, origin queries, RSS, TTL/freshness and error recovery.
5. Roll back by deploying the previously pinned package and recreating cache instances; ordinary HC1 records remain readable by the original version. Scope-tagged metadata is additive, but the original implementation has known isolation/race/resource defects. Clear process-local state on rollback and retain disjoint channels. Do not silently restore weaker publication assumptions for correctness-sensitive data.

No release/registry push or production deployment is performed by this audit. The source, tests, raw results and release gates are the reviewable local deliverable.
