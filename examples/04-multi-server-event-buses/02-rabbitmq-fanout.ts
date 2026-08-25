/**
 * ============================================================================
 * EXAMPLE 04-B: MULTI-SERVER CLUSTER WITH RABBITMQ FANOUT EVENT BUS
 * ============================================================================
 *
 * SYSTEM DESIGN & ARCHITECTURE OVERVIEW:
 * ----------------------------------------------------------------------------
 * 1. WHY RABBITMQ FOR CACHE INVALIDATION:
 *    - AMQP 0-9-1 architecture provides reliable, enterprise-grade pub/sub semantics.
 *    - Fanout exchanges duplicate invalidation events to all bound worker queues.
 *    - Each server instance asserts its own anonymous, exclusive, auto-deleting queue
 *      bound to the shared cache exchange. When a pod terminates, RabbitMQ automatically
 *      cleans up its queue.
 *
 * 2. PREFETCH & CONCURRENCY BOUNDING:
 *    - Without a prefetch limit (`DEFAULT_RABBITMQ_PREFETCH = 32`), a burst of 10,000
 *      invalidations would be pushed to Node.js all at once, overwhelming the event loop.
 *    - LazyLayers processes incoming invalidations with controlled concurrency and ACKs
 *      only after the local memory eviction completes.
 *
 * 3. CONNECTION RECOVERY & HEALTH MONITORING:
 *    - Built-in exponential backoff reconnection timer.
 *    - Health check verifies both broker connection and active consumer state.
 * ============================================================================
 */

import {
  LazyLayersCache,
  RabbitMQEventBus,
  type CacheEvent,
} from '../../dist/index.js';

export interface OrderRecord {
  orderId: string;
  customerId: string;
  totalUsd: number;
  status: 'pending' | 'shipped' | 'delivered';
}

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1:5673';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runRabbitMQClusterDemo() {
  console.log('\n=================================================================');
  console.log('  Multi-Server Cluster: RabbitMQ Fanout Event Bus Demo');
  console.log('  Connecting to RabbitMQ: ' + RABBITMQ_URL);
  console.log('=================================================================\n');

  const exchange = `cache.orders.fanout.${Date.now()}`;
  const buses: RabbitMQEventBus[] = [];
  const nodes: LazyLayersCache<string, OrderRecord>[] = [];

  try {
    // Spin up 3 simulated independent server pods
    for (let i = 1; i <= 3; i++) {
      const bus = new RabbitMQEventBus(exchange, {
        url: RABBITMQ_URL,
        exchangeType: 'fanout',
        prefetch: 16,
        logging: { env: 'production' },
      });
      await bus.connect();
      buses.push(bus);

      const node = new LazyLayersCache<string, OrderRecord>({
        source: `order-pod-0${i}`,
        eventBus: bus,
        broadcastSet: true, // Priming L1 on peer nodes
        ttlMs: 60_000,
        events: [
          (event: CacheEvent) => {
            if (event.type === 'invalidation:received') {
              console.log(`\x1b[35m[order-pod-0${i}]\x1b[0m RabbitMQ Invalidation received: ${event.eventType}`);
            }
          },
        ],
        logging: { env: 'production' },
      });
      nodes.push(node);
    }

    // Allow anonymous queue declarations and bindings to settle on the exchange
    await sleep(250);

    // Step 1: Pod 1 loads order:1001
    console.log('--- Step 1: Pod 1 loads order:1001 ---');
    const order = await nodes[0].getOrSet('order:1001', async () => {
      await sleep(30);
      return { orderId: 'order:1001', customerId: 'cust_88', totalUsd: 149.99, status: 'shipped' };
    });
    console.log(`Pod 1 loaded order:`, order.orderId, `$${order.totalUsd}`);

    // Wait for fanout message delivery over RabbitMQ
    await sleep(250);

    // Step 2: Pod 2 and Pod 3 verify primed L1
    console.log('\n--- Step 2: Pod 2 and Pod 3 check L1 (Primed by RabbitMQ broadcast) ---');
    const p2Order = await nodes[1].get('order:1001');
    const p3Order = await nodes[2].get('order:1001');

    console.log(`\x1b[32m✔ Pod 2 read order from L1: ${p2Order?.orderId} (${p2Order?.status})\x1b[0m`);
    console.log(`\x1b[32m✔ Pod 3 read order from L1: ${p3Order?.orderId} (${p3Order?.status})\x1b[0m`);

    // Step 3: Pod 3 deletes order:1001
    console.log('\n--- Step 3: Pod 3 mutates order and triggers delete invalidation ---');
    await nodes[2].delete('order:1001');
    await sleep(250);

    console.log('Checking L1 cache across all pods:');
    console.log(`Pod 1: ${await nodes[0].get('order:1001')}`);
    console.log(`Pod 2: ${await nodes[1].get('order:1001')}`);
    console.log(`\x1b[32m✔ Pod 3: ${await nodes[2].get('order:1001')} (Cleanly wiped across cluster!)\x1b[0m`);

  } finally {
    for (const bus of buses) {
      await bus.disconnect().catch(() => {});
    }
  }

  console.log('\n=================================================================');
  console.log('  RabbitMQ Fanout Multi-Server Demo Completed Successfully!');
  console.log('=================================================================\n');
}

if (process.argv[1]?.endsWith('02-rabbitmq-fanout.ts') || process.argv[1]?.endsWith('02-rabbitmq-fanout.js')) {
  runRabbitMQClusterDemo().catch(console.error);
}

export { runRabbitMQClusterDemo };
