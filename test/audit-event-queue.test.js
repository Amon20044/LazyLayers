import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
process.env.NODE_ENV = 'production';
const input = process.env.LAZY_LAYERS_AUDIT_ENTRY;
const entry = input ? (input.startsWith('file:') ? input : pathToFileURL(input).href) : new URL('../dist/index.js', import.meta.url).href;
const { EventBusHandlerQueue, EventBusRetryQueue, encodeInvalidationEvent } = await import(new URL('event-bus/index.js', new URL('.', entry)));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const event = { type: 'del', keys: ['a'], source: 'peer', ts: 1 };
test('audit: closed event queue cannot resurrect deliveries or retain new events', { timeout: 2000 }, async () => {
  const errors = []; let calls = 0;
  const queue = new EventBusHandlerQueue(() => { calls++; }, { onError: (error) => errors.push(error) });
  queue.close();
  assert.equal(queue.enqueue(event), false);
  await tick();
  assert.equal(calls, 0); assert.equal(queue.retainedBytes, 0);
});
test('audit: an unencodable event cannot bypass byte accounting', { timeout: 2000 }, () => {
  const cyclic = { ...event }; cyclic.value = cyclic;
  const queue = new EventBusHandlerQueue(() => {}, { onError: () => {} });
  assert.equal(queue.enqueue(cyclic), false);
  assert.equal(queue.retainedBytes, 0); assert.equal(queue.pendingCount, 0);
});
test('audit: event queue limits must be finite valid integers', { timeout: 2000 }, () => {
  for (const limits of [{ maxSize: Infinity }, { maxBytes: Infinity }, { maxSize: -1 }, { concurrency: 0 }, { concurrency: 1.5 }]) {
    assert.throws(() => new EventBusHandlerQueue(() => {}, { onError: () => {}, ...limits }), RangeError);
  }
});
test('audit: discarding pending events releases bytes and preserves active accounting', { timeout: 2000 }, async () => {
  let resolve; const barrier = new Promise((done) => { resolve = done; });
  const queue = new EventBusHandlerQueue(() => barrier, { onError: () => {}, concurrency: 1, maxSize: 8, maxBytes: 1024 });
  assert.equal(queue.enqueueEncoded(new Uint8Array(20), () => event), true);
  assert.equal(queue.enqueueEncoded(new Uint8Array(30), () => event), true);
  assert.equal(queue.retainedBytes, 50);
  queue.discardPending(); assert.equal(queue.retainedBytes, 20);
  resolve(); await tick(); assert.equal(queue.retainedBytes, 0);
});

test('audit: retry admission counts the active publication against the byte budget', { timeout: 2000 }, async () => {
  const bytes = encodeInvalidationEvent(event).byteLength;
  let done; const barrier = new Promise((resolve) => { done = resolve; });
  const queue = new EventBusRetryQueue({ maxBytes: bytes, maxSize: 1 });
  assert.equal(queue.enqueue(event), true);
  const flushing = queue.flush(() => barrier);
  try {
    assert.equal(queue.enqueue(event), false);
    assert.equal(queue.retainedBytes, bytes);
    assert.equal(queue.size, 1);
  } finally { done(); await flushing; }
  assert.equal(queue.retainedBytes, 0);
});

test('audit: retry clear keeps active bytes accounted until publication settles', { timeout: 2000 }, async () => {
  const bytes = encodeInvalidationEvent(event).byteLength;
  let done; const barrier = new Promise((resolve) => { done = resolve; });
  const queue = new EventBusRetryQueue({ maxBytes: bytes * 3 });
  queue.enqueue(event); queue.enqueue(event);
  const flushing = queue.flush(() => barrier);
  try {
    queue.clear();
    assert.equal(queue.retainedBytes, bytes);
    assert.equal(queue.size, 1);
  } finally { done(); await flushing; }
  assert.equal(queue.retainedBytes, 0);
  assert.equal(queue.size, 0);
});
