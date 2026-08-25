/**
 * ============================================================================
 * EXAMPLE 03: SINGLE-SERVER HYBRID L1 + L2 (TWO-TIERED ARCHITECTURE)
 * ============================================================================
 *
 * SYSTEM DESIGN & ARCHITECTURE OVERVIEW:
 * ----------------------------------------------------------------------------
 * 1. THE TWO-TIERED HYBRID PATTERN:
 *    - L1 (In-Memory LRU): Serves hot keys in sub-microseconds (<1µs) with zero network I/O.
 *    - L2 (Remote Redis): Acts as a shared persistent backing store across processes,
 *      warming up L1 instantly on process restarts and handling large working sets.
 *    - On cache miss:
 *        Step A: Check local L1 memory -> HIT -> Return immediately.
 *        Step B: Check remote Redis L2 -> HIT -> Populate L1 -> Return.
 *        Step C: Acquire distributed lock -> Execute origin DB query -> Write to L2 and L1 -> Return.
 *
 * 2. MULTI-TIER CACHE STAMPEDE DEFENSE:
 *    - Level 1 (Local): In-flight promise coalescing collapses simultaneous threads
 *      within the same Node.js process onto a single loader.
 *    - Level 2 (Global): Redis distributed mutex lock prevents multiple independent
 *      server instances from calculating the same expensive aggregate query concurrently.
 *
 * 3. TTL HIERARCHIES:
 *    - L1 TTL is typically configured shorter (e.g. 30-60 seconds) to bound memory
 *      and limit drift in single-server mode.
 *    - L2 TTL is configured longer (e.g. 10-60 minutes) to preserve persistence
 *      in Redis across restarts.
 *
 * 4. LIVE DASHBOARD & METRICS:
 *    - Standalone web inspector at http://127.0.0.1:7073/__lazylayers
 *    - Scrapes Prometheus gauges at http://127.0.0.1:7073/__lazylayers/metrics
 * ============================================================================
 */

import Redis from 'ioredis';
import {
  LazyLayersCache,
  RedisStore,
  type CacheEvent,
} from '../../dist/index.js';

// --- Domain Models ---
export interface UserSession {
  sessionId: string;
  userId: string;
  username: string;
  roles: string[];
  preferences: {
    theme: 'dark' | 'light';
    locale: string;
    notificationsEnabled: boolean;
  };
  lastActive: number;
}

// --- Simulated Database ---
const sessionDatabase = new Map<string, UserSession>();
let databaseQueryCount = 0;

async function loadSessionFromOrigin(sessionId: string): Promise<UserSession> {
  databaseQueryCount++;
  // Simulate 100ms database / auth service lookup
  await new Promise((resolve) => setTimeout(resolve, 100));

  if (!sessionDatabase.has(sessionId)) {
    sessionDatabase.set(sessionId, {
      sessionId,
      userId: `usr_${Math.floor(1000 + Math.random() * 9000)}`,
      username: `developer_${sessionId.slice(0, 4)}`,
      roles: ['engineer', 'admin'],
      preferences: {
        theme: 'dark',
        locale: 'en-US',
        notificationsEnabled: true,
      },
      lastActive: Date.now(),
    });
  }

  return sessionDatabase.get(sessionId)!;
}

// --- Connect to Redis ---
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6389';
const redisClient = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
});

