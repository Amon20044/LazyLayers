import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

process.env.NODE_ENV = 'production';

const {
  LazyLayersCache,
  RedisStore,
  RedisEventBus,
  RabbitMQEventBus,
  NatsEventBus,
} = await import('../dist/index.js');

const REDIS_URL = process.env.REDIS_URL;
const RABBITMQ_URL = process.env.RABBITMQ_URL;
const NATS_URL = process.env.NATS_URL;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── 1. Live Redis Integration ───────────────────────────────────────── */

test('Live Redis E2E: Real RedisStore & RedisEventBus cross-instance coherence', async (t) => {
  if (!REDIS_URL) {
    t.skip('REDIS_URL not provided, skipping live Redis test');
    return;
  }

  let Redis;
  try {
    Redis = (await import('ioredis')).default;
  } catch {
    t.skip('ioredis not available');
    return;
  }

  const client1 = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
  const client2 = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });

  try {
    await client1.connect();
    await client2.connect();
  } catch (err) {
    t.skip(`Cannot connect to Redis at ${REDIS_URL}: ${err.message}`);
    client1.disconnect();
    client2.disconnect();
    return;
  }

  const channel = `test.invalidation.${Date.now()}`;
  const bus1 = new RedisEventBus(client1, channel);
  const bus2 = new RedisEventBus(client2, channel);

  await bus1.connect();
  await bus2.connect();

  const prefix = `live:${Date.now()}:`;
  const node1 = new LazyLayersCache({
    source: 'node-live-1',
    l2: new RedisStore(client1, { prefix }),
    eventBus: bus1,
    broadcastSet: true,
    ttlMs: 30_000,
    logging: { env: 'production' },
  });

  const node2 = new LazyLayersCache({
    source: 'node-live-2',
    l2: new RedisStore(client2, { prefix }),
    eventBus: bus2,
    broadcastSet: true,
    ttlMs: 30_000,
    logging: { env: 'production' },
  });

  // Node 1 loads data via getOrSet
  let loaderCount = 0;
  const val = await node1.getOrSet('user:live-100', async () => {
    loaderCount++;
    return { id: 100, role: 'administrator', live: true };
  });

  assert.deepEqual(val, { id: 100, role: 'administrator', live: true });
  assert.equal(loaderCount, 1);

  // Allow pub/sub network hop to propagate
  await sleep(150);

  // Node 2 should have received set broadcast and warmed L1 directly
  const val2 = await node2.get('user:live-100');
  assert.deepEqual(val2, { id: 100, role: 'administrator', live: true });

  // Node 1 deletes the key
  await node1.delete('user:live-100');
  await sleep(150);

  // Node 2 must have dropped L1
  assert.equal(await node2.get('user:live-100'), undefined);

  // Test Pattern Deletion over live Redis
  await node1.set('catalog:1', { item: 1 });
  await node1.set('catalog:2', { item: 2 });
  await node2.get('catalog:1');
  await node2.get('catalog:2');

  await node1.deleteByPattern('catalog:*');
  await sleep(150);

  assert.equal(await node2.get('catalog:1'), undefined);
  assert.equal(await node2.get('catalog:2'), undefined);

  await bus1.disconnect();
  await bus2.disconnect();
  client1.disconnect();
  client2.disconnect();
});

/* ── 2. Live Redis Distributed Lock Stress Test ───────────────────────── */

