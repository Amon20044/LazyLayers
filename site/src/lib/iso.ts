/**
 * Hero diagram: the whole topology in one frame — three instances, their
 * channels down to the event bus, and the shared store beneath it.
 */

import { slab, slots, channel, proj, pts, rail, topCentre, isoLabel, ISO_DEFS, type Box, type V } from './isocore';
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
  const chips: Box[] = nodes.map((n) => ({ cx: n.cx, cy: n.cy, z: n.z + n.h, w: 52, d: 52, h: 14 }));

  const ports: V[] = nodes.map((n) => ({ x: n.cx, y: n.cy }));
  const hub: V = { x: 0, y: 0 };
  const l2: Box = { cx: 0, cy: 0, z: 0, w: 168, d: 168, h: 22 };
  const R = 168;

  const risers = nodes.map((n) =>
    slab({ cx: n.cx, cy: n.cy, z: BUS_Z + 4, w: 13, d: 13, h: n.z - BUS_Z - 4 }, { kind: 'riser' }),
  ).join('');

  const lanes = ports.map((p, i) =>
    channel(hub, p, BUS_Z + 1, 26, `lane lane--${i}`),
  ).join('');

  const pads = ports.map((p) =>
    slab({ cx: p.x, cy: p.y, z: BUS_Z, w: 34, d: 34, h: 3 }, { kind: 'pad' }),
  ).join('');

  const spine = slab({ cx: 0, cy: 0, z: l2.h, w: 15, d: 15, h: BUS_Z - l2.h }, { kind: 'spine' });

  const packets = ports.map((p, i) => {
    const down = `M ${proj(p.x, p.y, NODE_Z)[0].toFixed(1)} ${proj(p.x, p.y, NODE_Z)[1].toFixed(1)} L ${proj(p.x, p.y, BUS_Z + 6)[0].toFixed(1)} ${proj(p.x, p.y, BUS_Z + 6)[1].toFixed(1)}`;
    return `
      <circle r="3.2" class="packet d-packet" style="offset-path:path('${down}');animation-delay:${(i * 0.9).toFixed(2)}s"/>
      <circle r="3.2" class="packet packet--slow d-packet-b" style="offset-path:path('${rail(p, hub, BUS_Z + 2)}');animation-delay:${(i * 0.9 + 0.45).toFixed(2)}s"/>`;
  }).join('');

  const spinePath = `M ${proj(0, 0, BUS_Z)[0].toFixed(1)} ${proj(0, 0, BUS_Z)[1].toFixed(1)} L ${proj(0, 0, l2.h)[0].toFixed(1)} ${proj(0, 0, l2.h)[1].toFixed(1)}`;

  return `
<svg viewBox="-400 -470 800 578" role="img" aria-labelledby="iso-t iso-d" xmlns="http://www.w3.org/2000/svg">
  <title id="iso-t">LazyLayers distributed cache architecture</title>
  <desc id="iso-d">Three application instances, each holding an in-process L1 memory cache, drop down through
    dedicated channels onto a shared invalidation event bus. The bus fans del, pattern and set events between
    every instance, and a spine connects it to the shared L2 store.</desc>

  <defs>${ISO_DEFS}</defs>

  ${slab(l2, { kind: 'l2', glow: true })}
  ${markAt('redis', proj(l2.cx + l2.w / 2, l2.cy + l2.d / 2, l2.h)[0] + 20,
           proj(l2.cx + l2.w / 2, l2.cy + l2.d / 2, l2.h)[1] - 20, 34, BRAND.redis)}
  ${isoLabel(proj(l2.cx + l2.w / 2, l2.cy + l2.d / 2, l2.h), 62, 6, 'L2 · SHARED STORE', 'msgpack + gzip on the wire', HERO_LABEL)}

  ${slab({ cx: 0, cy: 0, z: l2.h, w: 34, d: 34, h: 4 }, { kind: 'collar' })}
  ${spine}

  <polygon points="${pts([proj(R, -R, BUS_Z), proj(R, R, BUS_Z), proj(-R, R, BUS_Z), proj(-R, -R, BUS_Z)])}"
           class="d-plane"/>
  ${lanes}
  ${pads}
  ${slab({ cx: 0, cy: 0, z: BUS_Z, w: 52, d: 52, h: 6 }, { kind: 'hub', glow: true })}
  ${/* Anchored to the viewBox's left margin rather than the plane corner: a
        right-anchored label runs off the canvas once the mobile CSS bumps its
        size up. */ ''}
  ${isoLabel([-386, proj(-R, R, BUS_Z)[1]], 2, -2, 'EVENT BUS', 'del · pattern · set', HERO_LABEL)}

  ${risers}

  ${nodes.map((n, i) => `
    ${slab(n, { kind: 'node' })}
    ${slab(chips[i], { kind: 'chip', glow: true,
      className: `node-pulse${i === 0 ? ' node-pulse--b' : i === 2 ? ' node-pulse--c' : ''}` })}
    ${slots(chips[i], 3, [0, 1, 3, 4, 5, 7])}
    ${markAt('node', topCentre(chips[i])[0] - 19, topCentre(chips[i])[1] - 128, 38, BRAND.node)}
    ${isoLabel(topCentre(chips[i]), 0, -78, `SERVER ${i + 1}`, 'L1 · LRU', HERO_LABEL)}
  `).join('')}

  <g>${packets}<circle r="3.2" class="packet d-packet-c" style="offset-path:path('${spinePath}');animation-delay:1.5s"/></g>
</svg>`;
}
