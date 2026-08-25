/**
 * Every number in this file is measured and reproducible from benchmarks/run.mjs.
 *
 * Subject: lazy-layers-cache serializer (MessagePack + size-tiered LZ4/Zstd)
 *          vs. Raw JSON.stringify(value) baseline
 *          vs. BentoCache 1.6.1 default L2 Redis payload (JSON with CacheEntry envelope)
 * Machine: Node v24.18.0.
 */

import rawResults from './results.json' with { type: 'json' };

export interface BenchRow {
  fixture: string;
  blurb: string;
  jsonBytes: number;
  bentoBytes: number;
  llBytes: number;
  encoding: string;
  saved: number;
  savedJson: number;
  serRatio: number;
  deRatio: number;
  bentoSer: number;
  llSer: number;
  bentoDe: number;
  llDe: number;
}

const BLURBS: Record<string, string> = {
  'Session token': 'Small, hot, read on every request',
  'User profile': 'Nested objects, mixed types',
  'API list (50)': 'Paginated list endpoint',
  'Metrics (24h/1m)': '1,440 numeric points — binary encoding territory',
  'Product catalog': '400 records with repetitive text',
};

export const BENCH: BenchRow[] = (rawResults.rows as any[]).map((r) => ({
  fixture: r.fixture,
  blurb: BLURBS[r.fixture] ?? 'Cache payload',
  jsonBytes: r.jsonBytes ?? r.bentoBytes,
  bentoBytes: r.bentoBytes,
  llBytes: r.llBytes,
  encoding: r.encoding,
  saved: r.saved,
  savedJson: r.savedJson ?? (1 - r.llBytes / (r.jsonBytes ?? r.bentoBytes)),
  serRatio: r.serRatio,
  deRatio: r.deRatio,
  bentoSer: r.bentoSer,
  llSer: r.llSer,
  bentoDe: r.bentoDe,
  llDe: r.llDe,
}));

export const saved = (r: BenchRow) => r.saved;
export const savedJson = (r: BenchRow) => r.savedJson;

export const BENCH_META = {
  node: rawResults.node ?? 'v24.18.0',
  bentocache: rawResults.bentocache ?? '1.6.1',
  lazyLayers: rawResults.lazyLayers ?? '0.5.0',
  reps: rawResults.reps ?? 15,
  cpu: 'Apple Silicon',
};

/** Range across the fixture set, used in headline copy. */
export const SAVINGS_MIN = Math.round(Math.min(...BENCH.map(saved)) * 100);
export const SAVINGS_MAX = Math.round(Math.max(...BENCH.map(saved)) * 100);

/**
 * Thundering herd, measured by benchmarks/herd.mjs: 10,000 concurrent
 * getOrSet calls against one cold key in a single process.
 */
export const HERD = {
  callers: 10_000,
  loaderCalls: 1,
  reused: 9_999,
  withoutDedupe: 10_000,
} as const;

/* ── What actually travels on the bus ─────────────────────────────────── */

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
    effect: 'Every peer drops user:42 from L1, L2, negative, stale and inflight. Only key and generation metadata travel.',
    carriesValue: false,
  },
  {
    type: 'pattern',
    headline: 'Invalidate wildcard pattern',
    payload: `{
  type: "pattern",
  pattern: "user:*",
  source: "node-1",
  generation: 7,
  ts: 1740086400000
}`,
    effect: 'Every peer drops each local entry whose key matches the wildcard pattern. No values travel on the wire.',
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
    effect: 'The newly loaded value is broadcast so peers warm L1 directly from the event without running the loader again.',
    carriesValue: true,
  },
];

/* ── Four Production Pillars ──────────────────────────────────────────── */

export interface Pillar {
  id: string;
  title: string;
  headline: string;
  description: string;
  bullets: string[];
}

