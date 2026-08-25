/**
 * ============================================================================
 * FULLSTACK DEMO: HONO.JS BACKEND + LAZYLAYERS HYBRID CACHE & OBSERVABILITY
 * ============================================================================
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import Redis from 'ioredis';
import {
  LazyLayersCache,
  RedisStore,
  type CacheEvent,
} from '../../../dist/index.js';

// --- Domain Models ---
export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'developer' | 'designer' | 'analyst';
  tier: 'starter' | 'pro' | 'enterprise';
  avatar: string;
  bio: string;
  stats: {
    projects: number;
    apiCalls: number;
    lastLogin: number;
  };
}

// --- Simulated Database with realistic latency ---
const mockDatabase = new Map<string, User>([
  [
    'usr_1',
    {
      id: 'usr_1',
      name: 'Alex Rivera',
      email: 'alex.rivera@example.com',
      role: 'admin',
      tier: 'enterprise',
      avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
      bio: 'Principal Infrastructure Engineer specializing in distributed caching and edge networks.',
      stats: { projects: 18, apiCalls: 142050, lastLogin: Date.now() - 3600000 },
    },
  ],
  [
    'usr_2',
    {
      id: 'usr_2',
      name: 'Sarah Chen',
      email: 'sarah.chen@example.com',
      role: 'developer',
      tier: 'pro',
      avatar: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=150&auto=format&fit=crop&q=80',
      bio: 'Full-stack TypeScript architect building scalable real-time systems.',
      stats: { projects: 12, apiCalls: 89300, lastLogin: Date.now() - 7200000 },
    },
  ],
  [
    'usr_3',
    {
      id: 'usr_3',
      name: 'Marcus Vance',
      email: 'marcus.v@example.com',
      role: 'analyst',
      tier: 'starter',
      avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80',
      bio: 'Data pipeline specialist focusing on low-latency analytical queries.',
      stats: { projects: 7, apiCalls: 24100, lastLogin: Date.now() - 14400000 },
    },
  ],
  [
    'usr_4',
    {
      id: 'usr_4',
      name: 'Elena Rostova',
      email: 'elena.r@example.com',
      role: 'designer',
      tier: 'pro',
      avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&auto=format&fit=crop&q=80',
      bio: 'Design systems lead crafting high-performance UI components and micro-interactions.',
      stats: { projects: 22, apiCalls: 65400, lastLogin: Date.now() - 86400000 },
    },
  ],
]);

let originDbQueryCount = 0;

async function queryDatabase(userId: string): Promise<User | null> {
  originDbQueryCount++;
  // Simulate 120ms database I/O latency
  await new Promise((resolve) => setTimeout(resolve, 120));
  return mockDatabase.get(userId) ?? null;
}

// --- Connect Redis ---
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6389';
const redisClient = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
});

await redisClient.connect().catch((err) => {
  console.warn(`[WARN] Redis not available at ${REDIS_URL} (${err.message}). Using L1 In-Memory only.`);
});

const redisStore = redisClient.status === 'ready'
  ? new RedisStore(redisClient, { prefix: 'fullstack:user:', deleteStrategy: 'unlink' })
  : undefined;

// --- Initialize LazyLayers Cache ---
const cache = new LazyLayersCache<string, User | null>({
  source: 'hono-api-server',
  l2: redisStore,
  levels: {
    L1: {
      maxEntries: 2000,
      ttlMs: 60_000, // 1 min in L1
    },
    L2: {
      ttlMs: 600_000, // 10 min in L2
    },
  },
  distributedLock: redisClient.status === 'ready' ? {
    enabled: true,
    redis: redisClient,
    ttlMs: 3000,
    waitTimeoutMs: 5000,
  } : undefined,
  negative: {
    enabled: true,
    ttlMs: 10_000,
  },
  failSafe: {
    enabled: true,
    staleTtlMs: 300_000,
  },
  observability: {
    enabled: true,
    route: '/__lazylayers',
    server: {
      host: '127.0.0.1',
      port: 7077,
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
  events: [
    (event: CacheEvent) => {
      const time = new Date().toISOString().split('T')[1].slice(0, 8);
      if (event.type === 'hit') {
        const color = event.level === 'L1' ? '\x1b[32m' : '\x1b[34m';
        console.log(`${color}[${time}] [${event.level} HIT]\x1b[0m key="${event.key}"`);
      } else if (event.type === 'miss') {
        console.log(`\x1b[33m[${time}] [CACHE MISS]\x1b[0m key="${event.key}" (Origin DB querying...)`);
      } else if (event.type === 'inflight:merged') {
        console.log(`\x1b[36m[${time}] [HERD MERGED]\x1b[0m key="${event.key}" caller joined in-flight promise`);
      } else if (event.type === 'set') {
        console.log(`\x1b[35m[${time}] [CACHE SET]\x1b[0m key="${event.key}" written to ${event.levels?.join('+')}`);
      } else if (event.type === 'delete') {
        console.log(`\x1b[31m[${time}] [CACHE INVALIDATE]\x1b[0m key="${event.key}" removed`);
      }
    },
  ],
  logging: { env: 'production' },
});

// --- Initialize Hono App ---
const app = new Hono();

// Enable CORS for Vite dev server and direct browser access
app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization', 'X-Cache-Status', 'X-Latency-Ms'],
  exposeHeaders: ['X-Cache-Status', 'X-Latency-Ms'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));

// GET /api/users - List all users
app.get('/api/users', (c) => {
  return c.json({
    users: Array.from(mockDatabase.values()),
    dbQueries: originDbQueryCount,
  });
});

// GET /api/users/:id - Cache-aside read through LazyLayers
app.get('/api/users/:id', async (c) => {
  const id = c.req.param('id');
  const t0 = performance.now();
  let wasL1Before = await cache.l1?.has(id);

  const user = await cache.getOrSet(id, () => queryDatabase(id));
  const latencyMs = Number((performance.now() - t0).toFixed(2));

  let cacheStatus = 'MISS-DB';
  if (wasL1Before) {
    cacheStatus = 'HIT-L1';
  } else if (latencyMs < 50 && user) {
    cacheStatus = 'HIT-L2';
  }

  c.header('X-Cache-Status', cacheStatus);
  c.header('X-Latency-Ms', String(latencyMs));

  if (!user) {
    return c.json({ error: 'User not found', id, latencyMs, cacheStatus, dbQueries: originDbQueryCount }, 404);
  }

  return c.json({
    user,
    cacheStatus,
    latencyMs,
    dbQueries: originDbQueryCount,
  });
});

// POST /api/users/:id - Update user and invalidate cache
app.post('/api/users/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const existing = mockDatabase.get(id);

  if (!existing) {
    return c.json({ error: 'User not found' }, 404);
  }

  const updated: User = {
    ...existing,
    ...body,
    id, // preserve ID
  };

  mockDatabase.set(id, updated);

  // Invalidate cache
  await cache.delete(id);

  return c.json({
    message: 'User updated & cache invalidated',
    user: updated,
    dbQueries: originDbQueryCount,
  });
});

// DELETE /api/users/:id - Remove user
app.delete('/api/users/:id', async (c) => {
  const id = c.req.param('id');
  mockDatabase.delete(id);
  await cache.delete(id);

  return c.json({
    message: 'User deleted & evicted from cache',
    id,
  });
});

// POST /api/simulate-herd - Fire 50 simultaneous requests for a cold key
app.post('/api/simulate-herd', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const targetId = body.userId || 'usr_1';

  // Invalidate first so it becomes a cold stampede target
  await cache.delete(targetId);
  cache.l1?.delete(targetId);

  const initialDbQueries = originDbQueryCount;
  const start = performance.now();

  const requests = Array.from({ length: 50 }, () =>
    cache.getOrSet(targetId, () => queryDatabase(targetId))
  );

  const results = await Promise.all(requests);
  const totalDurationMs = Number((performance.now() - start).toFixed(2));
  const newDbQueries = originDbQueryCount - initialDbQueries;

  return c.json({
    message: '50 concurrent requests executed with in-flight stampede collapse',
    targetId,
    totalRequests: 50,
    dbQueriesExecuted: newDbQueries,
    callersCollapsed: 50 - newDbQueries,
    totalDurationMs,
    averageLatencyMs: Number((totalDurationMs / 50).toFixed(2)),
    allSuccessful: results.every((r) => r !== null && r?.id === targetId),
  });
});

// POST /api/cache/purge - Wildcard pattern purge
app.post('/api/cache/purge', async (c) => {
  await cache.deleteByPattern('*');
  cache.l1?.clear();

  return c.json({
    message: 'Purged all keys across L1 and L2',
    timestamp: Date.now(),
  });
});

// GET /api/cache/stats - Real-time overview metrics
app.get('/api/cache/stats', async (c) => {
  const obsHandler = cache.getObservabilityHandler();
  const obsServer = cache.getObservabilityServer();

  let overview = null;
  if (obsServer) {
    try {
      const res = await fetch(`${obsServer.url}/api/overview`, {
        headers: { authorization: 'Basic ' + Buffer.from('lazydev:lazydev').toString('base64') },
      });
      if (res.ok) {
        overview = await res.json();
      }
    } catch {}
  }

  return c.json({
    backend: 'hono-node',
    redisConnected: redisClient.status === 'ready',
    dashboardUrl: obsServer?.url ?? 'http://127.0.0.1:7077/__lazylayers',
    totalDbQueries: originDbQueryCount,
    overview,
  });
});

// Start Hono Server on Port 3000
const port = 3000;
serve({
  fetch: app.fetch,
  port,
  hostname: '0.0.0.0',
}, (info) => {
  console.log('\n=================================================================');
  console.log(`  🚀 Hono.js API Server:          http://localhost:${info.port}`);
  console.log(`  📊 LazyLayers Dashboard:       http://127.0.0.1:7077/__lazylayers`);
  console.log(`  📈 Prometheus Scrape:          http://127.0.0.1:7077/__lazylayers/metrics`);
  console.log(`  🔑 Dashboard Auth:             lazydev / lazydev`);
  console.log('=================================================================\n');
});
