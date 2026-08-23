/**
 * Bento grid. Each cell carries one idea as a picture and one line of label —
 * the prose that used to explain these lives in the FAQ instead.
 */

import { TRANSPORTS } from './data';

/* ── Animated flow-line backdrop ──────────────────────────────────────── */

/**
 * A bundle of bezier curves that drift slowly across the card. Deterministic
 * from `seed` so a given cell always draws the same bundle.
 */
export function flowLines(seed: number, count = 14, hue = 'cyan'): string {
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);

  const stroke = hue === 'mint' ? '#34D399' : hue === 'violet' ? '#A855F7' : '#22D3EE';

  // One shared sweep, offset in small parallel steps — a ribbon, not a scribble.
  const baseY = 24 + rnd() * 40;
  const drop = 74 + rnd() * 40;
  const step = 5.4;
  const paths: string[] = [];

  for (let i = 0; i < count; i++) {
    const o = i * step;
    const jitter = (rnd() - 0.5) * 3;
    const y0 = baseY + o;
    const y1 = baseY + drop + o * 0.72 + jitter;
    const t = i / (count - 1);

    paths.push(
      `<path d="M -30 ${y0.toFixed(1)} C 90 ${(y0 - 16).toFixed(1)}, 190 ${(y1 + 20).toFixed(1)}, 330 ${y1.toFixed(1)}"
         fill="none" stroke="${stroke}" stroke-width="0.8" stroke-linecap="round"
         opacity="${(0.42 - Math.abs(t - 0.5) * 0.5).toFixed(2)}" style="--d:${(i * 0.13).toFixed(2)}s"/>`,
    );
  }

  return `<svg class="flow" viewBox="0 0 300 210" preserveAspectRatio="none" aria-hidden="true">
    <g class="flow__g">${paths.join('')}</g>
  </svg>`;
}

/* ── Cell visuals ─────────────────────────────────────────────────────── */

/** A: one publish, every peer applies. */
function vizFanout(): string {
  const node = (x: number, on: boolean, i: number) => `
    <g transform="translate(${x},30)">
      <rect x="-28" y="-19" width="56" height="38" rx="9"
            fill="${on ? 'rgba(34,211,238,0.16)' : 'rgba(255,255,255,0.04)'}"
            stroke="${on ? 'rgba(34,211,238,0.75)' : 'rgba(255,255,255,0.14)'}" stroke-width="1"/>
      <rect x="-12" y="-7" width="24" height="14" rx="3.5" fill="url(#bn-chip)" opacity="${on ? 1 : 0.4}"
            class="node-pulse${i === 1 ? ' node-pulse--b' : i === 2 ? ' node-pulse--c' : ''}"/>
    </g>`;

  const xs = [110, 310, 510];
  const wires = xs.map((x, i) => `
    <path d="M ${x} 56 L ${x} 96 Q ${x} 112 ${x > 310 ? x - 20 : x < 310 ? x + 20 : x} 112 L 310 112"
          fill="none" stroke="rgba(34,211,238,0.45)" stroke-width="1.3" class="wire-flow"/>
    <circle r="3" fill="#67E8F9" class="packet" style="animation-delay:${(i * 0.7).toFixed(1)}s;
      offset-path:path('M ${x} 56 L ${x} 96 Q ${x} 112 ${x > 310 ? x - 20 : x < 310 ? x + 20 : x} 112 L 310 112')"/>`).join('');

  return `<svg viewBox="0 0 620 150" class="viz viz--a" aria-hidden="true">
    <defs><linearGradient id="bn-chip" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#5EEAD4"/><stop offset="100%" stop-color="#22D3EE"/>
    </linearGradient></defs>
    ${xs.map((x, i) => node(x, true, i)).join('')}
    ${wires}
    <rect x="266" y="100" width="88" height="24" rx="7" fill="rgba(34,211,238,0.14)" stroke="rgba(34,211,238,0.7)"/>
    <text x="310" y="116" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="10"
          fill="#A5F3FC" letter-spacing="0.1em">BUS</text>
  </svg>`;
}

