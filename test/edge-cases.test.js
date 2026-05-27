import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "production";

const {
  HybridCache,
  LazyLayersCache,
  MemoryStore,
  RedisEventBus,
  RedisStore,
  createCache,
  serialize,
} = await import("../dist/index.js");

const quiet = { logging: { env: "production" } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 250) {
  const expiresAt = Date.now() + timeoutMs;

  while (Date.now() < expiresAt) {
    if (predicate()) {
      return;
    }

    await sleep(1);
  }

  assert.fail("timed out waiting for condition");
}

function patternToRegex(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

function sortedEntries(map) {
  return [...map.entries()].sort((a, b) => a[1] - b[1]);
}

class FakePipeline {
  constructor(redis) {
    this.redis = redis;
    this.ops = [];
  }

  set(...args) {
    this.ops.push(["set", args]);
    return this;
  }

  zadd(...args) {
    this.ops.push(["zadd", args]);
    return this;
  }

  zrem(...args) {
    this.ops.push(["zrem", args]);
    return this;
  }

  del(...args) {
    this.ops.push(["del", args]);
    return this;
  }

  unlink(...args) {
    this.ops.push(["unlink", args]);
    return this;
  }

  async exec() {
    const results = [];

    for (const [op, args] of this.ops) {
      results.push([null, await this.redis[op](...args)]);
    }

    return results;
  }
}

class FakeRedis {
  constructor() {
    this.status = "ready";
    this.values = new Map();
    this.zsets = new Map();
    this.deletedBy = [];
    this.published = [];
    this.listeners = new Map();
  }

  pipeline() {
    return new FakePipeline(this);
  }

  duplicate() {
    return this;
  }

  async ping() {
    return "PONG";
  }

  async publish(channel, message) {
    this.published.push({ channel, message });
    return 1;
  }

  async subscribe() {}
  async unsubscribe() {}
  on(event, handler) {
    this.listeners.set(event, handler);
  }
  disconnect() {}

  emitMessage(channel, event) {
    const handler = this.listeners.get("messageBuffer");

    if (handler) {
      handler(Buffer.from(channel), serialize(event));
    }
  }

  async set(key, value, px, ttlMs, nx) {
    this.pruneKey(key);

    if (nx === "NX" && this.values.has(key)) {
      return null;
    }

    const expiresAt = px === "PX" && typeof ttlMs === "number" ? Date.now() + ttlMs : undefined;
    this.values.set(key, { value, expiresAt });
    return "OK";
  }

  async getBuffer(key) {
    this.pruneKey(key);
    const entry = this.values.get(key);

    if (!entry) {
      return null;
    }

    return Buffer.isBuffer(entry.value) ? entry.value : Buffer.from(String(entry.value));
  }

  async exists(key) {
    this.pruneKey(key);
    return this.values.has(key) ? 1 : 0;
  }

  async del(...keys) {
    this.deletedBy.push("del");
    let deleted = 0;

    for (const key of keys) {
      deleted += this.values.delete(key) ? 1 : 0;
      this.removeMemberFromAllIndexes(key);
    }

    return deleted;
  }

  async unlink(...keys) {
    this.deletedBy.push("unlink");
    return this.del(...keys);
  }

  async zadd(indexKey, score, member) {
    const set = this.zsets.get(indexKey) ?? new Map();
    set.set(member, Number(score));
    this.zsets.set(indexKey, set);
    return 1;
  }

  async zrem(indexKey, ...members) {
    const set = this.zsets.get(indexKey);
    let removed = 0;

    if (!set) {
      return removed;
    }

    for (const member of members) {
      removed += set.delete(member) ? 1 : 0;
    }

    return removed;
  }

  async zcard(indexKey) {
    return this.zsets.get(indexKey)?.size ?? 0;
  }

  async zrange(indexKey, start, end) {
    const members = sortedEntries(this.zsets.get(indexKey) ?? new Map()).map(([member]) => member);
    const last = end < 0 ? members.length + end : end;

    return members.slice(start, last + 1);
  }

  zscanStream(indexKey, { match }) {
    const regex = patternToRegex(match);
    const entries = sortedEntries(this.zsets.get(indexKey) ?? new Map())
      .filter(([member]) => regex.test(member))
      .flatMap(([member, score]) => [member, String(score)]);

    return asyncGenerator(entries.length ? [entries] : []);
  }

  scanStream({ match }) {
    const regex = patternToRegex(match);
    const keys = [...this.values.keys()].filter((key) => {
      this.pruneKey(key);
      return this.values.has(key) && regex.test(key);
    });

    return asyncGenerator(keys.length ? [keys] : []);
  }

  async eval(_script, _keyCount, key, token) {
    this.pruneKey(key);
    const entry = this.values.get(key);

    if (entry && String(entry.value) === token) {
      this.values.delete(key);
      return 1;
    }

    return 0;
  }

  pruneKey(key) {
    const entry = this.values.get(key);

    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.values.delete(key);
    }
  }

  removeMemberFromAllIndexes(member) {
    for (const set of this.zsets.values()) {
      set.delete(member);
    }
  }
}

