/**
 * Every number in this file was measured, not estimated.
 *
 * Harness: bench/run.mjs + bench/throughput.mjs (see /benchmark methodology).
 * Subject: lazy-layers-cache serializer (msgpackr + size-tiered compression)
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
  encoding: 'msgpack' | 'msgpack-gzip' | 'msgpack-zstd' | 'msgpack-lz4' | 'msgpack-snappy';
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
    serRatio: 0.54, deRatio: 0.77,
    bentoSer: 3233598, llSer: 1733813, bentoDe: 2587723, llDe: 1992889,
  },
  {
    fixture: 'User profile',
    blurb: 'Nested objects, mixed types',
    bentoBytes: 424, llBytes: 284, encoding: 'msgpack',
    serRatio: 0.35, deRatio: 0.67,
    bentoSer: 1734527, llSer: 609091, bentoDe: 1455079, llDe: 970079,
  },
  {
    fixture: 'API list (50)',
    blurb: 'Paginated list endpoint',
    bentoBytes: 18127, llBytes: 3516, encoding: 'msgpack-zstd',
    serRatio: 0.46, deRatio: 0.58,
    bentoSer: 48558, llSer: 22496, bentoDe: 35280, llDe: 20526,
  },
  {
    fixture: 'Metrics (24h @ 1m)',
    blurb: '1,440 numeric points — binary encoding territory',
    bentoBytes: 119155, llBytes: 31104, encoding: 'msgpack-zstd',
    serRatio: 0.83, deRatio: 0.64,
    bentoSer: 3202, llSer: 2670, bentoDe: 4014, llDe: 2580,
  },
  {
    fixture: 'Product catalog',
    blurb: '400 records with repeated boilerplate text',
    bentoBytes: 125568, llBytes: 10015, encoding: 'msgpack-zstd',
    serRatio: 0.51, deRatio: 0.62,
    bentoSer: 8870, llSer: 4523, bentoDe: 7398, llDe: 4579,
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

/**
 * Thundering herd, measured by benchmarks/herd.mjs: 10,000 concurrent
 * getOrSet calls against one cold key, with and without inflight dedupe.
 * Both runs assert every caller got the correct value.
 */
export const HERD = {
  callers: 10_000,
  loaderCalls: 1,
  reused: 9_999,
  withoutDedupe: 10_000,
} as const;

/* ── What actually travels on the bus ─────────────────────────────────── */

/**
 * Concrete example payloads, matching the InvalidationEvent union in
 * src/types/event.types.ts exactly. The distinction that matters: `del` and
 * `pattern` carry no value at all — they only say what to forget. `set` is the
 * one that carries the value itself, which is what lets peers prime their L1
 * without calling a loader.
 */
export interface WireEvent {
  type: 'del' | 'pattern' | 'set';
  headline: string;
  payload: string;
  effect: string;
  carriesValue: boolean;
}

export const WIRE_EVENTS: WireEvent[] = [
  {
    type: 'del',
    headline: 'Invalidate one key',
    payload: `{
  type: "del",
  keys: ["user:42"],
  source: "node-1",
  generation: 7,
  ts: 1740086400000
}`,
    effect: 'Every peer drops user:42 from L1, L2, negative, stale and inflight. Nothing but the key travels.',
    carriesValue: false,
  },
  {
    type: 'pattern',
    headline: 'Invalidate a wildcard',
    payload: `{
  type: "pattern",
  pattern: "user:*",
  source: "node-1",
  generation: 7,
  ts: 1740086400000
}`,
    effect: 'Every peer drops each local entry whose key matches. Still no value on the wire.',
    carriesValue: false,
  },
  {
    type: 'set',
    headline: 'Prime peers with the value',
    payload: `{
  type: "set",
  keys: ["user:42"],
  value: { id: 42, plan: "pro" },
  generation: 8,
  ttlMs: 60000
}`,
    effect: 'The value comes along for the ride, so peers drop it straight into L1 and never call the loader.',
    carriesValue: true,
  },
];

/* ── Correctness guarantees ───────────────────────────────────────────── */

export interface Guarantee {
  name: string;
  detail: string;
}