/** B: L2 falls over and the request still lands on L1. */
function vizFailOpen(): string {
  return `<svg viewBox="0 0 300 108" class="viz" aria-hidden="true">
    <rect x="4" y="40" width="66" height="28" rx="8" fill="rgba(255,255,255,0.045)" stroke="rgba(255,255,255,0.16)"/>
    <text x="37" y="58" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9.5" fill="#9A9AA4" letter-spacing="0.06em">REQUEST</text>

    <path d="M 72 54 L 108 54" stroke="rgba(52,211,153,0.6)" stroke-width="1.4" marker-end="url(#bn-g)"/>

    <rect x="112" y="34" width="72" height="40" rx="9" fill="rgba(52,211,153,0.1)" stroke="rgba(52,211,153,0.55)"/>
    <text x="148" y="52" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9.5" fill="#6EE7B7" letter-spacing="0.06em">L1</text>
    <text x="148" y="64" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9" fill="#6EE7B7">SERVED</text>

    <g class="stale-blink">
      <path d="M 186 54 L 214 54" stroke="rgba(244,63,94,0.45)" stroke-width="1.4" stroke-dasharray="3 3"/>
      <g transform="translate(200,54)">
        <line x1="-5" y1="-5" x2="5" y2="5" stroke="#F43F5E" stroke-width="1.8" stroke-linecap="round"/>
        <line x1="5" y1="-5" x2="-5" y2="5" stroke="#F43F5E" stroke-width="1.8" stroke-linecap="round"/>
      </g>
      <rect x="220" y="38" width="74" height="32" rx="8" fill="rgba(244,63,94,0.07)" stroke="rgba(244,63,94,0.35)"/>
      <text x="257" y="52" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9.5" fill="#FDA4AF" letter-spacing="0.06em">L2</text>
      <text x="257" y="63" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9" fill="#FDA4AF">DOWN</text>
    </g>

    <defs><marker id="bn-g" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
      <path d="M0 0 L6 3 L0 6 Z" fill="rgba(52,211,153,0.75)"/></marker></defs>
  </svg>`;
}

/** C: a stale set arrives after a newer delete and is refused. */
function vizGeneration(): string {
  return `<svg viewBox="0 0 300 108" class="viz" aria-hidden="true">
    <rect x="112" y="34" width="76" height="40" rx="9" fill="rgba(255,255,255,0.045)" stroke="rgba(255,255,255,0.16)"/>
    <text x="150" y="52" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9.5" fill="#B4B5C4" letter-spacing="0.08em">KEY</text>
    <text x="150" y="65" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9.5" fill="#5EEAD4">gen 7</text>

    <g>
      <rect x="6" y="20" width="76" height="20" rx="6" fill="rgba(52,211,153,0.12)" stroke="rgba(52,211,153,0.55)"/>
      <text x="44" y="33.5" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9.5" fill="#6EE7B7">del · gen 7</text>
      <path d="M 84 30 L 108 42" stroke="rgba(52,211,153,0.6)" stroke-width="1.3" marker-end="url(#bn-ok)"/>
    </g>

    <g class="stale-blink">
      <rect x="6" y="68" width="76" height="20" rx="6" fill="rgba(244,63,94,0.1)" stroke="rgba(244,63,94,0.5)"/>
      <text x="44" y="81.5" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9.5" fill="#FDA4AF">set · gen 6</text>
      <path d="M 84 78 L 104 68" stroke="rgba(244,63,94,0.55)" stroke-width="1.3" stroke-dasharray="3 3"/>
      <g transform="translate(107,64)">
        <line x1="-5" y1="-5" x2="5" y2="5" stroke="#F43F5E" stroke-width="1.8" stroke-linecap="round"/>
        <line x1="5" y1="-5" x2="-5" y2="5" stroke="#F43F5E" stroke-width="1.8" stroke-linecap="round"/>
      </g>
    </g>

    <text x="196" y="57" font-family="'JetBrains Mono',monospace" font-size="9" fill="#9698AC" letter-spacing="0.08em">OLDER GEN</text>
    <text x="196" y="68" font-family="'JetBrains Mono',monospace" font-size="9" fill="#9698AC" letter-spacing="0.08em">REFUSED</text>

    <defs><marker id="bn-ok" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
      <path d="M0 0 L6 3 L0 6 Z" fill="rgba(52,211,153,0.75)"/></marker></defs>
  </svg>`;
}

/** D: four transports, split by delivery guarantee. */
function vizTransports(): string {
  return `<svg viewBox="0 0 300 108" class="viz" aria-hidden="true">
    ${TRANSPORTS.map((t, i) => {
      const x = (i % 2) * 152 + 2;
      const y = Math.floor(i / 2) * 52 + 2;
      const on = t.durable;
      return `<g transform="translate(${x},${y})">
        <rect width="144" height="44" rx="9" fill="${on ? 'rgba(52,211,153,0.07)' : 'rgba(255,255,255,0.035)'}"
              stroke="${on ? 'rgba(52,211,153,0.4)' : 'rgba(255,255,255,0.13)'}"/>
        <text x="12" y="19" font-family="Inter,sans-serif" font-size="10" font-weight="500" fill="#E8E8EE">${t.name}</text>
        <text x="12" y="33" font-family="'JetBrains Mono',monospace" font-size="9"
              fill="${on ? '#6EE7B7' : '#8A8A94'}" letter-spacing="0.08em">${t.delivery.toUpperCase()}</text>
      </g>`;
    }).join('')}
  </svg>`;
}

