/**
 * Bento grid. Each cell carries one idea as a picture and one line of label —
 * the prose that used to explain these lives in the FAQ instead.
 */

import { TRANSPORTS } from './data';
import { markAt, BRAND, type IconName } from './icons';

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
  // Index-matched to TRANSPORTS: Redis Pub/Sub, NATS Core, RabbitMQ, NATS JetStream.
  const ICONS: IconName[] = ['redis', 'nats', 'rabbit', 'nats'];

  return `<svg viewBox="0 0 300 108" class="viz" aria-hidden="true">
    ${TRANSPORTS.map((t, i) => {
      const x = (i % 2) * 152 + 2;
      const y = Math.floor(i / 2) * 52 + 2;
      const on = t.durable;
      return `<g transform="translate(${x},${y})">
        <rect width="144" height="44" rx="9" fill="${on ? 'rgba(52,211,153,0.07)' : 'rgba(255,255,255,0.035)'}"
              stroke="${on ? 'rgba(52,211,153,0.4)' : 'rgba(255,255,255,0.13)'}"/>
        ${markAt(ICONS[i], 10, 12, 20, BRAND[ICONS[i]])}
        <text x="38" y="19" font-family="Inter,sans-serif" font-size="10" font-weight="500" fill="#E8E8EE">${t.name}</text>
        <text x="38" y="33" font-family="'JetBrains Mono',monospace" font-size="9"
              fill="${on ? '#6EE7B7' : '#B4B5C4'}" letter-spacing="0.08em">${t.delivery.toUpperCase()}</text>
      </g>`;
    }).join('')}
  </svg>`;
}

/** E: ten thousand concurrent callers collapse into a single origin query. */
function vizHerd(): string {
  const FAN = 34;
  const lines: string[] = [];
  const packets: string[] = [];

  for (let i = 0; i < FAN; i++) {
    const t = i / (FAN - 1);
    const y = 10 + t * 116;
    const d = `M 122 ${y.toFixed(1)} C 206 ${y.toFixed(1)}, 244 75, 286 75`;
    // Middle strands sit brightest so the bundle reads as a beam, not a mesh.
    const op = (0.5 - Math.abs(t - 0.5) * 0.45).toFixed(2);
    lines.push(`<path d="${d}" fill="none" stroke="#A855F7" stroke-width="0.9" opacity="${op}"/>`);
    if (i % 3 === 0) {
      packets.push(`<circle r="2.2" fill="#DDD6FE" class="packet"
        style="offset-path:path('${d}');animation-delay:${((i / FAN) * 2.4).toFixed(2)}s"/>`);
    }
  }

  return `<svg viewBox="0 0 620 150" class="viz viz--a" aria-hidden="true">
    <defs>
      <marker id="bn-a" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
        <path d="M0 0 L7 3.5 L0 7 Z" fill="#A855F7"/>
      </marker>
      <radialGradient id="bn-hub"><stop offset="0%" stop-color="#C4B5FD"/><stop offset="100%" stop-color="#7C3AED"/></radialGradient>
    </defs>

    <!-- the herd -->
    <text x="0" y="62" font-family="Inter,system-ui,sans-serif" font-size="30" font-weight="600" fill="#F4F4F8">10,000</text>
    <text x="0" y="80" font-family="'JetBrains Mono',monospace" font-size="10" fill="#A2A3B4" letter-spacing="0.06em">CONCURRENT</text>
    <text x="0" y="94" font-family="'JetBrains Mono',monospace" font-size="10" fill="#A2A3B4" letter-spacing="0.06em">CALLERS</text>
    ${lines.join('')}

    <!-- the collapse -->
    <circle cx="308" cy="75" r="21" fill="url(#bn-hub)" opacity="0.22"/>
    <circle cx="308" cy="75" r="21" fill="none" stroke="#A855F7" stroke-width="1.4"/>
    <text x="308" y="82" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="21" font-weight="600" fill="#EDE9FE">1</text>
    <text x="308" y="44" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9.5" fill="#A2A3B4" letter-spacing="0.06em">IN-FLIGHT</text>

    <!-- the single origin query -->
    <path d="M 332 75 L 424 75" stroke="#A855F7" stroke-width="1.8" marker-end="url(#bn-a)"/>
    <text x="378" y="66" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9.5" fill="#C4B5FD" letter-spacing="0.06em">1 QUERY</text>
    <rect x="434" y="52" width="120" height="46" rx="11" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.18)"/>
    <text x="494" y="72" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="500" fill="#E8E8EE">ORIGIN</text>
    <text x="494" y="87" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9" fill="#A2A3B4" letter-spacing="0.05em">db · api</text>

    <!-- and the 9,999 that never touched it -->
    <path d="M 292 98 C 244 124, 178 124, 126 112" fill="none" stroke="#34D399" stroke-width="1.2"
          stroke-dasharray="4 4" opacity="0.8" marker-end="url(#bn-back)"/>
    <text x="209" y="143" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9.5"
          fill="#6EE7B7" letter-spacing="0.05em">9,999 SERVED FROM THE SAME PROMISE</text>
    <defs><marker id="bn-back" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
      <path d="M0 0 L7 3.5 L0 7 Z" fill="#34D399"/></marker></defs>

    ${packets.join('')}
  </svg>`;
}

