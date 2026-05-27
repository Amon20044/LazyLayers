import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "production";

const {
  HybridCache,
  LazyLayersCache,
  MemoryStore,
  NatsEventBus,
  RabbitMQEventBus,
  RedisEventBus,
  createCache,
} = await import("../dist/index.js");

test("stores and retrieves values", async () => {
  const cache = createCache({
    ttlMs: 1_000,
    levels: {
      L1: {
        maxEntries: 10,
      },
    },
  });

  await cache.set("answer", 42);

  assert.equal(await cache.get("answer"), 42);
  assert.equal(await cache.has("answer"), true);
  assert.equal(await cache.size(), 1);
});

test("expires values after ttl", async () => {
  const cache = new HybridCache({
    levels: {
      L1: {
        maxEntries: 10,
        ttlMs: 5,
      },
    },
  });

  await cache.set("short-lived", "value");
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(await cache.get("short-lived"), undefined);
  assert.equal(await cache.has("short-lived"), false);
  assert.equal(await cache.size(), 0);
});

test("respects l1 max entries", async () => {
  const cache = createCache({
    levels: {
      L1: {
        maxEntries: 2,
      },
    },
  });

  await cache.set("a", 1);
  await cache.set("b", 2);
  await cache.set("c", 3);

  assert.equal(await cache.size(), 2);
  assert.equal(await cache.get("a"), undefined);
  assert.equal(await cache.get("b"), 2);
  assert.equal(await cache.get("c"), 3);
});

test("deduplicates concurrent lazy loads with inflight entries", async () => {
  const cache = createCache({
    inflight: {
      enabled: true,
      ttlMs: 1_000,
      maxEntries: 10,
    },
  });
  let calls = 0;

  const values = await Promise.all([
    cache.getOrSet("user:1", async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { id: 1, name: "Amonk" };
    }),
    cache.getOrSet("user:1", async () => {
      calls += 1;
      return { id: 1, name: "Different" };
    }),
  ]);

  assert.equal(calls, 1);
  assert.deepEqual(values, [
    { id: 1, name: "Amonk" },
    { id: 1, name: "Amonk" },
  ]);
  assert.deepEqual(await cache.get("user:1"), { id: 1, name: "Amonk" });
});

test("keeps existing inflight entries protected when inflight capacity is full", async () => {
  const cache = createCache({
    inflight: {
      enabled: true,
      ttlMs: 1_000,
      maxEntries: 1,
    },
  });
  let releaseFirst;
  let firstCalls = 0;
  let secondCalls = 0;

  const firstLoad = cache.getOrSet("hot:1", async () => {
    firstCalls += 1;
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    return "first";
  });
  await new Promise((resolve) => setImmediate(resolve));

  const secondLoad = cache.getOrSet("cold:1", async () => {
    secondCalls += 1;
    return "second";
  });

  const firstReuse = cache.getOrSet("hot:1", async () => {
    firstCalls += 1;
    return "duplicate";
  });

  releaseFirst();

  assert.deepEqual(await Promise.all([firstLoad, secondLoad, firstReuse]), [
    "first",
    "second",
    "first",
  ]);
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
});

test("bypasses inflight tracking when maxEntries is zero", async () => {
  const cache = createCache({
    inflight: {
      enabled: true,
      ttlMs: 1_000,
      maxEntries: 0,
    },
  });
  let calls = 0;

  const values = await Promise.all([
    cache.getOrSet("uncapped", async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "a";
    }),
    cache.getOrSet("uncapped", async () => {
      calls += 1;
      return "b";
    }),
  ]);

  assert.equal(calls, 2);
  assert.deepEqual(values, ["a", "b"]);
});

test("allows getOrSet to override ttl per key", async () => {
  const cache = createCache({
    ttlMs: 1_000,
  });

  await cache.getOrSet(
    "custom-ttl",
    async () => "value",
    {
      ttlMs: 5,
    },
  );
  await cache.getOrSet("default-ttl", async () => "value");

  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(await cache.get("custom-ttl"), undefined);
  assert.equal(await cache.get("default-ttl"), "value");
});

test("warms l1 from l2 on l1 miss", async () => {
  const l2 = new MemoryStore({
    levels: {
      L1: {
        maxEntries: 10,
      },
    },
  });
  const cache = new HybridCache({
    levels: {
      L1: {
        maxEntries: 10,
      },
    },
    l2,
  });

  await l2.set("profile:1", { id: 1 });

  assert.deepEqual(await cache.get("profile:1"), { id: 1 });
  assert.equal(await cache.size(), 1);
});