/** E: many concurrent callers collapse into one loader call. */
function vizStampede(): string {
  const arrows = Array.from({ length: 7 }, (_, i) => {
    const y = 12 + i * 13;
    return `<path d="M 6 ${y} Q 74 ${y}, 118 54" fill="none" stroke="rgba(168,85,247,0.35)" stroke-width="1"/>
            <circle r="2" fill="#C4B5FD" class="packet" style="animation-delay:${(i * 0.16).toFixed(2)}s;
              offset-path:path('M 6 ${y} Q 74 ${y}, 118 54')"/>`;
  }).join('');

  return `<svg viewBox="0 0 300 108" class="viz" aria-hidden="true">
    ${arrows}
    <circle cx="132" cy="54" r="13" fill="rgba(168,85,247,0.14)" stroke="rgba(168,85,247,0.6)"/>
    <text x="132" y="57.5" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9" fill="#DDD6FE">1</text>
    <path d="M 148 54 L 216 54" stroke="rgba(168,85,247,0.55)" stroke-width="1.4" marker-end="url(#bn-a)"/>
    <rect x="222" y="38" width="72" height="32" rx="8" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.16)"/>
    <text x="258" y="58" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="10" fill="#9A9AA4" letter-spacing="0.06em">ORIGIN</text>
    <defs><marker id="bn-a" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
      <path d="M0 0 L6 3 L0 6 Z" fill="rgba(168,85,247,0.7)"/></marker></defs>
  </svg>`;
}

/** F: the write-time encoding decision, with real sizes. */
function vizEncodings(): string {
  const out = (x: number, code: string, name: string, note: string, w: number, colour: string) => `
    <g transform="translate(${x},0)">
      <rect y="30" width="150" height="52" rx="10" fill="rgba(255,255,255,0.035)" stroke="rgba(255,255,255,0.13)"/>
      <text x="14" y="49" font-family="'JetBrains Mono',monospace" font-size="9.5" fill="${colour}" letter-spacing="0.1em">${code}</text>
      <text x="14" y="63" font-family="Inter,sans-serif" font-size="10.5" font-weight="500" fill="#E8E8EE">${name}</text>
      <text x="14" y="75" font-family="'JetBrains Mono',monospace" font-size="9" fill="#A2A3B4">${note}</text>
      <rect x="112" y="42" width="26" height="4" rx="2" fill="rgba(255,255,255,0.09)"/>
      <rect x="112" y="42" width="${w}" height="4" rx="2" fill="${colour}"/>
    </g>`;

  return `<svg viewBox="0 0 640 96" class="viz viz--wide" aria-hidden="true">
    ${out(0, 'HC1M', 'MessagePack', '< 64 kB', 16, '#5EEAD4')}
    ${out(164, 'HC1G', 'gzip(MessagePack)', '≥ 64 kB · saves ≥ 15%', 7, '#818CF8')}
    ${out(328, 'HC1J', 'JSON passthrough', 'CACHE_FORMAT=json', 26, '#FBBF24')}
    <g transform="translate(492,0)">
      <rect y="30" width="148" height="52" rx="10" fill="rgba(34,211,238,0.05)" stroke="rgba(34,211,238,0.28)"/>
      <text x="14" y="52" font-family="Inter,sans-serif" font-size="10.5" font-weight="500" fill="#A5F3FC">4-byte prefix</text>
      <text x="14" y="67" font-family="'JetBrains Mono',monospace" font-size="9" fill="#A2A3B4">decodes every format</text>
    </g>
  </svg>`;
}

/* ── Grid ─────────────────────────────────────────────────────────────── */

interface Cell {
  span: string;
  label: string;
  viz: string;
  flow?: { seed: number; hue: string };
}

const CELLS: Cell[] = [
  { span: 'a', label: 'One publish. Every peer applies it.', viz: vizFanout(),      flow: { seed: 3, hue: 'cyan' } },
  { span: 'b', label: 'Redis dies. Requests still land.',      viz: vizFailOpen(),   flow: { seed: 11, hue: 'mint' } },
  { span: 'c', label: 'A late event cannot resurrect deleted data.', viz: vizGeneration(), flow: { seed: 19, hue: 'cyan' } },
  { span: 'd', label: 'Pick your delivery guarantee.',        viz: vizTransports(), flow: { seed: 23, hue: 'mint' } },
  { span: 'e', label: 'Fifty callers, one loader call.',      viz: vizStampede(),   flow: { seed: 7, hue: 'violet' } },
  { span: 'f', label: 'Three encodings, chosen at write time.', viz: vizEncodings(), flow: { seed: 5, hue: 'cyan' } },
];

export function bento(): string {
  return `<div class="bento reveal-stagger">${CELLS.map((c) => `
    <article class="bento__cell bento__cell--${c.span}">
      ${c.flow ? flowLines(c.flow.seed, 16, c.flow.hue) : ''}
      <div class="bento__viz">${c.viz}</div>
      <p class="bento__label">${c.label}</p>
    </article>`).join('')}</div>`;
}