async function* asyncGenerator(chunks) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function makeRedisStore(options = {}) {
  const redis = new FakeRedis();

  return {
    redis,
    store: new RedisStore(redis, {
      prefix: "edge:",
      logging: { env: "production" },
      ...options,
    }),
  };
}

const valueCases = [
  ["string", "value"],
  ["empty string", ""],
  ["number", 42],
  ["zero", 0],
  ["false", false],
  ["null", null],
  ["object", { id: 1, nested: { ok: true } }],
  ["array", [1, "two", { three: true }]],
  ["date string", "2026-04-30T00:00:00.000Z"],
  ["large payload", { text: "x".repeat(2048) }],
];

for (const [label, value] of valueCases) {
  test(`MemoryStore round-trips ${label}`, async () => {
    const cache = new MemoryStore({ ttlMs: 1_000 });

    await cache.set("key", value);

    assert.deepEqual(await cache.get("key"), value);
    assert.equal(await cache.has("key"), true);
  });
}

const memoryPatternCases = [
  ["*", ["user:1", "user:2", "post:1"], []],
  ["user:*", ["user:1", "user:2"], ["post:1"]],
  ["*:1", ["user:1", "post:1"], ["user:2"]],
  ["user:?", [], ["user:1", "user:2", "post:1"]],
  ["literal.+", ["literal.+"], ["literal-x"]],
  ["prefix*suffix", ["prefix-middle-suffix"], ["prefix-middle-other"]],
  ["no-match:*", [], ["user:1", "user:2", "post:1"]],
  ["order:*", ["order:1", "order:2"], ["order-item:1"]],
];

for (const [pattern, removed, kept] of memoryPatternCases) {
  test(`MemoryStore deleteByPattern handles ${pattern}`, async () => {
    const cache = new MemoryStore({ ttlMs: 1_000 });
    const keys = [...new Set([...removed, ...kept])];

    for (const key of keys) {
      await cache.set(key, key);
    }

    await cache.deleteByPattern(pattern);

    for (const key of removed) {
      assert.equal(await cache.get(key), undefined);
    }

    for (const key of kept) {
      assert.equal(await cache.get(key), key);
    }
  });
}

const maxEntryCases = [
  [1, ["a", "b"], ["b"]],
  [2, ["a", "b", "c"], ["b", "c"]],
  [3, ["a", "b", "c", "d"], ["b", "c", "d"]],
  [5, ["a", "b", "c"], ["a", "b", "c"]],
];

for (const [maxEntries, keys, expected] of maxEntryCases) {
  test(`MemoryStore keeps newest ${maxEntries} entries`, async () => {
    const cache = new MemoryStore({ levels: { L1: { maxEntries } } });

    for (const key of keys) {
      await cache.set(key, key);
    }

    assert.equal(await cache.size(), expected.length);

    for (const key of keys) {
      assert.equal(await cache.has(key), expected.includes(key));
    }
  });
}

test("MemoryStore per-call ttl overrides constructor ttl", async () => {
  const cache = new MemoryStore({ ttlMs: 1_000 });

  await cache.set("short", "value", { ttlMs: 5 });
  await sleep(15);

  assert.equal(await cache.get("short"), undefined);
});

