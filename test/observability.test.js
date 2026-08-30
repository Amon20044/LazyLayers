import assert from "node:assert/strict";
import { test } from "node:test";
import { pack } from "msgpackr";

const {
  ObservabilityCollector,
  createCache,
  createObservabilityHandler,
  ObservabilityInspector,
  inspectBuffer,
  resolveObservabilityOptions,
  renderPrometheus,
  subscribeTelemetry,
  TELEMETRY_CHANNEL_NAME,
  serialize,
  configureCompression,
  ZSTD_AVAILABLE,
  MemoryStore,
} = await import("../dist/index.js");

const HC1M = Buffer.from("HC1M", "ascii");
const HC1G = Buffer.from("HC1G", "ascii");
const HC1J = Buffer.from("HC1J", "ascii");

test("inspectBuffer labels every available encoding and runtime fallback", () => {
  const msgpack = serialize({ a: 1 });
  assert.equal(inspectBuffer(msgpack).encoding, "msgpack");
  assert.deepEqual(inspectBuffer(msgpack).value, { a: 1 });

  const big = { blob: "x".repeat(200 * 1024) };

  // Every compressed codec must be labelled correctly. This used to report
  // "legacy" for anything that was not gzip, which mislabelled the dashboard.
  for (const [codec, expected] of [
    ["gzip", "msgpack-gzip"],
    ["zstd", ZSTD_AVAILABLE ? "msgpack-zstd" : "msgpack-lz4"],
    ["lz4", "msgpack-lz4"],
    ["snappy", "msgpack-snappy"],
  ]) {
    configureCompression([{ codec }]);
    const buffer = serialize(big);
    assert.equal(inspectBuffer(buffer).encoding, expected, `${codec} should be labelled ${expected}`);
    assert.deepEqual(inspectBuffer(buffer).value, big);
  }

  configureCompression("gzip");
  const gz = serialize(big);

  const json = Buffer.concat([HC1J, Buffer.from(JSON.stringify({ j: true }), "utf8")]);
  assert.equal(inspectBuffer(json).encoding, "json");
  assert.deepEqual(inspectBuffer(json).value, { j: true });

  const legacy = Buffer.from(pack({ legacy: 1 }));
  assert.equal(inspectBuffer(legacy).encoding, "legacy");
  assert.deepEqual(inspectBuffer(legacy).value, { legacy: 1 });

  // sanity: prefixes referenced so the helper constants stay meaningful
  assert.ok(HC1M.equals(msgpack.subarray(0, 4)));
  assert.ok(HC1G.equals(gz.subarray(0, 4)));
});

test("collector ring buffer is bounded and overwrites oldest", () => {
  const collector = new ObservabilityCollector(3);
  for (let i = 0; i < 10; i += 1) {
    collector.handle({ type: "hit", key: `k${i}`, level: "L1" });
  }
  const events = collector.recentEvents();
  assert.equal(events.length, 3, "buffer never grows past maxEvents");
  assert.deepEqual(events.map((e) => e.data.key), ["k7", "k8", "k9"], "oldest dropped, chronological");
  assert.equal(collector.overview().totalEvents, 10, "monotonic total preserved");
});

test("collector counters and hit ratio", () => {
  const collector = new ObservabilityCollector(100);
  collector.handle({ type: "hit", key: "a", level: "L1" });
  collector.handle({ type: "hit", key: "b", level: "L2" });
  collector.handle({ type: "miss", key: "c", level: "L1" });
  collector.handle({ type: "miss", key: "d", level: "negative" });
  collector.handle({ type: "set", key: "a", levels: ["L1"] });
  collector.handle({ type: "loader:error", key: "c", durationMs: 5, error: new Error("boom") });

  const o = collector.overview();
  assert.equal(o.hits, 2);
  assert.equal(o.misses, 2);
  assert.equal(o.hitRatio, 0.5);
  assert.equal(o.counters.sets, 1);
  assert.equal(o.counters.loaderError, 1);
  assert.equal(o.counters.missesNegative, 1);

  // error must be flattened to a string message (no Error instance leaks)
  const errEvent = collector.recentEvents().find((e) => e.type === "loader:error");
  assert.equal(errEvent.data.error, "boom");
});

test("collector live subscribe receives events and unsubscribe stops them", () => {
  const collector = new ObservabilityCollector(10);
  const seen = [];
  const off = collector.subscribe((e) => seen.push(e.type));
  collector.handle({ type: "hit", key: "a", level: "L1" });
  off();
  collector.handle({ type: "hit", key: "b", level: "L1" });
  assert.deepEqual(seen, ["hit"]);
});

