import zlib from 'node:zlib';
import { pack } from 'msgpackr';
import { FIXTURES } from './fixtures.mjs';


const candidates = {
  'gzip-6 (current)': { c: (b) => zlib.gzipSync(b), d: (b) => zlib.gunzipSync(b) },
  'gzip-1':           { c: (b) => zlib.gzipSync(b, { level: 1 }), d: (b) => zlib.gunzipSync(b) },
  'brotli-q1':        { c: (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 } }), d: (b) => zlib.brotliDecompressSync(b) },
  'brotli-q4':        { c: (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }), d: (b) => zlib.brotliDecompressSync(b) },
  'zstd-3':           { c: (b) => zlib.zstdCompressSync(b), d: (b) => zlib.zstdDecompressSync(b) },
  'zstd-1':           { c: (b) => zlib.zstdCompressSync(b, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 1 } }), d: (b) => zlib.zstdDecompressSync(b) },
};

const time = (fn, iters) => {
  fn(); // warm
  const t = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  return Number(process.hrtime.bigint() - t) / 1e6 / iters;
};

for (const { name, build } of FIXTURES) {
  const value = build();
  const packed = Buffer.from(pack(value));
  if (packed.length < 64 * 1024) continue;   // only the gzip-eligible ones
  console.log(`\n=== ${name}  (msgpack ${packed.length} B) ===`);
  console.log('algo'.padEnd(18), 'bytes'.padStart(9), 'saved'.padStart(7), 'comp ms'.padStart(9), 'decomp ms'.padStart(10));
  for (const [algo, { c, d }] of Object.entries(candidates)) {
    const out = c(packed);
    const iters = packed.length > 500_000 ? 20 : 60;
    const cms = time(() => c(packed), iters);
    const dms = time(() => d(out), iters);
    const saved = ((1 - out.length / packed.length) * 100).toFixed(1);
    console.log(algo.padEnd(18), String(out.length).padStart(9), (saved + '%').padStart(7),
                cms.toFixed(2).padStart(9), dms.toFixed(2).padStart(10));
  }
}
