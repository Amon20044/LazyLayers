# Executed benchmark results

The tested build improves expiry checks, follower registration, empty-cache retention and large event enqueue cost. It also increases warm-read and large accepted-herd costs. These are retained correctness/resource trade-offs, not a universal speedup. The final source SHA is `e451d7c9d3524779584211fe0571acff4e68cecbf1e32e6f8bb10f8face8fd08`; ESM SHA is `21ed478360f76848bfb2b79594169f80bda2b24fe0bf4f9caacbb9aa66608b95`. Baseline is commit `ca9c02a04349a89278cd81b5b25d0000503cc5a3` with the same dependency lock.

## Hardware, isolation and measurement

Executed on Apple M5, 10 logical CPUs, 16 GiB host memory, Darwin 25.5.0, Node 24.21.0. Docker Desktop 29.6.2 provides the isolated services; its VM has approximately 8.32 GB memory. Each UUID project caps Redis/RabbitMQ/NATS at 96/512/128 MiB and 1/1/0.5 CPUs. Only new loopback resources and synthetic data were used. Docker projects and owned processes were cleaned up.

Offline comparisons use fresh children and five repetitions per micro/queue case, two per memory case, three per trace/codec case. CPU experiments ran sequentially. There are 65 micro runs, 15 queue runs, 28 memory cases, 60 policy cases and 144 codec cases per revision. Full raw results, process budgets and module paths are in [raw](raw/). Old-space flags do not bound all V8/native/external memory; RSS sampling and hard container limits are separate controls.

Real E2E uses two independent cache processes, one controlled HTTP origin and a fresh independent load-generator process per phase. Payloads are 1 KiB; warm traces use seeded skew over 64 keys. L1 has 4096 entries and a 64 MiB accounting budget; admission is disabled for this control. Per worker: 8 active/32 queued origin loads, 150 ms queue deadline, 750 ms hard deadline. Leases use 1200 ms TTL, 1600 ms wait and 10 ms polling. Overload controls explicitly use 4/16 or 16/64 active/queued origin limits and a 50 ms origin delay.

The default E2E pair has 33 one-second phases per revision; the high-rate pair has three 10,000-RPS warm phases. These are short offered-rate samples, **not maximum or sustained capacity**. The generator has 64 sockets per worker: a 1000-call burst queues at the client and is not 1000 simultaneous server followers. Client outstanding requests, dispatch lag, dropped arrivals, status/error/timeout counts and p50/p95/p99/p99.9 are retained in JSON.

Latency includes planned-arrival dispatch delay. Unsent arrivals are explicit errors and excluded from quantiles, so quantiles alone must not hide saturation. HTTP-bypass calibration reached 10,000 offered RPS with no dropped requests. A 50,000-RPS calibration either lacked headroom or dropped requests; cache load at 50,000 and 100,000+ RPS is **NOT MEASURED**. Wrong-key/version checks apply to the controlled payloads; load phases do not establish arbitrary concurrent-update freshness.

## Paired microbenchmarks

Elapsed milliseconds per stated batch; all five repetitions are in [before](raw/benchmark-before.json), [after](raw/benchmark-after.json) and [comparison](raw/performance-comparison.json). Bootstrap uses 10,000 median resamples, a 95% family interval and tolerance max(10%, three baseline relative MADs). Shared-machine, short-run inference remains limited.