export const GUARANTEES: Guarantee[] = [
  { name: 'Per-key generations', detail: 'del and set carry a generation. A late set can never resurrect a value a newer delete already removed.' },
  { name: 'Event dedupe',        detail: 'Recent event IDs are remembered, so a durable bus redelivering a message cannot re-apply it.' },
  { name: 'Loopback filter',     detail: 'Every event is stamped with its source. You never apply your own broadcast.' },
  { name: 'Ordered handlers',    detail: 'Subscriber concurrency defaults to 1, preserving approximate invalidation order.' },
  { name: 'Retry queue',         detail: 'A failed publish is buffered and flushed on the next success. Bounded, oldest dropped first.' },
  { name: 'Circuit breaker',     detail: 'Repeated publish failures open the circuit, so a sick bus never blocks your request path.' },
];

/* ── Transports ───────────────────────────────────────────────────────── */

export interface Transport {
  name: string;
  delivery: string;
  note: string;
  durable: boolean;
}

export const TRANSPORTS: Transport[] = [
  { name: 'Redis Pub/Sub',   delivery: 'At-most-once', note: 'Ephemeral. Subscribers receive only while connected.', durable: false },
  { name: 'NATS Core',       delivery: 'At-most-once', note: 'Fastest fanout. No replay for disconnected peers.',    durable: false },
  { name: 'RabbitMQ',        delivery: 'Durable',      note: 'Persistent messages and per-instance queues.',          durable: true },
  { name: 'NATS JetStream',  delivery: 'Durable',      note: 'Replayable, explicit ack, redelivery, max-deliver.',    durable: true },
];

export const FAQS = [
  {
    q: 'What does the event bus actually solve?',
    a: 'Every instance keeps its own in-process L1. Without a bus, the instance that just wrote has no way to tell anyone. The others carry on serving the old value until their TTL runs out. That means your staleness window is your L1 TTL times the share of traffic that never touched the node that wrote. A bus closes it to one network hop.',
  },
  {
    q: 'What is the difference between invalidation and L1 priming?',
    a: 'Invalidation is delete only. Peers hear a key is gone, drop it, and each one reloads it on its next request. Priming goes further. When a getOrSet loader returns, the value itself is broadcast, so peers put it straight into L1 and never call the loader. One instance pays for the load and everyone else gets it free. Set broadcastSet to false if you would rather stick to delete only.',
  },
  {
    q: 'How do you stop a late event from resurrecting deleted data?',
    a: 'Every del and set carries a generation counter for its key. An instance ignores any remote event older than what it already applied. So a set that turns up after a newer delete gets discarded, instead of quietly putting the value back. Durable transports also like to redeliver, so events are deduplicated by ID on top of that.',
  },
  {
    q: 'Which transport should I pick?',
    a: 'Redis Pub/Sub if you already run Redis and can live with at-most-once delivery. An instance that was disconnected misses those events and falls back to TTL expiry. NATS Core gives you the fastest fanout with the same trade. Reach for RabbitMQ in durable mode or NATS JetStream when missing an invalidation is not an option. Both hold events for an instance that is down and redeliver on reconnect.',
  },
  {
    q: 'How does size-tiered compression work?',
    a: 'The serializer picks a codec based on payload size, not a fixed threshold. Under 256 bytes: no compression at all, because every codec makes small payloads bigger. 256 bytes to 4 KB: lz4, which is both smaller and about five times faster than zstd at these sizes. Above 4 KB: zstd, where the bytes-saved-per-microsecond ratio climbs sharply — 9 B/µs at 512 bytes to 767 B/µs at 256 KB. The result: a 14 KB API list that used to store raw now lands at 3.4 KB.',
  },
  {
    q: 'What makes the serialization fast?',
    a: 'The v3 serializer runs at 2,670 ops/s — 3.2x faster than v2. The speed comes from choosing the right codec for each size tier rather than forcing everything through gzip. lz4 at small sizes and zstd at large sizes, with a 15% savings threshold that skips compression when it would not pay off.',
  },
  {
    q: 'Do I have to run Redis or a message broker?',
    a: 'No. It starts as an in-process LRU with no infrastructure at all. Redis earns its place as a shared L2 once you outgrow a single instance, and a bus earns its place once peer caches start drifting apart. Every layer is opt in, and the API does not change when you add one.',
  },
  {
    q: 'Can I reproduce these benchmarks?',
    a: 'Yes, and honestly you should. The fixtures are seeded, so the byte counts come out identical on any machine. Throughput is a median of 15 fixed-iteration runs and will move with your hardware. The harness lives in the repository under benchmarks/.',
  },
];
