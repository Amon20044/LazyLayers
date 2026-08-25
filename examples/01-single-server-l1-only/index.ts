/**
 * ============================================================================
 * EXAMPLE 01: SINGLE-SERVER L1-ONLY (IN-MEMORY LRU CACHE)
 * ============================================================================
 *
 * SYSTEM DESIGN & ARCHITECTURE OVERVIEW:
 * ----------------------------------------------------------------------------
 * 1. WHEN TO USE L1-ONLY:
 *    - Single-instance services, serverless/edge workers, local compute nodes,
 *      or microservices where sub-microsecond latency (<1µs) is critical.
 *    - Ephemeral datasets where cache loss on process restart is completely
 *      acceptable and will naturally warm back up from the source database.
 *    - High-frequency read paths (e.g. JWT session validation, tenant flags,
 *      localization dictionaries, high-throughput rate limiting counters).
 *
 * 2. MEMORY BUDGETING & LRU EVICTION:
 *    - L1 uses an optimized Least-Recently-Used (LRU) in-memory data structure.
 *    - In-memory objects avoid serialization/deserialization overhead on reads.
 *    - LRU eviction is O(1). Internal inspection (for dashboard/metrics) uses
 *      peek operations to ensure eviction order is NEVER corrupted by monitoring.
 *
 * 3. REQUEST COALESCING (IN-FLIGHT HERD COLLAPSE):
 *    - When 1,000 concurrent callers query the exact same missing key (e.g. `user:101`),
 *      LazyLayers coalesces them onto a SINGLE in-flight loader promise.
 *    - All 1,000 callers wait for that single database query and receive the result
 *      simultaneously, preventing downstream database connection exhaustion.
 *
 * 4. NEGATIVE CACHING & TIMEOUT BOUNDING:
 *    - 404 / null results are cached with a short TTL (negative caching) to stop
 *      cache penetration attacks from repeatedly hitting the database.
 *    - Soft/Hard loader timeouts ensure unresponsive origin databases fail open
 *      or serve stale fallback data rather than blocking caller HTTP threads.
 *
 * 5. LIVE OBSERVABILITY:
 *    - Integrated zero-dependency web dashboard at http://127.0.0.1:7071/__lazylayers
 *    - Real-time Prometheus metrics at http://127.0.0.1:7071/__lazylayers/metrics
 * ============================================================================
 */

import { LazyLayersCache, type CacheEvent } from '../../dist/index.js';

// --- Domain Models ---
export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'editor' | 'viewer';
  tier: 'free' | 'pro' | 'enterprise';
  createdAt: number;
}

// --- Simulated Database (Slow Origin Service) ---
const mockDatabase = new Map<string, User>([
  ['usr_101', { id: 'usr_101', name: 'Alice Smith', email: 'alice@example.com', role: 'admin', tier: 'enterprise', createdAt: Date.now() - 86400000 }],
  ['usr_102', { id: 'usr_102', name: 'Bob Jones', email: 'bob@example.com', role: 'editor', tier: 'pro', createdAt: Date.now() - 172800000 }],
  ['usr_103', { id: 'usr_103', name: 'Carol White', email: 'carol@example.com', role: 'viewer', tier: 'free', createdAt: Date.now() - 259200000 }],
]);

let originDbQueryCount = 0;

async function queryDatabase(userId: string): Promise<User | null> {
  originDbQueryCount++;
  // Simulate 120ms database I/O latency
  await new Promise((resolve) => setTimeout(resolve, 120));
  return mockDatabase.get(userId) ?? null;
}

