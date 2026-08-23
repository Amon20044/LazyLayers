/**
 * Problem diagrams. One per idea, each carrying its own story so the copy
 * around it can stay short.
 */

import { slab, channel, proj, pts, rail, topCentre, isoLabel, ISO_DEFS, type Box, type V } from './isocore';

const NODE = { w: 84, d: 84, h: 11 };
const CHIP = { w: 44, d: 44, h: 16 };

const row = (spread: number, z: number): Box[] =>
  [-1, 0, 1].map((i) => ({ cx: i * spread, cy: -i * spread, z, ...NODE }));

const chipOf = (n: Box): Box => ({ cx: n.cx, cy: n.cy, z: n.z + n.h, ...CHIP });

const body = (n: Box) =>
  slab(n, { top: '#1E1E29', left: '#15151F', right: '#0D0D15', stroke: 'rgba(255,255,255,0.16)' });

/* ── 1. The problem: L1s drift apart ──────────────────────────────────── */

export function staleDiagram(): string {
  const nodes = row(104, 40);
  const chips = nodes.map(chipOf);

  // Node 1 wrote. Nodes 2 and 3 never heard about it.
  const state = [
    { grad: 'url(#chip-top)',   glow: '#22D3EE', label: 'WROTE',  sub: 'v2', cls: '' },
    { grad: 'url(#chip-stale)', glow: '#F43F5E', label: 'STALE',  sub: 'v1', cls: 'stale-blink' },
    { grad: 'url(#chip-stale)', glow: '#F43F5E', label: 'STALE',  sub: 'v1', cls: 'stale-blink stale-blink--b' },
  ];

  return `
<svg viewBox="-270 -132 540 156" role="img" aria-labelledby="sd-t sd-d" xmlns="http://www.w3.org/2000/svg">
  <title id="sd-t">Diverged L1 caches without an event bus</title>
  <desc id="sd-d">One instance writes a new value while two peers keep serving the previous version from their
    own in-process caches until their TTL expires.</desc>
  <defs>${ISO_DEFS}</defs>

  ${nodes.map((n, i) => `
    ${body(n)}
    ${slab(chips[i], {
      top: state[i].grad, left: '#0E7490', right: '#0A5A6E',
      stroke: 'rgba(255,255,255,0.28)', glow: state[i].glow, className: state[i].cls,
    })}
    ${isoLabel(topCentre(chips[i]), 0, -40, state[i].label, state[i].sub)}
  `).join('')}

  <!-- Severed links: the peers have no way to hear about the write -->
  ${nodes.slice(0, -1).map((n, i) => {
    const a = proj(n.cx + 46, n.cy - 46, n.z + 6);
    const b = proj(nodes[i + 1].cx - 46, nodes[i + 1].cy + 46, n.z + 6);
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    return `<path d="M ${a[0].toFixed(1)} ${a[1].toFixed(1)} L ${b[0].toFixed(1)} ${b[1].toFixed(1)}"
              stroke="#F43F5E" stroke-width="1.3" stroke-dasharray="4 5" opacity="0.5" fill="none"/>
            <g transform="translate(${mx.toFixed(1)},${my.toFixed(1)})" opacity="0.9">
              <line x1="-5" y1="-5" x2="5" y2="5" stroke="#F43F5E" stroke-width="1.8" stroke-linecap="round"/>
              <line x1="5" y1="-5" x2="-5" y2="5" stroke="#F43F5E" stroke-width="1.8" stroke-linecap="round"/>
            </g>`;
  }).join('')}
</svg>`;
}

/* ── 2. The fix: events fan out across channels ───────────────────────── */

