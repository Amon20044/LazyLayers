/**
 * Size & latency benchmark for the hybrid cache serializer.
 *
 * Builds a realistic ~1 MB player listing response and compares:
 *   - JSON.stringify  (today's lowest-common-denominator baseline)
 *   - msgpack         (production default, HC1M)
 *   - msgpack + gzip  (production large-payload mode, HC1G)
 *
 * Run: node scripts/bench-serializer.mjs
 */

import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { pack } from "msgpackr";
import { serializeWithStats } from "../dist/index.js";

function makeListing(count) {
  const players = [];
  for (let index = 0; index < count; index += 1) {
    players.push({
      id: `player-${index.toString().padStart(8, "0")}`,
      device: {
        os: index % 2 ? "android" : "ios",
        version: "17.4.1",
        model: index % 3 ? "iphone-15-pro-max" : "pixel-8-pro",
        screen: { width: 1290, height: 2796, ppi: 460 },
      },
      languages: ["en-US", "hi-IN", "es-ES", "fr-FR"],
      userSnapshot: {
        name: `User Name ${index}`,
        email: `user_${index}@example.com`,
        level: (index * 13) % 100,
        joinedAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
        flags: { vip: index % 7 === 0, banned: false, newUser: index % 11 === 0 },
        stats: {
          wins: index * 3,
          losses: index * 2,
          draws: index,
          mmr: 1500 + (index % 800),
        },
      },
      infoCards: [
        { title: "stats", body: { wins: index, losses: index + 1, streak: index % 10 } },
        { title: "rank", body: { tier: "gold", division: 2, points: 1234 + index } },
        { title: "inventory", body: { gold: 9999, gems: 250, items: 42 } },
      ],
      friends: Array.from({ length: 5 }, (_, slot) => `player-${(index + slot) % 1000}`),
    });
  }
  return {
    pagination: { page: 1, perPage: count, total: count, hasMore: false },
    filters: { region: "global", mode: "ranked", season: 12 },
    players,
  };
}

// Tune count until we get ~1 MB JSON.
function pickListingFor1MB() {
  for (const count of [400, 600, 800, 1000, 1200]) {
    const listing = makeListing(count);
    const json = JSON.stringify(listing);
    if (json.length >= 1_000_000) return { count, listing, jsonSize: json.length };
  }
  const count = 1500;
  const listing = makeListing(count);
  return { count, listing, jsonSize: JSON.stringify(listing).length };
}

const { count, listing } = pickListingFor1MB();
const jsonString = JSON.stringify(listing);
const jsonBytes = Buffer.byteLength(jsonString, "utf8");
const msgpackBytes = Buffer.from(pack(listing)).length;
const gzipBytes = gzipSync(Buffer.from(pack(listing))).length;

const ITERATIONS = 25;

function timed(label, fn) {
  // warm up once
  fn();
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i += 1) fn();
  const elapsed = performance.now() - start;
  return { label, msPerOp: elapsed / ITERATIONS };
}

const jsonTime = timed("JSON.stringify", () => JSON.stringify(listing));
const msgpackTime = timed("msgpack pack", () => Buffer.from(pack(listing)));
const gzipTime = timed("msgpack + gzip", () => gzipSync(Buffer.from(pack(listing))));

const stats = serializeWithStats(listing);

const fmt = (bytes) => `${(bytes / 1024).toFixed(2)} KB`;
const pct = (saved) => `${(saved * 100).toFixed(1)}%`;

console.log(`\nMock listing: ${count} players, ${fmt(jsonBytes)} JSON\n`);
console.log("| encoding       | bytes        | vs JSON | ms/op (n=" + ITERATIONS + ") |");
console.log("|----------------|--------------|---------|--------------------|");
console.log(
  `| JSON           | ${fmt(jsonBytes).padEnd(12)} | ${"baseline".padEnd(7)} | ${jsonTime.msPerOp.toFixed(3).padStart(8)}           |`,
);
console.log(
  `| msgpack        | ${fmt(msgpackBytes).padEnd(12)} | ${pct(1 - msgpackBytes / jsonBytes).padEnd(7)} | ${msgpackTime.msPerOp.toFixed(3).padStart(8)}           |`,
);
console.log(
  `| msgpack + gzip | ${fmt(gzipBytes).padEnd(12)} | ${pct(1 - gzipBytes / jsonBytes).padEnd(7)} | ${gzipTime.msPerOp.toFixed(3).padStart(8)}           |`,
);

console.log("\nserializeWithStats() decision for this payload:");
console.log(`  encoding         = ${stats.encoding}`);
console.log(`  originalBytes    = ${stats.originalBytes}`);
console.log(`  storedBytes      = ${stats.storedBytes} (incl. 4-byte prefix)`);
console.log(`  compressionRatio = ${stats.compressionRatio.toFixed(3)} (saved fraction vs msgpack)`);
console.log(`  compressed       = ${stats.compressed}`);