test("MemoryStore level ttl overrides constructor ttl", async () => {
  const cache = new MemoryStore({ ttlMs: 1_000, levels: { L1: { ttlMs: 5 } } });

  await cache.set("level-short", "value");
  await sleep(15);

  assert.equal(await cache.get("level-short"), undefined);
});

test("MemoryStore default ttl keeps fresh values", async () => {
  const cache = new MemoryStore({ ttlMs: 1_000 });

  await cache.set("fresh", "value");

  assert.equal(await cache.get("fresh"), "value");
});

test("MemoryStore delete only removes one key", async () => {
  const cache = new MemoryStore();

  await cache.set("a", 1);
  await cache.set("b", 2);
  await cache.delete("a");

  assert.equal(await cache.get("a"), undefined);
  assert.equal(await cache.get("b"), 2);
});

test("MemoryStore clear removes all keys", async () => {
  const cache = new MemoryStore();

  await cache.set("a", 1);
  await cache.set("b", 2);
  await cache.clear();

  assert.equal(await cache.size(), 0);
});

test("MemoryStore getOrSet does not store undefined", async () => {
  const cache = new MemoryStore();

  assert.equal(await cache.getOrSet("missing", async () => undefined), undefined);
  assert.equal(await cache.has("missing"), false);
});

test("MemoryStore getOrSet reuses cached value", async () => {
  const cache = new MemoryStore();
  let calls = 0;

  assert.equal(await cache.getOrSet("same", async () => {
    calls += 1;
    return "first";
  }), "first");
  assert.equal(await cache.getOrSet("same", async () => {
    calls += 1;
    return "second";
  }), "first");
  assert.equal(calls, 1);
});

const layerModeCases = [
  ["default L1", {}, ["L1"], 1],
  ["explicit L2 off", { l2: false }, ["L1"], 1],
  ["L2 only", { l1: false, l2: new MemoryStore() }, ["L2"], 1],
  ["L1 plus L2", { l2: new MemoryStore() }, ["L1", "L2"], 1],
  ["no layers", { l1: false, l2: false }, [], 0],
];

for (const [label, options, levels, expectedSize] of layerModeCases) {
  test(`LazyLayersCache layer mode emits levels for ${label}`, async () => {
    const events = [];
    const cache = new LazyLayersCache({
      ...quiet,
      ...options,
      events: [(event) => events.push(event)],
    });

    await cache.set("key", "value");

    assert.deepEqual(events.find((event) => event.type === "set")?.levels, levels);
    assert.equal(await cache.size(), expectedSize);
  });
}

test("HybridCache promotes L2 hit into L1", async () => {
  const l2 = new MemoryStore();
  const cache = new HybridCache({ ...quiet, l2 });

  await l2.set("promote", "value");

  assert.equal(await cache.get("promote"), "value");
  await l2.delete("promote");
  assert.equal(await cache.get("promote"), "value");
});

test("HybridCache with L1 disabled does not promote L2 hits", async () => {
  const l2 = new MemoryStore();
  const cache = new HybridCache({ ...quiet, l1: false, l2 });

  await l2.set("remote", "value");

  assert.equal(await cache.get("remote"), "value");
  await l2.delete("remote");
  assert.equal(await cache.get("remote"), undefined);
});

test("HybridCache has checks L2 when L1 misses", async () => {
  const l2 = new MemoryStore();
  const cache = new HybridCache({ ...quiet, l2 });

  await l2.set("exists", "value");

  assert.equal(await cache.has("exists"), true);
});

test("HybridCache delete removes L1 and L2", async () => {
  const l2 = new MemoryStore();
  const cache = new HybridCache({ ...quiet, l2 });

  await cache.set("delete-me", "value");
  await cache.delete("delete-me");

  assert.equal(await cache.get("delete-me"), undefined);
  assert.equal(await l2.get("delete-me"), undefined);
});

test("HybridCache clear removes matching data from both layers", async () => {
  const l2 = new MemoryStore();
  const cache = new HybridCache({ ...quiet, l2 });

  await cache.set("a", 1);
  await cache.set("b", 2);
  await cache.clear();

  assert.equal(await cache.size(), 0);
  assert.equal(await l2.size(), 0);
});