test("deletes values by wildcard pattern", async () => {
  const cache = createCache();

  await cache.set("user:1", "a");
  await cache.set("user:2", "b");
  await cache.set("post:1", "c");
  await cache.deleteByPattern("user:*");

  assert.equal(await cache.get("user:1"), undefined);
  assert.equal(await cache.get("user:2"), undefined);
  assert.equal(await cache.get("post:1"), "c");
});

test("fails open when l2 operations fail", async () => {
  const failingL2 = {
    setCalls: 0,
    getCalls: 0,
    async set() {
      this.setCalls += 1;
      throw new Error("l2 set failed");
    },
    async get() {
      this.getCalls += 1;
      throw new Error("l2 get failed");
    },
    async getOrSet() {
      throw new Error("unused");
    },
    async has() {
      throw new Error("l2 has failed");
    },
    async delete() {
      throw new Error("l2 delete failed");
    },
    async deleteByPattern() {
      throw new Error("l2 pattern delete failed");
    },
    async clear() {
      throw new Error("unused");
    },
    async size() {
      return 0;
    },
  };
  const cache = new HybridCache({
    l2: failingL2,
    resilience: {
      l2CircuitBreaker: {
        failureThreshold: 1,
        cooldownMs: 10_000,
      },
    },
  });

  await cache.set("safe", "value");

  assert.equal(await cache.get("safe"), "value");
  assert.equal(await cache.get("missing"), undefined);
  assert.equal(await cache.has("missing"), false);

  await cache.delete("safe");
  await cache.deleteByPattern("safe:*");

  assert.equal(failingL2.setCalls, 1);
  assert.equal(failingL2.getCalls, 0);
});

test("fails open when event bus publish fails", async () => {
  const eventBus = {
    publishCalls: 0,
    async publish() {
      this.publishCalls += 1;
      throw new Error("publish failed");
    },
    async subscribe() {},
  };
  const cache = new HybridCache({
    eventBus,
    resilience: {
      eventBusCircuitBreaker: {
        failureThreshold: 1,
        cooldownMs: 10_000,
      },
    },
  });

  await cache.set("safe", "value");
  await cache.delete("safe");
  await cache.deleteByPattern("safe:*");

  assert.equal(await cache.get("safe"), undefined);
  assert.equal(eventBus.publishCalls, 1);
});

test("negative caching avoids repeated loaders for known misses", async () => {
  const cache = createCache({
    negativeCache: {
      ttlMs: 1_000,
    },
  });
  let calls = 0;

  assert.equal(await cache.getOrSet("missing", async () => {
    calls += 1;
    return undefined;
  }), undefined);
  assert.equal(await cache.getOrSet("missing", async () => {
    calls += 1;
    return "should-not-run";
  }), undefined);

  assert.equal(calls, 1);
});

test("fail-safe returns stale value when loader fails", async () => {
  const cache = createCache({
    levels: {
      L1: {
        ttlMs: 5,
      },
    },
    failSafe: {
      enabled: true,
      staleTtlMs: 1_000,
    },
  });

  await cache.set("profile", "old");
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(await cache.getOrSet("profile", async () => {
    throw new Error("db down");
  }), "old");
});

test("soft timeout returns stale value", async () => {
  const cache = createCache({
    levels: {
      L1: {
        ttlMs: 5,
      },
    },
    failSafe: {
      enabled: true,
      staleTtlMs: 1_000,
    },
    timeouts: {
      softMs: 5,
    },
  });

  await cache.set("profile", "old");
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(await cache.getOrSet("profile", async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return "new";
  }), "old");
});

test("emits observability events", async () => {
  const events = [];
  const cache = createCache({
    events: [
      (event) => {
        events.push(event.type);
      },
    ],
  });

  await cache.getOrSet("events", async () => "value");
  await cache.get("events");
  await cache.delete("events");

  assert.equal(events.includes("loader:start"), true);
  assert.equal(events.includes("loader:success"), true);
  assert.equal(events.includes("hit"), true);
  assert.equal(events.includes("delete"), true);
});

test("distributed lock prevents cross-instance duplicate loaders", async () => {
  class LockingStore extends MemoryStore {
    locks = new Map();

    async acquireLock(key, token) {
      if (this.locks.has(key)) {
        return false;
      }

      this.locks.set(key, token);
      return true;
    }

    async releaseLock(key, token) {
      if (this.locks.get(key) === token) {
        this.locks.delete(key);
      }
    }
  }

  const l2 = new LockingStore();
  const cacheA = new HybridCache({
    l2,
    distributedLock: {
      enabled: true,
      waitTimeoutMs: 100,
      pollMs: 5,
    },
  });
  const cacheB = new HybridCache({
    l2,
    distributedLock: {
      enabled: true,
      waitTimeoutMs: 100,
      pollMs: 5,
    },
  });
  let calls = 0;

  const [a, b] = await Promise.all([
    cacheA.getOrSet("shared", async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "value";
    }),
    cacheB.getOrSet("shared", async () => {
      calls += 1;
      return "duplicate";
    }),
  ]);

  assert.equal(a, "value");
  assert.equal(b, "value");
  assert.equal(calls, 1);
});

