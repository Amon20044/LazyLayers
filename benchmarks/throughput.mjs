import { FIXTURES } from './fixtures.mjs';
import { serialize, deserialize } from '../dist/utils/serializer.js';
const bento = { serialize: (v) => JSON.stringify(v), deserialize: (v) => JSON.parse(v) };
const envelope = (value) => ({ value, createdAt: 1740000000000, logicalExpiration: 1740000060000 });

// Fixed-iteration timing, median of many short reps -> far less noise than time-boxing.
function timeN(fn, n) { const t0 = performance.now(); for (let i = 0; i < n; i++) fn(); return performance.now() - t0; }
function opsPerSec(fn, n, reps = 15) {
  timeN(fn, Math.max(1, n >> 2));                       // warmup / JIT
  const rates = [];
  for (let r = 0; r < reps; r++) rates.push(n / (timeN(fn, n) / 1000));
  rates.sort((a, b) => a - b);
  return rates[reps >> 1];                              // median
}

const ITERS = { 'Session token': 200000, 'User profile': 100000, 'API list (50)': 3000, 'Metrics (24h/1m)': 400, 'Product catalog': 600 };
const out = [];
for (const f of FIXTURES) {
  const v = f.build(); const n = ITERS[f.name];
  const bStr = bento.serialize(envelope(v)); const lBuf = serialize(v);
  out.push({
    fixture: f.name,
    bentoSer: opsPerSec(() => bento.serialize(envelope(v)), n),
    llSer:    opsPerSec(() => serialize(v), n),
    bentoDe:  opsPerSec(() => bento.deserialize(bStr), n),
    llDe:     opsPerSec(() => deserialize(lBuf), n),
  });
}
const r0 = (x) => Math.round(x).toLocaleString();
console.log('\nThroughput — median of 15 fixed-iteration reps, node', process.version);
console.log('fixture             serialize bento →  lazylayers   ratio        deserialize bento →  lazylayers   ratio');
for (const r of out) {
  console.log(r.fixture.padEnd(19),
    `${r0(r.bentoSer)} → ${r0(r.llSer)}`.padStart(24), `${(r.llSer / r.bentoSer).toFixed(2)}x`.padStart(8),
    `${r0(r.bentoDe)} → ${r0(r.llDe)}`.padStart(28), `${(r.llDe / r.bentoDe).toFixed(2)}x`.padStart(8));
}
const { writeFileSync } = await import('node:fs');
writeFileSync(new URL('./throughput.json', import.meta.url), JSON.stringify({ node: process.version, rows: out }, null, 2));
