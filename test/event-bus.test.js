import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "production";

const {
  HybridCache,
  NatsEventBus,
  RabbitMQEventBus,
  RedisEventBus,
  serialize,
} = await import("../dist/index.js");

const quiet = { enabled: false };

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createFakeRedis(overrides = {}) {
  const sub = {
    status: "ready",
    listeners: new Map(),
    subscribed: [],
    unsubscribed: [],
    disconnectCalls: 0,
    async ping() {
      return "PONG";
    },
    async subscribe(channel) {
      this.subscribed.push(channel);
    },
    async unsubscribe(channel) {
      if (overrides.unsubscribeFails) {
        throw new Error("connection is closed");
      }

      this.unsubscribed.push(channel);
    },
    on(event, listener) {
      const existing = this.listeners.get(event) ?? [];
      existing.push(listener);
      this.listeners.set(event, existing);
    },
    off(event, listener) {
      const existing = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        existing.filter((candidate) => candidate !== listener),
      );
    },
    emit(event, ...args) {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    },
    disconnect() {
      this.disconnectCalls += 1;
    },
  };

  const pub = {
    status: "ready",
    published: [],
    disconnectCalls: 0,
    duplicate() {
      return sub;
    },
    async ping() {
      return "PONG";
    },
    async publish(channel, payload) {
      if (overrides.publish) {
        return overrides.publish.call(this, channel, payload);
      }

      this.published.push(payload);
      return 1;
    },
    disconnect() {
      this.disconnectCalls += 1;
    },
  };

  return { pub, sub };
}

test("redis event bus disconnect leaves the caller's client alone", async () => {
  const { pub, sub } = createFakeRedis();
  const bus = new RedisEventBus(pub, "cache:invalidations", { logging: quiet });

  await bus.subscribe(async () => {});
  await bus.disconnect();

  // The publisher is the caller's client, usually the same one backing the L2
  // RedisStore. Disconnecting it here would take L2 down with the bus.
  assert.equal(pub.disconnectCalls, 0);
  assert.equal(sub.disconnectCalls, 1);
  assert.deepEqual(sub.unsubscribed, ["cache:invalidations"]);
});

test("redis event bus removes its message listener on disconnect", async () => {
  const { pub, sub } = createFakeRedis();
  const bus = new RedisEventBus(pub, "cache:invalidations", { logging: quiet });

  await bus.subscribe(async () => {});
  assert.equal(sub.listeners.get("messageBuffer").length, 1);

  await bus.disconnect();
  assert.equal(sub.listeners.get("messageBuffer").length, 0);
});

test("redis event bus disconnect is idempotent and survives a dead connection", async () => {
  const { pub, sub } = createFakeRedis({ unsubscribeFails: true });
  const bus = new RedisEventBus(pub, "cache:invalidations", { logging: quiet });

  await bus.subscribe(async () => {});
  await bus.disconnect();
  await bus.disconnect();

  assert.equal(pub.disconnectCalls, 0);
  assert.equal(sub.disconnectCalls, 2);
  assert.equal(sub.listeners.get("messageBuffer").length, 0);
});

test("redis event bus disconnect before subscribe does not throw", async () => {
  const { pub, sub } = createFakeRedis();
  const bus = new RedisEventBus(pub, "cache:invalidations", { logging: quiet });

  await bus.disconnect();

  assert.equal(pub.disconnectCalls, 0);
  assert.equal(sub.disconnectCalls, 1);
});

test("redis event bus delivers decoded messages and ignores garbage", async () => {
  const { pub, sub } = createFakeRedis();
  const bus = new RedisEventBus(pub, "cache:invalidations", { logging: quiet });
  const received = [];

  await bus.subscribe((event) => {
    received.push(event);
  });

  const channel = Buffer.from("cache:invalidations", "utf8");

  sub.emit("messageBuffer", channel, Buffer.from("not an event"));
  sub.emit(
    "messageBuffer",
    channel,
    serialize({ id: "e1", type: "del", keys: ["a"], source: "peer", ts: Date.now() }),
  );
  sub.emit("messageBuffer", Buffer.from("other:channel", "utf8"), Buffer.from("ignored"));

  await tick();

  assert.equal(received.length, 1);
  assert.deepEqual(received[0].keys, ["a"]);

  await bus.disconnect();
});

test("redis event bus survives a handler that throws synchronously", async () => {
  const { pub, sub } = createFakeRedis();
  const bus = new RedisEventBus(pub, "cache:invalidations", { logging: quiet });
  let calls = 0;

  await bus.subscribe(() => {
    calls += 1;
    throw new Error("handler exploded");
  });

  const channel = Buffer.from("cache:invalidations", "utf8");
  const payload = serialize({ id: "e1", type: "del", keys: ["a"], source: "peer", ts: Date.now() });

  sub.emit("messageBuffer", channel, payload);
  await tick();
  sub.emit("messageBuffer", channel, payload);
  await tick();

  // A failing handler must not tear down the subscription.
  assert.equal(calls, 2);

  await bus.disconnect();
});

