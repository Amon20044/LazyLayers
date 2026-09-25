import assert from 'node:assert/strict';
import { test } from 'node:test';

const { CloudflareKVRestNamespace, CloudflareKVStore, setupCache } = await import('../dist/index.js');
const {
  CloudflareWorkerCache, CloudflareWorkerKVStore, CloudflareWorkerMemoryStore,
  CloudflareQueueInvalidationPublisher, CloudflareQueueRestSender, parseCloudflareInvalidationMessage,
} = await import('../dist/cloudflare/index.js');
const { parseCloudflarePlatformEvent, summarizeCloudflarePlatformEvent } = await import('../dist/cloudflare-events/index.js');

function fakeNamespace() {
  const entries = new Map();
  const writes = [];
  return {
    entries,
    writes,
    async get(key, type) {
      assert.equal(type, 'arrayBuffer');
      const entry = entries.get(key);
      return entry ? Uint8Array.from(entry.bytes).buffer : null;
    },
    async put(key, value, options) {
      entries.set(key, { bytes: Uint8Array.from(value) });
      writes.push({ key, options });
    },
    async delete(key) { entries.delete(key); },
    async list({ prefix = '', cursor, limit = 2 } = {}) {
      const keys = [...entries.keys()].filter((key) => key.startsWith(prefix) && (!cursor || key > cursor)).sort().slice(0, limit);
      const last = keys.at(-1);
      return { keys: keys.map((name) => ({ name })), list_complete: !last || ![...entries.keys()].some((key) => key.startsWith(prefix) && key > last), cursor: last };
    },
  };
}

