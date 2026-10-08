# Primary-source research comparison

Research date: 2026-10-08. Starting repository revision: `ca9c02a04349a89278cd81b5b25d0000503cc5a3` (`lazy-layers-cache` 0.6.2). Source references below name the inspected modules and functions; fixes made during this audit are distinguished in the correctness and before/after reports.

The evidence supports improving the existing library incrementally: preserve encoded L1 storage, local request sharing, finite origin admission, and Redis-side conditional publication. It does **not** establish that a Rust rewrite, a separate routing service, W-TinyLFU, or adaptive concurrency would improve this repository. Their LazyLayers end-to-end effects are **NOT MEASURED** here. Research findings are hypotheses and design constraints, not benchmark results or production certification.

## Required readings and concrete decisions

All eight requested sources were accessed through the internet tool. The papers were read as PDFs, including their implementation and evaluation sections where relevant; the singleflight API was checked against its source.

| Primary source | Finding relevant to this repository | Concrete decision |
|---|---|---|
| [Discord: How Discord Stores Trillions of Messages](https://discord.com/blog/how-discord-stores-trillions-of-messages), 2023, “Data Services Serving Data” | Discord shares concurrent requests for the same database row and routes by channel ID to improve sharing. Its migration changes several components together. | Keep `HybridCache.getOrSet` sharing. Treat routing as an optional application deployment experiment; do not attribute Discord's overall database improvements to routing alone. |
| [Discord: Why Discord Is Switching from Go to Rust](https://discord.com/blog/why-discord-is-switching-from-go-to-rust), 2020, “Read States” and “Implementation, load testing, and launch” | The service experienced GC-related spikes, then changed runtime, maps, metrics, and copying. The tested Go versions were 1.8–1.10. | Profile Node/V8 retained memory, buffer copies, GC, and telemetry here. Historical Go results do not justify changing the library's language or replacing maps with trees. |
| [Discord: How Discord Supercharges Network Disks for Extreme Low Latency](https://discord.com/blog/how-discord-supercharges-network-disks-for-extreme-low-latency), 2022 | Read-heavy storage developed growing disk queues. Discord combined local SSD reads with durable persistent-disk writes and tested failure handling. | Measure origin queues and recovery as well as cache hits. Do not import a storage topology into a Node cache library or confuse serialized-byte savings with origin capacity. |
| [Vattani, Chierichetti, Lowenstein: Optimal Probabilistic Cache Stampede Prevention](https://cseweb.ucsd.edu/~avattani/papers/cache_stampede.pdf), VLDB 2015, §5–6 | XFetch samples an exponential early-refresh gap scaled by measured regeneration duration. Its guarantees concern a specified stochastic model. | Explore opt-in early refresh only after loader-duration and remaining-TTL metadata exist. Continue coalescing, leasing, and bounding refreshes; probabilistic triggering does not enforce mutual exclusion. |
| [Einziger, Friedman, Manes: TinyLFU](https://arxiv.org/abs/1512.00727), [paper PDF](https://arxiv.org/pdf/1512.00727), §3–5 | TinyLFU compares a candidate with an eviction victim using recent approximate frequency. W-TinyLFU adds a recency window; window size affects workload results. | Describe the current fixed single-hash admission history accurately. Compare it with plain LRU and faithful experimental policies before adding implementation complexity. |
| [Kleppmann: How to Do Distributed Locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html), 2016, “Making the lock safe with fencing” | Paused owners and delayed writes can outlive a lease. An external resource must reject obsolete fencing tokens when correctness depends on locking. | Verify publication at the protected Redis state atomically. Do not claim that a random ownership token, safe unlock, or loader `AbortSignal` protects external database writes. |
| [Redis: Distributed Locks](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/), “Correct Implementation with a Single Instance” and failover discussion | `SET NX PX` plus owner-conditional unlock avoids deleting another owner's lock. Asynchronous replica promotion can lose lock state. | Preserve ownership-safe acquire/renew/release and same-slot scripts. Document failover assumptions; do not promote the current single-authority mechanism to a consensus-backed global lock. |
| [Go singleflight API](https://pkg.go.dev/golang.org/x/sync/singleflight), [implementation](https://github.com/golang/sync/blob/master/singleflight/singleflight.go) | Duplicates share the leader's result/error. `Forget` permits a subsequent call to start independently. Completion deletes a call only if it remains the registered call. | Test value/error fan-out and replacement cleanup in `getOrSet`. Expiring an in-flight map entry must not be mistaken for cancellation or for the old loader having stopped. |

## What already exists

The inspected [MemoryStore](../src/cache/memoryStore.ts) owns encoded buffers and uses `lru-cache`. Admission uses 4,096 saturating byte counters indexed by one FNV-style key hash; eight counters are partially aged every eight recorded accesses. Under space pressure, `worthAdmitting` compares estimated frequency per accounted byte with up to eight tail entries. This is a bespoke bounded heuristic. It has no multi-row Count-Min estimate, Bloom doorkeeper, SLRU main region, or unconditional recency window.

`worthAdmitting` can approve against any sampled tail entry, whereas `setEncoded` evicts through `cache.pop()`. The compared entry and actual first victim can differ. This is an admission-quality concern to test, not evidence of a measured benefit from replacement. The fixed history can also conflate unrelated keys. On write-only access, frequency evidence is limited because `record` is called from reads, not all writes. Compare object hits, byte hits, and rejected replacements independently.

[HybridCache](../src/cache/hybridCache.ts) has per-object local in-flight sharing, negative and stale maps, loader timeouts, an [OriginLoadGate](../src/cache/originLoadGate.ts), Redis lease polling, and invalidation trust tracking. The starting revision calls `pruneInflight` before the shared-key lookup and again on the miss path; this scans all tracked calls. Sharing can be expected constant-time in map lookup terms while its surrounding maintenance is linear in the tracked key count. Changes to this path belong in the complexity report and measured before/after evidence.

[RedisStore](../src/cache/redisStore.ts) has owner-conditional Lua publication, lease renewal/unlock scripts, a same-slot v2 data/lease layout, and direct-write/delete scripts that remove an outstanding lease. [RedisEventBus](../src/event-bus/redisEventBus.ts) exposes connection status, and HybridCache distrusts and clears local state around subscription gaps. This is considerably stronger than assuming Pub/Sub reconnection replays missed events, but does not make origin/cache updates transactional.

## Request affinity: useful experiment, no required routing service

The proposed routing hypothesis is: for a skewed workload, preferentially sending an identical normalized logical key to the same cache object reduces cross-instance misses, lease contention, and follower polling enough to offset routing CPU and worker imbalance. This remains **NOT MEASURED** for LazyLayers.

[Karger et al.'s original consistent-hashing paper](https://people.csail.mit.edu/karger/Papers/web.pdf) establishes limited assignment disruption as membership changes. [Mirrokni, Thorup, Zadimoghaddam](https://arxiv.org/abs/1608.01350) add capacity bounds to allocation. Neither result says that evenly allocating distinct keys evenly allocates request CPU for one extremely hot key. That conclusion is a workload-dependent inference.

| Question | Repository-grounded answer |
|---|---|
| Does affinity improve distributed deduplication? | It can place more duplicate calls in one existing in-flight map. With healthy Redis leases already preventing duplicate fills, the incremental value may be fewer lock/poll commands and better L1 locality, rather than fewer origin queries. Measure both. |
| Can it concentrate hot workers? | Yes: all response decoding and promise completion for a hot key can remain on its preferred worker even when origin work is shared. Track maximum/mean per-instance CPU, queue depth, decode bytes, and p99. |
| What if a worker crashes? | The caller needs health-aware remapping. The new worker begins cold; the Redis lease and origin gate still apply. A routing failure must not bypass tenant key normalization or publication protection. |
| What happens during scaling? | Membership changes move responsibility for some keys and discard local sharing continuity. Measure moved keys and moved request volume separately; a few moved hot keys can dominate traffic. Preserve correctness while old and new membership views coexist. |
| What is the rebalancing cost? | Router table rebuilds, cold L1 loads, extra lock contention, and duplicate in-flight leaders. A sorted ring lookup requires approximately `O(log I)` search plus `O(K)` hashing; a simple rendezvous implementation scores `I` workers and takes `O(I + K)` if the key hash is reused and worker identifiers have bounded length. Neither is unconditionally `O(1)`. |
| Where should affinity live? | Start in an existing application gateway, load balancer, or service-client routing layer that already owns health and membership. A library instance cannot transparently redirect arbitrary loader closures between processes. |
| Is Redis already sufficient? | Possibly. If safe Redis coordination already collapses loads and its polling cost is small, affinity may have little benefit. Keep direct library integration as the default. |

[The power-of-two-choices survey](https://www.eecs.harvard.edu/~michaelm/postscripts/handbook2001.pdf) analyzes improved allocation under random-choice and load-observation assumptions. Selecting the less-loaded of two workers can trade some affinity for better balance. Applying the theorem to correlated hot keys, stale load measurements, heterogeneous payloads, or imperfect worker health is an inference requiring tests. Do not add a synchronous remote load probe to every cache hit.

An isolated routing experiment should replay the same seeded uniform, Zipf, hot-key, burst, and shifting-hot-set traces across 2, 10, 50, and 100 logical instances, then compare random/round-robin assignment, stable affinity, and two-choice assignment. Run Redis coordination both enabled and disabled. Simulated instances establish assignment and coalescing effects only; they do not establish multi-process networking, failover, deployment capacity, or independent CPU saturation. Cap each run by request count, deadline, memory, and origin work, and inject membership changes using controlled mock workers.

## Admission and expiration alternatives

The library's byte budget makes variable-value costs central. A request-hit improvement can still reduce byte-hit ratio or spend excessive decode CPU. Any experiment must charge policy metadata, key retention, and ghost history to the same budget `B`, and report admission CPU separately from encoding and decoding.

| Candidate | Cost assumptions and trade-offs | Decision |
|---|---|---|
| Existing LRU with admission disabled | Expected map lookup plus `O(K)` key handling; constant list/index updates. Reads also decode and allocate the value; cost can exceed serialized size `V` for compressed payloads. Scan pollution is a useful control case. | Baseline control; no new policy implementation required. |
| Existing LRU with bounded history | Fixed 4 KiB history, `O(K)` record/hash work, at most eight sampled victims. Size-biased admission may protect many small items while rejecting costly large ones. | Measure current behavior before changing it. |
| Segmented LRU | Two bounded recency regions can separate probationary and reused entries; region sizing changes adaptation. | Consider only if scan/burst traces show an inadequacy in the current policy. |
| FIFO / CLOCK | FIFO avoids hit-time recency movement. CLOCK can need up to `O(N)` candidate scanning in one eviction; bounded scans can require rejection or deferred work. | Useful low-CPU controls; do not promise constant worst-case CLOCK eviction. |
| TinyLFU + LRU | A sized frequency sketch plus aging can improve admission under skew; hash work and reset latency remain costs. | Experimental only; no accuracy guarantees for the current single-hash table. |
| W-TinyLFU | A recency window, main SLRU regions, and frequency admission add state and maintenance. Size changes must account for bytes, not merely entry counts. | No default replacement without consistent trace and end-to-end wins. |
| S3-FIFO | The [original paper](https://juncheng.seas.harvard.edu/publication/sosp23-s3fifo.pdf) uses a small probationary queue, a main FIFO, and ghost history; its threaded results are not Node results. Many simulations ignore variable object size because of slab classes. | Useful future comparison if hit-time policy CPU is measured as material. Charge ghost key memory and validate heterogeneous values here. |

[Caffeine's implementation](https://github.com/ben-manes/caffeine/blob/master/caffeine/src/main/java/com/github/benmanes/caffeine/cache/FrequencySketch.java) uses four small-counter estimates and periodically ages the entire sketch. Reset is linear in sketch size; constant amortized work requires a proportional number of intervening accesses. A Node implementation must additionally control a single event-loop reset stall. Caffeine's [policy evaluations](https://github.com/ben-manes/caffeine/wiki/Efficiency) and adaptive window sizing are evidence for that implementation, not timing or memory measurements for this one.

For heavy-hitter detection, the [original Count-Min paper](https://www.cs.ox.ac.uk/people/graham.cormode/pubs/papers/cm-full.pdf), §3–4, bounds estimation error using independent hash rows, width, depth, and nonnegative updates. The repository's one-hash decaying history does not satisfy those assumptions. A sketch is a useful bounded diagnostic/admission tool, not an exact per-key frequency ledger or a security isolation mechanism. Collision and saturation tests should use long keys, adversarial colliding history buckets, and changing hot sets.

Expiration is a separate concern from replacement:

| Mechanism | Relevant bound | Appropriate use here |
|---|---|---|
| Per-access expiry check | A deadline comparison is bounded; removal and payload release still have costs. | Preserve lookup expiration semantics. |
| Full stale sweep | `O(N)` resident iteration; cheap infrequent diagnostics can tolerate this, repeated request-path sweeps cannot. | First remove any measured unrelated scans from hot paths. |
| Min-heap | `O(log N)` insertion/removal and `O(1)` minimum access. An expiry burst requires work for every expired item. | Only when prompt reclamation is required and metadata/update cost is acceptable. |
| Bucket queue / timing wheel | Bounded placement assumes a defined tick resolution/horizon. A bucket with many expirations is not bounded per-tick work without a drain limit. | An experiment for bounded asynchronous maintenance, with generation checks against overwritten entries. |

Policy evaluation should use identical trace seeds and byte budgets for uniform, Zipf, unique scans, repeated scans, bursts, shifting hot sets, reads, writes, and heterogeneous payloads. Report object/byte hit ratios, origin calls avoided, policy time per access, metadata retained, eviction operations, p99, and maximum event-loop stall. Start with simple controls; implement one advanced contender only if it addresses an observed deficit. Proposed adoption threshold: a repeatable end-to-end gain with confidence intervals, acceptable memory, and no material category regression; the numeric tolerance must be derived from baseline variance, not invented here.

## Stampede strategies and safe publication

| Strategy | What it can establish | What it cannot establish alone |
|---|---|---|
| Local singleflight | One registered leader for identical keys in one map. | A caller-memory bound, global duplicate suppression, or cancellation of a forgotten leader. |
| Redis per-key lease | A shared authority can serialize active fill owners while healthy. | External-origin write ordering or durability across loss of Redis authority. |
| Owner-conditional Redis publication | A live token is checked in the same Redis execution as the cache mutation. | A monotonic source-data version or a fenced mutation in another system. |
| Stale-if-error | Eligible previously loaded data can reduce failures and origin pressure. | Security-critical freshness, consistency after missed invalidations, or permission to retain indefinitely stale data. |
| Negative caching | Bounded not-found results can avoid repeated identical work. | Protection against an unlimited set of distinct attacker-controlled keys. |
| TTL jitter | Different keys can avoid aligning their expiry times. | Prevention of duplicate refreshes for the same cold key or permission to extend a contractual maximum age. |
| Early refresh | Can begin useful work before hard expiry. | A guaranteed leader or a global origin work bound. |

The Redis publication proof must be narrow. In `PUBLISH_IF_OWNER_LUA`, Redis checks the lease token and sets that entry before processing another command. A delayed worker A whose lease has expired or been replaced by B is rejected at publication. A separate client-side ownership check followed by `SET` would leave a race. This guarantee relies on the same Redis authority, unique tokens, the v2 same-slot layout, and use of the atomic publisher for the write path. It does not persist a monotonic fence sequence for an external origin.

Direct `set` and `delete` must supersede an outstanding fill. The inspected v2 scripts invalidate its lease. Custom stores that only implement acquire/release cannot be assumed to provide this atomic capability; their compatibility path needs an explicit weaker guarantee. Redis failures before or after an acknowledged publication can leave outcome uncertainty: replaying an ordinary unconditional `set` is not a safe recovery rule. See [distributed correctness](05-distributed-correctness.md) for executed races and limitations.

For XFetch, a future experiment can compare remaining TTL with `-duration * beta * log(U)`, where `U` is strictly inside `(0, 1)` and duration is bounded measured regeneration time. Keep absolute hard-expiration semantics, run refresh through existing sharing/leases, and shed background work first. This requires new metadata and a way to refresh a still-fresh entry; ordinary `getOrSet` immediately returns the fresh value. Treat that API and resource behavior as a design proposal, not an existing feature.

## Origin protection and tenant fairness

[Netflix concurrency-limits](https://github.com/Netflix/concurrency-limits) uses latency and rejection feedback to estimate concurrency; [Gradient2 source](https://github.com/Netflix/concurrency-limits/blob/main/concurrency-limits-core/src/main/java/com/netflix/concurrency/limits/limit/Gradient2Limit.java) smooths short/long latency and clamps the result. This motivates an optional experiment, not adopting its Java defaults. LazyLayers loader duration includes workload differences, event-loop stalls, and possibly queue wait, so using aggregate response latency as a database saturation signal can mislead an adaptive controller.

The existing finite FIFO gate should remain the uncomplicated default. Keep a hard maximum even if an adaptive limit is added. Measure only admitted origin work for service-time feedback, report queue wait separately, limit growth, and test slow-origin recovery and burst oscillation. Retry work must consume the same admission and deadline budgets. A loader timeout or `AbortSignal` is insufficient evidence that its origin query stopped: retain the execution permit until the underlying loader settles, or obtain an explicit cancellation completion from the origin driver.

The gate is owned by a cache object. Multiple objects/processes can therefore multiply the effective origin limit. A deployment with `I` instances cannot infer a database-wide limit from one object's `maxConcurrent`. Sharing a local gate or dividing a documented database budget is an application-level option; a cluster-wide admission service would need measured value before becoming required infrastructure.

[Tokio's bounded mpsc documentation](https://docs.rs/tokio/latest/tokio/sync/mpsc/index.html) distinguishes bounded channels, blocking/backpressure at capacity, and clean shutdown. The transferable lesson is to bound both executing and retained waiting work. Merely replacing an array with a ring or Set does not bound waiting callers or timers. Every queue in LazyLayers needs explicit capacity, expiry, cancellation/removal, and shutdown behavior.

Tenant fairness requires a trusted tenant identifier and a budget allocator, not parsing arbitrary caller-supplied key strings into privileged groups. Before adding per-tenant fair shares, establish normalized tenant namespaces and bounds on the number of tenant queues. One FIFO gate can bound total origin concurrency without guaranteeing tenant fairness. Deadline propagation, refresh priority, token buckets, adaptive limits, and per-tenant scheduling remain separate opt-in designs unless implemented and measured.

## Coherence, invalidation, and freshness

[Redis Pub/Sub](https://redis.io/docs/latest/develop/pubsub/) is at-most-once and does not isolate channels by Redis database number. Prefix channels by deployment and avoid treating successful subscription as replay. Pub/Sub dedupe and generations can suppress some duplicates or old events, but cannot reconstruct a missing event.

The official [Redis client-side caching reference](https://redis.io/docs/latest/develop/reference/client-side-caching/), “Avoiding race conditions” and “What to do when losing connection,” discusses a GET reply arriving after invalidation and recommends flushing cached state after connection loss. These are directly relevant to HybridCache's mutation epoch and invalidation trust boundary. Test a delayed L2 response across delete/reconnect; stale and negative maps are part of cached state and must be covered as well as L1. If the flush fails, do not mark local state trusted.

[Gray and Cheriton's original lease paper](https://www.cs.cmu.edu/afs/cs.cmu.edu/academic/class/15712-s12/www/papers/gray89.pdf), §5, makes bounded clock behavior and server persistence assumptions explicit. Its read-coherence lease is not automatically equivalent to a stampede-prevention lock. A future bounded-freshness lease design must state its clock, partition, authoritative-write, and reconciliation assumptions instead of inheriting its name.

For security-sensitive entries, disable stale serving when business policy requires current authorization. A cache-only lease cannot make an origin update plus cache invalidation atomic. If read-after-write or source-version ordering is required, the loader/application must provide an authoritative version or transaction/outbox protocol; that is an integration contract and potentially an API change, not a performance tweak.

## Tail latency and measurement discipline

[Dean and Barroso's original The Tail at Scale](https://barroso.org/publications/TheTailAtScale.pdf) explains why rare delays affect fan-out services and discusses shallow queues, background work, and hedging. This supports measuring misses, origin wait, decoding, and maintenance stalls independently. It does not justify default hedged origin loads: this library's primary mission includes suppressing duplicate origin work, and hedging needs spare capacity, replica semantics, and real cancellation.

[k6's official open/closed-model guidance](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/) describes closed-loop coordinated omission: slow responses lower subsequent offered load. Use an arrival-rate driver for overload tests, record scheduled versus actual send time, offered/completed/successful rates, and dropped starts. Generator saturation is a separate failure; cap inflight driver work instead of building an unlimited client queue.

[HdrHistogram's original implementation](https://github.com/HdrHistogram/HdrHistogram/blob/master/src/main/java/org/HdrHistogram/AbstractHistogram.java) provides expected-interval correction. Any corrected histogram must be labeled and keep the raw histogram; synthetic correction is not an independently offered request measurement. Do not apply both recording-time and post-processing correction to the same data.

The existing [benchmark notes](../benchmarks/README.md) distinguish payload bytes from Redis allocator footprint and use a fixed-iteration codec comparison. Those tests answer encoding questions. They do not establish open-loop Redis throughput, independent load-generator capacity, cluster fairness, or production fault recovery. See [benchmark results](08-benchmark-results.md), [chaos results](09-chaos-test-results.md), and [before/after](10-before-after-comparison.md) for this audit's executed workloads and raw measurements.

## Decisions, dependencies, and prioritized research backlog

No dependency or public API change is justified solely by this literature review. Keep routing services, replacement runtimes, advanced admission algorithms, and adaptive origin limits as experiments until repository measurements support adoption.

| Priority | Decision / next experiment | Required evidence |
|---|---|---|
| P0 | Preserve atomic publication; test expired/paused owner, direct write/delete versus fill, and unknown mutation outcome. | Deterministic races plus isolated real Redis verification; no obsolete protected cache overwrite. |
| P0 | Bound actual origin executions, follower/coordination work, and event queues; preserve tenant namespaces. | Slow/noncooperative loaders, cancellation, distinct-key pressure, and shutdown with hard deadlines. |
| P0 | Preserve conservative distrust after event loss and prevent delayed promotion. | Disconnect/reconnect, failed flush, invalidation/response reordering, negative/stale-state tests. |
| P1 | Remove measured in-flight scans and excess copies without weakening cleanup semantics. | Scaling and payload-size before/after distributions plus replacement cleanup tests. |
| P2 | Compare existing admission with plain LRU and, if warranted, one faithful advanced policy. | All trace categories, equal accounted-byte budget, metadata, policy CPU, object/byte hits, and tail latency. |
| P2 | Compare codecs at representative value sizes and entropy. | Encode/decode CPU, peak temporary memory, ratio, and L1/L2 end-to-end cost; use installed codecs before new dependencies. |
| P3 | Evaluate key affinity versus healthy Redis coordination. | Rebalancing, hot-worker imbalance, actual Redis operations, and multi-process latency. |
| P3 | Evaluate early refresh and adaptive concurrency independently. | Freshness preservation, bounded refresh count, feedback stability, overload recovery, and origin work avoided. |

The architectural preference is a single lightweight library with narrow internal seams for storage, coordination, admission, and observability. Additional layers should express tested invariants, not require extra deployable services. Future features remain optional when they add infrastructure, latency, metadata, or consistency assumptions.