test("HybridCache deleteByPattern keeps unrelated keys", async () => {
  const l2 = new MemoryStore();
  const cache = new HybridCache({ ...quiet, l2 });

  await cache.set("user:1", "a");
  await cache.set("post:1", "b");
  await cache.deleteByPattern("user:*");

  assert.equal(await cache.get("user:1"), undefined);
  assert.equal(await cache.get("post:1"), "b");
  assert.equal(await l2.get("user:1"), undefined);
  assert.equal(await l2.get("post:1"), "b");
});

test("HybridCache per-call ttl applies to getOrSet writes", async () => {
  const cache = new HybridCache({ ...quiet, ttlMs: 1_000 });

  await cache.getOrSet("short", async () => "value", { ttlMs: 5 });
  await sleep(15);

  assert.equal(await cache.get("short"), undefined);
});

test("HybridCache inflight disabled runs concurrent loaders", async () => {
  const cache = new HybridCache({ ...quiet, inflight: { enabled: false } });
  let calls = 0;

  const values = await Promise.all([
    cache.getOrSet("same", async () => {
      calls += 1;
      await sleep(5);
      return "a";
    }),
    cache.getOrSet("same", async () => {
      calls += 1;
      return "b";
    }),
  ]);

  assert.equal(calls, 2);
  assert.deepEqual(values.sort(), ["a", "b"]);
});

test("HybridCache expired inflight starts a new loader", async () => {
  const cache = new HybridCache({ ...quiet, inflight: { ttlMs: 1, maxEntries: 10 } });
  let releaseFirst;
  let calls = 0;

  const first = cache.getOrSet("slow", async () => {
    calls += 1;
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    return "first";
  });

  await sleep(5);
  const second = cache.getOrSet("slow", async () => {
    calls += 1;
    return "second";
  });

  releaseFirst();

  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(calls, 2);
});

test("HybridCache negative cache can be disabled per instance", async () => {
  const cache = new HybridCache({ ...quiet, negativeCache: { enabled: false, ttlMs: 1_000 } });
  let calls = 0;

  await cache.getOrSet("missing", async () => {
    calls += 1;
    return undefined;
  });
  await cache.getOrSet("missing", async () => {
    calls += 1;
    return undefined;
  });

  assert.equal(calls, 2);
});

test("HybridCache negative cache expires", async () => {
  const cache = new HybridCache({ ...quiet, negativeCache: { ttlMs: 5 } });
  let calls = 0;

  await cache.getOrSet("missing", async () => {
    calls += 1;
    return undefined;
  });
  await sleep(15);
  await cache.getOrSet("missing", async () => {
    calls += 1;
    return undefined;
  });

  assert.equal(calls, 2);
});

test("HybridCache negative cache maxEntries evicts oldest miss", async () => {
  const cache = new HybridCache({ ...quiet, negativeCache: { ttlMs: 1_000, maxEntries: 1 } });
  let calls = 0;

  await cache.getOrSet("missing:1", async () => {
    calls += 1;
    return undefined;
  });
  await cache.getOrSet("missing:2", async () => {
    calls += 1;
    return undefined;
  });
  await cache.getOrSet("missing:1", async () => {
    calls += 1;
    return undefined;
  });

  assert.equal(calls, 3);
});

test("HybridCache delete clears negative cache for key", async () => {
  const cache = new HybridCache({ ...quiet, negativeCache: { ttlMs: 1_000 } });
  let calls = 0;

  await cache.getOrSet("missing", async () => {
    calls += 1;
    return undefined;
  });
  await cache.delete("missing");
  await cache.getOrSet("missing", async () => {
    calls += 1;
    return "value";
  });

  assert.equal(calls, 2);
  assert.equal(await cache.get("missing"), "value");
});

test("HybridCache deleteByPattern clears matching negative entries", async () => {
  const cache = new HybridCache({ ...quiet, negativeCache: { ttlMs: 1_000 } });
  let calls = 0;

  await cache.getOrSet("missing:1", async () => {
    calls += 1;
    return undefined;
  });
  await cache.deleteByPattern("missing:*");
  await cache.getOrSet("missing:1", async () => {
    calls += 1;
    return "value";
  });

  assert.equal(calls, 2);
});

