/**
 * Hero diagram: the whole topology in one frame — three instances, their
 * channels down to the event bus, and the shared store beneath it.
 */

import { slab, channel, proj, pts, rail, topCentre, isoLabel, ISO_DEFS, type Box, type V } from './isocore';
import { markAt, BRAND } from './icons';

/** The hero SVG renders at roughly 0.7 scale in its column. */
const HERO_LABEL = 1.6;

export function isoDiagram(): string {
  const NODE_Z = 296;
  const BUS_Z = 146;
  const spread = 108;

  const nodes: Box[] = [-1, 0, 1].map((i) => ({
    cx: i * spread, cy: -i * spread, z: NODE_Z, w: 84, d: 84, h: 11,
  }));
  const chips: Box[] = nodes.map((n) => ({ cx: n.cx, cy: n.cy, z: n.z + n.h, w: 44, d: 44, h: 16 }));

  const ports: V[] = nodes.map((n) => ({ x: n.cx, y: n.cy }));
  const hub: V = { x: 0, y: 0 };
  const l2: Box = { cx: 0, cy: 0, z: 0, w: 168, d: 168, h: 22 };
  const R = 168;

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

  const spine = slab({ cx: 0, cy: 0, z: l2.h, w: 15, d: 15, h: BUS_Z - l2.h }, {
    top: 'rgba(168,85,247,0.55)', left: 'rgba(139,92,246,0.24)',
    right: 'rgba(139,92,246,0.14)', stroke: 'rgba(168,85,247,0.45)',
  });

  const packets = ports.map((p, i) => {
    const down = `M ${proj(p.x, p.y, NODE_Z)[0].toFixed(1)} ${proj(p.x, p.y, NODE_Z)[1].toFixed(1)} L ${proj(p.x, p.y, BUS_Z + 6)[0].toFixed(1)} ${proj(p.x, p.y, BUS_Z + 6)[1].toFixed(1)}`;
    return `
      <circle r="3.2" fill="#67E8F9" class="packet" style="offset-path:path('${down}');animation-delay:${(i * 0.9).toFixed(2)}s"/>
      <circle r="3.2" fill="#5EEAD4" class="packet packet--slow" style="offset-path:path('${rail(p, hub, BUS_Z + 2)}');animation-delay:${(i * 0.9 + 0.45).toFixed(2)}s"/>`;
  }).join('');

  const spinePath = `M ${proj(0, 0, BUS_Z)[0].toFixed(1)} ${proj(0, 0, BUS_Z)[1].toFixed(1)} L ${proj(0, 0, l2.h)[0].toFixed(1)} ${proj(0, 0, l2.h)[1].toFixed(1)}`;

  return `
<svg viewBox="-400 -392 800 500" role="img" aria-labelledby="iso-t iso-d" xmlns="http://www.w3.org/2000/svg">
  <title id="iso-t">LazyLayers distributed cache architecture</title>
  <desc id="iso-d">Three application instances, each holding an in-process L1 memory cache, drop down through
    dedicated channels onto a shared invalidation event bus. The bus fans del, pattern and set events between
    every instance, and a spine connects it to the shared L2 store.</desc>

  <defs>${ISO_DEFS}</defs>

  ${slab(l2, { top: 'url(#l2-top)', left: '#221C63', right: '#1A1550', stroke: 'rgba(255,255,255,0.18)' })}
  ${markAt('redis', proj(l2.cx + l2.w / 2, l2.cy + l2.d / 2, l2.h)[0] + 20,
           proj(l2.cx + l2.w / 2, l2.cy + l2.d / 2, l2.h)[1] - 20, 34, BRAND.redis)}
  ${isoLabel(proj(l2.cx + l2.w / 2, l2.cy + l2.d / 2, l2.h), 62, 6, 'L2 · SHARED STORE', 'msgpack + gzip on the wire', HERO_LABEL)}

  ${spine}

  <polygon points="${pts([proj(R, -R, BUS_Z), proj(R, R, BUS_Z), proj(-R, R, BUS_Z), proj(-R, -R, BUS_Z)])}"
           fill="rgba(34,211,238,0.028)" stroke="rgba(34,211,238,0.34)" stroke-width="1.1" stroke-dasharray="5 6"/>
  ${lanes}
  ${pads}
  ${slab({ cx: 0, cy: 0, z: BUS_Z, w: 52, d: 52, h: 6 }, {
    top: 'url(#hub-top)', left: 'rgba(14,116,144,0.5)', right: 'rgba(14,116,144,0.38)',
    stroke: 'rgba(34,211,238,0.75)', glow: '#22D3EE',
  })}
  ${/* Anchored to the viewBox's left margin rather than the plane corner: a
        right-anchored label runs off the canvas once the mobile CSS bumps its
        size up. */ ''}
  ${isoLabel([-386, proj(-R, R, BUS_Z)[1]], 2, -2, 'EVENT BUS', 'del · pattern · set', HERO_LABEL)}

  ${risers}

  ${nodes.map((n, i) => `
    ${slab(n, { top: '#1E1E29', left: '#15151F', right: '#0D0D15', stroke: 'rgba(255,255,255,0.16)' })}
    ${slab(chips[i], {
      top: 'url(#chip-top)', left: '#0E7490', right: '#0A5A6E', stroke: 'rgba(255,255,255,0.28)',
      glow: '#22D3EE', className: `node-pulse${i === 0 ? ' node-pulse--b' : i === 2 ? ' node-pulse--c' : ''}`,
    })}
    ${markAt('node', topCentre(chips[i])[0] - 19, topCentre(chips[i])[1] - 90, 38, BRAND.node)}
    ${isoLabel(topCentre(chips[i]), 0, -44, `NODE ${i + 1}`, 'L1 · LRU', HERO_LABEL)}
  `).join('')}

  <g>${packets}<circle r="3.2" fill="#C4B5FD" class="packet" style="offset-path:path('${spinePath}');animation-delay:1.5s"/></g>
</svg>`;
}
