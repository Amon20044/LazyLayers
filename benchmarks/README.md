# Benchmarks

These are the reproducible numbers published on <https://lazy-layers-cache.vercel.app>.

They compare `lazy-layers-cache`'s serializer (MessagePack + size-tiered LZ4/Zstd compression) against:
1. **Raw JSON.stringify(value)**: Pure serialization baseline.
2. **BentoCache default Redis payload**: BentoCache 1.6.1's default L2 storage format (`JSON.stringify`), which wraps each value in a `CacheEntry` envelope (`{ value, createdAt, logicalExpiration }`) as written to Redis.

> **Note on metadata envelopes**: BentoCache's measurement includes its `CacheEntry` envelope because that metadata is part of what it writes to Redis. LazyLayers manages cache metadata and generation counters differently and does not include an equivalent envelope in the serialized payload.

## Running them

```bash
npm run build                    # the harness imports from dist/
npm --prefix benchmarks i        # installs bentocache fixture dependency
node benchmarks/run.mjs          # single pipeline: bytes, round-trip check & median-of-15 throughput
npm run bench:herd               # 10,000-caller stampede collapse
npm run bench:release-memory     # v0.5.2 memory and queue workload harness
npm run bench:representations    # HC1 vs V8 JSON vs HASH-shaped payloads
npm run bench:transactions       # bounded payment-coordination path
```

## v0.5.3 representation and V8 experiment

`representations.mjs` records Node/V8 versions, round-trip correctness, source
bytes, payload bytes, and p50/p95/p99 codec timings for the HC1 string path, a
V8 `JSON.stringify` path, and a top-level HASH-shaped payload. The local run
does not pretend to measure Redis allocator overhead. For a controlled server,
run `REDIS_URL=... npm run bench:representations -- --live` to add `MEMORY
USAGE` for opaque strings, HASH records, and native JSON when the JSON module is
available. The script uses a unique namespace and cleans it up without changing
Redis `CONFIG`.

The benchmark is a decision aid, not a claim that JSON or HASH is universally
faster. LazyLayers keeps opaque HC1 strings as the default until a deployment's
schema, module availability, memory profile, and tail-latency evidence justify
an explicit representation.

## Thundering herd

`herd.mjs` fires 10,000 concurrent `getOrSet` calls at a single cold key within one Node.js process and counts loader executions. Set `LAZY_HERD_CALLERS` to raise or lower the concurrent caller count.

```txt
with inflight dedupe (default)   callers=10000  loaderCalls=1      inflightReuse=9999
with inflight + origin guard disabled
                                 callers=10000  loaderCalls=10000  inflightReuse=0
```

The first caller's promise is stored and every concurrent caller for that key awaits the same promise, so the origin sees one loader invocation instead of ten thousand. The comparison deliberately disables both protections to measure the unbounded baseline. Both runs assert every caller received the correct value.

## v0.5.2 release stress harness

`release-memory.mjs` emits JSON for deterministic workloads that match their names:

- hot-key reads
- concurrent distinct-key surges with measured actual loader concurrency
- incompressible oversized-object scans
- two-phase changing hot sets
- injected L2 failure handling
- uneven traffic routed across three real cache instances
- synthetic critical-memory pressure against an encoded L1 store

The pressure scenario (v0.5.2 only) verifies that the shared budget reaches `critical` and
evicts retained entries to the reduced target. The harness exits nonzero if any
workload reports an error, making it suitable for CI.

It records throughput, latency percentiles, process CPU time, event-loop delay, before/peak/after process memory, cache telemetry, accounted bytes, error count, and origin-gate statistics. To compare the published baseline, install v0.5.1 outside this repository and pass its ESM entry point:

```bash
LAZY_BENCH_ITERATIONS=10000 \
LAZY_BENCH_SEED=20250911 \
LAZY_BASELINE_MODULE=/tmp/lazy-baseline/node_modules/lazy-layers-cache/dist/index.js \
LAZY_BENCH_OUTPUT=benchmarks/release-memory.json \
npm run bench:release-memory
```

The outage workload uses an intentionally failing `CacheStore`; it does not claim to measure Redis server behavior. Run the live Redis tests with `REDIS_URL` against a controlled Redis 7/8 service when measuring transport behavior. Every release/workload pair uses a fresh child process, so peak memory from one workload cannot contaminate another.

The executable release gates require all workloads to complete without errors, origin concurrency to remain at or below the configured limit of 16, the oversized scan to retain no rejected values, critical pressure to evict below its adaptive target, and every measured workload to report p95/p99 latency, CPU time, and peak RSS. Throughput is reported for comparison but is not given a universal threshold because encoded L1 deliberately trades CPU for bounded retained bytes and results vary by machine.

## Reading the results

- **Byte counts are deterministic**: Fixtures are seeded with a deterministic LCG, so `run.mjs` reproduces the exact published byte sizes on any machine.
- **Throughput is measured via fixed-iteration timing**: `run.mjs` computes the median of 15 fixed-iteration reps. Ratios are the true signal, as absolute ops/s will vary with CPU clock and thermal throttling.

## What the numbers actually say

We store **33%–92% fewer bytes in Redis** across typical application payloads.

We are deliberately slower at serialization than native `JSON.stringify` (roughly **0.38×–0.93×** the speed of JSON.stringify on writes, and **0.56×–0.79×** on reads).

**This is an intentional engineering trade-off: CPU cycles for bytes.**
Native `JSON.stringify` is implemented in C++ in V8 and absurdly optimized. We trade some CPU time at cache boundaries to substantially reduce Redis memory bills, wire serialization size, network transfer, and replication pressure.

## Memory Footprint Note

Payload bytes are not total Redis memory consumption. Real Redis instances also incur memory for key names, Redis object headers, jemalloc allocator chunk fragmentation, sorted-set indexes (when enabled), and replication buffers. Fewer payload bytes directly reduce both raw memory and replication traffic.
