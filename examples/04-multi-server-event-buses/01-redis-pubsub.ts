/**
 * ============================================================================
 * EXAMPLE 04-A: MULTI-SERVER CLUSTER WITH REDIS PUB/SUB EVENT BUS
 * ============================================================================
 *
 * SYSTEM DESIGN & ARCHITECTURE OVERVIEW:
 * ----------------------------------------------------------------------------
 * 1. THE DISTRIBUTED CACHE COHERENCE CHALLENGE:
 *    - In a horizontally scaled cluster of 10 microservice pods, each pod maintains
 *      its own local in-memory L1 cache.
 *    - When Pod 1 updates a record in the database, Pods 2 through 10 have stale L1 copies!
 *    - Event Bus invalidation broadcasts deletion/mutation events to all peer pods
 *      over a pub/sub channel in real time (<2ms).
 *
 * 2. L1 PRIMING VIA SET-BROADCAST (`broadcastSet: true`):
 *    - Instead of just broadcasting "delete key X" (forcing all other pods to query DB),
 *      LazyLayers can broadcast the computed value to peer pods.
 *    - Peer pods warm their L1 directly without ever touching Redis or the Database!
 *    - Wire size protection: large payloads exceeding `broadcastSetMaxBytes` automatically
 *      downgrade to standard `del` invalidations to protect pub/sub channel bandwidth.
 *
 * 3. GENERATION FENCING (OUT-OF-ORDER RACE PROTECTION):
 *    - In distributed networks, a slow network hop could deliver a stale `set` event
 *      AFTER a newer `delete` was already executed (resurrecting deleted data!).
 *    - LazyLayers assigns monotonic per-key Generation Counters. If a node receives a
 *      `set` event with a generation older than its local counter, it is REJECTED.
 *
 * 4. EVENT DEDUPLICATION:
 *    - Every event has a unique UUID and origin `source` identifier.
 *    - Self-published events are ignored immediately without parsing.
 *    - A bounded sliding ring-buffer drops duplicate deliveries.
 * ============================================================================
 */

import Redis from 'ioredis';
import {
  LazyLayersCache,
  RedisStore,
  RedisEventBus,
  type CacheEvent,
} from '../../dist/index.js';

export interface UserAccount {
  userId: string;
  email: string;
  plan: 'free' | 'pro' | 'enterprise';
  status: 'active' | 'suspended';
}

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6389';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runRedisClusterDemo() {
  console.log('\n=================================================================');
  console.log('  Multi-Server Cluster: Redis Pub/Sub Event Bus Demo');
  console.log('  Connecting to Redis: ' + REDIS_URL);
  console.log('=================================================================\n');

  const channel = `cache.invalidation.cluster.${Date.now()}`;
  const prefix = `cluster:user:${Date.now()}:`;

  const clients: Redis[] = [];
  const buses: RedisEventBus[] = [];
  const nodes: LazyLayersCache<string, UserAccount>[] = [];

  // Spin up 3 simulated independent server instances
  for (let i = 1; i <= 3; i++) {
    const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
    await client.connect();
    clients.push(client);

    const bus = new RedisEventBus(client, channel);
    await bus.connect();
    buses.push(bus);

    const node = new LazyLayersCache<string, UserAccount>({
      source: `api-pod-0${i}`,
      l2: new RedisStore(client, { prefix }),
      eventBus: bus,
      broadcastSet: true, // Enable cross-node L1 priming on write/load
      ttlMs: 60_000,
      events: [
        (event: CacheEvent) => {
          if (event.type === 'invalidation:received') {
            console.log(`\x1b[36m[api-pod-0${i}]\x1b[0m Invalidation received: ${event.eventType}`);
          }
        },
      ],
      logging: { env: 'production' },
    });
    nodes.push(node);
  }

  // Step 1: Pod 1 performs a getOrSet for usr_777
  console.log('--- Step 1: Pod 1 loads usr_777 via getOrSet ---');
  let dbQueries = 0;
  const user = await nodes[0].getOrSet('usr_777', async () => {
    dbQueries++;
    await sleep(50);
    return { userId: 'usr_777', email: 'octo@cloud.com', plan: 'enterprise', status: 'active' };
  });
  console.log(`Pod 1 computed user (DB queries: ${dbQueries}):`, user.email);

  // Allow pub/sub hop to propagate to Pod 2 and Pod 3
  await sleep(150);

  // Step 2: Pod 2 and Pod 3 now have instant L1 hits without querying DB or Redis L2!
  console.log('\n--- Step 2: Pod 2 and Pod 3 read usr_777 (Primed in local L1 via broadcast) ---');
  const t2 = performance.now();
  const userPod2 = await nodes[1].get('usr_777');
  const d2 = (performance.now() - t2).toFixed(4);

  const t3 = performance.now();
  const userPod3 = await nodes[2].get('usr_777');
  const d3 = (performance.now() - t3).toFixed(4);

  console.log(`\x1b[32m✔ Pod 2 read from primed L1 in ${d2}ms (DB queries: ${dbQueries}): ${userPod2?.email}\x1b[0m`);
  console.log(`\x1b[32m✔ Pod 3 read from primed L1 in ${d3}ms (DB queries: ${dbQueries}): ${userPod3?.email}\x1b[0m`);

  // Step 3: Pod 2 updates user plan and deletes the key
  console.log('\n--- Step 3: Pod 2 updates user and triggers delete invalidation ---');
  await nodes[1].delete('usr_777');
  await sleep(150);

  console.log('Checking L1 cache across all pods after delete:');
  console.log(`Pod 1 cache: ${await nodes[0].get('usr_777')}`);
  console.log(`Pod 2 cache: ${await nodes[1].get('usr_777')}`);
  console.log(`\x1b[32m✔ Pod 3 cache: ${await nodes[2].get('usr_777')} (Instantly dropped!)\x1b[0m`);

  // Teardown
  for (const bus of buses) await bus.disconnect().catch(() => {});
  for (const client of clients) client.disconnect();

  console.log('\n=================================================================');
  console.log('  Redis Pub/Sub Multi-Server Cluster Demo Completed Successfully!');
  console.log('=================================================================\n');
}

if (process.argv[1]?.endsWith('01-redis-pubsub.ts') || process.argv[1]?.endsWith('01-redis-pubsub.js')) {
  runRedisClusterDemo().catch(console.error);
}

export { runRedisClusterDemo };