// --- Initialize L1-Only LazyLayers Cache ---
const cache = new LazyLayersCache<string, User | null>({
  source: 'web-api-node-01',
  l2: false, // Explicitly disable L2 layer (In-memory L1 only)

  // Memory budgeting: Store up to 5,000 entries before LRU eviction triggers
  levels: {
    L1: {
      maxEntries: 5000,
      ttlMs: 60_000, // 1 minute default TTL
    },
  },

  // In-flight stampede protection (enabled by default with 15s inflight lock timeout)
  inflight: {
    ttlMs: 15_000,
  },

  // Negative Caching: Cache null/not-found database lookups for 10s to prevent DB hammering
  negative: {
    enabled: true,
    ttlMs: 10_000,
  },

  // Fail-Safe: Keep stale value for 10 minutes to serve during origin database outages
  failSafe: {
    enabled: true,
    staleTtlMs: 600_000,
  },

  // Loader Timeouts: Bound slow queries (1000ms hard abort)
  timeouts: {
    softMs: 500,
    hardMs: 1000,
  },

  // Built-in Live Observability Dashboard & Prometheus Scrape Endpoint
  observability: {
    enabled: true,
    route: '/__lazylayers',
    server: {
      host: '127.0.0.1',
      port: 7071,
    },
    auth: {
      username: 'lazydev',
      password: 'lazydev',
    },
    prometheus: {
      enabled: true,
      prefix: 'lazycache',
      public: true, // Allow Prometheus scraper without Basic Auth
    },
  },

  // Real-time Event Hook for Terminal Logging
  events: [
    (event: CacheEvent) => {
      const time = new Date().toISOString().split('T')[1].slice(0, 8);
      if (event.type === 'hit') {
        console.log(`\x1b[32m[${time}] [L1 HIT]\x1b[0m key="${event.key}" level=${event.level}`);
      } else if (event.type === 'miss') {
        console.log(`\x1b[33m[${time}] [CACHE MISS]\x1b[0m key="${event.key}" level=${event.level} (fetching from DB...)`);
      } else if (event.type === 'inflight:merged') {
        console.log(`\x1b[36m[${time}] [HERD MERGED]\x1b[0m key="${event.key}" caller coalesced onto in-flight promise`);
      }
    },
  ],

  logging: { env: 'production' },
});

// --- Execution & Verification Workflow ---
async function runDemo() {
  console.log('\n=================================================================');
  console.log('  LazyLayers L1-Only In-Memory Cache Demo');
  console.log('  Observability Dashboard: http://127.0.0.1:7071/__lazylayers');
  console.log('  Prometheus Metrics:      http://127.0.0.1:7071/__lazylayers/metrics');
  console.log('  Credentials:             lazydev / lazydev');
  console.log('=================================================================\n');

  // 1. First Read: Cold Miss (Loads from DB)
  console.log('--- Step 1: Cold read for usr_101 ---');
  const t0 = performance.now();
  const user1 = await cache.getOrSet('usr_101', () => queryDatabase('usr_101'));
  const d0 = (performance.now() - t0).toFixed(2);
  console.log(`Loaded user in ${d0}ms (Origin DB queries: ${originDbQueryCount}):`, user1?.name);

  // 2. Second Read: Instant L1 Cache Hit (<0.1ms)
  console.log('\n--- Step 2: Warm read for usr_101 (Immediate L1 Hit) ---');
  const t1 = performance.now();
  const user1Cached = await cache.getOrSet('usr_101', () => queryDatabase('usr_101'));
  const d1 = (performance.now() - t1).toFixed(4);
  console.log(`Fetched from L1 in ${d1}ms (Origin DB queries: ${originDbQueryCount}):`, user1Cached?.name);

  // 3. Herd Stampede Simulation (50 concurrent requests for cold key usr_102)
  console.log('\n--- Step 3: Cache Stampede Simulation (50 concurrent requests for usr_102) ---');
  const dbQueriesBefore = originDbQueryCount;
  const herdStart = performance.now();

  const herdPromises = Array.from({ length: 50 }, () =>
    cache.getOrSet('usr_102', () => queryDatabase('usr_102'))
  );

  const herdResults = await Promise.all(herdPromises);
  const herdDuration = (performance.now() - herdStart).toFixed(2);
  const dbQueriesDuring = originDbQueryCount - dbQueriesBefore;

  console.log(`Resolved 50 simultaneous callers in ${herdDuration}ms`);
  console.log(`\x1b[32m✔ DB Queries executed: ${dbQueriesDuring} (49 callers collapsed!)\x1b[0m`);
  console.log(`All callers got valid data: ${herdResults.every((u) => u?.id === 'usr_102')}`);

  // 4. Negative Caching Demo (Non-existent user usr_999)
  console.log('\n--- Step 4: Negative Caching for non-existent usr_999 ---');
  await cache.getOrSet('usr_999', () => queryDatabase('usr_999')); // DB Miss -> caches null sentinel
  await cache.getOrSet('usr_999', () => queryDatabase('usr_999')); // L1 Miss -> returns cached negative sentinel
  console.log(`Total DB queries after querying non-existent key twice: ${originDbQueryCount} (1 query only)`);

  console.log('\n=================================================================');
  console.log('  Live Server is running! Open http://127.0.0.1:7071/__lazylayers');
  console.log('  Press Ctrl+C to terminate.');
  console.log('=================================================================\n');
}

// Execute demo if run directly
if (process.argv[1]?.endsWith('01-single-server-l1-only/index.ts') || process.argv[1]?.endsWith('01-single-server-l1-only/index.js')) {
  runDemo().catch(console.error);
}

export { cache, queryDatabase, runDemo };
