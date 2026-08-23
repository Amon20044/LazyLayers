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
  { code: 'HC1M', name: 'MessagePack',       detail: 'Binary encode. Numbers stop being decimal strings; keys stop repeating as UTF-8.', when: 'Every payload under 64 kB' },
  { code: 'HC1G', name: 'gzip(MessagePack)', detail: 'Deflate on top of binary — kept only when it actually pays for itself.',            when: '≥ 64 kB and gzip saves ≥ 15%' },
  { code: 'HC1J', name: 'JSON passthrough',  detail: 'Readable escape hatch. Same read path, no binary decode.',                          when: 'CACHE_FORMAT=json' },
];

/* ── The three lenses the page is organised around ────────────────────── */

export interface Lens {
  id: string;
  eye: string;
  title: string;
  question: string;
  answer: string;
  metric: string;
  metricLabel: string;
  accent: string;
}

export const LENSES: Lens[] = [
  {
    id: 'architect',
    eye: 'The architect',
    title: 'Every node agrees',
    question: 'What happens to my other instances when one of them writes?',
    answer: 'Events fan out over a bus. Peers drop the key, or take the new value straight into L1.',
    metric: '3',
    metricLabel: 'event types, fanned to every peer',
    accent: 'cyan',
  },
  {
    id: 'cost',
    eye: 'The cost saver',
    title: 'Bytes are the bill',
    question: 'What am I actually paying Redis to store?',
    answer: 'Forty percent of a JSON record is punctuation and repeated key names. We stop storing it.',
    metric: '92%',
    metricLabel: 'smaller on the wire, measured',
    accent: 'mint',
  },
  {
    id: 'optimizer',
    eye: 'The optimizer',
    title: 'One load, not fifty',
    question: 'How many times does my database answer the same question?',
    answer: 'Inflight dedupe collapses concurrent loads. The winner broadcasts, so peers never load it at all.',
    metric: '1',
    metricLabel: 'loader call per key, per fanout',
    accent: 'violet',
  },
];

/* ── What actually travels on the bus ─────────────────────────────────── */

export interface BusEvent {
  type: string;
  trigger: string;
  effect: string;
}

export const BUS_EVENTS: BusEvent[] = [
  { type: 'del',     trigger: 'cache.delete(key)',      effect: 'Peers drop the key from L1, L2, negative, stale and inflight.' },
  { type: 'pattern', trigger: 'cache.deleteByPattern()', effect: 'Peers drop every local entry matching the wildcard.' },
  { type: 'set',     trigger: 'a getOrSet loader returns', effect: 'Peers take the value straight into L1 — no second loader call.' },
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
    q: 'What problem does the event bus actually solve?',
    a: 'Every instance keeps its own in-process L1 cache. Without a bus, an instance that writes has no way to tell its peers, so they keep serving the previous value until their own TTL expires. Your staleness window is your L1 TTL multiplied by the share of traffic that is not hitting the instance that wrote. The bus closes that window to one network hop.',
  },
  {
    q: 'What is the difference between invalidation and L1 priming?',
    a: 'Invalidation is delete-only: peers hear that a key is gone and drop it, then each reloads it independently on the next request. Priming goes further — when a getOrSet loader returns, the value itself is broadcast, so peers put it straight into L1 without calling the loader at all. One instance pays for the load, every peer benefits. Set broadcastSet to false if you want delete-only semantics.',
  },
  {
    q: 'How do you stop a late event from resurrecting deleted data?',
    a: 'Every del and set event carries a per-key generation counter. Each instance ignores a remote event whose generation is older than the one it has already applied for that key, so a set broadcast that arrives after a newer delete is discarded rather than repopulating the value. Durable transports can also redeliver, so events are additionally deduplicated by ID.',
  },
  {
    q: 'Which transport should I pick?',
    a: 'Redis Pub/Sub if you already run Redis and can tolerate at-most-once delivery — a disconnected instance misses events and falls back to TTL expiry. NATS Core for the fastest fanout with the same trade. RabbitMQ in durable mode, or NATS JetStream, when missing an invalidation is not acceptable: both buffer for a disconnected instance and redeliver on reconnect.',
  },
  {
    q: 'How does lazy-layers-cache make cached payloads smaller?',
    a: 'It replaces JSON with MessagePack on the Redis wire, then conditionally gzips. In a real 212-byte session record, 85 bytes are structural punctuation and repeated key names carrying no information at all. MessagePack encodes the whole record in 123 bytes — fewer than JSON spends on values alone. Above 64 kB it also tries gzip and keeps it only when compression saves at least 15%.',
  },
  {
    q: 'Is lazy-layers-cache faster than bentocache?',
    a: 'Not at serialization, and we are not going to claim otherwise. V8 JSON.stringify is native and beats our encoder on raw throughput in every fixture we measured — we run at roughly 0.2x to 0.8x its speed. What we win is bytes on the wire, which is what Redis actually bills you for, and correctness across instances, which JSON speed does nothing for.',
  },
  {
    q: 'Do I have to run Redis or a message broker?',
    a: 'No. It starts as an in-process LRU cache with zero infrastructure. Redis becomes useful as a shared L2 when you outgrow one instance, and a bus becomes useful when peer L1s start diverging. Each layer is opt-in and the API does not change when you add one.',
  },
  {
    q: 'Can I reproduce these benchmarks?',
    a: 'Yes, and you should. The fixtures are seeded, so byte counts reproduce exactly on any machine. Throughput is a median of 15 fixed-iteration reps and will move with your hardware. The harness is in the repository under benchmarks/.',
  },
];