test("HybridCache loader error throws without failSafe", async () => {
  const cache = new HybridCache({ ...quiet });

  await assert.rejects(
    cache.getOrSet("error", async () => {
      throw new Error("loader failed");
    }),
    /loader failed/,
  );
});

test("HybridCache stale entry expires after failSafe ttl", async () => {
  const cache = new HybridCache({
    ...quiet,
    levels: { L1: { ttlMs: 5 } },
    failSafe: { enabled: true, staleTtlMs: 5 },
  });

  await cache.set("profile", "old");
  await sleep(20);

  await assert.rejects(
    cache.getOrSet("profile", async () => {
      throw new Error("db down");
    }),
    /db down/,
  );
});

test("HybridCache hard timeout rejects without stale", async () => {
  const cache = new HybridCache({ ...quiet, timeouts: { hardMs: 5 } });

  await assert.rejects(
    cache.getOrSet("slow", async () => {
      await sleep(30);
      return "late";
    }),
    /hard-timeout/,
  );
});

test("HybridCache hard timeout returns stale when failSafe has stale", async () => {
  const cache = new HybridCache({
    ...quiet,
    levels: { L1: { ttlMs: 5 } },
    failSafe: { enabled: true, staleTtlMs: 1_000 },
    timeouts: { hardMs: 5 },
  });

  await cache.set("slow", "old");
  await sleep(15);

  assert.equal(await cache.getOrSet("slow", async () => {
    await sleep(30);
    return "late";
  }), "old");
});

test("HybridCache loader receives abort signal", async () => {
  const cache = new HybridCache({ ...quiet, timeouts: { hardMs: 5 } });
  let signalSeen = false;

  await assert.rejects(
    cache.getOrSet("signal", async ({ signal }) => {
      signalSeen = signal instanceof AbortSignal;
      await sleep(30);
      return "late";
    }),
    /hard-timeout/,
  );

  assert.equal(signalSeen, true);
});

test("HybridCache event handler errors do not break operations", async () => {
  const cache = new HybridCache({
    ...quiet,
    events: [
      () => {
        throw new Error("metrics down");
      },
    ],
  });

  await cache.set("safe", "value");

  assert.equal(await cache.get("safe"), "value");
});

test("HybridCache ignores invalidation events from same source", async () => {
  let handler;
  const eventBus = {
    async publish() {},
    async subscribe(next) {
      handler = next;
    },
  };
  const cache = new HybridCache({ ...quiet, eventBus, source: "self" });

  await sleep(0);
  await cache.set("self-key", "value");
  await handler({ type: "del", keys: ["self-key"], source: "self", ts: Date.now() });

  assert.equal(await cache.get("self-key"), "value");
});

test("HybridCache applies remote delete invalidation", async () => {
  let handler;
  const eventBus = {
    async publish() {},
    async subscribe(next) {
      handler = next;
    },
  };
  const cache = new HybridCache({ ...quiet, eventBus, source: "local" });

  await sleep(0);
  await cache.set("remote-key", "value");
  await handler({ id: "delete-1", type: "del", keys: ["remote-key"], source: "remote", ts: Date.now() });

  assert.equal(await cache.get("remote-key"), undefined);
});

test("HybridCache applies remote pattern invalidation", async () => {
  let handler;
  const eventBus = {
    async publish() {},
    async subscribe(next) {
      handler = next;
    },
  };
  const cache = new HybridCache({ ...quiet, eventBus, source: "local" });

  await sleep(0);
  await cache.set("user:1", "a");
  await cache.set("post:1", "b");
  await handler({ id: "pattern-1", type: "pattern", pattern: "user:*", source: "remote", ts: Date.now() });

  assert.equal(await cache.get("user:1"), undefined);
  assert.equal(await cache.get("post:1"), "b");
});

test("HybridCache can skip event subscription", async () => {
  let subscribed = false;
  const eventBus = {
    async publish() {},
    async subscribe() {
      subscribed = true;
    },
  };

  new HybridCache({ ...quiet, eventBus, subscribeToEvents: false });
  await sleep(0);

  assert.equal(subscribed, false);
});

