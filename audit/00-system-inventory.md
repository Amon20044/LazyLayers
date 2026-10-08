# System inventory

Baseline: commit `ca9c02a04349a89278cd81b5b25d0000503cc5a3`, package `lazy-layers-cache@0.6.2`. The audit began from a clean `main` checkout. The original 268 tracked files and built ESM output were preserved outside the working tree for equivalent baseline runs. Final source/build hashes are recorded in `raw/build-manifest.json` when validation is complete.

## Runtime and packaging

| Item | Observed implementation |
| --- | --- |
| Language | TypeScript, strict mode, ES2022 target, NodeNext modules |
| Supported Node | `20 || >=22`; existing CI tests Node 20, 22, 24 on Linux |
| Local audit runtime | Node 24.21.0, npm 12, macOS, Apple M5, 10 logical CPUs |
| Distribution | ESM `dist`, CommonJS `dist-cjs`, declarations and source maps; `sideEffects:false` |
| Root build | `tsc`, then `scripts/build-cjs.cjs`; package verification exercises exports |
| Dependencies | ioredis, lru-cache, msgpackr, lz4-napi, snappy, amqplib, NATS transport/JetStream |
| Native compatibility | LZ4/Snappy native bindings; native Zstandard depends on Node availability. Actual selected wire codec is recorded by experiments. |
| Node 20 dependency qualification | Live Node 20.20.2 tests passed, but installed `@nats-io/nuid@3.0.0` declares Node >=22. Dev-only Wrangler/Miniflare/KV tooling also declares >=22. Functional coverage does not waive declared dependency support. |
| Other applications | Vite marketing site, Next/Fumadocs documentation, Hono examples and Cloudflare Worker examples |
| Release pipeline | `prepublishOnly` runs clean/typecheck/build/test/package verification; CI also builds site and documentation. No automated registry publication workflow is present. |

Dependency versions and lockfiles were inspected. No production dependency was added or upgraded in this audit. Audit tooling uses Node standard library, installed codecs, and disposable official Docker services.

## Public surface

`createCache`, `LazyLayersCache`, `HybridCache`, managed `setupCache`, MemoryStore, RedisStore, Node CloudflareKVStore and KV REST client are exposed at the root/cache entrypoints. Cache operations include `get`, `getOrSet`, `set`, `has`, `delete`, `invalidate`, pattern invalidation, `clear`, `size`, readiness, health, prewarming, events and close. Optional encoded/atomic publication capabilities are separate adapter contracts.

Subpaths: `types`, `cache`, `event-bus`, `cloudflare`, `cloudflare-events`, `observability`, `transactions`. Root exports preserve existing names and signatures; additive decoder limits, event scope/types, follower budgets, and typed shutdown/overload errors are documented in `migration.md`.

The Worker cache facade is a distinct implementation, not the full Node hybrid coordinator. The separate transaction API coordinates metadata against an explicit authoritative primary and does not execute application side effects or use cache stale/fail-open behavior.

## Module ownership and actual behavior