export const PILLARS: Pillar[] = [
  {
    id: 'origin',
    title: 'Protect the origin',
    headline: 'Single loader execution on cold spikes',
    description: 'In-process request deduplication collapses concurrent getOrSet calls for the same key into a single loader execution. Add the Redis distributed lock when you need cluster-wide protection.',
    bullets: [
      '10,000 concurrent callers share 1 promise per process',
      'Optional Redis distributed lock for multi-instance herd collapse',
      'AbortSignal cancellation and configurable hard timeouts',
    ],
  },
  {
    id: 'coherence',
    title: 'Keep L1s coordinated',
    headline: 'Del, pattern, and optional set priming fanout',
    description: 'When any instance mutates or deletes data, peers are notified over Redis Pub/Sub, RabbitMQ, or NATS. Values can be broadcast to prime peer caches without redundant database trips.',
    bullets: [
      'Per-key generation counters reject out-of-order stale writes',
      'Event ID deduplication protects against durable bus replay',
      'Source loopback filtering ensures instances never echo their own events',
    ],
  },
  {
    id: 'resilience',
    title: 'Fail like a cache',
    headline: 'Dependencies fail; your request path stays alive',
    description: 'A cache must never bring down the primary application. When Redis or message brokers degrade, LazyLayers gracefully fails open to L1 or loaders without throwing 500 errors.',
    bullets: [
      'Circuit breakers trip on repeated L2/bus errors to shed load',
      'Stale fallback serves previous L1 data if origin loader times out',
      'Bounded in-memory retry queue buffers transient bus publish failures',
    ],
  },
  {
    id: 'operability',
    title: 'Make it operable',
    headline: 'Zero-guesswork runtime introspection',
    description: 'Inspect L1/L2 entries, TTL countdowns, compression savings, hit ratios, and live invalidation traffic from a built-in dashboard at /__lazylayers or scrape Prometheus metrics.',
    bullets: [
      'Built-in live web dashboard at /__lazylayers (or alias /observelazyily)',
      'Prometheus exposition endpoint at /__lazylayers/metrics',
      'OpenTelemetry diagnostics via node:diagnostics_channel',
    ],
  },
];

/* ── Progressive Adoption Stages ──────────────────────────────────────── */

export interface AdoptionStage {
  stage: string;
  scope: string;
  title: string;
  detail: string;
  code: string;
}

export const ADOPTION_STAGES: AdoptionStage[] = [
  {
    stage: '01',
    scope: '1 Process',
    title: 'Zero Infrastructure',
    detail: 'In-memory LRU with getOrSet() lazy loading, maxEntries key capacity, LRU eviction policies, and inflight herd deduplication.',
    code: `const cache = new LazyLayersCache({
  ttlMs: 60_000,
  levels: {
    L1: {
      maxEntries: 10_000, // Maximum in-memory capacity with LRU eviction
      ttlMs: 60_000,
    },
  },
});
const user = await cache.getOrSet('user:1', () => db.find(1));`,
  },
  {
    stage: '02',
    scope: 'Multiple Processes',
    title: 'Add Redis Shared L2',
    detail: 'Add a RedisStore for shared L2 caching with size-tiered compression and fail-open resilience.',
    code: `const cache = new LazyLayersCache({\n  l2: new RedisStore(redis, { prefix: 'app:' }),\n  ttlMs: 300_000,\n});`,
  },
  {
    stage: '03',
    scope: 'Multiple App Instances',
    title: 'Add an Invalidation Bus',
    detail: 'Plug in Redis Pub/Sub, RabbitMQ, or NATS to fan out del, pattern, and set priming events across instances.',
    code: `const bus = new RedisEventBus(redis, 'cache.invalidation');\nconst cache = new LazyLayersCache({ l2, eventBus: bus, broadcastSet: true });`,
  },
  {
    stage: '04',
    scope: 'High-Volume Spikes',
    title: 'Add Distributed Lock',
    detail: 'Cluster-wide stampede protection with Redis-backed lock so only one instance loads cold expensive keys.',
    code: `const cache = new LazyLayersCache({\n  l2, eventBus: bus,\n  distributedLock: { enabled: true, redis },\n});`,
  },
];

/* ── Comparison Table ─────────────────────────────────────────────────── */

export interface ComparisonRow {
  feature: string;
  ll: string;
  llStatus: 'win' | 'check' | 'neutral';
  bento: string;
  bentoStatus: 'win' | 'check' | 'neutral';
  keyv: string;
  keyvStatus: 'win' | 'check' | 'neutral';
}