| Case / resident or concurrent count | Operations | Before ms | After ms | Change | Statistical gate |
| --- | --- | --- | --- | --- | --- |
| lookup/64 | 20000 | 27.766 | 36.224 | +30.46% | REGRESSION |
| lookup-stale/64 | 20000 | 40.782 | 49.395 | +21.12% | REGRESSION |
| has/32 | 4000 | 6.104 | 1.141 | -81.31% | not flagged |
| has/1024 | 4000 | 84.644 | 2.201 | -97.40% | not flagged |
| has/8192 | 4000 | 807.716 | 1.379 | -99.83% | not flagged |
| promotion/2048 | 2048 | 59.986 | 20.981 | -65.02% | not flagged |
| inflight/32 | 4000 | 8.074 | 4.045 | -49.90% | not flagged |
| inflight/1024 | 4000 | 101.602 | 2.524 | -97.52% | not flagged |
| herd/10 | 10 | 2.481 | 2.715 | +9.42% | not flagged |
| herd/100 | 100 | 2.528 | 2.976 | +17.73% | not flagged |
| herd/1000 | 1000 | 3.624 | 4.730 | +30.51% | REGRESSION |
| herd/10000 | 10000 | 14.956 | 27.564 | +84.30% | REGRESSION |
| herd/100000 | 100000 | 118.528 | 215.568 | +81.87% | REGRESSION |

`has` uses 64-byte values at N=32/1024/8192. Lookup uses 1 KiB values over 64 keys, 20,000 reads. Promotion uses 2048 independent 1 KiB keys with an in-process MemoryStore L2: no Redis/network throughput claim. In-flight tests time registration of 4000 followers while 32/1024 loaders are blocked, not complete request latency. Herd tests simulate 10 through 100,000 Promise callers; both explicitly provision `maxWaiters=100000` and require exactly one loader. Default follower caps are tested separately. Herd elapsed includes forced GC and completion; it is not an HTTP capacity figure.

## Real E2E

Cells are median successful completed RPS / median per-phase p99 milliseconds, across three phases. Burst rows use burst-completion rate, not a one-second offered RPS. Source: [default before](raw/e2e-before.json), [default after](raw/e2e-after.json), [high before](raw/e2e-before-high.json), [high after](raw/e2e-after-high.json).

| Scenario | Before RPS / p99 ms | After RPS / p99 ms | Origin requests before → after | Errors before → after |
| --- | --- | --- | --- | --- |
| warm-100 | 100.76 / 3.218 | 100.72 / 3.076 | 0 → 0 | 0 → 0 |
| warm-1000 | 997.35 / 2.266 | 998.20 / 2.056 | 0 → 0 | 0 → 0 |
| l1-disabled | 997.50 / 2.912 | 998.25 / 2.787 | 0 → 0 | 0 → 0 |
| compression-gzip | 997.46 / 2.236 | 998.23 / 1.972 | 0 → 0 | 0 → 0 |
| cold-one-key-lease | 9372.39 / 104.028 | 10036.03 / 98.359 | 1 → 1 | 0 → 0 |
| cold-one-key-no-lease | 9952.70 / 99.095 | 10116.75 / 97.501 | 2 → 2 | 0 → 0 |
| cold-one-key-no-singleflight | 279.04 / 169.962 | 655.08 / 67.680 | 48 → 17 | 208 → 176 |
| cold-distinct-overload | 152.26 / 203.299 | 152.34 / 203.153 | 180 → 181 | 820 → 819 |
| cold-distinct-limit-16 | 603.68 / 471.292 | 605.74 / 487.180 | 889 → 899 | 111 → 101 |
| stale-if-error | 997.61 / 3.210 | 997.88 / 3.551 | 1000 → 997 | 0 → 0 |
| strict-origin-error | 0.00 / 4.418 | 0.00 / 3.598 | 999 → 997 | 1000 → 1000 |
| warm-10000 | 9965.60 / 6.017 | 9974.84 / 6.851 | 0 → 0 | 0 → 0 |

Warm phases and lease-enabled bursts have zero client drops, wrong-key/version responses and errors. Cold single-key leases avoid cross-process origin duplication: one origin request with leases, two without, on both revisions. Disabling singleflight creates more origin operations/errors even with execution caps. Distinct-key saturation preserves bounded work and controlled rejection; increasing limits improves successful requests but raises tail latency and origin load. These controls do not establish per-tenant fairness or a cluster-global budget.