test("MemoryStore.inspect: peek does not change eviction order", async () => {
  const store = new MemoryStore({ levels: { L1: { maxEntries: 2 } } });
  await store.set("a", 1);
  await store.set("b", 2);

  // Inspect both — must use peek, so recency is untouched.
  const snap = await store.inspect();
  assert.equal(snap.size, 2);
  const keys = snap.keys.map((k) => k.key).sort();
  assert.deepEqual(keys, ["a", "b"]);
  const ka = snap.keys.find((k) => k.key === "a");
  assert.equal(ka.value, 1);
  assert.equal(ka.encoding, "msgpack");
  // serialized-vs-deserialized comparison is populated per key
  assert.equal(typeof ka.serializedBytes, "number");
  assert.equal(typeof ka.deserializedBytes, "number");
  assert.equal(typeof ka.compressionRatio, "number");

  // Adding "c" should evict "a" (the genuine LRU victim), proving inspect()
  // did NOT promote "a" by touching it.
  await store.set("c", 3);
  assert.equal(await store.get("a"), undefined, "a was evicted as true LRU victim");
  assert.equal(await store.get("b"), 2);
  assert.equal(await store.get("c"), 3);
});

test("MemoryStore.inspect: match filter, pagination, value truncation", async () => {
  const store = new MemoryStore({ levels: { L1: { maxEntries: 100 } } });
  await store.set("user:1", { id: 1 });
  await store.set("user:2", { id: 2 });
  await store.set("post:1", { id: 1 });

  const filtered = await store.inspect({ match: "user:*" });
  assert.equal(filtered.keys.length, 2);
  assert.ok(filtered.keys.every((k) => k.key.startsWith("user:")));

  const page = await store.inspect({ limit: 1 });
  assert.equal(page.keys.length, 1);
  assert.ok(page.cursor, "cursor returned when more pages remain");

  await store.set("big", { blob: "x".repeat(1000) });
  const capped = await store.inspect({ match: "big", maxValueBytes: 10 });
  assert.equal(capped.keys[0].truncated, true);
  assert.equal(capped.keys[0].value, undefined);
});

test("resolveObservabilityOptions: defaults, env overrides, precedence", () => {
  const def = resolveObservabilityOptions(true);
  assert.equal(def.enabled, true);
  assert.equal(def.route, "/__lazylayers");
  assert.equal(def.auth.username, "lazydev");
  assert.equal(def.auth.password, "lazydev");
  assert.equal(def.server.host, "127.0.0.1");
  assert.equal(def.server.port, 7077);

  process.env.LAZY_OBS_USER = "envuser";
  process.env.LAZY_OBS_PORT = "9999";
  try {
    const fromEnv = resolveObservabilityOptions({ enabled: true });
    assert.equal(fromEnv.auth.username, "envuser");
    assert.equal(fromEnv.server.port, 9999);

    // explicit option beats env
    const explicit = resolveObservabilityOptions({ enabled: true, auth: { username: "opt" } });
    assert.equal(explicit.auth.username, "opt");
  } finally {
    delete process.env.LAZY_OBS_USER;
    delete process.env.LAZY_OBS_PORT;
  }

  assert.equal(resolveObservabilityOptions(undefined).enabled, false);
  assert.equal(resolveObservabilityOptions({ enabled: true, server: false }).server, null);
});

test("handler: route passthrough, auth, and JSON endpoints", async () => {
  const collector = new ObservabilityCollector(50);
  collector.handle({ type: "hit", key: "a", level: "L1" });

  const store = new MemoryStore({ levels: { L1: { maxEntries: 10 } } });
  await store.set("k", { v: 1 });
  const inspector = new ObservabilityInspector({
    l1: store,
    options: {},
    source: "test",
    route: "/observelazyily",
    maxValueBytes: 256 * 1024,
    l2CircuitBreaker: { currentState: "closed" },
    eventBusCircuitBreaker: { currentState: "closed" },
  });

  const options = resolveObservabilityOptions({ enabled: true, server: false });
  const handler = createObservabilityHandler({ collector, inspector, options });

  // passthrough: unrelated path
  assert.equal(handler(mockReq("/something-else"), mockRes()), false);

  // unauthorized without credentials
  const unauth = mockRes();
  assert.equal(handler(mockReq("/observelazyily/api/overview"), unauth), true);
  await tick();
  assert.equal(unauth.statusCode, 401);

  // authorized with lazydev/lazydev basic auth
  const ok = mockRes();
  const auth = "Basic " + Buffer.from("lazydev:lazydev").toString("base64");
  handler(mockReq("/observelazyily/api/overview", { authorization: auth }), ok);
  await tick();
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).hits, 1);

  // L1 endpoint returns inspection
  const l1 = mockRes();
  handler(mockReq("/observelazyily/api/l1", { authorization: auth }), l1);
  await tick();
  assert.equal(l1.statusCode, 200);
  assert.equal(JSON.parse(l1.body).keys[0].key, "k");

  // dashboard HTML
  const html = mockRes();
  handler(mockReq("/observelazyily", { authorization: auth }), html);
  await tick();
  assert.equal(html.statusCode, 200);
  assert.match(html.body, /observability/);
});