export const COMPARISON_ROWS: ComparisonRow[] = [
  {
    feature: 'In-memory L1 (LRU)',
    ll: '✓ Built-in',
    llStatus: 'check',
    bento: '✓ Built-in',
    bentoStatus: 'check',
    keyv: '✓ Built-in',
    keyvStatus: 'check',
  },
  {
    feature: 'Shared Redis L2',
    ll: '✓ Built-in',
    llStatus: 'check',
    bento: '✓ Built-in',
    bentoStatus: 'check',
    keyv: '✓ Built-in',
    keyvStatus: 'check',
  },
  {
    feature: 'Read-through getOrSet',
    ll: '✓ Built-in',
    llStatus: 'check',
    bento: '✓ Built-in',
    bentoStatus: 'check',
    keyv: '✓ Built-in',
    keyvStatus: 'check',
  },
  {
    feature: 'Per-process inflight dedupe',
    ll: '✓ Automatic',
    llStatus: 'check',
    bento: '✓ Automatic',
    bentoStatus: 'check',
    keyv: '✓ Automatic',
    keyvStatus: 'check',
  },
  {
    feature: 'Cross-instance stampede lock',
    ll: '✓ Built-in Redis lock',
    llStatus: 'win',
    bento: '✓ Built-in driver lock',
    bentoStatus: 'check',
    keyv: 'Plugin required',
    keyvStatus: 'neutral',
  },
  {
    feature: 'Cross-instance invalidation',
    ll: '✓ Redis, RabbitMQ, NATS',
    llStatus: 'win',
    bento: '✓ Redis, Memory bus',
    bentoStatus: 'check',
    keyv: 'Varies by adapter',
    keyvStatus: 'neutral',
  },
  {
    feature: 'Value broadcast / L1 priming',
    ll: '✓ First-class (broadcastSet)',
    llStatus: 'win',
    bento: 'Delete-focused',
    bentoStatus: 'neutral',
    keyv: '—',
    keyvStatus: 'neutral',
  },
  {
    feature: 'NATS Core & JetStream',
    ll: '✓ Built-in native drivers',
    llStatus: 'win',
    bento: 'Custom driver needed',
    bentoStatus: 'neutral',
    keyv: '—',
    keyvStatus: 'neutral',
  },
  {
    feature: 'RabbitMQ durable bus',
    ll: '✓ Built-in amqplib driver',
    llStatus: 'win',
    bento: '✓ Community bus',
    bentoStatus: 'check',
    keyv: '—',
    keyvStatus: 'neutral',
  },
  {
    feature: 'Redis payload compression',
    ll: '✓ MessagePack + LZ4/Zstd tiered',
    llStatus: 'win',
    bento: 'JSON default envelope',
    bentoStatus: 'neutral',
    keyv: 'JSON / manual plugin',
    keyvStatus: 'neutral',
  },
  {
    feature: 'Live UI cache inspector',
    ll: '✓ Built-in (/__lazylayers)',
    llStatus: 'win',
    bento: 'External APM tooling',
    bentoStatus: 'neutral',
    keyv: '—',
    keyvStatus: 'neutral',
  },
  {
    feature: 'Storage driver ecosystem',
    ll: 'Focused (Memory, Redis)',
    llStatus: 'neutral',
    bento: 'Large (Redis, Memcached, Dynamo, Files)',
    bentoStatus: 'win',
    keyv: 'Very large (Postgres, Mongo, SQLite, etc.)',
    keyvStatus: 'win',
  },
  {
    feature: 'Tagging & Namespaces',
    ll: 'Prefixes & Wildcard patterns',
    llStatus: 'neutral',
    bento: 'Comprehensive tag trees',
    bentoStatus: 'win',
    keyv: 'Strong namespaces',
    keyvStatus: 'win',
  },
  {
    feature: 'Maturity',
    ll: 'Active (v0.5.x)',
    llStatus: 'neutral',
    bento: 'Mature (1.x)',
    bentoStatus: 'win',
    keyv: 'Mature (1.x)',
    keyvStatus: 'win',
  },
];

/* ── Limitations ──────────────────────────────────────────────────────── */

export interface Limitation {
  title: string;
  reason: string;
}

export const LIMITATIONS: Limitation[] = [
  {
    title: 'You need strongly consistent or linearizable reads',
    reason: 'LazyLayers uses asynchronous bus invalidation and generation counters. It is an eventually consistent caching layer, not a distributed consensus engine like Raft.',
  },
  {
    title: 'You need ACID transactions across cached keys',
    reason: 'Operations on L1 and L2 are individually atomic per key, but there is no multi-key distributed transaction coordinator.',
  },
  {
    title: 'The cache is your primary source of truth',
    reason: 'LazyLayers is built to sit in front of databases and APIs. Cache entries can be evicted, expired, or purged at any time.',
  },
  {
    title: 'You need dozens of database/storage adapters',
    reason: 'LazyLayers focuses intentionally on in-memory LRU and Redis. If you need Postgres, SQLite, MongoDB, or DynamoDB as cache stores, libraries like Keyv or BentoCache are better suited.',
  },
  {
    title: 'You need complex hierarchical tagging taxonomies today',
    reason: 'LazyLayers currently provides key prefixes and wildcard pattern invalidations (e.g. user:*). Complex multi-tag intersections are not supported in pre-1.0.',
  },
  {
    title: 'Your values are micro-strings and serialization speed dominates',
    reason: 'We deliberately spend some CPU cycles packing MessagePack and compressing tiered payloads to save 33%–92% Redis bytes. If storing 20-byte strings at 5,000,000 ops/sec, raw JSON.stringify will be faster.',
  },
];

