# Before/after comparison and decisions

Baseline `ca9c02a04349a89278cd81b5b25d0000503cc5a3` versus the frozen final source `e451d7c9d3524779584211fe0571acff4e68cecbf1e32e6f8bb10f8face8fd08`, same lockfile. Node 24.21.0 / Apple M5 / 10 logical CPUs / 16 GiB / Darwin 25.5 / Docker 29.6.2. All values below derive from canonical JSON using [audit-summarize.py](../scripts/audit-summarize.py); [result summary](raw/result-summary.json). More workloads and distributions are in [benchmark results](08-benchmark-results.md).

## Required comparison

| Metric | Before | After | Change |
| --- | --- | --- | --- |
| L1 lookup latency (batch mean, 1 KiB/64 keys) | 1.388 µs | 1.811 µs | +30.46% |
| Memory per entry (approx incremental 1 KiB binary cohort) | 1718.7 B | 1711.7 B | -0.41% |
| Peak RSS (max sum of worker phase peaks, 33-phase E2E) | 363.484 MiB | 382.484 MiB | +5.23% |
| Worker CPU per 1M requests (10k-RPS warm) | 32848.4 ms | 38203.8 ms | +16.30% |
| p99 arrival latency (10k-RPS warm) | 6.017 ms | 6.851 ms | +13.86% |
| Successful throughput (10k offered RPS warm) | 9965.60 RPS | 9974.84 RPS | +0.09% |
| Redis client ops/request (cold single-key lease burst) | 0.054 | 0.100 | +85.19% |
| Origin amplification (one cold-key episode) | 1 | 1 | 0 |
| Cache hit event ratio (10k-RPS warm) | 100.0% | 100.0% | +0.0 percentage points |
| Fault recovery (Redis restart-to-PING, single observation) | 217.768 ms | 196.536 ms | -9.75% |
| 20 empty caches, heap plus external delta | 4,507,364 B | 110,160 B | -97.56% |
| 20 closed caches held by caller, heap plus external delta | 4,439,052 B | 8,344 B | -99.81% |

These rows intentionally show costs as well as gains. Micro L1 latency is median batch elapsed/20,000 operations, not an HTTP p99. Memory is a forced-GC cohort delta of heap plus external memory, excluding empty-store allocation; exact retained memory/entry is **NOT MEASURED**. Two samples cannot prove the small per-entry change. The large empty-store/held-close gain has separate structural snapshot evidence and repeated checkpoints.

E2E uses two independent cache processes, a controlled HTTP origin and a separate generator; 1 KiB values, seeded 64-key skew, three one-second 10k-RPS phases, 64 client sockets per worker and bounded queues/deadlines. Throughput is demand-limited, not maximum capacity. p99 ranges overlap; CPU/p99/recovery changes are descriptive, not confidence claims. Peak RSS is the maximum **sum of individual worker sampled phase peaks** across 33 phases; the peaks need not occur simultaneously and exclude Redis/origin/generator. Redis counts are client commands/Lua requests, not Lua-internal operations or total network bytes. Cold lease bursts have 1000 offered calls, one ideal origin miss episode and at most 128 active HTTP sockets. Fault recovery is one disposable no-persistence Redis restart, not replica failover or a statistically established speedup.

Exact allocations/operation, native fragmentation, total Redis traffic, hours-long retained-heap stability, 50k/100k cache capacity and external DB fencing remain **NOT MEASURED**.

## Incremental decisions

| Hypothesis / change | Evidence | Decision |
| --- | --- | --- |
| Full expiry sweeps and in-flight pruning add N/C-dependent work to requests. Use per-key expiry/coalescing and bounded maintenance. | `has` at8192 entries −99.83%; 1024-active-key follower registration −97.52%; promotions −65.02%, five repeats. | Keep; expected Map costs still include hashing/key cost and bounded maintenance. |
| Preallocated LRU arrays retain substantial memory even when empty/closed. Use dynamically growing count-bounded LRU and drop owned cache reference on close. | Empty heap+external −97.56%; held-close −99.81%; owned-array snapshot backing4,406,400→0 B. Earlier isolated LRU profile is preserved. | Keep; JS backing capacity during a long-lived high-water workload is not an exact RSS guarantee. |
| Recomputing queue bytes on enqueue causes quadratic storm cost. Use owned FIFO records and incremental counters. |8192-event enqueue −98.64%, aggregate CPU208.960→86.838 ms; drain/flush and small-queue/RSS costs increase. | Keep bounded accounting and enqueue improvement; slower paths remain visible. |
| Unleased fallback, namespace collisions and corrupt record interpretation can violate correctness/isolation. | Real chaos8pass/7fail→15pass/0fail; tenant value leakage and unleased overwrite reproduced; focused regressions green. | Keep correctness fixes; random owners do not provide external monotonic fencing. |
| Strict preflight/owned buffers and finite follower reservations add warm/accepted-follower cost. | Warm lookup+30.46%, stale lookup+21.12%; large herd regressions; seven-repeat CI rejects four cases. | Keep security/resource controls; performance release review remains red. Do not waive the gate or reset baseline silently. |
| A more complex admission/compression/routing default might reduce total cost. | Actual admission has trace-dependent hit/byte-hit trade-offs; codecs vary by entropy/size. No full W-TinyLFU or routing comparison was executed. | Preserve uncomplicated defaults; no new production dependencies or routing service. |

Source changes include cancellation/rechecks, safe publication and per-key revision guards, bounded follower/metadata/event/telemetry retention, scoped/authoritative peer handling, conservative reconnect recovery, bounded internal decoding and Redis STRLEN-before-GET. Tests accompany critical findings. Public method signatures, exports and legacy one-argument codec behavior are retained; tightened resource/close/error behavior and operational compatibility are documented in [migration notes](migration.md). Dependency lock and production dependencies are unchanged.

## Verification and remaining gates

Original full live-service suite356/356; final480/480, zero skips/failures. Node20 and22 each480/480 with build/typecheck/package verification, plus local24. Independent focused verification93/93 includes separately constructed binary ownership controls. Both28-case memory matrices and30-second memory smokes pass. All15 final real fault cases pass. Documentation lint/types pass; full108-page static-site generation exceeded local memory budgets and is not reported as passed.

The seven-repeat performance gate actually returns exit1 without a resource abort. Redis failover/Cluster, undetected/lost invalidations, external source fencing, legacy/custom non-atomic adapters, Worker aggregate limits, tenant/global origin fairness, exact RSS≤B and long endurance remain open. No production-ready declaration, package release or production deployment was made. [Independent readiness gates](12-production-readiness.md), [prioritized backlog](11-future-architecture.md).