| Area | Source | Inventory and limits |
| --- | --- | --- |
| Access/setup | `src/index.ts`, `src/setup.ts`, `src/types` | Generic string/number keys; managed namespace/prefix/channel; startup timeout/health/capability discovery; no authenticated tenant context |
| L1 | `src/cache/memoryStore.ts` | Encoded buffers in lru-cache; count cap; TTL-on-access; approximate frequency/byte admission; incremental shared ledger; expensive full size/inspection cleanup remains off ordinary lookup |
| Memory | `memoryBudget.ts`, `memorySignals.ts` | Shared category reservations and pressure eviction; cgroup/process signals; ledger estimates are not actual retained heap/RSS limits |
| L2 | `redisStore.ts`, `redisPipeline.ts` | Reused caller/managed client; encoded Redis values; GET+PTTL snapshot; optional index; SCAN/UNLINK batches; v2 same-slot data/lease keys |
| KV | `cloudflareKvStore.ts`, `cloudflareKvRest.ts`, `cloudflare/kvWire.ts` | LLK expiration envelope plus portable HC1; KV reads/writes/listing; no Redis-equivalent atomic publication capability; platform eventual consistency |
| Local coordination | `hybridCache.ts` | Per-key singleflight and mutation guards; finite leaders, origin admission, negative and stale copies; bounded key/revision/event metadata |
| Leases | `distributedLock.ts`, Redis Lua in `redisStore.ts` | SET NX PX, random ownership, bounded lease lifetime and renewal, safe unlock; v2 publication checks current owner atomically with SET |
| Origin protection | `originLoadGate.ts` | Count/byte/deadline bounds and controlled overload; no adaptive concurrency, tenant fair scheduling, request priority or global across-process origin limit |
| L2 protection | `l2OperationGate.ts`, `circuitBreaker.ts` | Bounded active/queued commands and queue bytes; command deadlines do not free capacity until actual command settles; one half-open probe |
| Invalidation | `eventCodec.ts`, Hybrid event handlers | Direct key/pattern events, dedupe, generation tracking, optional scope/type tags, authoritative peer priming and reconnect flush |
| Transports | `redisEventBus.ts`, `rabbitmqEventBus.ts`, `natsEventBus.ts` | Redis Pub/Sub, Rabbit fanout/topic/direct with optional durable consumer, NATS Core/JetStream; retry/handler queues, lifecycle health/status/reconnection |
| Serialization | `serializer.ts`, `portableSerializer.ts`, `codecs.ts`, `decodeValidation.ts` | HC1 MessagePack/JSON, gzip/Zstd/LZ4/Snappy, bounded internal decode with structural and UTF-8 validation; legacy public decoding compatibility |
| Observability | `src/observability` | Fixed metric label categories, counters, optional ring event log/dashboard/SSE, diagnostics_channel/OTel bridge; raw events can contain keys/error text |
| Platform events | `src/cloudflare-events`, `cloudflare/invalidationQueue.ts` | Typed platform event validation, queue-message invalidation, Node REST publisher; no claim that ordinary KV/Pub/Sub events form a durable globally ordered coherence protocol |
| Transactions | `src/transactions` | Bounded primary transport/gate, tenant tuple digests, Lua operation state machine, fencing/renewal, durable-identity references, strict uncertainty handling |

## Important defaults

Raw cache defaults: TTL 1 hour, L1 1,000 entries, tracked in-flight keys 1,024, hard loader deadline 10 s, negative TTL 10 s / 10,000 entries, stale retention 30 s / 1,000 entries / 16 MiB. Origin defaults: 32 active, 1,024 queued, 1 s queue wait. L2 defaults: 64 active, 1,024 queued, 32 MiB queued accounting, 250 ms queue wait, 2 s command deadline. Lease default: 10 s with 50 ms polling. Circuit breaker: 3 failures and 30 s cooldown. Explicit disable flags can weaken these controls.

Managed setup uses a shorter L1 TTL and finite startup/Redis command limits, disables unsafe client offline buffering/replay by default, and derives a scope from the namespace. Read `src/setup.ts` rather than assuming raw constructor and managed defaults are identical.

## Test and infrastructure inventory

Original offline suite: 343 passed, 13 live-service skips, 0 failed. Original real Docker suite: 356 passed, 0 skipped, 0 failed. Raw logs and platform/resource metadata are retained. New regressions were run against the frozen original module before fixing the code; final aggregate counts belong in `12-production-readiness.md`.

`audit/compose.yml` owns disposable Redis 7, RabbitMQ 3, NATS 2.10/JetStream containers with random loopback ports. Container memory totals 736 MiB; CPUs total 2.5. Local runners bound subprocess wall time, heap, aggregate sampled RSS and output; teardown removes only their UUID project and its volumes. No existing application/production resource was reused.

Ancillary source, tests, examples, package/export configuration, lockfiles, CI, release documentation, site and documentation tree were inventoried. Cache/runtime modules receive detailed correctness analysis; visual website content is outside cache performance measurement. External claims are sourced in `06-research-comparison.md`.

## Undocumented or unverified behavior

- Raw stale retention is renewed when a fresh value is remembered; it is not a universal exact `normal expiration + 30 s` boundary.
- Direct `set` does not automatically provide every application with a read-after-write event propagation policy. Loaded-value broadcast and invalidation are separate operations.
- Local version generations are not a durable global source version; restart and delivery loss require authoritative recovery.
- Redis v2 atomic owner publication does not certify Redis asynchronous failover or business exactly-once correctness. Legacy/custom adapters have weaker guarantees.
- Redis numeric and string keys can alias according to the existing stringification contract; local/event type tags prevent guessing a different local key type.
- Memory reservations describe retained cache-owned data estimates; engine objects, codec temporaries, caller request objects, client buffers and open-cache LRU high-water capacity need separate measurements.
- Worker facade memory/origin/coordination limits differ from Node's. Its remaining gates are reported explicitly.
- Default dashboard credentials, TLS/ACL/tenant authentication, source freshness requirements and durable origin idempotency are deployment/application responsibilities.