/* ── Transports ───────────────────────────────────────────────────────── */

export interface Transport {
  name: string;
  delivery: string;
  note: string;
  durable: boolean;
}

export const TRANSPORTS: Transport[] = [
  { name: 'Redis Pub/Sub',   delivery: 'At-most-once', note: 'Ephemeral. Zero extra broker infra if you already use Redis.', durable: false },
  { name: 'NATS Core',       delivery: 'At-most-once', note: 'Fastest fanout and lowest latency. No replay for disconnected peers.', durable: false },
  { name: 'RabbitMQ',        delivery: 'Durable',      note: 'Persistent messages and dedicated per-instance queue bindings.', durable: true },
  { name: 'NATS JetStream',  delivery: 'Durable',      note: 'Replayable streams, explicit acks, redelivery tracking, max-deliver.', durable: true },
];

export const FAQS = [
  {
    q: 'What problem does cross-instance invalidation solve?',
    a: 'Every application instance keeps its own fast in-process L1 LRU cache. When one instance updates or deletes a record, other instances would otherwise continue serving their stale local copy until its TTL expires. An invalidation bus notifies peer instances immediately, reducing the stale window to network propagation latency.',
  },
  {
    q: 'What is the difference between invalidation and L1 priming?',
    a: 'Invalidation is delete-only: peers receive a key deletion event, drop the local entry, and reload it from L2 or database on their next read. Priming goes further: when a getOrSet loader resolves, the loaded value is broadcast so peers can warm their local L1 directly without executing the database loader. Set broadcastSet: false if you prefer delete-only fanout.',
  },
  {
    q: 'How does LazyLayers handle out-of-order and duplicate events?',
    a: 'LazyLayers uses three distinct checks: (1) Event deduplication by ID with an LRU ring-buffer catches redeliveries on durable brokers; (2) Source filtering ignores self-broadcasts; (3) Per-key generation counters reject incoming events that are older than the local state, preventing stale sets from overwriting newer deletes.',
  },
  {
    q: 'Why are serialization ratios slower than JSON.stringify in benchmarks?',
    a: 'Native JSON.stringify is built in C++ inside the V8 engine and heavily optimized. LazyLayers uses MessagePack and size-tiered LZ4/Zstd compression. We deliberately trade modest CPU time on writes/reads to reduce Redis payload size by 33%–92%. This substantially lowers Redis memory costs, network payload transfer, and replica sync bandwidth.',
  },
  {
    q: 'How does size-tiered compression decide which codec to use?',
    a: 'Under 256 bytes: raw MessagePack (no compression, since headers expand small buffers). Between 256 bytes and 4 KB: LZ4 (fastest compression with low CPU overhead). Above 4 KB: Zstd (where compression ratios produce the largest byte savings per microsecond). On Node 20 runtimes without native Zstd, it automatically falls back to LZ4.',
  },
  {
    q: 'Do I have to run Redis or an event bus to use LazyLayers?',
    a: 'No. LazyLayers is designed for progressive adoption. You can use it as a standalone, zero-infrastructure in-process LRU cache. You can add Redis when you need a shared L2 store, add Pub/Sub or RabbitMQ/NATS when scaling out across multiple servers, and enable distributed locking only for expensive cold queries.',
  },
  {
    q: 'How do I access the live observability dashboard?',
    a: 'Set observability: true in cache options. LazyLayers exposes a lightweight, zero-dependency dashboard at /__lazylayers (with /observelazyily supported as an alias). It includes real-time L1/L2 memory inspection, compression savings gauges, and Prometheus metrics at /__lazylayers/metrics.',
  },
  {
    q: 'Are the published benchmark numbers reproducible?',
    a: 'Yes. All fixtures are seeded and deterministic, so byte counts reproduce identically on any machine. Throughput benchmarks use 15-repetition fixed-iteration timing in benchmarks/run.mjs.',
  },
];