async function initHybridCache() {
  await redisClient.connect().catch((err) => {
    console.warn(`[WARN] Could not connect to Redis at ${REDIS_URL}: ${err.message}`);
  });

  const redisStore = new RedisStore(redisClient, {
    prefix: 'hybrid:session:',
    useIndex: true,
    deleteStrategy: 'unlink',
  });

  const cache = new LazyLayersCache<string, UserSession>({
    source: 'hybrid-app-server',

    // L1: In-memory LRU store (Fast path)
    // L2: Redis store (Persistence path)
    l2: redisStore,

    // TTL Hierarchy: 30s in L1 RAM, 10 minutes in Redis L2
    levels: {
      L1: {
        maxEntries: 10_000,
        ttlMs: 30_000,
      },
      L2: {
        ttlMs: 600_000,
      },
    },

    // Multi-tier stampede protection with Redis distributed lock
    distributedLock: {
      enabled: true,
      redis: redisClient,
      ttlMs: 3000,
      waitTimeoutMs: 5000,
    },

    // Circuit Breaker for L2 Redis resilience
    circuitBreaker: {
      failureThreshold: 3,
      resetTimeoutMs: 8000,
      halfOpenSuccessThreshold: 2,
    },

    // Observability Dashboard on Port 7073
    observability: {
      enabled: true,
      route: '/__lazylayers',
      server: {
        host: '127.0.0.1',
        port: 7073,
      },
      auth: {
        username: 'lazydev',
        password: 'lazydev',
      },
      prometheus: {
        enabled: true,
        prefix: 'lazycache',
        public: true,
      },
    },

    // Terminal Logging
    events: [
      (event: CacheEvent) => {
        const time = new Date().toISOString().split('T')[1].slice(0, 8);
        if (event.type === 'hit') {
          const color = event.level === 'L1' ? '\x1b[32m' : '\x1b[34m';
          console.log(`${color}[${time}] [${event.level} HIT]\x1b[0m key="${event.key}"`);
        } else if (event.type === 'miss') {
          console.log(`\x1b[33m[${time}] [CACHE MISS]\x1b[0m key="${event.key}" level=${event.level}`);
        } else if (event.type === 'set') {
          console.log(`\x1b[35m[${time}] [CACHE SET]\x1b[0m key="${event.key}" written to levels: ${event.levels?.join(', ')}`);
        }
      },
    ],

    logging: { env: 'production' },
  });

  return cache;
}

// --- Execution & Verification Workflow ---
async function runDemo() {
  console.log('\n=================================================================');
  console.log('  LazyLayers Hybrid L1 + L2 Two-Tiered Cache Demo');
  console.log('  Redis Connection:        ' + REDIS_URL);
  console.log('  Observability Dashboard: http://127.0.0.1:7073/__lazylayers');
  console.log('  Prometheus Metrics:      http://127.0.0.1:7073/__lazylayers/metrics');
  console.log('  Credentials:             lazydev / lazydev');
  console.log('=================================================================\n');

  const cache = await initHybridCache();

  // 1. Cold Read: Misses L1 and L2 -> Queries DB -> Populates both L2 and L1
  console.log('--- Step 1: Cold Read for session:sess_alpha ---');
  const t0 = performance.now();
  const session1 = await cache.getOrSet('sess_alpha', () => loadSessionFromOrigin('sess_alpha'));
  const d0 = (performance.now() - t0).toFixed(2);
  console.log(`Loaded from origin DB in ${d0}ms (DB queries: ${databaseQueryCount}):`, session1.username);

  // 2. Warm L1 Read: Serves in sub-microsecond time (<0.1ms)
  console.log('\n--- Step 2: Warm Read for session:sess_alpha (L1 In-Memory Hit) ---');
  const t1 = performance.now();
  const session1L1 = await cache.getOrSet('sess_alpha', () => loadSessionFromOrigin('sess_alpha'));
  const d1 = (performance.now() - t1).toFixed(4);
  console.log(`\x1b[32m✔ Served from L1 RAM in ${d1}ms (DB queries: ${databaseQueryCount}): ${session1L1.username}\x1b[0m`);

  // 3. Simulate L1 Eviction / Server Restart (Drop L1, Read from L2 Redis)
  console.log('\n--- Step 3: Simulate L1 Eviction (Clear local RAM, read from L2 Redis) ---');
  cache.l1?.clear(); // Evict local memory
  console.log('L1 memory cleared. Reading sess_alpha again...');

  const t2 = performance.now();
  const session1L2 = await cache.getOrSet('sess_alpha', () => loadSessionFromOrigin('sess_alpha'));
  const d2 = (performance.now() - t2).toFixed(2);
  console.log(`\x1b[34m✔ Served from Redis L2 in ${d2}ms (Promoted back to L1! DB queries: ${databaseQueryCount}): ${session1L2.username}\x1b[0m`);

  // 4. Verify L1 was re-promoted from L2 read
  const t3 = performance.now();
  await cache.get('sess_alpha');
  const d3 = (performance.now() - t3).toFixed(4);
  console.log(`Next read immediately served from re-promoted L1 in ${d3}ms`);

  console.log('\n=================================================================');
  console.log('  Live Server is running! Open http://127.0.0.1:7073/__lazylayers');
  console.log('  Press Ctrl+C to terminate.');
  console.log('=================================================================\n');
}

// Execute demo if run directly
if (process.argv[1]?.endsWith('03-single-server-hybrid-l1-l2/index.ts') || process.argv[1]?.endsWith('03-single-server-hybrid-l1-l2/index.js')) {
  runDemo().catch(console.error);
}

export { initHybridCache, runDemo };