export function fanoutDiagram(): string {
  const BUS_Z = 34;
  const nodes = row(104, 150);
  const chips = nodes.map(chipOf);
  const ports: V[] = nodes.map((n) => ({ x: n.cx, y: n.cy }));
  const hub: V = { x: 0, y: 0 };
  const R = 164;

  const risers = nodes.map((n) =>
    slab({ cx: n.cx, cy: n.cy, z: BUS_Z + 4, w: 13, d: 13, h: n.z - BUS_Z - 4 }, {
      top: 'rgba(34,211,238,0.5)', left: 'rgba(34,211,238,0.20)',
      right: 'rgba(34,211,238,0.11)', stroke: 'rgba(34,211,238,0.42)',
    }),
  ).join('');

  const lanes = ports.map((p, i) =>
    channel(hub, p, BUS_Z + 1, 26, 'url(#lane-fill)', 'rgba(34,211,238,0.5)', `lane lane--${i}`),
  ).join('');

  const pads = ports.map((p) =>
    slab({ cx: p.x, cy: p.y, z: BUS_Z, w: 34, d: 34, h: 3 }, {
      top: 'rgba(34,211,238,0.22)', left: 'rgba(14,116,144,0.4)',
      right: 'rgba(14,116,144,0.3)', stroke: 'rgba(34,211,238,0.6)',
    }),
  ).join('');

  // Node 1 publishes; the hub fans it back out to every peer.
  const packets = ports.map((p, i) => {
    const inbound = rail(p, hub, BUS_Z + 2);
    const drop = `M ${proj(p.x, p.y, nodes[i].z)[0].toFixed(1)} ${proj(p.x, p.y, nodes[i].z)[1].toFixed(1)} L ${proj(p.x, p.y, BUS_Z + 6)[0].toFixed(1)} ${proj(p.x, p.y, BUS_Z + 6)[1].toFixed(1)}`;
    return i === 0
      ? `<circle r="3.4" fill="#67E8F9" class="packet" style="offset-path:path('${drop}')"/>
         <circle r="3.4" fill="#67E8F9" class="packet" style="offset-path:path('${inbound}');animation-delay:.5s"/>`
      : `<circle r="3.4" fill="#5EEAD4" class="packet packet--rev" style="offset-path:path('${inbound}');animation-delay:1s"/>
         <circle r="3.4" fill="#5EEAD4" class="packet packet--rev" style="offset-path:path('${drop}');animation-delay:1.5s"/>`;
  }).join('');

  return `
<svg viewBox="-300 -240 600 388" role="img" aria-labelledby="fd-t fd-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fd-t">Event fanout across the invalidation bus</title>
  <desc id="fd-d">One instance publishes an event down its channel to the bus hub, which fans it back out along
    every other channel so all peers apply it.</desc>
  <defs>${ISO_DEFS}</defs>

  <polygon points="${pts([proj(R, -R, BUS_Z), proj(R, R, BUS_Z), proj(-R, R, BUS_Z), proj(-R, -R, BUS_Z)])}"
           fill="rgba(34,211,238,0.028)" stroke="rgba(34,211,238,0.34)" stroke-width="1.1" stroke-dasharray="5 6"/>
  ${lanes}
  ${pads}
  ${slab({ cx: 0, cy: 0, z: BUS_Z, w: 52, d: 52, h: 6 }, {
    top: 'url(#hub-top)', left: 'rgba(14,116,144,0.5)', right: 'rgba(14,116,144,0.38)',
    stroke: 'rgba(34,211,238,0.75)', glow: '#22D3EE',
  })}
  ${risers}

  ${nodes.map((n, i) => `
    ${body(n)}
    ${slab(chips[i], {
      top: 'url(#chip-top)', left: '#0E7490', right: '#0A5A6E', stroke: 'rgba(255,255,255,0.28)',
      glow: '#22D3EE', className: `node-pulse${i === 0 ? '' : i === 1 ? ' node-pulse--b' : ' node-pulse--c'}`,
    })}
    ${isoLabel(topCentre(chips[i]), 0, -40, i === 0 ? 'PUBLISHES' : 'APPLIES', i === 0 ? 'del · set' : 'L1 updated')}
  `).join('')}

  <g>${packets}</g>
</svg>`;
}
