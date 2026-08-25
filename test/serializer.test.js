import assert from "node:assert/strict";
import { test } from "node:test";
import { pack } from "msgpackr";

const {
  NULL_SENTINEL,
  GZIP_MIN_BYTES,
  deserialize,
  getCompressionSavings,
  hasPrefix,
  serialize,
  serializeWithStats,
  shouldGzip,
  stripPrefix,
} = await import("../dist/index.js");

const HC1M = Buffer.from("HC1M", "ascii");
const HC1G = Buffer.from("HC1G", "ascii");
const HC1J = Buffer.from("HC1J", "ascii");

// Mock player listing — nested arrays, objects, mixed types. The fixture is intentionally
// shaped like a real API response so deep-equal regressions surface clearly.
function makePlayerListing(count = 3) {
  const players = [];
  for (let index = 0; index < count; index += 1) {
    players.push({
      id: `player-${index}`,
      device: { os: "ios", version: "17.4", model: "iphone-15" },
      languages: ["en", "hi", "es"],
      userSnapshot: {
        name: `User ${index}`,
        level: index,
        flags: { vip: index % 2 === 0, banned: false },
      },
      infoCards: [
        { title: "stats", body: { wins: index, losses: index + 1 } },
        { title: "rank", body: { tier: "gold", points: 1234 + index } },
      ],
    });
  }
  return {
    pagination: { page: 1, perPage: count, total: count },
    players,
  };
}

test("plain object: serialize and deserialize round-trips", () => {
  const value = { id: 1, name: "Amonk", active: true };
  const buffer = serialize(value);
  assert.ok(Buffer.isBuffer(buffer));
  assert.deepEqual(deserialize(buffer), value);
});

test("listing response: deep round-trip preserves nested structure", () => {
  const value = makePlayerListing(5);
  const buffer = serialize(value);
  assert.deepEqual(deserialize(buffer), value);
});

test("null serializes via sentinel and deserializes to null", () => {
  const buffer = serialize(null);
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(deserialize(buffer), null);
});

test("undefined serializes via sentinel and deserializes to null", () => {
  const buffer = serialize(undefined);
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(deserialize(buffer), null);
});

test("plain string round-trips through msgpack", () => {
  const buffer = serialize("hello world");
  assert.equal(deserialize(buffer), "hello world");
});

test("legacy JSON string (no buffer) deserializes to object", () => {
  const parsed = deserialize(JSON.stringify({ ok: true }));
  assert.deepEqual(parsed, { ok: true });
});

test("legacy JSON buffer (no prefix) deserializes to object", () => {
  const raw = Buffer.from(JSON.stringify({ ok: true }), "utf8");
  assert.deepEqual(deserialize(raw), { ok: true });
});

test("legacy raw msgpack buffer (no prefix) deserializes to object", () => {
  const raw = Buffer.from(pack({ ok: true }));
  assert.deepEqual(deserialize(raw), { ok: true });
});

test("legacy sentinel string deserializes to null", () => {
  assert.equal(deserialize(NULL_SENTINEL), null);
});

test("small payload uses plain msgpack encoding", () => {
  const stats = serializeWithStats({ small: "object" });
  assert.equal(stats.encoding, "msgpack");
  assert.equal(stats.compressed, false);
  assert.ok(hasPrefix(stats.buffer, HC1M));
});

test("large payload prefers gzip when savings >= 15%", () => {
  // Highly compressible: 200 KB of a repeating pattern.
  const value = { blob: "a".repeat(200 * 1024) };
  const stats = serializeWithStats(value);
  assert.equal(stats.encoding, "msgpack-gzip");
  assert.equal(stats.compressed, true);
  assert.ok(hasPrefix(stats.buffer, HC1G));
  assert.ok(stats.compressionRatio >= 0.15);
  assert.deepEqual(deserialize(stats.buffer), value);
});

test("large but incompressible payload falls back to msgpack", () => {
  // Random bytes resist gzip — should remain msgpack-only.
  const bytes = new Uint8Array(80 * 1024);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  const value = { blob: Buffer.from(bytes).toString("latin1") };
  const stats = serializeWithStats(value);
  // Either passes (extremely unlikely with random) or falls back — both are correct;
  // assert the buffer round-trips and respects the threshold rule.
  assert.deepEqual(deserialize(stats.buffer), value);
  if (stats.encoding === "msgpack-gzip") {
    assert.ok(stats.compressionRatio >= 0.15);
  } else {
    assert.equal(stats.encoding, "msgpack");
  }
});

test("JSON debug mode uses HC1J encoding", () => {
  const previous = process.env.CACHE_FORMAT;
  process.env.CACHE_FORMAT = "json";
  try {
    const value = { debug: true, ts: 1 };
    const stats = serializeWithStats(value);
    assert.equal(stats.encoding, "json");
    assert.ok(hasPrefix(stats.buffer, HC1J));
    assert.deepEqual(deserialize(stats.buffer), value);
  } finally {
    if (previous === undefined) delete process.env.CACHE_FORMAT;
    else process.env.CACHE_FORMAT = previous;
  }
});