/** G: a publish fails, so the event is buffered and flushed on the next one. */
function vizRetry(): string {
  const q = Array.from({ length: 4 }, (_, i) => `
    <rect x="${(96 + i * 26).toFixed(0)}" y="44" width="22" height="22" rx="5"
          fill="rgba(251,191,36,0.14)" stroke="rgba(251,191,36,0.5)"/>`).join('');

  return `<svg viewBox="0 0 300 108" class="viz" aria-hidden="true">
    <rect x="4" y="42" width="62" height="26" rx="8" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.18)"/>
    <text x="35" y="59" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9.5" fill="#B4B5C4">publish</text>

    <g class="stale-blink">
      <path d="M 70 55 L 88 55" stroke="rgba(244,63,94,0.5)" stroke-width="1.3" stroke-dasharray="3 3"/>
      <g transform="translate(79,55)">
        <line x1="-4" y1="-4" x2="4" y2="4" stroke="#F43F5E" stroke-width="1.7" stroke-linecap="round"/>
        <line x1="4" y1="-4" x2="-4" y2="4" stroke="#F43F5E" stroke-width="1.7" stroke-linecap="round"/>
      </g>
    </g>

    ${q}
    <text x="150" y="34" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9"
          fill="#FBBF24" letter-spacing="0.06em">BUFFERED · BOUNDED</text>

    <path d="M 206 55 L 236 55" stroke="rgba(52,211,153,0.6)" stroke-width="1.5" marker-end="url(#bn-ok2)"/>
    <rect x="242" y="42" width="54" height="26" rx="8" fill="rgba(52,211,153,0.09)" stroke="rgba(52,211,153,0.45)"/>
    <text x="269" y="59" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9.5" fill="#6EE7B7">bus</text>
    <text x="150" y="86" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="9"
          fill="#A2A3B4" letter-spacing="0.05em">FLUSHED ON THE NEXT SUCCESS</text>

    <defs><marker id="bn-ok2" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
      <path d="M0 0 L6 3 L0 6 Z" fill="rgba(52,211,153,0.8)"/></marker></defs>
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

interface Step {
  span: string;
  /**
   * The failure MODE — named the way an incident review would name it. This is
   * a property of distributed caching, never a claim about this library, which
   * is why it is a noun and not a "fails when" clause.
   */
  risk: string;
  /** The guarantee. Leads, because that is the thing being offered. */
  answer: string;
  /** How it is actually achieved. */
  detail: string;
  viz: string;
  flow?: { seed: number; hue: string };
}

/**
 * The order you actually hit these problems in. Each step is the failure that
 * pushes you to the next one — which is why they read top to bottom.
 */
const STEPS: Step[] = [
  {
    span: 'b',
    risk: 'L2 unavailable',
    answer: 'Requests still land.',
    detail: 'Redis going slow or dark drops you to L1 instead of throwing, and a circuit breaker stops hammering a store that is already unwell.',
    viz: vizFailOpen(), flow: { seed: 11, hue: 'mint' },
  },
  {
    span: 'e',
    risk: 'Cache stampede',
    answer: 'Ten thousand callers, one query.',
    detail: 'Concurrent callers on a cold key share a single in-flight promise, so your origin is asked once.',
    viz: vizHerd(), flow: { seed: 7, hue: 'violet' },
  },
  {
    span: 'a',
    risk: 'Stale peers',
    answer: 'Every node agrees.',
    detail: 'A write fans out over the bus. Peers drop the key, or take the new value straight into L1 without calling a loader.',
    viz: vizFanout(), flow: { seed: 3, hue: 'cyan' },
  },
  {
    span: 'c',
    risk: 'Out-of-order delivery',
    answer: 'A late event cannot resurrect deleted data.',
    detail: 'Per-key generations refuse anything older than what was already applied. Event IDs are deduplicated, and your own broadcasts are filtered out.',
    viz: vizGeneration(), flow: { seed: 19, hue: 'cyan' },
  },
  {
    span: 'd',
    risk: 'Missed while offline',
    answer: 'You choose the delivery guarantee.',
    detail: 'At-most-once is the fastest fanout. Durable transports buffer for a disconnected instance and redeliver on reconnect.',
    viz: vizTransports(), flow: { seed: 23, hue: 'mint' },
  },
  {
    span: 'g',
    risk: 'Bus unavailable',
    answer: 'A rejected publish is not a lost event.',
    detail: 'It is buffered in a bounded queue and flushed on the next success. Oldest drops first, so a long outage cannot grow without limit.',
    viz: vizRetry(), flow: { seed: 29, hue: 'cyan' },
  },
  {
    span: 'f',
    risk: 'Storage cost',
    answer: 'Three encodings, chosen per payload.',
    detail: 'Picked at write time and tagged with a 4-byte prefix, so the read path stays uniform whichever one was used.',
    viz: vizEncodings(), flow: { seed: 5, hue: 'cyan' },
  },
];

export function bento(): string {
  return `<ol class="bento reveal-stagger">${STEPS.map((st, i) => `
    <li class="bento__cell bento__cell--${st.span}">
      ${st.flow ? flowLines(st.flow.seed, 14, st.flow.hue) : ''}
      <span class="bento__no">${String(i + 1).padStart(2, '0')}</span>
      <div class="bento__viz">${st.viz}</div>
      <div class="bento__foot">
        <span class="bento__risk">${st.risk}</span>
        <p class="bento__answer">${st.answer}</p>
        <p class="bento__detail">${st.detail}</p>
      </div>
    </li>`).join('')}</ol>`;
}
