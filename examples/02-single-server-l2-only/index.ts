/**
 * ============================================================================
 * EXAMPLE 02: SINGLE-SERVER L2-ONLY (REDIS WITH SIZE-TIERED COMPRESSION)
 * ============================================================================
 *
 * SYSTEM DESIGN & ARCHITECTURE OVERVIEW:
 * ----------------------------------------------------------------------------
 * 1. WHEN TO USE L2-ONLY:
 *    - Memory-constrained application containers (e.g. 256MB RAM ECS/Kubernetes pods)
 *      where keeping large in-memory objects in Node.js heap would trigger OOM kills.
 *    - State persistence across frequent application restarts, blue-green deployments,
 *      and worker scaling events.
 *    - Very large cached objects (e.g. 500KB - 5MB product catalogs, analytics reports)
 *      where centralized Redis memory with compression is preferred over local RAM.
 *
 * 2. SIZE-TIERED WIRE COMPRESSION (MSGPACK / LZ4 / ZSTD):
 *    - Small payloads (<256 B): Encoded via high-speed binary MessagePack (`HC1M`).
 *    - Medium payloads (256 B - 4 KB): Compressed with LZ4 (`HC1L`) for 60-80% size savings
 *      with virtually zero CPU decompression overhead.
 *    - Large payloads (>=4 KB): Compressed with Zstandard / Zstd (`HC1Z`) or gzip (`HC1G`),
 *      reducing bandwidth on the Redis network link by up to 85-92%.
 *
 * 3. SCAN-BASED & INDEXED WILDCARD INVALIDATION:
 *    - Unlike Redis `KEYS *` which is O(N) and BLOCKS the entire single-threaded Redis
 *      event loop, LazyLayers uses non-blocking cursor-based `ZSCAN` or `SCAN` streams.
 *    - Deletions are batched in pipelines using `UNLINK` (non-blocking background memory free)
 *      rather than synchronous `DEL`.
 *
 * 4. CIRCUIT BREAKER & FAIL-OPEN RESILIENCE:
 *    - If Redis experiences a network partition, timeout, or failover, the built-in
 *      Circuit Breaker trips OPEN.
 *    - When OPEN, calls fail open directly to the origin database loader without waiting
 *      for Redis timeouts, preserving service availability during infrastructure outages.
 *
 * 5. LIVE OBSERVABILITY:
 *    - Integrated web dashboard at http://127.0.0.1:7072/__lazylayers
 *    - Prometheus scrape endpoint at http://127.0.0.1:7072/__lazylayers/metrics
 * ============================================================================
 */

import Redis from 'ioredis';
import {
  LazyLayersCache,
  RedisStore,
  serializeWithStats,
  type CacheEvent,
} from '../../dist/index.js';

// --- Domain Models ---
export interface ProductCatalogItem {
  sku: string;
  title: string;
  description: string;
  price: number;
  tags: string[];
  specs: Record<string, string | number>;
}

export interface ProductCatalog {
  categoryId: string;
  generatedAt: number;
  items: ProductCatalogItem[];
}

// Helper to generate a realistic large catalog payload
function generateCatalog(categoryId: string, itemCount = 60): ProductCatalog {
  const items: ProductCatalogItem[] = [];
  for (let i = 1; i <= itemCount; i++) {
    items.push({
      sku: `PROD-${categoryId.toUpperCase()}-${i.toString().padStart(4, '0')}`,
      title: `High Performance Industrial Component Model #${i}`,
      description: 'Durable anodized aluminum housing with precision calibrated sensors and low-power telemetry.',
      price: Math.round((49.99 + i * 2.5) * 100) / 100,
      tags: ['industrial', 'precision', 'sensors', 'telemetry', 'high-durability'],
      specs: {
        weightGrams: 350 + (i % 10) * 15,
        operatingTempC: '-40 to +85',
        voltageRange: '12-24V DC',
        firmwareRev: `v2.4.${i % 5}`,
      },
    });
  }
  return {
    categoryId,
    generatedAt: Date.now(),
    items,
  };
}

// --- Connect to Redis ---
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6389';
const redisClient = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
});

let dbQueryCount = 0;
async function fetchCatalogFromDatabase(categoryId: string): Promise<ProductCatalog> {
  dbQueryCount++;
  // Simulate slow SQL aggregation across product tables (150ms)
  await new Promise((resolve) => setTimeout(resolve, 150));
  return generateCatalog(categoryId);
}