test("retry queue does not publish a buffered event twice under concurrent publishes", async () => {
  let failNext = true;
  const published = [];
  const { pub } = createFakeRedis({
    async publish(_channel, payload) {
      if (failNext) {
        failNext = false;
        throw new Error("bus blip");
      }

      // Resolve on a later turn so two flushes can overlap.
      await tick();
      published.push(payload);
      return 1;
    },
  });
  const bus = new RedisEventBus(pub, "cache:invalidations", { logging: quiet });

  const first = { id: "buffered", type: "del", keys: ["a"], source: "me", ts: 1 };

  await assert.rejects(bus.publish(first));

  await Promise.all([
    bus.publish({ id: "second", type: "del", keys: ["b"], source: "me", ts: 2 }),
    bus.publish({ id: "third", type: "del", keys: ["c"], source: "me", ts: 3 }),
  ]);

  const bufferedCopies = published.filter(
    (payload) => payload.equals(serialize(first)),
  ).length;

  assert.equal(bufferedCopies, 1);

  await bus.disconnect();
});

function createFakeNatsConnection(options = {}) {
  return {
    closed: false,
    drained: 0,
    isClosed() {
      return this.closed;
    },
    getServer() {
      return "test-nats";
    },
    async flush() {},
    publish() {},
    subscribe() {
      return {
        async *[Symbol.asyncIterator]() {
          // An iterator that ends immediately is exactly what a connection that
          // gave up reconnecting looks like from the bus's point of view.
        },
        async drain() {
          if (options.drainFails) {
            throw new Error("connection is closed");
          }
        },
      };
    },
    async drain() {
      this.drained += 1;

      if (options.drainFails) {
        throw new Error("connection is closed");
      }
    },
  };
}

test("nats core reports unhealthy once its subscription ends", async () => {
  const connection = createFakeNatsConnection();
  const bus = new NatsEventBus({ connection, logging: quiet });

  const healthyBefore = await bus.healthCheck();
  assert.equal(healthyBefore.ok, true);

  await bus.subscribe(async () => {});
  await tick();

  const health = await bus.healthCheck();

  assert.equal(health.ok, false);
  assert.match(String(health.error), /not receiving invalidations/);

  // Stops the pending resubscribe timer.
  await bus.disconnect();
});

test("nats disconnect is idempotent and does not throw on a dead connection", async () => {
  const connection = createFakeNatsConnection({ drainFails: true });
  const bus = new NatsEventBus({ connection, logging: quiet });

  await bus.subscribe(async () => {});
  await bus.disconnect();
  await bus.disconnect();

  const health = await bus.healthCheck();
  assert.equal(health.ok, true);
});

test("nats disconnect does not drain a connection it did not create", async () => {
  const connection = createFakeNatsConnection();
  const bus = new NatsEventBus({ connection, logging: quiet });

  await bus.connect();
  await bus.disconnect();

  assert.equal(connection.drained, 0);
});

test("rabbitmq disconnect before init does not throw and is idempotent", async () => {
  const bus = new RabbitMQEventBus("cache.invalidations", { logging: quiet });

  await bus.disconnect();
  await bus.disconnect();

  const health = await bus.healthCheck();

  assert.equal(health.ok, false);
  assert.match(String(health.error), /URL/);
});

test("a failed remote invalidation is retried instead of dropped as a duplicate", async () => {
  const setCalls = [];
  let failNext = true;

  const l1 = {
    async set(key, value) {
      setCalls.push(key);

      if (failNext) {
        failNext = false;
        throw new Error("l1 write failed");
      }
    },
    async get() {
      return undefined;
    },
    async getOrSet() {
      return undefined;
    },
    async has() {
      return false;
    },
    async delete() {},
    async deleteByPattern() {},
    async clear() {},
    async size() {
      return setCalls.length;
    },
  };

  let handler;
  const eventBus = {
    async publish() {},
    async subscribe(fn) {
      handler = fn;
    },
  };

  const cache = new HybridCache({ l1, eventBus, source: "me", logging: quiet });
  await tick();

  const event = {
    id: "redelivered",
    type: "set",
    keys: ["user:1"],
    value: { id: 1 },
    source: "peer",
    ts: Date.now(),
  };

  await assert.rejects(handler(event), /l1 write failed/);

  // The transport redelivers the very same event. It must be applied, not
  // discarded as a duplicate of the delivery that failed.
  await handler(event);

  assert.deepEqual(setCalls, ["user:1", "user:1"]);
  await cache.close?.();
});

test("a successfully applied invalidation is still deduplicated", async () => {
  const setCalls = [];

  const l1 = {
    async set(key) {
      setCalls.push(key);
    },
    async get() {
      return undefined;
    },
    async getOrSet() {
      return undefined;
    },
    async has() {
      return false;
    },
    async delete() {},
    async deleteByPattern() {},
    async clear() {},
    async size() {
      return setCalls.length;
    },
  };

  let handler;
  const eventBus = {
    async publish() {},
    async subscribe(fn) {
      handler = fn;
    },
  };

  const cache = new HybridCache({ l1, eventBus, source: "me", logging: quiet });
  await tick();

  const event = {
    id: "duplicate",
    type: "set",
    keys: ["user:2"],
    value: { id: 2 },
    source: "peer",
    ts: Date.now(),
  };

  await handler(event);
  await handler(event);

  assert.deepEqual(setCalls, ["user:2"]);
  await cache.close?.();
});