test('Live Redis E2E: Distributed Lock stampede collapse across independent instances', async (t) => {
  if (!REDIS_URL) {
    t.skip('REDIS_URL not provided, skipping live Redis distributed lock test');
    return;
  }

  let Redis;
  try {
    Redis = (await import('ioredis')).default;
  } catch {
    t.skip('ioredis not available');
    return;
  }

  const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await client.connect();
  } catch {
    t.skip('Redis not available');
    client.disconnect();
    return;
  }

  const prefix = `locktest:${Date.now()}:`;
  const instances = [];
  for (let i = 1; i <= 5; i++) {
    instances.push(new LazyLayersCache({
      source: `worker-${i}`,
      l2: new RedisStore(client, { prefix }),
      distributedLock: {
        enabled: true,
        redis: client,
        ttlMs: 2000,
        waitTimeoutMs: 3000,
      },
      ttlMs: 60_000,
      logging: { env: 'production' },
    }));
  }

  let loaderRuns = 0;
  const slowLoader = async () => {
    loaderRuns++;
    await sleep(50);
    return { data: 'cluster-locked-value' };
  };

  // 25 concurrent calls across 5 separate cache instances
  const promises = [];
  for (let req = 0; req < 25; req++) {
    const inst = instances[req % instances.length];
    promises.push(inst.getOrSet('expensive:aggregate', slowLoader));
  }

  const results = await Promise.all(promises);
  for (const r of results) {
    assert.deepEqual(r, { data: 'cluster-locked-value' });
  }

  // Exactly 1 loader should have executed across the 5 instances
  assert.equal(loaderRuns, 1);

  client.disconnect();
});

/* ── 3. Live RabbitMQ E2E ────────────────────────────────────────────── */

test('Live RabbitMQ E2E: Durable fanout and cross-instance invalidation', async (t) => {
  if (!RABBITMQ_URL) {
    t.skip('RABBITMQ_URL not provided, skipping live RabbitMQ test');
    return;
  }

  const exchange = `cache.fanout.${Date.now()}`;
  const bus1 = new RabbitMQEventBus(exchange, {
    url: RABBITMQ_URL,
    logging: { env: 'production' },
  });
  const bus2 = new RabbitMQEventBus(exchange, {
    url: RABBITMQ_URL,
    logging: { env: 'production' },
  });

  try {
    await bus1.connect();
    await bus2.connect();
  } catch (err) {
    t.skip(`Cannot connect to RabbitMQ at ${RABBITMQ_URL}: ${err.message}`);
    return;
  }

  const received = [];
  await bus2.subscribe((evt) => {
    received.push(evt);
  });

  await bus1.publish({
    type: 'del',
    id: `rabbit-del-${Date.now()}`,
    keys: ['order:999'],
    source: 'node-live-1',
    generation: 1,
    ts: Date.now(),
  });

  await sleep(250);

  assert.equal(received.length >= 1, true);
  assert.equal(received[0].keys[0], 'order:999');

  await bus1.disconnect();
  await bus2.disconnect();
});

/* ── 4. Live NATS Core & JetStream E2E ────────────────────────────────── */

