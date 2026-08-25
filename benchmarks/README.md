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
NODE_ENV=production node benchmarks/herd.mjs   # stampede collapse
```

## Thundering herd

`herd.mjs` fires 10,000 concurrent `getOrSet` calls at a single cold key within one Node.js process and counts loader executions.

```txt
with inflight dedupe (default)   callers=10000  loaderCalls=1      inflightReuse=9999
with inflight disabled           callers=10000  loaderCalls=10000  inflightReuse=0
```

The first caller's promise is stored and every concurrent caller for that key awaits the same promise, so the origin sees one loader invocation instead of ten thousand. Both runs assert every caller received the correct value.

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