test("cache with observability:true exposes a mountable handler", async () => {
  const cache = createCache({ observability: { enabled: true, server: false } });
  const handler = cache.getObservabilityHandler();
  assert.equal(typeof handler, "function");
  assert.equal(cache.getObservabilityServer(), undefined);

  await cache.set("hello", "world");
  await cache.get("hello");

  const res = mockRes();
  const auth = "Basic " + Buffer.from("lazydev:lazydev").toString("base64");
  handler(mockReq("/observelazyily/api/overview", { authorization: auth }), res);
  await tick();
  assert.equal(res.statusCode, 200);
  assert.ok(JSON.parse(res.body).counters.sets >= 1);
});

test("cache without observability attaches nothing", () => {
  const cache = createCache();
  assert.equal(cache.getObservabilityHandler(), undefined);
  assert.equal(cache.getObservabilityServer(), undefined);
});

test("renderPrometheus emits exposition format with level labels, no key cardinality", () => {
  const collector = new ObservabilityCollector(100);
  collector.handle({ type: "hit", key: "secret-user-42", level: "L1" });
  collector.handle({ type: "miss", key: "secret-user-99", level: "L2" });
  collector.handle({ type: "set", key: "x", levels: ["L1"] });

  const text = renderPrometheus(collector, "lazycache", { l1Size: 7, l2Size: 3 });

  assert.match(text, /# TYPE lazycache_hits_total counter/);
  assert.match(text, /lazycache_hits_total\{level="l1"\} 1/);
  assert.match(text, /lazycache_misses_total\{level="l2"\} 1/);
  assert.match(text, /lazycache_writes_total 1/);
  assert.match(text, /lazycache_hit_ratio /);
  assert.match(text, /lazycache_l1_entries 7/);
  assert.match(text, /lazycache_l2_entries 3/);
  // keys must never leak into label values (cardinality + privacy)
  assert.ok(!text.includes("secret-user-42"), "no per-key labels");
});

test("prometheus endpoint: 404 when disabled, public scrape when enabled", async () => {
  const collector = new ObservabilityCollector(50);
  collector.handle({ type: "hit", key: "a", level: "L1" });
  const inspector = new ObservabilityInspector({
    options: {},
    source: "test",
    route: "/observelazyily",
    maxValueBytes: 1024,
    l2CircuitBreaker: { currentState: "closed" },
    eventBusCircuitBreaker: { currentState: "closed" },
  });

  const off = resolveObservabilityOptions({ enabled: true, server: false });
  const disabledHandler = createObservabilityHandler({ collector, inspector, options: off });
  const r1 = mockRes();
  const auth = "Basic " + Buffer.from("lazydev:lazydev").toString("base64");
  disabledHandler(mockReq("/observelazyily/metrics", { authorization: auth }), r1);
  await tick();
  assert.equal(r1.statusCode, 404, "metrics 404 when prometheus disabled");

  const on = resolveObservabilityOptions({
    enabled: true,
    server: false,
    prometheus: { enabled: true, public: true },
  });
  const handler = createObservabilityHandler({ collector, inspector, options: on });
  const r2 = mockRes();
  // no auth header — public scrape must be allowed
  handler(mockReq("/observelazyily/metrics"), r2);
  await tick();
  assert.equal(r2.statusCode, 200);
  assert.match(r2.headers["Content-Type"], /text\/plain/);
  assert.match(r2.body, /lazycache_hits_total/);
});

test("telemetry diagnostics channel receives the raw event stream", async () => {
  assert.equal(TELEMETRY_CHANNEL_NAME, "lazycache:cache:event");
  const seen = [];
  const off = subscribeTelemetry((e) => seen.push(e.type));
  try {
    const cache = createCache();
    await cache.set("k", "v");
    await cache.get("k");
    await cache.get("nope");
  } finally {
    off();
  }
  assert.ok(seen.includes("set"));
  assert.ok(seen.includes("hit"));
  assert.ok(seen.includes("miss"));

  // after unsubscribe, no further delivery
  const before = seen.length;
  const cache2 = createCache();
  await cache2.set("z", 1);
  assert.equal(seen.length, before, "unsubscribe stops delivery");
});

// ---- tiny http mocks ----
function mockReq(url, headers = {}) {
  return { url, method: "GET", headers, on() {} };
}
function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    headersSent: false,
    body: "",
    writable: true,
    writableEnded: false,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headersSent = true;
      Object.assign(this.headers, headers || {});
    },
    write(chunk) {
      this.body += chunk;
      return true;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
      this.writableEnded = true;
    },
    on() {},
  };
}
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}