test('Live NATS E2E: Core fanout and JetStream stream broadcast', async (t) => {
  if (!NATS_URL) {
    t.skip('NATS_URL not provided, skipping live NATS test');
    return;
  }

  const subject = `cache.nats.${Date.now()}`;
  const busCore1 = new NatsEventBus({
    connectionOptions: { servers: NATS_URL },
    subject,
    mode: 'core',
    logging: { env: 'production' },
  });

  const busCore2 = new NatsEventBus({
    connectionOptions: { servers: NATS_URL },
    subject,
    mode: 'core',
    logging: { env: 'production' },
  });

  try {
    await busCore1.connect();
    await busCore2.connect();
  } catch (err) {
    t.skip(`Cannot connect to NATS at ${NATS_URL}: ${err.message}`);
    return;
  }

  const receivedCore = [];
  await busCore2.subscribe((evt) => {
    receivedCore.push(evt);
  });

  await busCore1.publish({
    type: 'del',
    id: `nats-del-${Date.now()}`,
    keys: ['item:404'],
    source: 'node-nats-1',
    generation: 5,
    ts: Date.now(),
  });

  await sleep(250);

  assert.equal(receivedCore.length >= 1, true);
  assert.equal(receivedCore[0].keys[0], 'item:404');

  await busCore1.disconnect();
  await busCore2.disconnect();

  // Test JetStream Mode
  const jsSubject = `cache.js.${Date.now()}`;
  const jsStream = `STREAM_${Date.now()}`;
  const busJS1 = new NatsEventBus({
    connectionOptions: { servers: NATS_URL },
    subject: jsSubject,
    mode: 'jetstream',
    jetstream: {
      stream: jsStream,
      durableName: `cons_${Date.now()}`,
      ensureStream: true,
      ensureConsumer: true,
    },
    logging: { env: 'production' },
  });

  const busJS2 = new NatsEventBus({
    connectionOptions: { servers: NATS_URL },
    subject: jsSubject,
    mode: 'jetstream',
    jetstream: {
      stream: jsStream,
      durableName: `cons_sub_${Date.now()}`,
      ensureStream: true,
      ensureConsumer: true,
    },
    logging: { env: 'production' },
  });

  try {
    await busJS1.connect();
    await busJS2.connect();

    const receivedJS = [];
    await busJS2.subscribe((evt) => {
      receivedJS.push(evt);
    });

    await busJS1.publish({
      type: 'set',
      id: `js-set-${Date.now()}`,
      keys: ['config:live'],
      value: { mode: 'jetstream-active' },
      source: 'node-js-1',
      generation: 10,
      ts: Date.now(),
    });

    await sleep(350);

    assert.equal(receivedJS.length >= 1, true);
    assert.equal(receivedJS[0].keys[0], 'config:live');

    await busJS1.disconnect();
    await busJS2.disconnect();
  } catch (err) {
    await busJS1.disconnect().catch(() => {});
    await busJS2.disconnect().catch(() => {});
    throw err;
  }
});

/* ── 5. Live Multi-Node Cluster Monitoring (5 Nodes) ─────────────────── */

