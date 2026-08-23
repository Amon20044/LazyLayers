import { FIXTURES } from './fixtures.mjs';
import { serialize, serializeWithStats, deserialize } from '../dist/utils/serializer.js';

// Bentocache's default L2 serializer, verbatim from build/index.js:1681
const bento = { serialize: (v) => JSON.stringify(v), deserialize: (v) => JSON.parse(v) };
// ...and the envelope CacheEntry.serialize() wraps every value in (build/index.js:1171)
const envelope = (value) => ({ value, createdAt: 1740000000000, logicalExpiration: 1740000060000 });

function bench(fn, ms = 1500) {
  // warmup
  const wEnd = performance.now() + 250;
  while (performance.now() < wEnd) fn();
  let ops = 0;
  const t0 = performance.now();
  const end = t0 + ms;
  do { fn(); ops++; } while (performance.now() < end);
  const elapsed = performance.now() - t0;
  return ops / (elapsed / 1000);
}

function median(xs) { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
const REPS = 5;
function benchMedian(fn) { return median(Array.from({ length: REPS }, () => bench(fn, 700))); }

const rows = [];
for (const f of FIXTURES) {
  const value = f.build();

  // --- bytes on the wire ---
  const bentoStr = bento.serialize(envelope(value));
  const bentoBytes = Buffer.byteLength(bentoStr, 'utf8');
  const ll = serializeWithStats(value);
  const llBytes = ll.buffer.length;

  // --- correctness: both must round-trip ---
  const bentoBack = bento.deserialize(bentoStr).value;
  const llBack = deserialize(ll.buffer);
  const ok = JSON.stringify(bentoBack) === JSON.stringify(value) && JSON.stringify(llBack) === JSON.stringify(value);

  // --- throughput ---
  const bentoSer = benchMedian(() => bento.serialize(envelope(value)));
  const llSer = benchMedian(() => serialize(value));
  const bentoDe = benchMedian(() => bento.deserialize(bentoStr));
  const llDe = benchMedian(() => deserialize(ll.buffer));

  rows.push({
    fixture: f.name, ok,
    bentoBytes, llBytes,
    saved: 1 - llBytes / bentoBytes,
    encoding: ll.encoding, compressed: ll.compressed,
    bentoSer: Math.round(bentoSer), llSer: Math.round(llSer),
    bentoDe: Math.round(bentoDe), llDe: Math.round(llDe),
  });
}

const fmtB = (b) => b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} kB` : `${b} B`;
console.log('\nnode', process.version, '| bentocache 1.6.1 JsonSerializer vs lazy-layers-cache serializer\n');
console.log('fixture           roundtrip  bentocache   lazylayers   saved   encoding      ser ops/s (bento→ll)      deser ops/s (bento→ll)');
for (const r of rows) {
  console.log(
    r.fixture.padEnd(18),
    (r.ok ? 'ok' : 'FAIL').padEnd(10),
    fmtB(r.bentoBytes).padStart(10),
    fmtB(r.llBytes).padStart(12),
    `${(r.saved * 100).toFixed(1)}%`.padStart(7),
    ` ${r.encoding.padEnd(13)}`,
    `${r.bentoSer.toLocaleString()} → ${r.llSer.toLocaleString()}`.padStart(24),
    `${r.bentoDe.toLocaleString()} → ${r.llDe.toLocaleString()}`.padStart(26),
  );
}
const { writeFileSync } = await import('node:fs');
writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify({ node: process.version, bentocache: '1.6.1', reps: REPS, rows }, null, 2));
console.log('\nwrote results.json');
