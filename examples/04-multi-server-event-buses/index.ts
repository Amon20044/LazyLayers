/**
 * ============================================================================
 * EXAMPLES 04: ALL 4 MULTI-SERVER EVENT BUS TRANSPORTS IN SEQUENCE
 * ============================================================================
 */

import { runRedisClusterDemo } from './01-redis-pubsub.js';
import { runRabbitMQClusterDemo } from './02-rabbitmq-fanout.js';
import { runNatsCoreClusterDemo } from './03-nats-core-pubsub.js';
import { runNatsJetStreamClusterDemo } from './04-nats-jetstream.js';

async function runAllEventBusDemos() {
  console.log('\n=================================================================');
  console.log('  RUNNING ALL 4 MULTI-SERVER EVENT BUS CLUSTER EXAMPLES');
  console.log('=================================================================\n');

  try {
    console.log('\n>>> (1/4) Running Redis Pub/Sub Cluster Demo...');
    await runRedisClusterDemo();
  } catch (err: any) {
    console.warn(`[SKIP] Redis Pub/Sub Demo skipped or failed: ${err.message}`);
  }

  try {
    console.log('\n>>> (2/4) Running RabbitMQ Fanout Cluster Demo...');
    await runRabbitMQClusterDemo();
  } catch (err: any) {
    console.warn(`[SKIP] RabbitMQ Demo skipped or failed: ${err.message}`);
  }

  try {
    console.log('\n>>> (3/4) Running NATS Core Pub/Sub Cluster Demo...');
    await runNatsCoreClusterDemo();
  } catch (err: any) {
    console.warn(`[SKIP] NATS Core Demo skipped or failed: ${err.message}`);
  }

  try {
    console.log('\n>>> (4/4) Running NATS JetStream Stream Cluster Demo...');
    await runNatsJetStreamClusterDemo();
  } catch (err: any) {
    console.warn(`[SKIP] NATS JetStream Demo skipped or failed: ${err.message}`);
  }

  console.log('\n=================================================================');
  console.log('  ALL MULTI-SERVER EVENT BUS CLUSTER EXAMPLES FINISHED');
  console.log('=================================================================\n');
}

if (process.argv[1]?.endsWith('04-multi-server-event-buses/index.ts') || process.argv[1]?.endsWith('04-multi-server-event-buses/index.js')) {
  runAllEventBusDemos().catch(console.error);
}

export { runAllEventBusDemos };