test('Live Cluster Monitoring: 5-Node Redis Cluster with Live Observability & Prometheus Monitoring', async (t) => {
  if (!REDIS_URL) {
    t.skip('REDIS_URL not provided, skipping live 5-node cluster monitoring test');
    return;
  }

  let Redis;
  try {
    Redis = (await import('ioredis')).default;
  } catch {
    t.skip('ioredis not available');
    return;
  }

  const clients = [];
  const buses = [];
  const nodes = [];
  const servers = [];
  const baseUrls = [];
  const channel = `cluster.monitor.${Date.now()}`;
  const prefix = `clustermon:${Date.now()}:`;

  try {
    // 1. Initialize 5 independent Redis clients & event buses
    for (let i = 1; i <= 5; i++) {
      const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
      await client.connect();
      clients.push(client);

      const bus = new RedisEventBus(client, channel);
      await bus.connect();
      buses.push(bus);

      const node = new LazyLayersCache({
        source: `server-node-${i}`,
        l2: new RedisStore(client, { prefix }),
        eventBus: bus,
        broadcastSet: true,
        ttlMs: 60_000,
        distributedLock: {
          enabled: true,
          redis: client,
          ttlMs: 3000,
          waitTimeoutMs: 5000,
        },
        observability: {
          enabled: true,
          server: false,
          auth: { username: 'clusteradmin', password: 'clusterpassword' },
          prometheus: { enabled: true, prefix: 'lazycache', public: true },
        },
        logging: { env: 'production' },
      });
      nodes.push(node);
    }

    // 2. Start 5 standalone HTTP servers on dynamic ports
    for (let i = 0; i < 5; i++) {
      const handler = nodes[i].getObservabilityHandler();
      assert.ok(handler, `Handler for node ${i + 1} must be defined`);

      const server = http.createServer((req, res) => {
        const handled = handler(req, res);
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
        }
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      servers.push(server);
      baseUrls.push(`http://127.0.0.1:${port}`);
    }

    // 3. Concurrently trigger heavy stampede load across all 5 nodes for cold key
    let clusterLoaderCalls = 0;
    const clusterLoader = async () => {
      clusterLoaderCalls++;
      await sleep(30);
      return { clusterId: 'prime-alpha', activeNodes: 5, timestamp: Date.now() };
    };

    const stampedeRequests = [];
    for (let req = 0; req < 30; req++) {
      const targetNode = nodes[req % nodes.length];
      stampedeRequests.push(targetNode.getOrSet('tenant:shared:config', clusterLoader));
    }

    const stampedeResults = await Promise.all(stampedeRequests);
    for (const res of stampedeResults) {
      assert.equal(res.clusterId, 'prime-alpha');
      assert.equal(res.activeNodes, 5);
    }
    assert.equal(clusterLoaderCalls, 1, 'Stampede lock must collapse loader execution to exactly 1');

    // Wait for set-broadcast priming to settle across peer nodes
    await sleep(200);

    // 4. Verify all 5 nodes now have instant L1 hits
    for (let i = 0; i < 5; i++) {
      const val = await nodes[i].get('tenant:shared:config');
      assert.equal(val?.clusterId, 'prime-alpha');
    }

    // 5. Node 1 sets keys, Node 3 deletes a pattern
    await nodes[0].set('metric:cpu', { usage: 42 });
    await nodes[0].set('metric:mem', { usage: 78 });
    await sleep(150);

    await nodes[2].deleteByPattern('metric:*');
    await sleep(150);

    for (let i = 0; i < 5; i++) {
      assert.equal(await nodes[i].get('metric:cpu'), undefined);
      assert.equal(await nodes[i].get('metric:mem'), undefined);
    }

    // 6. Dynamically query HTTP monitoring endpoints on all 5 nodes
    const authHeader = 'Basic ' + Buffer.from('clusteradmin:clusterpassword').toString('base64');

    for (let i = 0; i < 5; i++) {
      const baseUrl = baseUrls[i];

      // A. Scrape /api/overview JSON endpoint
      const overviewRes = await fetch(`${baseUrl}/__lazylayers/api/overview`, {
        headers: { authorization: authHeader },
      });
      assert.equal(overviewRes.status, 200, `Node ${i + 1} overview should return 200`);
      const overviewData = await overviewRes.json();
      assert.equal(overviewData.hits >= 1, true, `Node ${i + 1} should have recorded hits`);
      assert.equal(overviewData.totalEvents >= 1, true, `Node ${i + 1} should have recorded events`);
      assert.equal(typeof overviewData.uptimeMs, 'number');

      // B. Scrape /metrics (Prometheus format, public scrape)
      const metricsRes = await fetch(`${baseUrl}/__lazylayers/metrics`);
      assert.equal(metricsRes.status, 200, `Node ${i + 1} Prometheus scrape should return 200`);
      const metricsText = await metricsRes.text();
      assert.match(metricsText, /lazycache_hits_total\{level="l1"\}/);
      assert.match(metricsText, /lazycache_l1_entries/);
      assert.match(metricsText, /lazycache_l2_entries/);

      // C. Scrape Dashboard UI
      const dashboardRes = await fetch(`${baseUrl}/__lazylayers`, {
        headers: { authorization: authHeader },
      });
      assert.equal(dashboardRes.status, 200, `Node ${i + 1} dashboard UI should return 200`);
      const dashboardHtml = await dashboardRes.text();
      assert.match(dashboardHtml, /lazy-layers-cache · observability/);
    }
  } finally {
    // Graceful teardown
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    for (const bus of buses) {
      await bus.disconnect().catch(() => {});
    }
    for (const client of clients) {
      client.disconnect();
    }
  }
});

/* ── 6. Live Multi-Node Cluster Fanout (5 Nodes RabbitMQ & NATS) ───────── */

test('Live Cluster Fanout: 5-Node RabbitMQ & NATS cross-instance invalidation', async (t) => {
  if (!RABBITMQ_URL && !NATS_URL) {
    t.skip('Neither RABBITMQ_URL nor NATS_URL provided, skipping 5-node cluster fanout test');
    return;
  }

  // 1. RabbitMQ 5-Node Fanout
  if (RABBITMQ_URL) {
    const exchange = `cluster.rabbit.fanout.${Date.now()}`;
    const rabbitBuses = [];
    const rabbitNodes = [];

    try {
      for (let i = 1; i <= 5; i++) {
        const bus = new RabbitMQEventBus(exchange, {
          url: RABBITMQ_URL,
          logging: { env: 'production' },
        });
        await bus.connect();
        rabbitBuses.push(bus);

        const node = new LazyLayersCache({
          source: `rabbit-node-${i}`,
          eventBus: bus,
          broadcastSet: true,
          ttlMs: 60_000,
          logging: { env: 'production' },
        });
        rabbitNodes.push(node);
      }

      // Allow asynchronous consumer queue bindings to settle on the exchange
      await sleep(250);

      // Node 1 primes data
      await rabbitNodes[0].getOrSet('product:live:555', async () => ({
        id: 555,
        sku: 'RABBIT-5X',
        stock: 120,
      }));

      // Wait for broadcast fanout across all 5 nodes
      await sleep(350);

      // Verify Nodes 2..5 have primed value in L1 without executing loader
      for (let i = 1; i < 5; i++) {
        const cached = await rabbitNodes[i].get('product:live:555');
        assert.deepEqual(cached, { id: 555, sku: 'RABBIT-5X', stock: 120 });
      }

      // Node 4 deletes the key
      await rabbitNodes[3].delete('product:live:555');
      await sleep(350);

      // Verify all 5 nodes invalidated the key
      for (let i = 0; i < 5; i++) {
        assert.equal(await rabbitNodes[i].get('product:live:555'), undefined);
      }
    } finally {
      for (const bus of rabbitBuses) {
        await bus.disconnect().catch(() => {});
      }
    }
  }

  // 2. NATS JetStream 5-Node Broadcast
  if (NATS_URL) {
    const jsSubject = `cluster.nats.js.${Date.now()}`;
    const jsStream = `STREAM_CLUSTER_${Date.now()}`;
    const natsBuses = [];
    const natsNodes = [];

    try {
      for (let i = 1; i <= 5; i++) {
        const bus = new NatsEventBus({
          connectionOptions: { servers: NATS_URL },
          subject: jsSubject,
          mode: 'jetstream',
          jetstream: {
            stream: jsStream,
            durableName: `cons_clust_${i}_${Date.now()}`,
            ensureStream: true,
            ensureConsumer: true,
          },
          logging: { env: 'production' },
        });
        await bus.connect();
        natsBuses.push(bus);

        const node = new LazyLayersCache({
          source: `nats-node-${i}`,
          eventBus: bus,
          broadcastSet: true,
          ttlMs: 60_000,
          logging: { env: 'production' },
        });
        natsNodes.push(node);
      }

      // Node 1 primes data
      await natsNodes[0].getOrSet('session:cluster:token', async () => ({
        token: 'nats-jetstream-token-xyz',
        active: true,
      }));

      // Wait for JetStream broadcast across all 5 consumer groups
      await sleep(400);

      // Verify Nodes 2..5 have primed value in L1
      for (let i = 1; i < 5; i++) {
        const session = await natsNodes[i].get('session:cluster:token');
        assert.deepEqual(session, {
          token: 'nats-jetstream-token-xyz',
          active: true,
        });
      }

      // Node 2 deletes the session
      await natsNodes[1].delete('session:cluster:token');
      await sleep(400);

      for (let i = 0; i < 5; i++) {
        assert.equal(await natsNodes[i].get('session:cluster:token'), undefined);
      }
    } finally {
      for (const bus of natsBuses) {
        await bus.disconnect().catch(() => {});
      }
    }
  }
});

