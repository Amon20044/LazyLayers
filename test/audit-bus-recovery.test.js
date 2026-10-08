import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'production';
const input = process.env.LAZY_LAYERS_AUDIT_ENTRY;
const entry = input ? (input.startsWith('file:') ? input : pathToFileURL(input).href) : new URL('../dist/index.js', import.meta.url).href;
const { HybridCache, NatsEventBus, RabbitMQEventBus, RedisEventBus, serialize } = await import(entry);
const quiet = { enabled: false };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function stream() {
  const values = []; let pending; let ended = false;
  const source = {
    returned: false,
    push(value) { if (pending) { const next = pending; pending = undefined; next({ value, done: false }); } else values.push(value); },
    end() { ended = true; pending?.({ done: true }); pending = undefined; },
    iterator: {
      [Symbol.asyncIterator]() { return this; },
      next() { if (values.length) return Promise.resolve({ value: values.shift(), done: false }); if (ended) return Promise.resolve({ done: true }); return new Promise((resolve) => { pending = resolve; }); },
      return() { source.returned = true; source.end(); return Promise.resolve({ done: true }); },
    },
  };
  return source;
}
function natsConnection() {
  const statuses = stream(); const messages = stream();
  return {
    statuses, messages, drained: 0,
    isClosed: () => false, getServer: () => 'isolated-test', flush: async () => {}, publish() {},
    status: () => statuses.iterator,
    subscribe: () => ({ ...messages.iterator, unsubscribe: () => messages.end(), drain: async () => {} }),
    async drain() { this.drained++; }, close: async () => {},
  };
}
test('audit: NATS transport gaps flush L1 and recover trust without owning caller connection', { timeout: 2500 }, async () => {
  const connection = natsConnection(); const bus = new NatsEventBus({ connection, logging: quiet });
  const cache = new HybridCache({ eventBus: bus, logging: quiet, failSafe: { enabled: false } });
  try {
    await cache.ready(); await cache.set('key', 'old');
    assert.equal(await cache.get('key'), 'old');
    connection.statuses.push({ type: 'disconnect', data: 'local fault' }); await tick();
    assert.equal(cache.isInvalidationTrusted(), false);
    assert.equal(await cache.get('key'), undefined);
    connection.statuses.push({ type: 'reconnect', data: 'recovered' }); await tick(); await tick();
    assert.equal(cache.isInvalidationTrusted(), true);
    assert.equal(await cache.get('key'), undefined);
  } finally { await cache.close(); }
  assert.equal(connection.drained, 0);
  assert.equal(connection.statuses.returned, true);
});
test('audit: RabbitMQ exposes consumer and connection loss through status observers', { timeout: 2500 }, async () => {
  const bus = new RabbitMQEventBus('isolated-test', { logging: quiet });
  assert.equal(typeof bus.onStatus, 'function');
  const statuses = []; const remove = bus.onStatus((status) => statuses.push(status));
  const connection = new EventEmitter(); connection.close = async () => {};
  const channel = new EventEmitter(); channel.close = async () => {}; channel.cancel = async () => {};
  channel.assertQueue = async () => ({ queue: 'isolated-test' }); channel.bindQueue = async () => {};
  let delivery; channel.consume = async (_queue, handler) => { delivery = handler; return { consumerTag: 'one' }; };
  const publisher = new EventEmitter(); publisher.close = async () => {};
  bus.connection = connection; bus.channel = channel; bus.publishChannel = publisher;
  bus.watchConnection(connection, channel, publisher);
  await bus.subscribe(() => {});
  assert.ok(statuses.includes('subscribed'));
  delivery(null);
  assert.equal(statuses.at(-1), 'disconnected');
  connection.emit('close');
  assert.equal(statuses.at(-1), 'disconnected');
  remove(); await bus.disconnect();
});
test('audit: Redis delivery overflow reconciles trust after active handlers finish', { timeout: 2500 }, async () => {
  const sub = new EventEmitter(); sub.status = 'ready'; sub.subscribe = async () => {}; sub.unsubscribe = async () => {}; sub.disconnect = () => {};
  const pub = { duplicate: () => sub, status: 'ready', publish: async () => 1 };
  const bus = new RedisEventBus(pub, 'isolated-test', { logging: quiet, handlerMaxSize: 1, handlerConcurrency: 1 });
  const statuses = []; bus.onStatus((status) => statuses.push(status));
  let done; const barrier = new Promise((resolve) => { done = resolve; });
  await bus.subscribe(() => barrier);
  const event = serialize({ type: 'del', keys: ['a'], source: 'peer', ts: 1 });
  sub.emit('messageBuffer', Buffer.from('isolated-test'), event);
  sub.emit('messageBuffer', Buffer.from('isolated-test'), event);
  assert.equal(statuses.at(-1), 'error');
  done(); await tick(); await tick();
  assert.equal(statuses.at(-1), 'subscribed');
  await bus.disconnect();
});

test('audit: RabbitMQ rejects unlimited prefetch configuration', () => {
  for (const prefetch of [0, -1, Infinity, 1.5]) assert.throws(() => new RabbitMQEventBus('bounded', { prefetch, logging: quiet }), RangeError);
});

test('audit: RabbitMQ bounds retained deliveries by bytes and heals rejected-message gaps', { timeout: 2500 }, async () => {
  const bus = new RabbitMQEventBus('bounded', { logging: quiet, handlerMaxBytes: 128, handlerMaxSize: 1 });
  const statuses = []; bus.onStatus((status) => statuses.push(status));
  const channel = new EventEmitter(); channel.close = async () => {}; channel.cancel = async () => {};
  channel.assertQueue = async () => ({ queue: 'bounded' }); channel.bindQueue = async () => {};
  let delivery; channel.consume = async (_queue, handler) => { delivery = handler; return { consumerTag: 'one' }; };
  const settled = []; channel.ack = () => settled.push('ack'); channel.nack = () => settled.push('nack');
  bus.channel = channel;
  let done; const barrier = new Promise((resolve) => { done = resolve; }); let calls = 0;
  await bus.subscribe(() => { calls++; return barrier; });
  const raw = serialize({ type: 'del', keys: ['a'], source: 'peer', ts: 1 });
  delivery({ content: raw, fields: { deliveryTag: 1 } });
  delivery({ content: Buffer.alloc(1024), fields: { deliveryTag: 2 } });
  try {
    await tick();
    assert.equal(calls, 1);
    assert.ok(statuses.includes('error'));
    assert.ok(bus.handlerQueue.retainedBytes <= 128);
  } finally { done(); await tick(); await tick(); await bus.disconnect(); }
  assert.ok(settled.includes('nack'));
  assert.ok(statuses.includes('subscribed'));
});

test('audit: RabbitMQ channel-only closure drops subscription trust', { timeout: 2500 }, async () => {
  const bus = new RabbitMQEventBus('channel-test', { logging: quiet });
  const connection = new EventEmitter(); connection.close = async () => {};
  const channel = new EventEmitter(); channel.close = async () => {};
  const publisher = new EventEmitter(); publisher.close = async () => {};
  bus.connection = connection; bus.channel = channel; bus.publishChannel = publisher;
  const statuses = []; bus.onStatus((status) => statuses.push(status));
  bus.watchConnection(connection, channel, publisher);
  channel.emit('close'); await tick();
  assert.ok(statuses.includes('disconnected'));
  assert.equal(bus.consumerTag, null);
  await bus.disconnect();
});