test("CACHE_DEBUG_SERIALIZATION=true also triggers JSON mode", () => {
  const previous = process.env.CACHE_DEBUG_SERIALIZATION;
  process.env.CACHE_DEBUG_SERIALIZATION = "true";
  try {
    const stats = serializeWithStats({ ok: true });
    assert.equal(stats.encoding, "json");
  } finally {
    if (previous === undefined) delete process.env.CACHE_DEBUG_SERIALIZATION;
    else process.env.CACHE_DEBUG_SERIALIZATION = previous;
  }
});

test("HC1M values decode correctly", () => {
  const stats = serializeWithStats({ a: 1 });
  assert.ok(hasPrefix(stats.buffer, HC1M));
  assert.deepEqual(deserialize(stats.buffer), { a: 1 });
});

test("HC1G values decode correctly", () => {
  const stats = serializeWithStats({ blob: "x".repeat(GZIP_MIN_BYTES * 2) });
  assert.equal(stats.encoding, "msgpack-gzip");
  assert.deepEqual(deserialize(stats.buffer), {
    blob: "x".repeat(GZIP_MIN_BYTES * 2),
  });
});

test("HC1J values decode correctly", () => {
  const previous = process.env.CACHE_FORMAT;
  process.env.CACHE_FORMAT = "json";
  try {
    const stats = serializeWithStats({ a: 1 });
    assert.ok(hasPrefix(stats.buffer, HC1J));
    assert.deepEqual(deserialize(stats.buffer), { a: 1 });
  } finally {
    if (previous === undefined) delete process.env.CACHE_FORMAT;
    else process.env.CACHE_FORMAT = previous;
  }
});

test("hasPrefix is O(1) and matches only on full 4-byte prefix", () => {
  assert.equal(hasPrefix(Buffer.from("HC1Mxxxx"), HC1M), true);
  assert.equal(hasPrefix(Buffer.from("HC1Gxxxx"), HC1M), false);
  assert.equal(hasPrefix(Buffer.from("HC1"), HC1M), false);
});

test("stripPrefix removes the prefix bytes without copying", () => {
  const body = Buffer.from("payload");
  const buf = Buffer.concat([HC1M, body]);
  assert.deepEqual(stripPrefix(buf, HC1M), body);
});

test("getCompressionSavings returns saved fraction (100KB -> 25KB == 0.75)", () => {
  const saved = getCompressionSavings(100 * 1024, 25 * 1024);
  assert.equal(Math.round(saved * 100) / 100, 0.75);
});

test("shouldGzip returns false for small payloads regardless of savings", () => {
  assert.equal(shouldGzip(1024, 100), false);
});

test("shouldGzip returns false when savings are below 15%", () => {
  assert.equal(shouldGzip(GZIP_MIN_BYTES, GZIP_MIN_BYTES * 0.9), false);
});

test("shouldGzip returns true for large payloads with >=15% savings", () => {
  assert.equal(shouldGzip(GZIP_MIN_BYTES, GZIP_MIN_BYTES * 0.5), true);
});

test("Uint8Array input is supported by deserialize", () => {
  const buffer = serialize({ ok: 1 });
  const view = new Uint8Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  assert.deepEqual(deserialize(view), { ok: 1 });
});

test("non-JSON, non-sentinel string is returned as-is", () => {
  assert.equal(deserialize("just a string"), "just a string");
});

test("corrupted prefixed buffer returns null instead of throwing", () => {
  const corrupt = Buffer.concat([HC1G, Buffer.from("not actually gzip")]);
  assert.equal(deserialize(corrupt), null);
});

test("sentinel decoded via deserialize never leaks the marker string", () => {
  const buffer = serialize(null);
  assert.equal(deserialize(buffer), null);
});

/* Regression tests for two silent-corruption bugs. */

test("an unserializable value throws instead of storing garbage", async () => {
  const { serialize, CacheSerializationError } = await import("../dist/index.js");
  const circular = { name: "a" };
  circular.self = circular;

  // This used to store the literal string "[object Object]" and report success.
  assert.throws(() => serialize(circular), CacheSerializationError);
});

test("an unserializable value does not fail the read path", async () => {
  const { LazyLayersCache } = await import("../dist/index.js");
  const cache = new LazyLayersCache({ ttlMs: 5_000 });

  const circular = { id: 1 };
  circular.self = circular;

  const value = await cache.getOrSet("circ", async () => circular);

  assert.equal(value.id, 1);
  assert.equal(value.self, value, "L1 must still hold the real object");
});

test("a caller who caches the sentinel string gets it back", async () => {
  const { serialize, deserialize, NULL_SENTINEL } = await import("../dist/index.js");

  assert.equal(deserialize(serialize(NULL_SENTINEL)), NULL_SENTINEL);
  assert.equal(deserialize(serialize(null)), null);
});

test("sentinel buffers written by older versions still decode to null", async () => {
  const { deserialize } = await import("../dist/index.js");
  const { pack } = await import("msgpackr");

  // Exactly what every previous release wrote for a null value.
  const legacy = Buffer.concat([Buffer.from("HC1M", "ascii"), Buffer.from(pack("__hybridcache_null__"))]);

  assert.equal(deserialize(legacy), null);
});