test("versioning writes new generations after deletes", async () => {
  const l2 = new MemoryStore();
  const cache = new HybridCache({
    l2,
    versioning: {
      enabled: true,
    },
  });

  await cache.set("item", "v0");
  await cache.delete("item");
  await cache.set("item", "v1");

  assert.equal(await l2.get("item::v0"), undefined);
  assert.equal(await l2.get("item::v1"), "v1");
  assert.equal(await cache.get("item"), "v1");
});

test("dedupes invalidation events by id", async () => {
  let handler;
  const eventBus = {
    async publish() {},
    async subscribe(next) {
      handler = next;
    },
  };
  const events = [];
  const cache = new HybridCache({
    eventBus,
    source: "local",
    events: [
      (event) => {
        events.push(event.type);
      },
    ],
  });

  await new Promise((resolve) => setImmediate(resolve));
  await cache.set("dup", "value");
  await handler({
    id: "same-event",
    type: "del",
    keys: ["dup"],
    source: "remote",
    ts: Date.now(),
  });
  await cache.set("dup", "value-again");
  await handler({
    id: "same-event",
    type: "del",
    keys: ["dup"],
    source: "remote",
    ts: Date.now(),
  });

  assert.equal(await cache.get("dup"), "value-again");
  assert.equal(events.includes("invalidation:duplicate"), true);
});

test("nats jetstream mode requires a durable consumer name", async () => {
  const eventBus = new NatsEventBus({
    mode: "jetstream",
  });

  await assert.rejects(
    eventBus.subscribe(async () => {}),
    /durableName/,
  );
});

test("nats core mode can use an injected connection", async () => {
  let published = false;
  const connection = {
    isClosed() {
      return false;
    },
    getServer() {
      return "test-nats";
    },
    publish(subject, payload) {
      published = subject === "cache.invalidations" && payload instanceof Uint8Array;
    },
    async flush() {},
  };
  const eventBus = new NatsEventBus({
    connection,
  });

  await eventBus.publish({
    id: "nats-test",
    type: "del",
    keys: ["a"],
    source: "test",
    ts: Date.now(),
  });

  assert.equal(published, true);
});

test("nats core mode preflight connect checks the injected connection", async () => {
  let flushed = false;
  const connection = {
    isClosed() {
      return false;
    },
    getServer() {
      return "test-nats";
    },
    async flush() {
      flushed = true;
    },
  };
  const eventBus = new NatsEventBus({
    connection,
  });

  await eventBus.connect();
  const health = await eventBus.healthCheck();

  assert.equal(flushed, true);
  assert.equal(health.ok, true);
  assert.equal(health.server, "test-nats");
});

test("nats jetstream health check reports missing durable name before network connection", async () => {
  const eventBus = new NatsEventBus({
    mode: "jetstream",
  });
  const health = await eventBus.healthCheck();

  assert.equal(health.ok, false);
  assert.match(String(health.error), /durableName/);
});

test("redis event bus health checks publisher and subscriber", async () => {
  const client = {
    status: "ready",
    duplicate() {
      return {
        status: "ready",
        async ping() {
          return "PONG";
        },
        async subscribe() {},
        on() {},
        disconnect() {},
      };
    },
    async ping() {
      return "PONG";
    },
    async publish() {
      return 1;
    },
    disconnect() {},
  };
  const eventBus = new RedisEventBus(client, "cache:invalidations");
  const health = await eventBus.healthCheck();

  assert.equal(health.ok, true);
  assert.equal(health.transport, "redis");
  assert.equal(health.channel, "cache:invalidations");
});

test("rabbitmq health reports missing url before initialization", async () => {
  const eventBus = new RabbitMQEventBus("cache.invalidations");
  const health = await eventBus.healthCheck();

  assert.equal(health.ok, false);
  assert.equal(health.transport, "rabbitmq");
  assert.match(String(health.error), /URL/);
});

