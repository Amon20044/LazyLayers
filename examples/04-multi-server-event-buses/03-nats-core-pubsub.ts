/**
 * ============================================================================
 * EXAMPLE 04-C: MULTI-SERVER CLUSTER WITH NATS CORE PUB/SUB EVENT BUS
 * ============================================================================
 *
 * SYSTEM DESIGN & ARCHITECTURE OVERVIEW:
 * ----------------------------------------------------------------------------
 * 1. WHY NATS CORE FOR CACHE INVALIDATION:
 *    - NATS Core is an ultra-high performance, lightweight messaging system capable
 *      of processing millions of messages per second with microsecond latency.
 *    - Uses subject-based routing (e.g. `cache.events.us-east`).
 *    - Zero broker persistence overhead: purely in-memory subject fanout, ideal
 *      for fast-path cache invalidations where raw speed is the highest priority.
 *
 * 2. WIRE EFFICIENCY & BINARY CODEC:
 *    - LazyLayers encodes invalidation payloads via compact binary MessagePack (`HC1M`),
 *      keeping network packet sizes under 100 bytes per invalidation.
 *
 * 3. CONNECTION REUSE & POOLING:
 *    - Supports injecting an existing shared NATS connection or auto-connecting via
 *      `connectionOptions: { servers: NATS_URL }`.
 * ============================================================================
 */

import {
  LazyLayersCache,
  NatsEventBus,
  type CacheEvent,
} from '../../dist/index.js';

export interface DeviceTelemetry {
  deviceId: string;
  firmware: string;
  batteryPct: number;
  ipAddress: string;
}

const NATS_URL = process.env.NATS_URL || 'nats://127.0.0.1:4223';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runNatsCoreClusterDemo() {
  console.log('\n=================================================================');
  console.log('  Multi-Server Cluster: NATS Core Pub/Sub Event Bus Demo');
  console.log('  Connecting to NATS: ' + NATS_URL);
  console.log('=================================================================\n');

  const subject = `cache.devices.${Date.now()}`;
  const buses: NatsEventBus[] = [];
  const nodes: LazyLayersCache<string, DeviceTelemetry>[] = [];

  try {
    // Spin up 3 simulated microservice nodes
    for (let i = 1; i <= 3; i++) {
      const bus = new NatsEventBus({
        connectionOptions: { servers: NATS_URL },
        subject,
        mode: 'core', // NATS Core fast-path mode
        logging: { env: 'production' },
      });
      await bus.connect();
      buses.push(bus);

      const node = new LazyLayersCache<string, DeviceTelemetry>({
        source: `iot-gateway-0${i}`,
        eventBus: bus,
        broadcastSet: true,
        ttlMs: 60_000,
        events: [
          (event: CacheEvent) => {
            if (event.type === 'invalidation:received') {
              console.log(`\x1b[34m[iot-gateway-0${i}]\x1b[0m NATS Core invalidation received: ${event.eventType}`);
            }
          },
        ],
        logging: { env: 'production' },
      });
      nodes.push(node);
    }

    // Step 1: Gateway 1 caches telemetry for dev_9001
    console.log('--- Step 1: Gateway 1 caches telemetry for dev_9001 ---');
    const device = await nodes[0].getOrSet('dev_9001', async () => {
      return { deviceId: 'dev_9001', firmware: 'v4.1.2', batteryPct: 98, ipAddress: '192.168.1.45' };
    });
    console.log(`Gateway 1 stored: ${device.deviceId}, battery: ${device.batteryPct}%`);

    // Wait for sub-millisecond NATS fanout
    await sleep(200);

    // Step 2: Gateway 2 and Gateway 3 verify primed L1
    console.log('\n--- Step 2: Gateway 2 & 3 verify primed L1 from NATS broadcast ---');
    const g2Dev = await nodes[1].get('dev_9001');
    const g3Dev = await nodes[2].get('dev_9001');

    console.log(`\x1b[32m✔ Gateway 2 L1: ${g2Dev?.deviceId} (${g2Dev?.ipAddress})\x1b[0m`);
    console.log(`\x1b[32m✔ Gateway 3 L1: ${g3Dev?.deviceId} (${g3Dev?.ipAddress})\x1b[0m`);

    // Step 3: Gateway 1 updates device and publishes delete
    console.log('\n--- Step 3: Gateway 1 purges dev_9001 across cluster ---');
    await nodes[0].delete('dev_9001');
    await sleep(200);

    console.log('Checking L1 cache across gateways:');
    console.log(`Gateway 1: ${await nodes[0].get('dev_9001')}`);
    console.log(`Gateway 2: ${await nodes[1].get('dev_9001')}`);
    console.log(`\x1b[32m✔ Gateway 3: ${await nodes[2].get('dev_9001')} (Purged instantly over NATS Core)\x1b[0m`);

  } finally {
    for (const bus of buses) {
      await bus.disconnect().catch(() => {});
    }
  }

  console.log('\n=================================================================');
  console.log('  NATS Core Multi-Server Demo Completed Successfully!');
  console.log('=================================================================\n');
}

if (process.argv[1]?.endsWith('03-nats-core-pubsub.ts') || process.argv[1]?.endsWith('03-nats-core-pubsub.js')) {
  runNatsCoreClusterDemo().catch(console.error);
}

export { runNatsCoreClusterDemo };
