// Run with NODE_ENV=production to silence the cache's debug logging.
import { LazyLayersCache } from '../dist/index.js';

const N = 10_000;

async function run(label, makeCache, opts = {}) {
  const cache = makeCache();
  let loaderCalls = 0;
  let inflightReuse = 0;

  cache.on?.((e) => { if (e.type === 'inflight:reuse') inflightReuse++; });

  const loader = async () => {
    loaderCalls++;
    await new Promise((r) => setTimeout(r, 25));   // stand-in for a DB round trip
    return { id: 'u1', name: 'Ada Lovelace', plan: 'pro' };
  };

  const t0 = performance.now();
  const results = await Promise.all(
    Array.from({ length: N }, () => cache.getOrSet('user:1', loader, opts)),
  );
  const ms = performance.now() - t0;

  const allSame = results.every((r) => r && r.id === 'u1');
  console.log(
    `${label.padEnd(34)} callers=${N}  loaderCalls=${String(loaderCalls).padStart(5)}  ` +
    `inflightReuse=${String(inflightReuse).padStart(5)}  ${ms.toFixed(0)}ms  correct=${allSame}`,
  );
  return { loaderCalls, inflightReuse, ms, allSame };
}

console.log('\nThundering herd — 10,000 concurrent getOrSet on one cold key\n');

const deduped = await run('with inflight dedupe (default)', () => new LazyLayersCache({ ttlMs: 60_000 }));
const naive = await run('with inflight disabled', () => new LazyLayersCache({ ttlMs: 60_000, inflight: { enabled: false } }));

console.log(`\ncollapse ratio: ${N} callers -> ${deduped.loaderCalls} loader call` +
            `  (${(N / deduped.loaderCalls).toFixed(0)}x fewer origin hits than the undeduped path's ${naive.loaderCalls})`);

const { writeFileSync } = await import('node:fs');
writeFileSync(new URL('./herd.json', import.meta.url), JSON.stringify({ N, deduped, naive }, null, 2));