test("HybridCache publishes delete invalidations", async () => {
  const published = [];
  const eventBus = {
    async publish(event) {
      published.push(event);
    },
    async subscribe() {},
  };
  const cache = new HybridCache({ ...quiet, eventBus, source: "local" });

  await cache.delete("key");

  assert.equal(published[0].type, "del");
  assert.deepEqual(published[0].keys, ["key"]);
  assert.equal(published[0].source, "local");
});

test("HybridCache publishes pattern invalidations", async () => {
  const published = [];
  const eventBus = {
    async publish(event) {
      published.push(event);
    },
    async subscribe() {},
  };
  const cache = new HybridCache({ ...quiet, eventBus, source: "local" });

  await cache.deleteByPattern("user:*");

  assert.equal(published[0].type, "pattern");
  assert.equal(published[0].pattern, "user:*");
});

test("HybridCache event bus publish circuit opens after failure", async () => {
  const events = [];
  const eventBus = {
    async publish() {
      throw new Error("bus down");
    },
    async subscribe() {},
  };
  const cache = new HybridCache({
    ...quiet,
    eventBus,
    events: [(event) => events.push(event.type)],
    resilience: { eventBusCircuitBreaker: { failureThreshold: 1, cooldownMs: 10_000 } },
  });

  await cache.delete("a");
  await cache.delete("b");

  assert.equal(events.includes("event-bus:publish-error"), true);
  assert.equal(events.includes("event-bus:publish-skipped"), true);
});

test("HybridCache L2 circuit emits skipped after opening", async () => {
  const events = [];
  const failingL2 = {
    async set() {
      throw new Error("l2 down");
    },
    async get() {
      throw new Error("l2 down");
    },
    async getOrSet() {},
    async has() {
      throw new Error("l2 down");
    },
    async delete() {},
    async deleteByPattern() {},
    async clear() {},
    async size() {
      return 0;
    },
  };
  const cache = new HybridCache({
    ...quiet,
    l1: false,
    l2: failingL2,
    events: [(event) => events.push(event.type)],
    resilience: { l2CircuitBreaker: { failureThreshold: 1, cooldownMs: 10_000 } },
  });

  await cache.set("a", "value");
  await cache.get("a");

  assert.equal(events.includes("l2:error"), true);
  assert.equal(events.includes("l2:skipped"), true);
});

test("HybridCache versioning leaves old L2 generation unread", async () => {
  const l2 = new MemoryStore();
  const cache = new HybridCache({ ...quiet, l2, versioning: { enabled: true } });

  await cache.set("item", "v0");
  await cache.delete("item");
  await l2.set("item::v0", "stale");

  assert.equal(await cache.get("item"), undefined);
});

test("HybridCache clear bumps generation through pattern delete", async () => {
  const l2 = new MemoryStore();
  const cache = new HybridCache({ ...quiet, l2, versioning: { enabled: true } });

  await cache.set("item", "v0");
  await cache.clear();
  await cache.set("item", "v1");

  assert.equal(await cache.get("item"), "v1");
});

test("createCache accepts default generics and stores mixed values at runtime", async () => {
  const cache = createCache(quiet);

  await cache.set("number", 1);
  await cache.set("object", { ok: true });

  assert.equal(await cache.get("number"), 1);
  assert.deepEqual(await cache.get("object"), { ok: true });
});

for (const [label, value] of valueCases) {
  test(`RedisStore round-trips ${label}`, async () => {
    const { store } = makeRedisStore({ ttlMs: 1_000 });

    await store.set("key", value);

    assert.deepEqual(await store.get("key"), value);
  });
}

test("RedisStore returns undefined for missing key and removes stale index member", async () => {
  const { redis, store } = makeRedisStore();

  await redis.zadd("edge:__index", Date.now(), "edge:missing");

  assert.equal(await store.get("missing"), undefined);
  assert.equal(await redis.zcard("edge:__index"), 0);
});

test("RedisStore per-call ttl overrides constructor ttl", async () => {
  const { store } = makeRedisStore({ ttlMs: 1_000 });

  await store.set("short", "value", { ttlMs: 5 });
  await sleep(15);

  assert.equal(await store.get("short"), undefined);
});

test("RedisStore L2 level ttl overrides global ttl", async () => {
  const { store } = makeRedisStore({ ttlMs: 1_000, levels: { L2: { ttlMs: 5 } } });

  await store.set("short", "value");
  await sleep(15);

  assert.equal(await store.get("short"), undefined);
});

