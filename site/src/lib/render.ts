/**
 * HTML fragment builders. These run at BUILD time (see the vite plugin in
 * vite.config.ts) so the shipped index.html is fully static — crawlers and
 * the first paint both get real content, no hydration required.
 */

import { BENCH, saved, LAYERS, FAQS, BENCH_META, SAVINGS_MIN, SAVINGS_MAX } from './data';
import { isoDiagram } from './iso';

const bytes = (b: number) =>
  b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB`
  : b >= 1024  ? `${(b / 1024).toFixed(1)} kB`
  : `${b} B`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ── Benchmark table ─────────────────────────────────────────────────── */

export function benchTable(): string {
  const rows = BENCH.map((r, i) => {
    const pct = saved(r) * 100;
    return `
    <div class="bench__row">
      <div>
        <div class="bench__name">${esc(r.fixture)}</div>
        <div class="bench__blurb">${esc(r.blurb)}</div>
      </div>
      <div class="bench__num" data-label="bentocache">${bytes(r.bentoBytes)}</div>
      <div class="bench__num bench__num--win" data-label="lazylayers">${bytes(r.llBytes)}</div>
      <div class="bench__saved" data-label="saved">−${pct.toFixed(1)}%</div>
      <div class="bench__bar">
        <i style="--w:${pct.toFixed(1)}%;--bar-delay:${i * 90}ms"></i>
        <b>${r.encoding}</b>
      </div>
    </div>`;
  }).join('');

  return `
  <div class="bench__table reveal">
    <div class="bench__head">
      <div>Payload</div>
      <div style="text-align:right">bentocache</div>
      <div style="text-align:right">lazy-layers</div>
      <div style="text-align:right">Saved</div>
      <div>Encoding chosen</div>
    </div>
    ${rows}
  </div>`;
}

/* ── Honest tradeoff panel ───────────────────────────────────────────── */

export function tradeoff(): string {
  const serMin = Math.min(...BENCH.map((r) => r.serRatio));
  const serMax = Math.max(...BENCH.map((r) => r.serRatio));
  const deMin = Math.min(...BENCH.map((r) => r.deRatio));
  const deMax = Math.max(...BENCH.map((r) => r.deRatio));

  return `
  <div class="tradeoff reveal">
    <div class="tradeoff__cell">
      <div class="tradeoff__k"><span class="tag tag--mint">win</span> Bytes stored</div>
      <div class="tradeoff__v"><strong>${SAVINGS_MIN}%–${SAVINGS_MAX}% smaller</strong> across all five fixtures.
      This is the metered resource on every managed Redis plan, and it is deterministic — the same payload
      always encodes to the same size.</div>
    </div>
    <div class="tradeoff__cell">
      <div class="tradeoff__k"><span class="tag tag--amber">cost</span> Serialize CPU</div>
      <div class="tradeoff__v"><strong>${serMin.toFixed(2)}×–${serMax.toFixed(2)}× the speed</strong> of
      <code class="mono">JSON.stringify</code>. V8's JSON encoder is native and extremely well optimised —
      we do not beat it, and we are not going to pretend we do.</div>
    </div>
    <div class="tradeoff__cell">
      <div class="tradeoff__k"><span class="tag tag--amber">cost</span> Deserialize CPU</div>
      <div class="tradeoff__v"><strong>${deMin.toFixed(2)}×–${deMax.toFixed(2)}×</strong> the speed of
      <code class="mono">JSON.parse</code>. The gap narrows on large payloads because there is simply
      less data to pull off the wire and decode.</div>
    </div>
    <div class="tradeoff__cell">
      <div class="tradeoff__k">When it pays</div>
      <div class="tradeoff__v">When <strong>bytes cost more than cycles</strong> — which is the usual shape of a
      Redis bill. Large, numeric, or repetitive payloads win hardest. Tiny keys serialized millions of
      times a second may well be better off on plain JSON.</div>
    </div>
  </div>`;
}

/* ── Serializer layers ───────────────────────────────────────────────── */

export function layers(): string {
  return `<div class="layers reveal-stagger">${LAYERS.map((l) => `
    <article class="card card--spot card--lift layer">
      <div class="layer__code">${l.code}</div>
      <h3 class="layer__name">${esc(l.name)}</h3>
      <p class="layer__detail">${esc(l.detail)}</p>
      <div class="layer__when">${esc(l.when)}</div>
    </article>`).join('')}</div>`;
}

/* ── FAQ (mirrored into JSON-LD below) ───────────────────────────────── */

export function faq(): string {
  return `<div class="faq reveal">${FAQS.map((f, i) => `
    <div class="faq__item" data-faq>
      <h3 style="margin:0">
        <button class="faq__q" aria-expanded="false" aria-controls="faq-a-${i}" id="faq-q-${i}">
          <span>${esc(f.q)}</span>
          <span class="faq__icon" aria-hidden="true"></span>
        </button>
      </h3>
      <div class="faq__a" id="faq-a-${i}" role="region" aria-labelledby="faq-q-${i}">
        <div><p>${esc(f.a)}</p></div>
      </div>
    </div>`).join('')}</div>`;
}

export function faqJsonLd(): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQS.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  });
}

/* ── Stat bar ────────────────────────────────────────────────────────── */

export function statbar(): string {
  const cells = [
    { v: `${SAVINGS_MAX}%`, n: SAVINGS_MAX, suffix: '%', l: 'Smaller on the wire for a 400-record catalog vs. JSON' },
    { v: `${SAVINGS_MIN}%`, n: SAVINGS_MIN, suffix: '%', l: 'Smallest saving we measured — a 50-item API list' },
    { v: '3', n: 3, suffix: '', l: 'Wire encodings, picked per payload at write time' },
    { v: '0', n: 0, suffix: '', l: 'Infrastructure needed to start — L1 runs in-process' },
  ];
  return `<div class="statbar reveal">${cells.map((c) => `
    <div class="statbar__cell">
      <div class="statbar__val" data-count="${c.n}" data-suffix="${c.suffix}">${c.v}</div>
      <div class="statbar__label">${esc(c.l)}</div>
    </div>`).join('')}</div>`;
}

export function iso(): string {
  return `<div class="iso reveal">${isoDiagram()}</div>`;
}

export function benchMeta(): string {
  return `Measured on Node ${BENCH_META.node} · ${BENCH_META.cpu} · bentocache ${BENCH_META.bentocache}
          vs lazy-layers-cache ${BENCH_META.lazyLayers} · byte counts deterministic, throughput median of ${BENCH_META.reps} reps`;
}