test("production logging option suppresses cache logs", async () => {
  const originalLog = console.log;
  let calls = 0;

  console.log = () => {
    calls += 1;
  };

  try {
    const cache = createCache({
      logging: {
        env: "production",
      },
    });

    await cache.set("quiet", "value");
    await cache.get("quiet");
  } finally {
    console.log = originalLog;
  }

  assert.equal(calls, 0);
});

test("development logging option enables cache logs", async () => {
  const originalLog = console.log;
  let calls = 0;

  console.log = () => {
    calls += 1;
  };

  try {
    const cache = createCache({
      logging: {
        env: "development",
      },
    });

    await cache.set("loud", "value");
  } finally {
    console.log = originalLog;
  }

  assert.equal(calls > 0, true);
});

test("createCache returns a LazyLayersCache compatibility instance", () => {
  const cache = createCache();

  assert.equal(cache instanceof LazyLayersCache, true);
  assert.equal(cache instanceof HybridCache, true);
});

test("LazyLayersCache defaults to L1 only when L2 is not provided", async () => {
  const events = [];
  const cache = new LazyLayersCache({
    logging: {
      env: "production",
    },
    events: [(event) => events.push(event)],
  });

  await cache.set("local", "value");

  assert.equal(await cache.get("local"), "value");
  assert.equal(await cache.size(), 1);
  assert.deepEqual(events.find((event) => event.type === "set")?.levels, ["L1"]);
});

test("LazyLayersCache can explicitly disable L2 with l2 false", async () => {
  const cache = new LazyLayersCache({
    l2: false,
    logging: {
      env: "production",
    },
  });

  await cache.set("local-only", "value");

  assert.equal(await cache.get("local-only"), "value");
  assert.equal(await cache.size(), 1);
});

test("LazyLayersCache can explicitly disable L1 and use only L2", async () => {
  const l2 = new MemoryStore();
  const events = [];
  const cache = new LazyLayersCache({
    l1: false,
    l2,
    logging: {
      env: "production",
    },
    events: [(event) => events.push(event)],
  });

  await cache.set("remote-only", "value");

  assert.equal(await cache.get("remote-only"), "value");
  assert.equal(await cache.has("remote-only"), true);
  assert.equal(await cache.size(), 1);
  assert.deepEqual(events.find((event) => event.type === "set")?.levels, ["L2"]);
});

test("LazyLayersCache with both layers disabled does not retain values", async () => {
  const cache = new LazyLayersCache({
    l1: false,
    l2: false,
    logging: {
      env: "production",
    },
  });

  await cache.set("disabled", "value");

  assert.equal(await cache.get("disabled"), undefined);
  assert.equal(await cache.has("disabled"), false);
  assert.equal(await cache.size(), 0);
});

function createSharedEventBus() {
  const handlers = new Set();
  const published = [];

  return {
    published,
    async publish(event) {
      published.push(event);

      for (const handler of handlers) {
        await handler(event);
      }
    },
    async subscribe(handler) {
      handlers.add(handler);
    },
  };
}

