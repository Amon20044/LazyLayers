/**
 * HTML fragment builders. These run at BUILD time (see the vite plugin in
 * vite.config.ts) so the shipped index.html is fully static — crawlers and the
 * first paint both get real content, no hydration required.
 */

import {
  BENCH, saved, FAQS, BENCH_META, SAVINGS_MIN, SAVINGS_MAX, WIRE_EVENTS,
  PILLARS, ADOPTION_STAGES, COMPARISON_ROWS, LIMITATIONS, TRANSPORTS,
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

/* ── Progressive Adoption ────────────────────────────────────────────── */

export function progressive(): string {
  return `
  <div class="progressive-grid reveal-stagger">
    ${ADOPTION_STAGES.map((s) => `
      <div class="prog-card">
        <div class="prog-card__head">
          <span class="prog-card__step">${s.stage}</span>
          <span class="prog-card__scope">${esc(s.scope)}</span>
        </div>
        <h3 class="prog-card__title">${esc(s.title)}</h3>
        <p class="prog-card__desc">${esc(s.detail)}</p>
        <pre class="prog-card__code"><code>${esc(s.code)}</code></pre>
      </div>`).join('')}
  </div>`;
}

/* ── Four Production Pillars ──────────────────────────────────────────── */

export function pillars(): string {
  return `
  <div class="pillars-grid reveal-stagger">
    ${PILLARS.map((p) => `
      <div class="pillar-card">
        <div class="pillar-card__head">
          <h3 class="pillar-card__title">${esc(p.title)}</h3>
          <span class="pillar-card__headline">${esc(p.headline)}</span>
        </div>
        <p class="pillar-card__desc">${esc(p.description)}</p>
        <ul class="pillar-card__bullets">
          ${p.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}
        </ul>
      </div>`).join('')}
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
      <div class="bench__num" data-label="Raw JSON">${bytes(r.jsonBytes)}</div>
      <div class="bench__num" data-label="BentoCache">${bytes(r.bentoBytes)}</div>
      <div class="bench__num bench__num--win" data-label="LazyLayers">${bytes(r.llBytes)}</div>
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
      <div style="text-align:right">Raw JSON</div>
      <div style="text-align:right">BentoCache Default</div>
      <div style="text-align:right">LazyLayers</div>
      <div style="text-align:right">Saved</div>
      <div>Encoding chosen</div>
    </div>
    ${rows}
  </div>`;
}

export function tradeoff(): string {
  return `
  <div class="tradeoff reveal">
    <div class="tradeoff__cell">
      <div class="tradeoff__k"><span class="tag tag--mint">measured win</span> Redis payload size</div>
      <div class="tradeoff__v"><strong>${SAVINGS_MIN}%–${SAVINGS_MAX}% smaller on the wire.</strong> The metered resource on
      every managed Redis plan (memory, network transfer, replica bandwidth). Deterministic across any machine.</div>
    </div>
    <div class="tradeoff__cell">
      <div class="tradeoff__k"><span class="tag tag--amber">trade-off</span> Serialization CPU</div>
      <div class="tradeoff__v"><strong>0.38×–0.93×</strong> the speed of <code class="mono">JSON.stringify</code>. We deliberately spend CPU cycles at cache write/read boundaries to dramatically reduce bytes stored and transmitted.</div>
    </div>
    <div class="tradeoff__cell">
      <div class="tradeoff__k"><span class="tag tag--amber">trade-off</span> Deserialization CPU</div>
      <div class="tradeoff__v"><strong>0.56×–0.79×</strong> the speed of <code class="mono">JSON.parse</code>. Native V8 C++ parsers are heavily optimized; we trade a fraction of a millisecond for compact memory.</div>
    </div>
    <div class="tradeoff__cell">
      <div class="tradeoff__k">Total Redis Memory Context</div>
      <div class="tradeoff__v">Payload bytes are not total Redis memory consumption. Key names, Redis object headers, jemalloc allocator fragmentation, indexes, and replication buffers add overhead. Fewer payload bytes directly alleviate memory pressure.</div>
    </div>
  </div>`;
}

/* ── Comparison Table ─────────────────────────────────────────────────── */

export function comparisonTable(): string {
  return `
  <div class="compare-table-wrap reveal">
    <table class="compare-table">
      <thead>
        <tr>
          <th>Capability</th>
          <th class="th--highlight">LazyLayers</th>
          <th>BentoCache</th>
          <th>Keyv / Cacheable</th>
        </tr>
      </thead>
      <tbody>
        ${COMPARISON_ROWS.map((r) => `
          <tr>
            <td class="td-feature">${esc(r.feature)}</td>
            <td class="td-ll ${r.llStatus === 'win' ? 'td--win' : ''}">${esc(r.ll)}</td>
            <td class="${r.bentoStatus === 'win' ? 'td--comp-win' : ''}">${esc(r.bento)}</td>
            <td class="${r.keyvStatus === 'win' ? 'td--comp-win' : ''}">${esc(r.keyv)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <p class="compare-note">
      Feature set verified against BentoCache 1.6.x and Keyv/Cacheable latest releases. We let competitors win where they excel (broad multi-database ecosystems and deep tagging) so our architectural focus is clear.
    </p>
  </div>`;
}

/* ── Limitations Section ──────────────────────────────────────────────── */

export function limitations(): string {
  return `
  <div class="limitations-grid reveal-stagger">
    ${LIMITATIONS.map((l) => `
      <div class="limit-card">
        <div class="limit-card__icon">✕</div>
        <div class="limit-card__body">
          <h3 class="limit-card__title">${esc(l.title)}</h3>
          <p class="limit-card__reason">${esc(l.reason)}</p>
        </div>
      </div>`).join('')}
  </div>
  <div class="philosophy-box reveal">
    <p><em>“A cache should be allowed to be wrong for a bounded amount of time. If a value must never be stale, don't cache it.”</em></p>
  </div>`;
}

/* ── Transports Matrix ────────────────────────────────────────────────── */

export function transportMatrix(): string {
  return `
  <div class="transports-grid reveal-stagger">
    ${TRANSPORTS.map((t) => `
      <div class="transport-card ${t.durable ? 'transport-card--durable' : ''}">
        <div class="transport-card__head">
          <span class="transport-card__name">${esc(t.name)}</span>
          <span class="tag ${t.durable ? 'tag--mint' : 'tag--dim'}">${esc(t.delivery)}</span>
        </div>
        <p class="transport-card__note">${esc(t.note)}</p>
      </div>`).join('')}
  </div>`;
}

/* ── Observability Showcase ───────────────────────────────────────────── */

export function observabilityShowcase(): string {
  return `
  <div class="obs-showcase reveal">
    <div class="obs-showcase__preview">
      <div class="obs-window">
        <div class="obs-window__bar">
          <div class="code__dots"><i></i><i></i><i></i></div>
          <span class="obs-window__title">LazyLayers Inspector — <code>http://127.0.0.1:7077/__lazylayers</code></span>
          <span class="obs-window__tag">LIVE</span>
        </div>
        <div class="obs-window__body">
          <div class="obs-stats-row">
            <div class="obs-stat">
              <span class="obs-stat__label">L1 Hit Rate</span>
              <span class="obs-stat__val">94.8%</span>
              <span class="obs-stat__sub">12.4k req/s</span>
            </div>
            <div class="obs-stat">
              <span class="obs-stat__label">Inflight Coalesce</span>
              <span class="obs-stat__val">99.9%</span>
              <span class="obs-stat__sub">1 db loader / spike</span>
            </div>
            <div class="obs-stat">
              <span class="obs-stat__label">Redis Bytes Saved</span>
              <span class="obs-stat__val">−78.4%</span>
              <span class="obs-stat__sub">Zstd + LZ4 tiered</span>
            </div>
            <div class="obs-stat">
              <span class="obs-stat__label">Bus Propagation</span>
              <span class="obs-stat__val">&lt; 1.2ms</span>
              <span class="obs-stat__sub">Redis / NATS / Rabbit</span>
            </div>
          </div>
          <div class="obs-feed">
            <div class="obs-feed__head">Live Invalidation &amp; Priming Stream</div>
            <div class="obs-feed__item"><span class="tag tag--mint">SET PRIMED</span> <code>user:9841</code> fanned to 3 peers <span class="dim">· 284 B · L1 primed</span></div>
            <div class="obs-feed__item"><span class="tag tag--cyan">DEL</span> <code>session:x7f9</code> invalidated cluster-wide <span class="dim">· gen: 14</span></div>
            <div class="obs-feed__item"><span class="tag tag--violet">PATTERN</span> <code>catalog:prod:*</code> wiped 42 local L1 keys <span class="dim">· wildcard fanout</span></div>
          </div>
        </div>
      </div>
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
  { id: 'msgpack',                      role: 'lz4 · zstd · gzip' },
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
  return `Node ${BENCH_META.node} · ${BENCH_META.cpu} · BentoCache ${BENCH_META.bentocache} vs
          LazyLayers ${BENCH_META.lazyLayers} · byte counts deterministic, throughput median of ${BENCH_META.reps} reps`;
}

