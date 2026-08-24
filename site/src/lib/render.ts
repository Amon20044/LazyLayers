/**
 * HTML fragment builders. These run at BUILD time (see the vite plugin in
 * vite.config.ts) so the shipped index.html is fully static — crawlers and the
 * first paint both get real content, no hydration required.
 */

import {
  BENCH, saved, FAQS, BENCH_META, SAVINGS_MIN, SAVINGS_MAX, WIRE_EVENTS,
} from './data';
import { BUDGET } from './bytes';
import { isoDiagram } from './iso';
import { staleDiagram, fanoutDiagram } from './diagrams';
import { byteViz, BYTE_LEGEND } from './byteviz';
import { bento as bentoGrid } from './bento';
import { icon, BRAND, TITLE, type IconName } from './icons';

const bytes = (b: number) =>
  b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} kB` : `${b} B`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ── Diagrams ────────────────────────────────────────────────────────── */

export const iso = () => `<div class="iso reveal">${isoDiagram()}</div>`;
export const stale = () => `<figure class="iso iso--inset reveal">${staleDiagram()}</figure>`;
export const fanout = () => `<figure class="iso iso--inset reveal">${fanoutDiagram()}</figure>`;
export const bento = () => bentoGrid();

/* ── Byte story ──────────────────────────────────────────────────────── */

export function byteStory(): string {
  const wastePct = Math.round(((BUDGET.structural + BUDGET.keys) / BUDGET.total) * 100);
  return `
  <div class="bytes reveal">
    <div class="bytes__viz">${byteViz()}</div>
    <div class="bytes__legend">
      ${BYTE_LEGEND.map((l) => `
        <div class="bytes__key">
          <i style="background:${l.fill}"></i>
          <span>${esc(l.label)}</span>
          <b>${l.value} B</b>
        </div>`).join('')}
      <div class="bytes__key bytes__key--out">
        <i style="background:linear-gradient(135deg,#5EEAD4,#22D3EE)"></i>
        <span>MessagePack, all of it</span>
        <b>${BUDGET.binaryTotal} B</b>
      </div>
    </div>
    <p class="bytes__punch">
      <strong>${BUDGET.structural + BUDGET.keys} of ${BUDGET.total} bytes</strong> — ${wastePct}% of that record —
      is punctuation and key names you already know. The binary encoding fits the
      <em>whole</em> record into less than JSON spends on values alone.
    </p>
  </div>`;
}

/* ── Benchmarks ──────────────────────────────────────────────────────── */

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
      <div>Payload</div><div style="text-align:right">bentocache</div>
      <div style="text-align:right">lazy-layers</div><div style="text-align:right">Saved</div>
      <div>Encoding chosen</div>
    </div>
    ${rows}
  </div>`;
}

export function tradeoff(): string {
  const serMin = Math.min(...BENCH.map((r) => r.serRatio));
  const serMax = Math.max(...BENCH.map((r) => r.serRatio));
  const deMin = Math.min(...BENCH.map((r) => r.deRatio));
  const deMax = Math.max(...BENCH.map((r) => r.deRatio));

  return `
  <div class="tradeoff reveal">
    <div class="tradeoff__cell">
      <div class="tradeoff__k"><span class="tag tag--mint">win</span> Bytes stored</div>
      <div class="tradeoff__v"><strong>${SAVINGS_MIN}%–${SAVINGS_MAX}% smaller.</strong> The metered resource on
      every managed Redis plan, and deterministic — the same payload always encodes to the same size.</div>
    </div>
    <div class="tradeoff__cell">
      <div class="tradeoff__k"><span class="tag tag--amber">cost</span> Serialize CPU</div>
      <div class="tradeoff__v"><strong>${serMin.toFixed(2)}×–${serMax.toFixed(2)}×</strong> the speed of
      <code class="mono">JSON.stringify</code>. V8's encoder is native. We do not beat it.</div>
    </div>
    <div class="tradeoff__cell">
      <div class="tradeoff__k"><span class="tag tag--amber">cost</span> Deserialize CPU</div>
      <div class="tradeoff__v"><strong>${deMin.toFixed(2)}×–${deMax.toFixed(2)}×</strong> the speed of
      <code class="mono">JSON.parse</code>. The gap narrows on big payloads — less data to move.</div>
    </div>
    <div class="tradeoff__cell">
      <div class="tradeoff__k">When it pays</div>
      <div class="tradeoff__v">When <strong>bytes cost more than cycles</strong>. Large, numeric or repetitive
      payloads win hardest. Tiny keys at millions of ops/sec may not.</div>
    </div>
  </div>`;
}