test("getOrSet broadcasts loader result so peer instances populate L1 without rerunning the loader", async () => {
  const eventBus = createSharedEventBus();
  let loaderCallsA = 0;
  let loaderCallsB = 0;

  const cacheA = new HybridCache({
    eventBus,
    source: "instance-a",
    logging: { env: "production" },
  });
  const cacheB = new HybridCache({
    eventBus,
    source: "instance-b",
    logging: { env: "production" },
  });

  await new Promise((resolve) => setImmediate(resolve));

  const value = await cacheA.getOrSet("shared:1", async () => {
    loaderCallsA += 1;
    return { id: 1, name: "Amonk" };
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(value, { id: 1, name: "Amonk" });
  assert.equal(loaderCallsA, 1);

  const broadcastEvent = eventBus.published.find((event) => event.type === "set");
  assert.ok(broadcastEvent, "expected a 'set' invalidation event");
  assert.deepEqual(broadcastEvent.keys, ["shared:1"]);

  const valueOnB = await cacheB.getOrSet("shared:1", async () => {
    loaderCallsB += 1;
    return { id: 1, name: "Different" };
  });

  assert.deepEqual(valueOnB, { id: 1, name: "Amonk" });
  assert.equal(loaderCallsB, 0);
});

test("getOrSet broadcast can be disabled via broadcastSet=false", async () => {
  const eventBus = createSharedEventBus();
  const cache = new HybridCache({
    eventBus,
    source: "instance-a",
    broadcastSet: false,
    logging: { env: "production" },
  });

  await new Promise((resolve) => setImmediate(resolve));
  await cache.getOrSet("solo:1", async () => "value");

  assert.equal(
    eventBus.published.find((event) => event.type === "set"),
    undefined,
  );
});

test("direct set() calls do not broadcast set events", async () => {
  const eventBus = createSharedEventBus();
  const cache = new HybridCache({
    eventBus,
    source: "instance-a",
    logging: { env: "production" },
  });

  await new Promise((resolve) => setImmediate(resolve));
  await cache.set("manual", "value");

  assert.equal(
    eventBus.published.find((event) => event.type === "set"),
    undefined,
  );
});

test("remote set events emit set:received and clear negative cache", async () => {
  let handler;
  const eventBus = {
    async publish() {},
    async subscribe(next) {
      handler = next;
    },
  };
  const received = [];
  const cache = new HybridCache({
    eventBus,
    source: "local",
    negativeCache: { ttlMs: 1_000 },
    logging: { env: "production" },
    events: [(event) => received.push(event)],
  });

  await new Promise((resolve) => setImmediate(resolve));
  await cache.getOrSet("post:1", async () => undefined);

  assert.equal(await cache.get("post:1"), undefined);

  await handler({
    id: "remote-set-1",
    type: "set",
    keys: ["post:1"],
    value: { title: "remote" },
    ttlMs: 60_000,
    source: "remote",
    ts: Date.now(),
  });

  assert.deepEqual(await cache.get("post:1"), { title: "remote" });
  assert.equal(received.some((event) => event.type === "set:received"), true);
});

test("remote set events with older generations are ignored after a delete", async () => {
  let handler;
  const eventBus = {
    async publish() {},
    async subscribe(next) {
      handler = next;
    },
  };
  const events = [];
  const cache = new HybridCache({
    eventBus,
    source: "local",
    logging: { env: "production" },
    events: [(event) => events.push(event)],
  });

  await new Promise((resolve) => setImmediate(resolve));
  await cache.set("race:1", "current");
  await cache.delete("race:1");

  await handler({
    id: "late-set-older-generation",
    type: "set",
    keys: ["race:1"],
    value: "stale",
    source: "remote",
    ts: Date.now(),
    generation: 0,
  });

  assert.equal(await cache.get("race:1"), undefined);
  assert.equal(events.some((event) => event.type === "invalidation:stale"), true);
});

test("remote deletes advance to their generation before later remote sets are accepted", async () => {
  let handler;
  const eventBus = {
    async publish() {},
    async subscribe(next) {
      handler = next;
    },
  };
  const cache = new HybridCache({
    eventBus,
    source: "local",
    logging: { env: "production" },
  });

  await new Promise((resolve) => setImmediate(resolve));
  await cache.set("race:2", "before-delete");

  await handler({
    id: "remote-delete-generation-3",
    type: "del",
    keys: ["race:2"],
    source: "remote",
    ts: Date.now(),
    generation: 3,
  });

  await handler({
    id: "remote-set-generation-2",
    type: "set",
    keys: ["race:2"],
    value: "stale",
    source: "remote",
    ts: Date.now(),
    generation: 2,
  });

  assert.equal(await cache.get("race:2"), undefined);

  await handler({
    id: "remote-set-generation-3",
    type: "set",
    keys: ["race:2"],
    value: "fresh",
    source: "remote",
    ts: Date.now(),
    generation: 3,
  });

  assert.equal(await cache.get("race:2"), "fresh");
});

test("getOrSet skips set broadcasts when the encoded payload exceeds broadcastSetMaxBytes", async () => {
  const eventBus = createSharedEventBus();
  const events = [];
  const cache = new HybridCache({
    eventBus,
    source: "instance-a",
    broadcastSetMaxBytes: 1,
    logging: { env: "production" },
    events: [(event) => events.push(event)],
  });

  await new Promise((resolve) => setImmediate(resolve));

  const value = "x".repeat(2048);

  assert.equal(await cache.getOrSet("big:1", async () => value), value);
  assert.equal(await cache.get("big:1"), value);
  assert.equal(eventBus.published.some((event) => event.type === "set"), false);
  assert.equal(events.some((event) => event.type === "set:broadcast-skipped"), true);
});

test("remote set events from self source are ignored", async () => {
  let handler;
  const eventBus = {
    async publish() {},
    async subscribe(next) {
      handler = next;
    },
  };
  const cache = new HybridCache({
    eventBus,
    source: "self",
    logging: { env: "production" },
  });

  await new Promise((resolve) => setImmediate(resolve));
  await cache.set("loop:1", "original");

  await handler({
    id: "self-set-1",
    type: "set",
    keys: ["loop:1"],
    value: "hijacked",
    source: "self",
    ts: Date.now(),
  });

  assert.equal(await cache.get("loop:1"), "original");
});
