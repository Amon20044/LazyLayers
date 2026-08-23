# Benchmarks

These are the numbers published on <https://lazy-layers-cache.vercel.app>.

They compare `lazy-layers-cache`'s serializer (msgpackr + conditional gzip)
against [bentocache](https://bentocache.dev)'s default L2 serializer, which is
`JSON.stringify` (`JsonSerializer`, `build/index.js`), including the
`CacheEntry` envelope bentocache wraps around every value — that envelope is
what actually lands in Redis, so excluding it would flatter us unfairly.

## Running them

```bash
npm run build            # the harness imports from dist/
npm --prefix benchmarks i bentocache
node benchmarks/run.mjs         # byte sizes + round-trip check
node benchmarks/throughput.mjs  # ops/sec
```

## Reading the results

**Byte counts are deterministic.** The fixtures are seeded with a fixed LCG, so
`run.mjs` reproduces the published sizes exactly on any machine.

**Throughput is not.** `throughput.mjs` reports a median of 15 fixed-iteration
reps and will move with your CPU, Node version and thermal state. Compare the
*ratios*, not the absolute ops/s.

## What the numbers actually say

We store 22%–92% fewer bytes, and we are slower doing it — roughly 0.2×–0.8× the
speed of `JSON.stringify`, which is native and very well optimised. The trade is
CPU cycles for bytes. That is a good trade when bytes are the metered resource
(managed Redis memory, network transfer, replication) and a bad one for tiny
keys serialized millions of times a second.

`run.mjs` also asserts that both libraries round-trip every fixture back to a
deeply-equal value, so a "win" can never come from dropping data.