// --- Initialize L2-Only LazyLayers Cache ---
async function initCache() {
  await redisClient.connect().catch((err) => {
    console.warn(`[WARN] Could not connect to Redis at ${REDIS_URL}: ${err.message}. Using mock/fallback.`);
  });

  const redisStore = new RedisStore(redisClient, {
    prefix: 'l2example:catalog:',
    useIndex: true, // Maintain sorted-set index for ultra-fast O(log N) wildcard pattern wipes
    deleteStrategy: 'unlink', // Non-blocking background memory freeing in Redis
  });

  const cache = new LazyLayersCache<string, ProductCatalog>({
    source: 'catalog-service-node',
    l1: false, // Explicitly disable in-memory L1 cache (L2-only)
    l2: redisStore,
    ttlMs: 300_000, // 5 minutes TTL

    // Distributed lock to prevent multiple cluster workers from computing the catalog at once
    distributedLock: {
      enabled: true,
      redis: redisClient,
      ttlMs: 5000,
      waitTimeoutMs: 8000,
    },

    // Circuit Breaker: Fail-open if Redis encounters 3 consecutive timeouts
    circuitBreaker: {
      failureThreshold: 3,
      resetTimeoutMs: 10_000,
      halfOpenSuccessThreshold: 2,
    },

    // Built-in Observability Dashboard on Port 7072
    observability: {
      enabled: true,
      route: '/__lazylayers',
      server: {
        host: '127.0.0.1',
        port: 7072,
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

    // Real-time Event Hook for Terminal Logs
    events: [
      (event: CacheEvent) => {
        const time = new Date().toISOString().split('T')[1].slice(0, 8);
        if (event.type === 'hit') {
          console.log(`\x1b[32m[${time}] [L2 HIT]\x1b[0m key="${event.key}" from Redis L2 layer`);
        } else if (event.type === 'miss') {
          console.log(`\x1b[33m[${time}] [L2 MISS]\x1b[0m key="${event.key}" (querying database...)`);
        } else if (event.type === 'set') {
          console.log(`\x1b[35m[${time}] [L2 STORE]\x1b[0m key="${event.key}" serialized & compressed to Redis`);
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
  console.log('  LazyLayers L2-Only (Redis + Tiered Compression) Demo');
  console.log('  Redis Connection:        ' + REDIS_URL);
  console.log('  Observability Dashboard: http://127.0.0.1:7072/__lazylayers');
  console.log('  Prometheus Metrics:      http://127.0.0.1:7072/__lazylayers/metrics');
  console.log('  Credentials:             lazydev / lazydev');
  console.log('=================================================================\n');

  const cache = await initCache();

  // 1. Serialization & Wire Compression Demonstration
  console.log('--- Step 1: Wire Compression Analysis ---');
  const sampleCatalog = generateCatalog('electronics', 100);
  const stats = serializeWithStats(sampleCatalog);
  const rawJsonBytes = Buffer.byteLength(JSON.stringify(sampleCatalog));

  console.log(`Raw JSON payload size:          ${(rawJsonBytes / 1024).toFixed(2)} kB`);
  console.log(`LazyLayers compressed size:     ${(stats.storedBytes / 1024).toFixed(2)} kB (${stats.encoding})`);
  console.log(`\x1b[32m✔ Network Bandwidth Saved:       ${((1 - stats.storedBytes / rawJsonBytes) * 100).toFixed(1)}%\x1b[0m\n`);

  // 2. Cold L2 Read (Computes and Stores into Redis)
  console.log('--- Step 2: Cold read for category:hardware ---');
  const t0 = performance.now();
  const catalog1 = await cache.getOrSet('hardware', () => fetchCatalogFromDatabase('hardware'));
  const d0 = (performance.now() - t0).toFixed(2);
  console.log(`Loaded catalog in ${d0}ms (${catalog1.items.length} items, DB queries: ${dbQueryCount})`);

  // 3. Warm L2 Read (Fetched directly from Redis)
  console.log('\n--- Step 3: Warm read for category:hardware (Redis L2 Hit) ---');
  const t1 = performance.now();
  const catalog1Cached = await cache.getOrSet('hardware', () => fetchCatalogFromDatabase('hardware'));
  const d1 = (performance.now() - t1).toFixed(2);
  console.log(`Fetched from Redis in ${d1}ms (DB queries: ${dbQueryCount}): ${catalog1Cached.items.length} items`);

  // 4. Wildcard Pattern Invalidation (Delete category:* without blocking Redis)
  console.log('\n--- Step 4: Non-blocking Wildcard Pattern Invalidation ---');
  await cache.set('tools:hand', generateCatalog('tools:hand', 10));
  await cache.set('tools:power', generateCatalog('tools:power', 10));

  console.log('Keys before pattern purge: tools:hand & tools:power are cached');
  await cache.deleteByPattern('tools:*');
  console.log('\x1b[32m✔ Executed deleteByPattern("tools:*") using indexed SCAN & UNLINK\x1b[0m');

  const handVal = await cache.get('tools:hand');
  const powerVal = await cache.get('tools:power');
  console.log(`tools:hand deleted: ${handVal === undefined}, tools:power deleted: ${powerVal === undefined}`);

  console.log('\n=================================================================');
  console.log('  Live Server is running! Open http://127.0.0.1:7072/__lazylayers');
  console.log('  Press Ctrl+C to terminate.');
  console.log('=================================================================\n');
}

// Execute demo if run directly
if (process.argv[1]?.endsWith('02-single-server-l2-only/index.ts') || process.argv[1]?.endsWith('02-single-server-l2-only/index.js')) {
  runDemo().catch(console.error);
}

export { initCache, runDemo };
