/**
 * Problem diagrams. One per idea, each carrying its own story so the copy
 * around it can stay short.
 */

import { slab, slots, channel, proj, pts, rail, topCentre, isoLabel, ISO_DEFS, type Box, type V } from './isocore';
import { markAt, BRAND } from './icons';

const NODE = { w: 84, d: 84, h: 11 };
const CHIP = { w: 52, d: 52, h: 14 };

const row = (spread: number, z: number): Box[] =>
  [-1, 0, 1].map((i) => ({ cx: i * spread, cy: -i * spread, z, ...NODE }));

const chipOf = (n: Box): Box => ({ cx: n.cx, cy: n.cy, z: n.z + n.h, ...CHIP });

const body = (n: Box) =>
  slab(n, { kind: 'node' });

/* ── 1. The problem: L1s drift apart ──────────────────────────────────── */

export function staleDiagram(): string {
  const nodes = row(104, 40);
  const chips = nodes.map(chipOf);

  // Node 1 wrote. Nodes 2 and 3 never heard about it.
  const state = [
    { kind: 'chip' as const,       label: 'SERVER 1', sub: 'L1 · fresh v2', cls: '' },
    { kind: 'chip-stale' as const, label: 'SERVER 2', sub: 'L1 · stale v1', cls: 'stale-blink' },
    { kind: 'chip-stale' as const, label: 'SERVER 3', sub: 'L1 · stale v1', cls: 'stale-blink stale-blink--b' },
  ];

  return `
<svg viewBox="-270 -178 540 202" role="img" aria-labelledby="sd-t sd-d" xmlns="http://www.w3.org/2000/svg">
  <title id="sd-t">Diverged L1 caches without an event bus</title>
  <desc id="sd-d">One instance writes a new value while two peers keep serving the previous version from their
    own in-process caches until their TTL expires.</desc>
  <defs>${ISO_DEFS}</defs>

  ${nodes.map((n, i) => `
    ${body(n)}
    ${slab(chips[i], { kind: state[i].kind, glow: true, className: state[i].cls })}
    ${slots(chips[i], 3, i === 0 ? [0, 1, 2, 3, 4, 5, 7] : [0, 1, 3, 4, 7])}
    ${markAt('node', topCentre(chips[i])[0] - 13, topCentre(chips[i])[1] - 104, 26, BRAND.node)}
    ${isoLabel(topCentre(chips[i]), 0, -62, state[i].label, state[i].sub)}
  `).join('')}

  <!-- Severed links: the peers have no way to hear about the write -->
  ${nodes.slice(0, -1).map((n, i) => {
    const a = proj(n.cx + 46, n.cy - 46, n.z + 6);
    const b = proj(nodes[i + 1].cx - 46, nodes[i + 1].cy + 46, n.z + 6);
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    return `<path d="M ${a[0].toFixed(1)} ${a[1].toFixed(1)} L ${b[0].toFixed(1)} ${b[1].toFixed(1)}"
              class="d-cut" stroke-width="1.3" stroke-dasharray="4 5" opacity="0.5" fill="none"/>
            <g transform="translate(${mx.toFixed(1)},${my.toFixed(1)})" opacity="0.9">
              <line x1="-5" y1="-5" x2="5" y2="5" class="d-cut" stroke-width="1.8" stroke-linecap="round"/>
              <line x1="5" y1="-5" x2="-5" y2="5" class="d-cut" stroke-width="1.8" stroke-linecap="round"/>
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
    slab({ cx: n.cx, cy: n.cy, z: BUS_Z + 4, w: 13, d: 13, h: n.z - BUS_Z - 4 }, { kind: 'riser' }),
  ).join('');

  const lanes = ports.map((p, i) =>
    channel(hub, p, BUS_Z + 1, 26, `lane lane--${i}`),
  ).join('');

  const pads = ports.map((p) =>
    slab({ cx: p.x, cy: p.y, z: BUS_Z, w: 34, d: 34, h: 3 }, { kind: 'pad' }),
  ).join('');

  // Node 1 publishes; the hub fans it back out to every peer.
  const packets = ports.map((p, i) => {
    const inbound = rail(p, hub, BUS_Z + 2);
    const drop = `M ${proj(p.x, p.y, nodes[i].z)[0].toFixed(1)} ${proj(p.x, p.y, nodes[i].z)[1].toFixed(1)} L ${proj(p.x, p.y, BUS_Z + 6)[0].toFixed(1)} ${proj(p.x, p.y, BUS_Z + 6)[1].toFixed(1)}`;
    return i === 0
      ? `<circle r="3.4" class="packet d-packet" style="offset-path:path('${drop}')"/>
         <circle r="3.4" class="packet d-packet" style="offset-path:path('${inbound}');animation-delay:.5s"/>`
      : `<circle r="3.4" class="packet packet--rev d-packet-b" style="offset-path:path('${inbound}');animation-delay:1s"/>
         <circle r="3.4" class="packet packet--rev d-packet-b" style="offset-path:path('${drop}');animation-delay:1.5s"/>`;
  }).join('');

  return `
<svg viewBox="-300 -302 600 450" role="img" aria-labelledby="fd-t fd-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fd-t">Event fanout across the invalidation bus</title>
  <desc id="fd-d">One instance publishes an event down its channel to the bus hub, which fans it back out along
    every other channel so all peers apply it.</desc>
  <defs>${ISO_DEFS}</defs>

  <polygon points="${pts([proj(R, -R, BUS_Z), proj(R, R, BUS_Z), proj(-R, R, BUS_Z), proj(-R, -R, BUS_Z)])}"
           class="d-plane"/>
  ${lanes}
  ${pads}
  ${slab({ cx: 0, cy: 0, z: BUS_Z, w: 52, d: 52, h: 6 }, { kind: 'hub', glow: true })}
  <g transform="translate(0,${(proj(0, 0, BUS_Z)[1] + 54).toFixed(1)})" text-anchor="middle">
    <rect x="-118" y="-15" width="236" height="26" rx="7"
          class="d-chip-card"/>
    <text y="3" font-family="'JetBrains Mono',monospace" font-size="12" class="d-chip-text">
      { type: "del", keys: ["user:42"] }
    </text>
  </g>
  ${risers}

  ${nodes.map((n, i) => `
    ${body(n)}
    ${slab(chips[i], { kind: 'chip', glow: true,
      className: `node-pulse${i === 0 ? '' : i === 1 ? ' node-pulse--b' : ' node-pulse--c'}` })}
    ${slots(chips[i], 3, [0, 1, 3, 4, 5, 7])}
    ${markAt('node', topCentre(chips[i])[0] - 13, topCentre(chips[i])[1] - 104, 26, BRAND.node)}
    ${isoLabel(topCentre(chips[i]), 0, -62,
        `SERVER ${i + 1}`,
        i === 0 ? 'L1 · publishes' : 'L1 · applies')}
  `).join('')}

  <g>${packets}</g>
</svg>`;
}
