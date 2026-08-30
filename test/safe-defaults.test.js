import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "production";

const {
  CacheSetupError,
  CircuitBreaker,
  LazyLayersCache,
  ManagedLazyLayersCache,
  setupCache,
} = await import("../dist/index.js");

/**
 * These tests all construct the cache with as little configuration as possible.
 * That is the point: every protection below has to work for someone who has
 * read nothing but the install command.
 */

test("negative caching is on with no configuration", async () => {
  const cache = new LazyLayersCache({ ttlMs: 60_000 });
  let calls = 0;
  const missing = async () => {
    calls++;
    return undefined;
  };

  assert.equal(await cache.getOrSet("absent", missing), undefined);
  assert.equal(await cache.getOrSet("absent", missing), undefined);
  assert.equal(await cache.getOrSet("absent", missing), undefined);

  assert.equal(calls, 1, "a remembered miss must not re-run the loader");
});

test("negative caching can still be turned off deliberately", async () => {
  const cache = new LazyLayersCache({
    ttlMs: 60_000,
    negativeCache: { enabled: false },
  });
  let calls = 0;
  const missing = async () => {
    calls++;
    return undefined;
  };

  await cache.getOrSet("absent", missing);
  await cache.getOrSet("absent", missing);

  assert.equal(calls, 2, "opting out must restore the old behaviour");
});

test("fail-safe keeps a stale copy with no configuration", async () => {
  const cache = new LazyLayersCache({ levels: { L1: { ttlMs: 40 } } });

  assert.deepEqual(await cache.getOrSet("k", async () => ({ v: 1 })), { v: 1 });

  // Let L1 expire, then fail the loader. The stale copy should answer.
  await new Promise((r) => setTimeout(r, 60));

  const value = await cache.getOrSet("k", async () => {
    throw new Error("origin is down");
  });

  assert.deepEqual(value, { v: 1 }, "a dead origin must not surface as an error");
});

test("fail-safe can still be turned off deliberately", async () => {
  const cache = new LazyLayersCache({
    levels: { L1: { ttlMs: 40 } },
    failSafe: { enabled: false },
  });

  await cache.getOrSet("k", async () => ({ v: 1 }));
  await new Promise((r) => setTimeout(r, 60));

  await assert.rejects(
    () => cache.getOrSet("k", async () => { throw new Error("origin is down"); }),
    /origin is down/,
    "opting out must let the error through",
  );
});

test("a loader that never returns is bounded", async () => {
  const cache = new LazyLayersCache({ timeouts: { hardMs: 60 } });

  await assert.rejects(
    () => cache.getOrSet("hangs", () => new Promise(() => {})),
    "a loader with no ceiling would leak the caller forever",
  );
});

test("the loader receives an abort signal that actually fires", async () => {
  const cache = new LazyLayersCache({ timeouts: { hardMs: 50 } });
  let aborted = false;

  await cache
    .getOrSet("hangs", ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        resolve(undefined);
      });
    }))
    .catch(() => {});

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(aborted, true, "the signal must be wired to the timeout");
});

test("in-flight dedupe collapses a herd with no configuration", async () => {
  const cache = new LazyLayersCache({ ttlMs: 60_000 });
  let calls = 0;

  const results = await Promise.all(
    Array.from({ length: 500 }, () =>
      cache.getOrSet("hot", async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
        return { hit: true };
      }),
    ),
  );

  assert.equal(calls, 1, "500 callers must produce one loader call");
  assert.equal(results.length, 500);
  assert.ok(results.every((r) => r.hit === true));
});

test("circuit breakers are closed and armed by default", () => {
  const breaker = new CircuitBreaker();

  assert.equal(breaker.canCall(), true);
  assert.equal(breaker.currentState, "closed");

  // The documented default threshold is three consecutive failures.
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.currentState, "closed", "must not trip early");

  breaker.recordFailure();
  assert.equal(breaker.currentState, "open", "must trip on the third");
  assert.equal(breaker.canCall(), false);
});