/* ── Serializer / FAQ / stats ────────────────────────────────────────── */

export function faq(): string {
  return `<div class="faq reveal">${FAQS.map((f, i) => `
    <div class="faq__item" data-faq>
      <h3 style="margin:0">
        <button class="faq__q" aria-expanded="false" aria-controls="faq-a-${i}" id="faq-q-${i}">
          <span>${esc(f.q)}</span><span class="faq__icon" aria-hidden="true"></span>
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
      '@type': 'Question', name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  });
}

export function statbar(): string {
  const cells = [
    { n: 3, suffix: '', v: '3', l: 'Event types keeping every peer in sync' },
    { n: 4, suffix: '', v: '4', l: 'Transports, from at-most-once to durable' },
    { n: SAVINGS_MAX, suffix: '%', v: `${SAVINGS_MAX}%`, l: 'Smaller on the wire, measured not estimated' },
    { n: 0, suffix: '', v: '0', l: 'Infrastructure needed to start' },
  ];
  return `<div class="statbar reveal">${cells.map((c) => `
    <div class="statbar__cell">
      <div class="statbar__val" data-count="${c.n}" data-suffix="${c.suffix}">${c.v}</div>
      <div class="statbar__label">${esc(c.l)}</div>
    </div>`).join('')}</div>`;
}

/* ── What travels on the wire ────────────────────────────────────────── */

export function wireEvents(): string {
  return `<div class="wire reveal-stagger">${WIRE_EVENTS.map((e) => `
    <article class="wire__card${e.carriesValue ? ' wire__card--value' : ''}">
      <header class="wire__head">
        <code class="wire__type">${esc(e.type)}</code>
        <span class="wire__headline">${esc(e.headline)}</span>
        <span class="wire__flag">${e.carriesValue ? 'carries a value' : 'no value'}</span>
      </header>
      <pre class="wire__payload"><code>${esc(e.payload)}</code></pre>
      <p class="wire__effect">${esc(e.effect)}</p>
    </article>`).join('')}</div>`;
}

/* ── Integration strip ───────────────────────────────────────────────── */

const STACK: Array<{ id: IconName; name?: string; role: string }> = [
  { id: 'node',    name: 'Node.js 20+', role: 'runtime' },
  { id: 'ts',                           role: 'types built in' },
  { id: 'redis',                        role: 'L2 store · pub/sub' },
  { id: 'rabbit',                       role: 'durable bus' },
  { id: 'nats',                         role: 'core · JetStream' },
  { id: 'msgpack',                      role: 'wire format' },
];

export function stack(): string {
  return `
  <div class="stack reveal" aria-label="Technologies LazyLayers integrates with">
    <span class="stack__lede">Works with</span>
    <ul class="stack__list">
      ${STACK.map((t) => `
        <li class="stack__item" style="--brand:${BRAND[t.id]}">
          ${icon(t.id, 20)}
          <span class="stack__name">${esc(t.name ?? TITLE[t.id])}</span>
          <span class="stack__role">${esc(t.role)}</span>
        </li>`).join('')}
    </ul>
  </div>`;
}

export function benchMeta(): string {
  return `Node ${BENCH_META.node} · ${BENCH_META.cpu} · bentocache ${BENCH_META.bentocache} vs
          lazy-layers-cache ${BENCH_META.lazyLayers} · byte counts deterministic, throughput median of ${BENCH_META.reps} reps`;
}
