import assert from "node:assert/strict";
import { test } from "node:test";

const { HybridCache } = await import("../dist/index.js");
const { EventBusHandlerQueue, EventBusRetryQueue } = await import("../dist/event-bus/index.js");

const wait = () => new Promise((resolve) => setImmediate(resolve));

test("remote delete is local-only and trust recovers only after subscription acknowledgement", async () => {
  let handler;
  let status;
  let l2Deletes = 0;
  const l1 = new Map([["a", 1]]);
  const l2 = {
    async get(key) { return key === "a" ? 2 : undefined; },
    async set() {}, async has() { return true; },
    async delete() { l2Deletes++; }, async deleteByPattern() {},
    async size() { return 1; },
  };
  const l1Store = {
    async get(key) { return l1.get(key); }, async set(key, value) { l1.set(key, value); },
    async has(key) { return l1.has(key); }, async delete(key) { l1.delete(key); },
    async deleteByPattern() { l1.clear(); }, async size() { return l1.size; },
  };
  const bus = {
    async publish() {}, async subscribe(fn) { handler = fn; },
    onStatus(fn) { status = fn; return () => {}; },
  };
  const cache = new HybridCache({ l1: l1Store, l2, eventBus: bus, source: "local" });
  await cache.ready();
  assert.equal(cache.isInvalidationTrusted(), true);
  status("disconnected");
  await wait();
  assert.equal(cache.isInvalidationTrusted(), false);
  assert.equal(await cache.get("a"), 2);
  status("subscribed");
  await wait();
  assert.equal(cache.isInvalidationTrusted(), true);
  await handler({ id: "d1", type: "del", keys: ["a"], source: "peer", ts: Date.now() });
  assert.equal(l2Deletes, 0);
  await cache.close();
});

test("handler queue counts active encoded bytes and reports overflow", async () => {
  let release;
  const overflow = [];
  const queue = new EventBusHandlerQueue(async () => new Promise((r) => { release = r; }), {
    concurrency: 1, maxSize: 2, maxBytes: 5, onError() {}, onOverflow: (x) => overflow.push(x),
  });
  const event = { type: "del", keys: ["a"], source: "p", ts: 1 };
  assert.equal(queue.enqueue(event, Buffer.alloc(4)), true);
  await wait();
  assert.equal(queue.enqueue(event, Buffer.alloc(2)), false);
  assert.equal(queue.retainedBytes, 4);
  assert.equal(overflow.length, 1);
  release();
  await wait();
});

test("retry queue bounds retained encoded bytes and exposes drops", async () => {
  let drops = 0;
  const queue = new EventBusRetryQueue({ maxSize: 10, maxBytes: 1, onOverflow: () => drops++ });
  const event = { type: "del", keys: ["a"], source: "p", ts: 1 };
  assert.equal(queue.enqueue(event), false);
  assert.equal(queue.size, 0);
  assert.equal(queue.droppedCount, 1);
  assert.equal(drops, 1);
});
