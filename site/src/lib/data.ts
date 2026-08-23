/**
 * Every number in this file was measured, not estimated.
 *
 * Harness: bench/run.mjs + bench/throughput.mjs (see /benchmark methodology).
 * Subject: lazy-layers-cache serializer (msgpackr + conditional gzip)
 *          vs. bentocache 1.6.1's default L2 serializer (JSON.stringify),
 *          including bentocache's CacheEntry envelope, which is what actually
 *          lands in Redis.
 * Machine: Apple Silicon, Node v24.18.0.
 *
 * Byte counts are deterministic — the fixtures are seeded, so these reproduce
 * exactly. Throughput is median-of-15 fixed-iteration reps and will vary by
 * machine; treat the ratios, not the absolute ops/s, as the signal.
 */

export interface BenchRow {
  fixture: string;
  blurb: string;
  bentoBytes: number;
  llBytes: number;
  encoding: 'msgpack' | 'msgpack-gzip';
  /** ll ops/s ÷ bentocache ops/s. Below 1.0 means we are slower. */
  serRatio: number;
  deRatio: number;
  bentoSer: number;
  llSer: number;
  bentoDe: number;
  llDe: number;
}

export const BENCH: BenchRow[] = [
  {
    fixture: 'Session token',
    blurb: 'Small, hot, read on every request',
    bentoBytes: 212, llBytes: 123, encoding: 'msgpack',
    serRatio: 0.52, deRatio: 0.99,
    bentoSer: 3618542, llSer: 1864961, bentoDe: 2625025, llDe: 2603397,
  },
  {
    fixture: 'User profile',
    blurb: 'Nested objects, mixed types',
    bentoBytes: 424, llBytes: 284, encoding: 'msgpack',
    serRatio: 0.69, deRatio: 0.75,
    bentoSer: 1726378, llSer: 1188687, bentoDe: 1455683, llDe: 1097559,
  },
  {
    fixture: 'API list (50)',
    blurb: 'Paginated list endpoint',
    bentoBytes: 18127, llBytes: 14140, encoding: 'msgpack',
    serRatio: 0.76, deRatio: 0.72,
    bentoSer: 46875, llSer: 35430, bentoDe: 35020, llDe: 25112,
  },
  {
    fixture: 'Metrics (24h @ 1m)',
    blurb: '1,440 numeric points — binary encoding territory',
    bentoBytes: 119155, llBytes: 30393, encoding: 'msgpack-gzip',
    serRatio: 0.21, deRatio: 0.61,
    bentoSer: 3221, llSer: 683, bentoDe: 4336, llDe: 2639,
  },
  {
    fixture: 'Product catalog',
    blurb: '400 records with repeated boilerplate text',
    bentoBytes: 125568, llBytes: 9903, encoding: 'msgpack-gzip',
    serRatio: 0.23, deRatio: 0.60,
    bentoSer: 9814, llSer: 2264, bentoDe: 7515, llDe: 4544,
  },
];

export const saved = (r: BenchRow) => 1 - r.llBytes / r.bentoBytes;

export const BENCH_META = {
  node: 'v24.18.0',
  bentocache: '1.6.1',
  lazyLayers: '0.5.0',
  reps: 15,
  cpu: 'Apple Silicon',
};

/** Range across the fixture set, used in headline copy. */
export const SAVINGS_MIN = Math.round(Math.min(...BENCH.map(saved)) * 100);
export const SAVINGS_MAX = Math.round(Math.max(...BENCH.map(saved)) * 100);

export interface Layer {
  code: string;
  name: string;
  detail: string;
  when: string;
}

export const LAYERS: Layer[] = [
  { code: 'HC1M', name: 'MessagePack',  detail: 'Binary encode via msgpackr. Numbers stop being decimal strings, keys stop repeating as UTF-8.', when: 'Default for every payload under 64 kB' },
  { code: 'HC1G', name: 'gzip(MessagePack)', detail: 'Deflate on top of the binary encoding — but only when it actually pays for itself.', when: '≥ 64 kB and gzip saves ≥ 15%' },
  { code: 'HC1J', name: 'JSON passthrough', detail: 'Human-readable escape hatch. Same read path, no binary decode needed.', when: 'CACHE_FORMAT=json or debug mode' },
];

export const FAQS = [
  {
    q: 'How does lazy-layers-cache make cached payloads smaller?',
    a: 'It replaces JSON with MessagePack for the Redis wire format, then conditionally gzips. JSON stores numbers as decimal strings and repeats every object key as UTF-8 text on every record; MessagePack encodes both as binary. On payloads at or above 64 kB it also tries gzip and keeps the result only when compression saves at least 15%, so you never pay CPU for a compression pass that does not earn its place.',
  },
  {
    q: 'How does it compare to bentocache?',
    a: `Bentocache's default L2 serializer is JSON.stringify. Against it, lazy-layers-cache stored ${SAVINGS_MIN}% to ${SAVINGS_MAX}% fewer bytes across our five fixtures. The honest trade is CPU: our serialize path runs at roughly 0.2×–0.8× the speed of V8's native JSON.stringify, which is extremely well optimised. You are buying smaller payloads with cycles.`,
  },
  {
    q: 'Is lazy-layers-cache faster than bentocache?',
    a: 'Not at serialization, and we are not going to claim otherwise. V8 JSON.stringify beats our encoder on raw throughput in every fixture we measured. What we do win is bytes on the wire, which translates to Redis memory, network transfer, and replication cost. On large numeric payloads deserialization also gets closer to parity because there is simply less data to move.',
  },
  {
    q: 'When is the CPU cost worth it?',
    a: 'When bytes cost more than cycles. That is the usual shape of a managed-Redis bill: memory is the metered resource and app CPU is already provisioned. It is most compelling for large, numeric, or repetitive payloads — analytics series, catalogs, list endpoints. For tiny hot keys where you are serializing millions of times per second, plain JSON may well be the better call.',
  },
  {
    q: 'Do I have to use Redis?',
    a: 'No. It starts as an in-process LRU cache with zero infrastructure. Redis is an optional L2 layer you add when you outgrow a single instance. The serializer only runs on the L2 path — the L1 memory cache holds live objects.',
  },
  {
    q: 'How do peers stay in sync across instances?',
    a: 'The first instance to lazily load a key broadcasts the result to every peer, so their L1 warms without a second loader call. Deletes and wildcard pattern wipes fan out the same way. Transports are Redis Pub/Sub, RabbitMQ, NATS core, or NATS JetStream for durable, replayable delivery.',
  },
  {
    q: 'Can I reproduce these benchmarks?',
    a: 'Yes, and you should. The fixtures are seeded so byte counts are deterministic and reproduce exactly. Throughput is median-of-15 fixed-iteration reps and will vary with your hardware. The methodology is documented in full on this page.',
  },
];