test('Cloudflare KV L2 retains the requested logical TTL below the platform minimum', async () => {
  const namespace = fakeNamespace();
  const store = new CloudflareKVStore(namespace, { prefix: 'test:' });
  await store.set('short', { id: 1 }, { ttlMs: 20 });
  assert.equal(namespace.writes[0].options.expirationTtl, 60);
  assert.deepEqual(await store.get('short'), { id: 1 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await store.get('short'), undefined);
  assert.equal(await store.has('short'), false);
});

test('Cloudflare KV L2 scopes and paginates pattern deletion', async () => {
  const namespace = fakeNamespace();
  const store = new CloudflareKVStore(namespace, { prefix: 'app:' });
  for (const key of ['user:1', 'user:2', 'user:3', 'other']) await store.set(key, key);
  namespace.entries.set('neighbor:user:1', namespace.entries.get('app:user:1'));
  await store.deleteByPattern('user:*');
  assert.equal(await store.size(), 1);
  assert.equal(await store.get('other'), 'other');
  assert.equal(namespace.entries.has('neighbor:user:1'), true);
  namespace.list = async () => { throw new Error('Exact deletion must not list KV'); };
  await store.deleteByPattern('other');
  assert.equal(namespace.entries.has('app:other'), false);
});

test('setupCache selects KV L2 without implicitly using REDIS_URL', async () => {
  const previous = process.env.REDIS_URL;
  process.env.REDIS_URL = 'redis://127.0.0.1:1';
  try {
    const namespace = fakeNamespace();
    const cache = await setupCache({ namespace: 'sample', kv: { namespace }, logging: { enabled: false } });
    try {
      assert.equal(await cache.getOrSet('item', async () => 42), 42);
      assert.equal(namespace.entries.has('sample:cache:item'), true);
    } finally {
      await cache.close();
    }
  } finally {
    if (previous === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previous;
  }
});

test('Cloudflare platform event parser accepts build and KV lifecycle events only', () => {
  const metadata = {
    accountId: 'account', eventSubscriptionId: 'subscription',
    eventSchemaVersion: 1, eventTimestamp: '2026-09-25T00:00:00.000Z',
  };
  const build = parseCloudflarePlatformEvent({
    type: 'cf.workersBuilds.worker.build.failed',
    source: { type: 'workersBuilds.worker', workerName: 'api' },
    payload: { buildUuid: 'build-1', buildOutcome: 'failure' }, metadata,
  });
  assert.equal(summarizeCloudflarePlatformEvent(build).resource, 'api');
  assert.equal(parseCloudflarePlatformEvent({
    type: 'cf.kv.namespace.deleted', source: { type: 'kv' },
    payload: { id: 'ns', name: 'cache' }, metadata,
  }).payload.name, 'cache');
  assert.equal(parseCloudflarePlatformEvent({ type: 'cf.kv.key.deleted', source: { type: 'kv' }, payload: {}, metadata }), null);
  assert.equal(parseCloudflarePlatformEvent({ type: 'cf.kv.namespace.deleted', source: { type: 'kv' }, payload: {}, metadata }), null);
});

test('Node and Worker KV stores share the same JSON wire format', async () => {
  const namespace = fakeNamespace();
  const node = new CloudflareKVStore(namespace, { prefix: 'shared:' });
  const worker = new CloudflareWorkerKVStore(namespace, { prefix: 'shared:' });
  await node.set('from-node', { id: 1 });
  assert.deepEqual(await worker.get('from-node'), { id: 1 });
  await worker.set('from-worker', { id: 2 });
  assert.deepEqual(await node.get('from-worker'), { id: 2 });
});

test('Worker cache deduplicates loaders and invalidates a key family', async () => {
  const namespace = fakeNamespace();
  const l1 = new CloudflareWorkerMemoryStore(10);
  const cache = new CloudflareWorkerCache(namespace, { prefix: 'worker:', l1 });
  let loads = 0;
  const loader = async () => { loads++; await new Promise((resolve) => setTimeout(resolve, 5)); return { count: loads }; };
  const values = await Promise.all([cache.getOrSet('user:1', loader), cache.getOrSet('user:1', loader)]);
  assert.deepEqual(values, [{ count: 1 }, { count: 1 }]);
  const first = await cache.get('user:1');
  first.count = 99;
  assert.deepEqual(await cache.get('user:1'), { count: 1 });
  await cache.set('user:2', { count: 2 });
  await cache.invalidateByPattern('user:*');
  assert.equal(await cache.get('user:1'), undefined);
  assert.equal(await cache.get('user:2'), undefined);
});

test('Worker L1 isolates prefixes and returns the same JSON shape as KV', async () => {
  const namespace = fakeNamespace();
  const l1 = new CloudflareWorkerMemoryStore(10);
  const first = new CloudflareWorkerCache(namespace, { prefix: 'first:', l1 });
  const second = new CloudflareWorkerCache(namespace, { prefix: 'second:', l1 });
  await first.set('item', { when: new Date('2026-01-01T00:00:00.000Z') });
  assert.deepEqual(await first.get('item'), { when: '2026-01-01T00:00:00.000Z' });
  assert.equal(await second.get('item'), undefined);
  await second.set('item', { value: 2 });
  await first.invalidateByPattern('item*');
  assert.deepEqual(await second.get('item'), { value: 2 });
});

test('Worker pattern scan bound rejects a broad purge before deleting keys', async () => {
  const namespace = fakeNamespace();
  const store = new CloudflareWorkerKVStore(namespace, { prefix: 'bounded:', maxPatternScanKeys: 2 });
  for (const key of ['one', 'two', 'three']) await store.set(key, key);
  await assert.rejects(store.deleteByPattern('*'), /exceeded 2 keys/);
  assert.equal(namespace.entries.size, 3);
});

test('Worker and managed Node caches publish application invalidations', async () => {
  const namespace = fakeNamespace();
  const messages = [];
  const publisher = new CloudflareQueueInvalidationPublisher({ send: async (message) => { messages.push(message); } }, 'users-api');
  const worker = new CloudflareWorkerCache(namespace, { prefix: 'users-api:', invalidationPublisher: publisher });
  await worker.set('tenant:42:user:1', { id: 1 });
  await worker.invalidateByPattern('tenant:42:user:*');
  assert.equal(messages[0].type, 'pattern');
  assert.equal(messages[0].scope, 'users-api');
  assert.equal(parseCloudflareInvalidationMessage(messages[0]).pattern, 'tenant:42:user:*');
  const node = await setupCache({
    namespace: 'users-api', redis: false,
    kv: { namespace, store: { prefix: 'users-api:' } },
    invalidationPublisher: publisher,
    logging: { enabled: false },
  });
  try {
    await node.invalidate('tenant:42:user:1');
    assert.equal(messages[1].type, 'key');
    assert.equal(messages[1].key, 'tenant:42:user:1');
  } finally {
    await node.close();
  }
  assert.equal(parseCloudflareInvalidationMessage({ ...messages[0], type: 'pattern', pattern: '' }), null);
});

test('Queue REST sender posts a JSON invalidation with bearer auth', async () => {
  const requests = [];
  const sender = new CloudflareQueueRestSender({
    accountId: 'account', queueId: 'queue', apiToken: 'secret',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ success: true });
    },
  });
  const publisher = new CloudflareQueueInvalidationPublisher(sender, 'users-api');
  await publisher.publishKey('user:1');
  assert.match(requests[0].url, /\/accounts\/account\/queues\/queue\/messages$/);
  assert.equal(requests[0].init.headers.authorization, 'Bearer secret');
  assert.equal(JSON.parse(requests[0].init.body).body.key, 'user:1');
  assert.equal(JSON.parse(requests[0].init.body).content_type, 'json');
});

test('Node REST namespace sends binary KV operations with scoped bearer auth', async () => {
  const requests = [];
  const namespace = new CloudflareKVRestNamespace({
    accountId: 'account', namespaceId: 'namespace', apiToken: 'secret',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('/keys?')) return Response.json({ success: true, result: [{ name: 'app:key' }], result_info: {} });
      if (init.method === 'PUT' || init.method === 'DELETE') return Response.json({ success: true, result: {} });
      return new Response(new Uint8Array([1, 2, 3]));
    },
  });
  await namespace.put('app:key', new Uint8Array([4, 5]), { expirationTtl: 60 });
  assert.deepEqual([...new Uint8Array(await namespace.get('app:key', 'arrayBuffer'))], [1, 2, 3]);
  assert.deepEqual((await namespace.list({ prefix: 'app:', limit: 1 })).keys, [{ name: 'app:key' }]);
  await namespace.delete('app:key');
  assert.equal(requests[0].init.headers.authorization, 'Bearer secret');
  assert.match(requests[0].url, /expiration_ttl=60/);
  assert.equal(requests[0].init.method, 'PUT');
  assert.match(requests[2].url, /limit=10/);
});
