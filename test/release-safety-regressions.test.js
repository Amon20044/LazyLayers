import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

const { HybridCache, RedisEventBus, serialize } = await import('../dist/index.js');
const { EventBusRetryQueue } = await import('../dist/event-bus/index.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const quiet = { enabled: false };
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function memory(overrides = {}) {
  const entries = new Map();
  return {
    entries,
    async get(key) { return entries.get(key); },
    async set(key, value) { entries.set(key, value); },
    async has(key) { return entries.has(key); },
    async delete(key) { entries.delete(key); },
    async deleteByPattern() { entries.clear(); },
    async size() { return entries.size; },
    ...overrides,
  };
}
function eventBus() {
  let receive;
  let status;
  return {
    async subscribe(handler) { receive = handler; },
    async publish() {},
    onStatus(handler) { status = handler; return () => {}; },
    receive(event) { return receive(event); },
    status(value) { status(value); },
  };
}
function redisPair() {
  const sub = new EventEmitter();
  sub.calls = 0;
  sub.subscribe = async () => { sub.calls++; };
  sub.unsubscribe = async () => {};
  sub.disconnect = () => {};
  const pub = { duplicate: () => sub, async publish() {}, async ping() {} };
  return { pub, sub };
}
function event(type, id, value) {
  return { type, id, source: 'peer', ts: 1, keys: ['key'], ...(type === 'set' ? { value } : {}) };
}

test('release: a local invalidation fences an already-running origin load', async (t) => {
  const started = deferred();
  const result = deferred();
  const cache = new HybridCache({ broadcastSet: false, logging: quiet });
  t.after(() => cache.close());
  const loading = cache.getOrSet('key', () => { started.resolve(); return result.promise; });
  await started.promise;
  await cache.delete('key');
  result.resolve('obsolete');
  await loading;
  assert.equal(await cache.get('key'), undefined);
});

test('release: an initial subscription failure never enables L1 trust', async (t) => {
  const cache = new HybridCache({ logging: quiet, eventBus: {
    async subscribe() { throw new Error('subscription failed'); }, async publish() {},
  } });
  t.after(() => cache.close());
  await assert.rejects(cache.ready(), /subscription failed/);
  assert.equal(cache.isInvalidationTrusted(), false);
});

test('release: a second disconnect fences an outstanding recovery flush', async (t) => {
  const bus = eventBus();
  const flushing = deferred();
  let block = false;
  const cache = new HybridCache({ logging: quiet, eventBus: bus, l1: memory({
    async deleteByPattern() { if (block) await flushing.promise; },
  }) });
  t.after(() => cache.close());
  await cache.ready();
  bus.status('disconnected');
  await tick();
  block = true;
  bus.status('subscribed');
  await tick();
  bus.status('disconnected');
  flushing.resolve();
  await tick();
  assert.equal(cache.isInvalidationTrusted(), false);
});

test('release: a delayed remote set cannot resurrect a newer remote delete', async (t) => {
  const bus = eventBus();
  const writing = deferred();
  const resume = deferred();
  const l1 = memory();
  l1.set = async (key, value) => { writing.resolve(); await resume.promise; l1.entries.set(key, value); };
  const cache = new HybridCache({ logging: quiet, eventBus: bus, l1 });
  t.after(() => cache.close());
  await cache.ready();
  const oldSet = bus.receive({ ...event('set', 'old-set', 'obsolete'), generation: 0 });
  await writing.promise;
  const deletion = bus.receive({ ...event('del', 'new-delete'), generation: 1 });
  await tick();
  resume.resolve();
  await Promise.all([oldSet, deletion]);
  assert.equal(await cache.get('key'), undefined);
});

test('release: a delayed L2 promotion cannot repopulate L1 after invalidation', async (t) => {
  const writing = deferred();
  const resume = deferred();
  const l1 = memory();
  const l2 = memory();
  l2.entries.set('key', 'obsolete');
  l1.set = async (key, value) => { writing.resolve(); await resume.promise; l1.entries.set(key, value); };
  const cache = new HybridCache({ logging: quiet, l1, l2 });
  t.after(() => cache.close());
  const reading = cache.get('key');
  await writing.promise;
  const deletion = cache.delete('key');
  await tick();
  resume.resolve();
  await Promise.all([reading, deletion]);
  assert.equal(l1.entries.has('key'), false);
  assert.equal(l2.entries.has('key'), false);
});

test('release: Redis reconnect explicitly subscribes again and resumes delivery', async (t) => {
  const { pub, sub } = redisPair();
  const bus = new RedisEventBus(pub, 'channel', { logging: quiet });
  t.after(() => bus.disconnect());
  const received = [];
  await bus.subscribe((value) => { received.push(value.id); });
  sub.emit('close');
  sub.emit('ready');
  await tick();
  assert.equal(sub.calls, 2);
  sub.emit('messageBuffer', Buffer.from('channel'), serialize(event('del', 'after-reconnect')));
  await tick();
  assert.deepEqual(received, ['after-reconnect']);
});

test('release: a stale reconnect acknowledgement cannot restore subscription status', async (t) => {
  const { pub, sub } = redisPair();
  const bus = new RedisEventBus(pub, 'channel', { logging: quiet });
  t.after(() => bus.disconnect());
  const statuses = [];
  bus.onStatus((status) => statuses.push(status));
  await bus.subscribe(() => {});
  const acknowledgement = deferred();
  sub.subscribe = async () => { sub.calls++; await acknowledgement.promise; };
  sub.emit('close');
  sub.emit('ready');
  await tick();
  sub.emit('close');
  acknowledgement.resolve();
  await tick();
  assert.equal(statuses.at(-1), 'disconnected');
});

test('release: Redis discards pre-gap pending deliveries before trusting reconnection', async (t) => {
  const { pub, sub } = redisPair();
  const bus = new RedisEventBus(pub, 'channel', { logging: quiet });
  const first = deferred();
  const received = [];
  t.after(() => { first.resolve(); return bus.disconnect(); });
  await bus.subscribe(async (value) => {
    received.push(value.id);
    if (value.id === 'active') await first.promise;
  });
  sub.emit('messageBuffer', Buffer.from('channel'), serialize(event('del', 'active')));
  await tick();
  sub.emit('messageBuffer', Buffer.from('channel'), serialize(event('set', 'old-pending', 'obsolete')));
  sub.emit('close');
  sub.emit('ready');
  await tick();
  first.resolve();
  await tick();
  sub.emit('messageBuffer', Buffer.from('channel'), serialize(event('del', 'fresh')));
  await tick();
  assert.deepEqual(received, ['active', 'fresh']);
});

test('release: retry overflow during publishing does not silently remove the next event', async () => {
  const queue = new EventBusRetryQueue({ maxSize: 1 });
  const publishing = deferred();
  const sent = [];
  queue.enqueue(event('del', 'first'));
  const flush = queue.flush(async (value) => {
    sent.push(value.id);
    if (value.id === 'first') await publishing.promise;
  });
  queue.enqueue(event('del', 'second'));
  publishing.resolve();
  await flush;
  assert.deepEqual(sent, ['first', 'second']);
  assert.equal(queue.size, 0);
  assert.equal(queue.retainedBytes, 0);
});

test('release: retry queues own an immutable payload snapshot', async () => {
  const queue = new EventBusRetryQueue();
  const original = event('set', 'snapshot', { revision: 1 });
  queue.enqueue(original);
  original.value.revision = 2;
  original.keys.push('unrelated');
  const sent = [];
  await queue.flush(async (value) => { sent.push(value); });
  assert.equal(sent[0].value.revision, 1);
  assert.deepEqual(sent[0].keys, ['key']);
});