/* Compression backend selection. */

test("gzip stays the default, so a mixed-version fleet keeps working", async () => {
  const { serialize } = await import("../dist/index.js");
  const big = { rows: Array.from({ length: 4_000 }, (_, i) => ({ i, name: `row-${i}`, tag: "repeatable" })) };

  assert.equal(serialize(big).subarray(0, 4).toString(), "HC1G");
});

test("zstd is used once it is switched on, and round-trips", async () => {
  const { serialize, deserialize, configureCompression, ZSTD_AVAILABLE } = await import("../dist/index.js");

  if (!ZSTD_AVAILABLE) return; // Node 20 and early 22 have no zstd in node:zlib.

  const big = { rows: Array.from({ length: 4_000 }, (_, i) => ({ i, name: `row-${i}`, tag: "repeatable" })) };

  configureCompression("auto");
  try {
    const buffer = serialize(big);
    assert.equal(buffer.subarray(0, 4).toString(), "HC1Z");
    assert.deepEqual(deserialize(buffer), big);
  } finally {
    configureCompression("gzip");
  }
});

test("gzip buffers still decode after switching to zstd", async () => {
  const { serialize, deserialize, configureCompression, ZSTD_AVAILABLE } = await import("../dist/index.js");

  if (!ZSTD_AVAILABLE) return;

  const big = { rows: Array.from({ length: 4_000 }, (_, i) => ({ i, tag: "repeatable" })) };
  const written = serialize(big);          // gzip, the default
  assert.equal(written.subarray(0, 4).toString(), "HC1G");

  configureCompression("auto");
  try {
    assert.deepEqual(deserialize(written), big, "reads must accept every format");
  } finally {
    configureCompression("gzip");
  }
});

test("an unknown tag from a newer release reads as a miss", async () => {
  const { deserialize } = await import("../dist/index.js");

  // Falling through to the legacy decoder would read the tag bytes as data and
  // return a plausible wrong value. A miss makes the caller reload instead.
  assert.equal(deserialize(Buffer.concat([Buffer.from("HC1Q"), Buffer.from([0x01, 0x02])])), null);
  assert.equal(deserialize(Buffer.concat([Buffer.from("HC1_"), Buffer.from([0x2a])])), null);
});

/* Size-tiered compression. */

test("payloads under a kilobyte are never compressed", async () => {
  const { serializeWithStats } = await import("../dist/index.js");

  // Every codec we benchmarked makes a 119 byte value bigger, so the only
  // correct choice down here is to leave it alone.
  const small = { sid: "s_abc123", uid: 42, exp: 1740086400000 };
  const stats = serializeWithStats(small);

  assert.equal(stats.encoding, "msgpack");
  assert.equal(stats.compressed, false);
});

test("mid-sized payloads are compressed, which the old 64 KB floor skipped", async () => {
  const { serializeWithStats } = await import("../dist/index.js");

  // ~14 KB, well under the old floor and previously stored raw.
  const list = { items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item-${i}`, status: "active" })) };
  const stats = serializeWithStats(list);

  assert.equal(stats.compressed, true);
  assert.ok(stats.compressionRatio > 0.5, `expected real savings, got ${stats.compressionRatio}`);
});

test("a custom tier array is honoured", async () => {
  const { serializeWithStats, configureCompression, getCompressionTiers } = await import("../dist/index.js");

  configureCompression([
    { maxBytes: 100, codec: "none" },
    { codec: "gzip" },
  ]);

  try {
    assert.equal(getCompressionTiers().length, 2);

    const midsized = { rows: Array.from({ length: 400 }, (_, i) => ({ i, tag: "repeatable" })) };
    assert.equal(serializeWithStats(midsized).compressed, true);
  } finally {
    configureCompression("gzip");
  }
});

test("a malformed tier list is rejected at configuration time", async () => {
  const { configureCompression } = await import("../dist/index.js");

  assert.throws(() => configureCompression([]), /non-empty/);
  assert.throws(() => configureCompression([{ codec: "brotli" }]), /Unknown compression codec/);
  assert.throws(
    () => configureCompression([{ maxBytes: 100, codec: "none" }, { maxBytes: 50, codec: "gzip" }]),
    /greater than/,
    "tiers must ascend",
  );
  assert.throws(
    () => configureCompression([{ codec: "gzip" }, { maxBytes: 100, codec: "none" }]),
    /Only the last/,
  );
});

test("a tier naming an uninstalled codec falls back instead of throwing", async () => {
  const { serializeWithStats, configureCompression, SNAPPY_AVAILABLE } = await import("../dist/index.js");

  configureCompression([{ maxBytes: 100, codec: "none" }, { codec: "snappy" }]);

  try {
    const midsized = { rows: Array.from({ length: 400 }, (_, i) => ({ i, tag: "repeatable" })) };
    const stats = serializeWithStats(midsized);

    // Installed or not, the write must succeed and round-trip.
    const expected = SNAPPY_AVAILABLE() ? "msgpack-snappy" : "msgpack-gzip";
    assert.equal(stats.encoding, expected);
  } finally {
    configureCompression("gzip");
  }
});
