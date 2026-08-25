import { FIXTURES } from './fixtures.mjs';
import { serialize, serializeWithStats, deserialize } from '../dist/utils/serializer.js';

// Raw JSON baseline (pure serialization)
const rawJson = { serialize: (v) => JSON.stringify(v), deserialize: (v) => JSON.parse(v) };

// Bentocache's default L2 serializer, verbatim from build/index.js:1681
const bento = { serialize: (v) => JSON.stringify(v), deserialize: (v) => JSON.parse(v) };
// ...and the envelope CacheEntry.serialize() wraps every value in (build/index.js:1171)
const envelope = (value) => ({ value, createdAt: 1740000000000, logicalExpiration: 1740000060000 });

// Fixed-iteration timing with median of 15 reps
function timeN(fn, n) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  return performance.now() - t0;
}

function opsPerSec(fn, n, reps = 15) {
  timeN(fn, Math.max(1, n >> 2)); // warmup
  const rates = [];
  for (let r = 0; r < reps; r++) rates.push(n / (timeN(fn, n) / 1000));
  rates.sort((a, b) => a - b);
  return rates[reps >> 1]; // median
}

const ITERS = {
  'Session token': 100000,
  'User profile': 50000,
  'API list (50)': 2000,
  'Metrics (24h/1m)': 300,
  'Product catalog': 400,
};

const REPS = 15;
const rows = [];

for (const f of FIXTURES) {
  const value = f.build();
  const n = ITERS[f.name] || 5000;

  // --- bytes on the wire ---
  const jsonStr = rawJson.serialize(value);
  const jsonBytes = Buffer.byteLength(jsonStr, 'utf8');

  const bentoStr = bento.serialize(envelope(value));
  const bentoBytes = Buffer.byteLength(bentoStr, 'utf8');

  const ll = serializeWithStats(value);
  const llBytes = ll.buffer.length;

  // --- correctness: all must round-trip ---
  const bentoBack = bento.deserialize(bentoStr).value;
  const llBack = deserialize(ll.buffer);
  const ok = JSON.stringify(bentoBack) === JSON.stringify(value) && JSON.stringify(llBack) === JSON.stringify(value);

  // --- throughput ---
  const bentoSer = opsPerSec(() => bento.serialize(envelope(value)), n, REPS);
  const llSer = opsPerSec(() => serialize(value), n, REPS);
  const bentoDe = opsPerSec(() => bento.deserialize(bentoStr), n, REPS);
  const llDe = opsPerSec(() => deserialize(ll.buffer), n, REPS);

  const serRatio = Number((llSer / bentoSer).toFixed(2));
  const deRatio = Number((llDe / bentoDe).toFixed(2));

  rows.push({
    fixture: f.name,
    ok,
    jsonBytes,
    bentoBytes,
    llBytes,
    saved: 1 - llBytes / bentoBytes,
    savedJson: 1 - llBytes / jsonBytes,
    encoding: ll.encoding,
    compressed: ll.compressed,
    serRatio,
    deRatio,
    bentoSer: Math.round(bentoSer),
    llSer: Math.round(llSer),
    bentoDe: Math.round(bentoDe),
    llDe: Math.round(llDe),
  });
}

const fmtB = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} kB` : `${b} B`);
console.log('\nNode.js', process.version, '| Benchmarks: JSON vs BentoCache vs LazyLayers\n');
console.log('Fixture            Roundtrip  Raw JSON   BentoCache  LazyLayers  Saved vs Bento  Encoding      Ser Ratio (LL/Bento)  Deser Ratio (LL/Bento)');
for (const r of rows) {
  console.log(
    r.fixture.padEnd(18),
    (r.ok ? 'ok' : 'FAIL').padEnd(10),
    fmtB(r.jsonBytes).padStart(9),
    fmtB(r.bentoBytes).padStart(11),
    fmtB(r.llBytes).padStart(11),
    `${(r.saved * 100).toFixed(1)}%`.padStart(15),
    ` ${r.encoding.padEnd(14)}`,
    `${r.serRatio}x (${r.llSer.toLocaleString()}/${r.bentoSer.toLocaleString()})`.padStart(22),
    `${r.deRatio}x (${r.llDe.toLocaleString()}/${r.bentoDe.toLocaleString()})`.padStart(24),
  );
}

const { writeFileSync } = await import('node:fs');
const outData = {
  node: process.version,
  bentocache: '1.6.1',
  lazyLayers: '0.5.0',
  reps: REPS,
  rows,
};
writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(outData, null, 2));
console.log('\nWrote unified benchmarks/results.json successfully.');