Stale-if-error hides origin errors from callers but still attempts almost one origin call per request. It is not evidence that an origin circuit breaker or negative/error cache prevents that traffic. Optional refresh shedding, tenant fairness and wider recovery scheduling remain backlog work. Strict-origin-error deliberately returns controlled 503 responses and is not counted as a successful-throughput scenario.

10,000-RPS warm p99 ranges overlap: before 3.793–9.333 ms, after 3.210–9.678 ms. The median difference is descriptive, not statistically proven. Worker CPU/RSS exclude Redis, origin and generator; client `sendCommand` counts include Lua requests but not every command executed inside Lua. Full Redis network traffic, exact bytes allocated/operation, continuously measured waiter peaks, physical 50/100-instance imbalance and production DB capacity are **NOT MEASURED**.

## Queue and policy controls

Queue cells show before → after medians over five fresh processes. RSS is per-child OS high-water in MiB. Enqueue wins do not conceal slower drain/flush or increased small-queue CPU/RSS.

| Events | Enqueue ms | Drain ms | Retry flush ms | CPU ms | RSS MiB |
| --- | --- | --- | --- | --- | --- |
| 32 | 0.094 → 0.105 | 0.073 → 0.091 | 0.529 → 0.872 | 1.441 → 2.157 | 67.688 → 67.922 |
| 1024 | 2.131 → 0.424 | 0.487 → 0.891 | 2.041 → 3.644 | 14.550 → 16.339 | 73.625 → 75.859 |
| 8192 | 172.173 → 2.343 | 3.054 → 8.935 | 8.184 → 27.388 | 208.960 → 86.838 | 82.984 → 120.609 |

Actual admission enabled vs disabled, 16,000 requests per trace, 128 entry / 256 KiB budget, three repeats. Cells are object hit ratio / byte hit ratio. Before/after hits and origin counts are identical for every paired case: no eviction policy was silently replaced.

| Trace | Admission disabled | Existing admission enabled |
| --- | --- | --- |
| uniform | 12.181% / 12.181% | 12.269% / 12.269% |
| zipf | 71.006% / 71.006% | 72.069% / 72.069% |
| scan | 0.000% / 0.000% | 0.000% / 0.000% |
| repeated-scan | 0.000% / 0.000% | 0.000% / 0.000% |
| scan-pollution | 77.956% / 77.956% | 78.575% / 78.575% |
| burst | 89.438% / 89.438% | 79.144% / 79.144% |
| shifting-hot-set | 98.400% / 98.400% | 89.200% / 89.200% |
| read-heavy | 12.172% / 12.172% | 12.159% / 12.159% |
| write-heavy | 11.820% / 11.820% | 11.729% / 11.729% |
| large-values | 5.394% / 2.527% | 12.300% / 0.153% |

These controls are not implementations of CLOCK, FIFO, LFU, TinyLFU or W-TinyLFU. Advanced policies/routing remain research candidates rather than measured improvements. The [memory/codec report](04-memory-profile.md) contains all payload sizes, available JSON/MessagePack/gzip/Zstd/LZ4/Snappy controls, storage fractions and strict/public decode timing. No Brotli dependency was added.

## CI and reproducibility

The real seven-repeat PR-style gate completed and rejected four regressions: lookup, stale lookup and 1000/10000-caller herds. [CI receipt](raw/performance-ci.log.meta.json), [CI comparison](raw/ci-performance-comparison.json). This is an intentional visible review gate, not a pass or an automatic approval rejection. No release was made.

Use [reproduction instructions](README.md), `scripts/audit-ci.mjs`, `scripts/audit-summarize.py` and the bounded runners. The [workflow](../.github/workflows/performance.yml) stores PR/release-candidate history for 90 days and separates quick correctness/memory/performance checks from scheduled live-service/chaos/endurance runs. Critical correctness failures block release. Performance gates require repeated statistical evidence; retaining a justified safety cost still requires explicit baseline/release review.
