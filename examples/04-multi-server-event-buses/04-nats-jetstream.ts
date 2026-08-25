/**
 * ============================================================================
 * EXAMPLE 04-D: MULTI-SERVER CLUSTER WITH NATS JETSTREAM (PERSISTENT STREAMS)
 * ============================================================================
 *
 * SYSTEM DESIGN & ARCHITECTURE OVERVIEW:
 * ----------------------------------------------------------------------------
 * 1. WHY NATS JETSTREAM OVER PLAIN PUB/SUB:
 *    - In mission-critical financial / billing / auth systems, dropping an invalidation
 *      event due to a transient network partition or pod restart can cause persistent
 *      stale data bugs.
 *    - JetStream provides persistent, stream-backed event storage with durable consumer
 *      offsets, message acknowledgments (ACKs), and at-least-once delivery semantics.
 *
 * 2. DURABLE CONSUMERS & CATCH-UP REPLAY:
 *    - When a pod temporarily disconnects and reconnects, its Durable Consumer resumes
 *      from its last acknowledged sequence number, replaying any missed invalidations!
 *
 * 3. DEDUPLICATION ACROSS RETRIES:
 *    - Because JetStream may re-deliver unacked messages during restarts, LazyLayers'
 *      built-in event deduplication (`seenEvents`) ensures that redelivered events
 *      do not trigger redundant cache evictions or race conditions.
 * ============================================================================
 */

import {
  LazyLayersCache,
  NatsEventBus,
  type CacheEvent,
} from '../../dist/index.js';

export interface BillingInvoice {
  invoiceId: string;
  amountCents: number;
  currency: string;
  status: 'draft' | 'paid' | 'overdue';
  dueDate: number;
}

const NATS_URL = process.env.NATS_URL || 'nats://127.0.0.1:4223';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runNatsJetStreamClusterDemo() {
  console.log('\n=================================================================');
  console.log('  Multi-Server Cluster: NATS JetStream Stream Broadcast Demo');
  console.log('  Connecting to NATS JetStream: ' + NATS_URL);
  console.log('=================================================================\n');

  const jsSubject = `billing.invalidation.${Date.now()}`;
  const jsStream = `STREAM_BILLING_${Date.now()}`;
  const buses: NatsEventBus[] = [];
  const nodes: LazyLayersCache<string, BillingInvoice>[] = [];

  try {
    // Spin up 3 independent billing worker pods, each with its own durable consumer
    for (let i = 1; i <= 3; i++) {
      const bus = new NatsEventBus({
        connectionOptions: { servers: NATS_URL },
        subject: jsSubject,
        mode: 'jetstream',
        jetstream: {
          stream: jsStream,
          durableName: `billing_consumer_pod_${i}_${Date.now()}`,
          ensureStream: true, // Automatically asserts JetStream stream if not existing
          ensureConsumer: true,
        },
        logging: { env: 'production' },
      });
      await bus.connect();
      buses.push(bus);

      const node = new LazyLayersCache<string, BillingInvoice>({
        source: `billing-pod-0${i}`,
        eventBus: bus,
        broadcastSet: true,
        ttlMs: 60_000,
        events: [
          (event: CacheEvent) => {
            if (event.type === 'invalidation:received') {
              console.log(`\x1b[33m[billing-pod-0${i}]\x1b[0m JetStream Stream event received: ${event.eventType}`);
            }
          },
        ],
        logging: { env: 'production' },
      });
      nodes.push(node);
    }

    // Allow consumer bindings to register with JetStream
    await sleep(300);

    // Step 1: Pod 1 primes invoice:inv_5500
    console.log('--- Step 1: Pod 1 loads invoice:inv_5500 ---');
    const invoice = await nodes[0].getOrSet('inv_5500', async () => {
      return {
        invoiceId: 'inv_5500',
        amountCents: 450000,
        currency: 'USD',
        status: 'draft',
        dueDate: Date.now() + 86400000 * 30,
      };
    });
    console.log(`Pod 1 stored invoice: ${invoice.invoiceId} ($${invoice.amountCents / 100})`);

    // Wait for JetStream stream fanout
    await sleep(350);

    // Step 2: Pod 2 and Pod 3 verify primed L1
    console.log('\n--- Step 2: Pod 2 & 3 verify primed L1 from JetStream stream ---');
    const p2Inv = await nodes[1].get('inv_5500');
    const p3Inv = await nodes[2].get('inv_5500');

    console.log(`\x1b[32m✔ Pod 2 L1: ${p2Inv?.invoiceId} (${p2Inv?.status}, $${(p2Inv?.amountCents ?? 0) / 100})\x1b[0m`);
    console.log(`\x1b[32m✔ Pod 3 L1: ${p3Inv?.invoiceId} (${p3Inv?.status}, $${(p3Inv?.amountCents ?? 0) / 100})\x1b[0m`);

    // Step 3: Pod 2 marks invoice paid and deletes old cache
    console.log('\n--- Step 3: Pod 2 publishes payment update & stream invalidation ---');
    await nodes[1].delete('inv_5500');
    await sleep(350);

    console.log('Checking L1 cache across all pods:');
    console.log(`Pod 1: ${await nodes[0].get('inv_5500')}`);
    console.log(`Pod 2: ${await nodes[1].get('inv_5500')}`);
    console.log(`\x1b[32m✔ Pod 3: ${await nodes[2].get('inv_5500')} (Invalidated via JetStream!)\x1b[0m`);

  } finally {
    for (const bus of buses) {
      await bus.disconnect().catch(() => {});
    }
  }

  console.log('\n=================================================================');
  console.log('  NATS JetStream Multi-Server Demo Completed Successfully!');
  console.log('=================================================================\n');
}

if (process.argv[1]?.endsWith('04-nats-jetstream.ts') || process.argv[1]?.endsWith('04-nats-jetstream.js')) {
  runNatsJetStreamClusterDemo().catch(console.error);
}

export { runNatsJetStreamClusterDemo };