test("RedisStore has uses prefixed key", async () => {
  const { redis, store } = makeRedisStore();

  await store.set("exists", "value");

  assert.equal(await redis.exists("edge:exists"), 1);
  assert.equal(await store.has("exists"), true);
});

test("RedisStore getOrSet stores loader result", async () => {
  const { store } = makeRedisStore();
  let calls = 0;

  assert.equal(await store.getOrSet("lazy", async () => {
    calls += 1;
    return "value";
  }), "value");
  assert.equal(await store.getOrSet("lazy", async () => {
    calls += 1;
    return "other";
  }), "value");
  assert.equal(calls, 1);
});

test("RedisStore getOrSet does not store undefined", async () => {
  const { store } = makeRedisStore();

  assert.equal(await store.getOrSet("missing", async () => undefined), undefined);
  assert.equal(await store.has("missing"), false);
});

const redisPatternCases = [
  ["user:*", ["user:1", "user:2"], ["post:1"]],
  ["*:1", ["user:1", "post:1"], ["user:2"]],
  ["literal.+", ["literal.+"], ["literal-x"]],
  ["prefix*suffix", ["prefix-middle-suffix"], ["prefix-middle-other"]],
  ["*", ["a", "b", "c"], []],
];

for (const [pattern, removed, kept] of redisPatternCases) {
  test(`RedisStore indexed deleteByPattern handles ${pattern}`, async () => {
    const { store } = makeRedisStore({ useIndex: true });
    const keys = [...new Set([...removed, ...kept])];

    for (const key of keys) {
      await store.set(key, key);
    }

    await store.deleteByPattern(pattern);

    for (const key of removed) {
      assert.equal(await store.get(key), undefined);
    }

    for (const key of kept) {
      assert.equal(await store.get(key), key);
    }
  });
}

for (const [pattern, removed, kept] of redisPatternCases.slice(0, 3)) {
  test(`RedisStore scan deleteByPattern handles ${pattern} without index`, async () => {
    const { store } = makeRedisStore({ useIndex: false });
    const keys = [...new Set([...removed, ...kept])];

    for (const key of keys) {
      await store.set(key, key);
    }

    await store.deleteByPattern(pattern);

    for (const key of removed) {
      assert.equal(await store.get(key), undefined);
    }

    for (const key of kept) {
      assert.equal(await store.get(key), key);
    }
  });
}

test("RedisStore maxEntries trims oldest indexed values", async () => {
  const { store } = makeRedisStore({ levels: { L2: { maxEntries: 2 } } });

  await store.set("a", "a");
  await sleep(1);
  await store.set("b", "b");
  await sleep(1);
  await store.set("c", "c");

  assert.equal(await store.get("a"), undefined);
  assert.equal(await store.get("b"), "b");
  assert.equal(await store.get("c"), "c");
});

test("RedisStore deleteStrategy del uses DEL path", async () => {
  const { redis, store } = makeRedisStore({ deleteStrategy: "del" });

  await store.set("a", "a");
  await store.delete("a");

  assert.equal(redis.deletedBy.includes("del"), true);
});

test("RedisStore default deleteStrategy uses UNLINK path", async () => {
  const { redis, store } = makeRedisStore();

  await store.set("a", "a");
  await store.delete("a");

  assert.equal(redis.deletedBy.includes("unlink"), true);
});

test("RedisStore clear removes all prefixed keys", async () => {
  const { store } = makeRedisStore();

  await store.set("a", "a");
  await store.set("b", "b");
  await store.clear();

  assert.equal(await store.get("a"), undefined);
  assert.equal(await store.get("b"), undefined);
});

test("RedisStore size uses index when enabled", async () => {
  const { store } = makeRedisStore({ useIndex: true });

  await store.set("a", "a");
  await store.set("b", "b");

  assert.equal(await store.size(), 2);
});

test("RedisStore size scans keys when index is disabled", async () => {
  const { store } = makeRedisStore({ useIndex: false });

  await store.set("a", "a");
  await store.set("b", "b");

  assert.equal(await store.size(), 2);
});