test("an opted-out breaker never trips", () => {
  const breaker = new CircuitBreaker({ enabled: false });

  for (let i = 0; i < 10; i++) breaker.recordFailure();

  assert.equal(breaker.canCall(), true);
});

test("a single-process cache is unaffected by the distributed lock default", async () => {
  // No L2, so there is nothing to lock against. This must not hang or throw.
  const cache = new LazyLayersCache({ ttlMs: 60_000 });

  const value = await cache.getOrSet("k", async () => ({ v: 7 }));

  assert.deepEqual(value, { v: 7 });
});

test("the observability dashboard stays off unless asked for", async () => {
  const cache = new LazyLayersCache({ ttlMs: 1_000 });

  // It binds a port and serves cache contents, so it must never start on its own.
  assert.notEqual(
    typeof cache.getObservabilityHandler,
    "undefined",
    "the handler accessor should exist",
  );
  assert.equal(
    cache.getObservabilityHandler(),
    undefined,
    "no handler should be mounted by default",
  );
});

test("setupCache resolves to a managed production cache in L1-only mode", async () => {
  const cache = await setupCache({
    namespace: "safe-defaults",
    redis: false,
  });
  let calls = 0;

  assert.ok(cache instanceof ManagedLazyLayersCache);
  assert.deepEqual(
    await cache.prewarm("user:1", async () => {
      calls++;
      return { id: 1 };
    }),
    { id: 1 },
  );
  assert.deepEqual(await cache.prewarm("user:1", async () => ({ id: 2 })), { id: 1 });
  assert.equal(calls, 1);

  await cache.invalidate("user:1");
  assert.deepEqual(await cache.prewarm("user:1", async () => ({ id: 2 })), { id: 2 });

  await cache.invalidateByPattern("user:*");
  assert.equal(await cache.has("user:1"), false);

  await cache.close();
  await cache.close();
});

test("setupCache waits for bus health and subscription, then owns bus cleanup", async () => {
  const published = [];
  let subscribed = false;
  let disconnects = 0;
  const eventBus = {
    async healthCheck() {
      return { ok: true, transport: "fake" };
    },
    async subscribe() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      subscribed = true;
    },
    async publish(event) {
      published.push(event);
    },
    async disconnect() {
      disconnects++;
    },
  };

  const cache = await setupCache({
    namespace: "managed-bus",
    redis: false,
    l2: false,
    eventBus,
  });

  assert.equal(subscribed, true, "setup must not return before the subscription is active");
  await cache.prewarm("ready", async () => "yes");
  await cache.invalidate("ready");
  assert.deepEqual(published.map((event) => event.type), ["set", "del"]);

  await cache.close();
  await cache.close();
  assert.equal(disconnects, 1);
});

test("setupCache fails closed when configured infrastructure is unhealthy", async () => {
  let disconnects = 0;
  const eventBus = {
    async healthCheck() {
      return { ok: false, transport: "fake", error: new Error("offline") };
    },
    async subscribe() {},
    async publish() {},
    async disconnect() {
      disconnects++;
    },
  };

  await assert.rejects(
    () => setupCache({ redis: false, eventBus }),
    (error) => error instanceof CacheSetupError && /health check/.test(error.message),
  );
  assert.equal(disconnects, 1);
});

test("setupCache bounds a startup check that never settles", async () => {
  let disconnects = 0;
  const eventBus = {
    healthCheck() {
      return new Promise(() => {});
    },
    async subscribe() {},
    async publish() {},
    async disconnect() {
      disconnects++;
    },
  };

  await assert.rejects(
    () => setupCache({
      redis: false,
      eventBus,
      startup: { timeoutMs: 10 },
    }),
    (error) => error instanceof CacheSetupError && /timed out/.test(error.message),
  );
  assert.equal(disconnects, 1);
});