test("RedisStore acquireLock succeeds once per key", async () => {
  const { store } = makeRedisStore();

  assert.equal(await store.acquireLock("lock", "token-1", 1_000), true);
  assert.equal(await store.acquireLock("lock", "token-2", 1_000), false);
});

test("RedisStore releaseLock releases matching token only", async () => {
  const { store } = makeRedisStore();

  await store.acquireLock("lock", "token-1", 1_000);
  await store.releaseLock("lock", "wrong");
  assert.equal(await store.acquireLock("lock", "token-2", 1_000), false);

  await store.releaseLock("lock", "token-1");
  assert.equal(await store.acquireLock("lock", "token-2", 1_000), true);
});

test("RedisStore lock expires by ttl", async () => {
  const { store } = makeRedisStore();

  assert.equal(await store.acquireLock("lock", "token-1", 5), true);
  await sleep(15);
  assert.equal(await store.acquireLock("lock", "token-2", 1_000), true);
});

test("RedisEventBus publishes encoded messages", async () => {
  const redis = new FakeRedis();
  const bus = new RedisEventBus(redis, "cache:invalidations", { logging: { env: "production" } });

  await bus.publish({ id: "1", type: "del", keys: ["a"], source: "test", ts: Date.now() });

  assert.equal(redis.published.length, 1);
  assert.equal(redis.published[0].channel, "cache:invalidations");
  assert.equal(Buffer.isBuffer(redis.published[0].message), true);
});

test("RedisEventBus subscribe ignores duplicate subscribe calls", async () => {
  let subscribeCalls = 0;
  const redis = new FakeRedis();
  redis.subscribe = async () => {
    subscribeCalls += 1;
  };
  const bus = new RedisEventBus(redis, "cache:invalidations", { logging: { env: "production" } });

  await bus.subscribe(() => {});
  await bus.subscribe(() => {});

  assert.equal(subscribeCalls, 1);
});

test("RedisEventBus processes subscribed messages with bounded handler concurrency", async () => {
  const redis = new FakeRedis();
  const bus = new RedisEventBus(redis, "cache:invalidations", {
    handlerConcurrency: 1,
    logging: { env: "production" },
  });
  const received = [];
  let active = 0;
  let maxActive = 0;

  await bus.subscribe(async (event) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(5);
    received.push(event.id);
    active -= 1;
  });

  redis.emitMessage("cache:invalidations", {
    id: "first",
    type: "del",
    keys: ["a"],
    source: "remote",
    ts: Date.now(),
  });
  redis.emitMessage("cache:invalidations", {
    id: "second",
    type: "del",
    keys: ["b"],
    source: "remote",
    ts: Date.now(),
  });

  await waitFor(() => received.length === 2);

  assert.deepEqual(received, ["first", "second"]);
  assert.equal(maxActive, 1);
});

test("EventBusRetryQueue caps queued events by default", async () => {
  const {
    DEFAULT_EVENT_BUS_RETRY_QUEUE_MAX_SIZE,
    EventBusRetryQueue,
  } = await import("../dist/event-bus/retryQueue.js");
  const queue = new EventBusRetryQueue();
  const flushed = [];

  for (let i = 0; i <= DEFAULT_EVENT_BUS_RETRY_QUEUE_MAX_SIZE; i += 1) {
    queue.enqueue({
      id: String(i),
      type: "del",
      keys: [String(i)],
      source: "test",
      ts: Date.now(),
    });
  }

  await queue.flush(async (event) => {
    flushed.push(event.id);
  });

  assert.equal(flushed.length, DEFAULT_EVENT_BUS_RETRY_QUEUE_MAX_SIZE);
  assert.equal(flushed[0], "1");
});

test("EventBusRetryQueue drops new events when maxSize is zero", async () => {
  const { EventBusRetryQueue } = await import("../dist/event-bus/retryQueue.js");
  const queue = new EventBusRetryQueue({ maxSize: 0 });
  const flushed = [];

  queue.enqueue({
    id: "dropped",
    type: "del",
    keys: ["a"],
    source: "test",
    ts: Date.now(),
  });

  await queue.flush(async (event) => {
    flushed.push(event.id);
  });

  assert.deepEqual(flushed, []);
});
