/**
 * Isometric architecture diagram — generated, not hand-drawn, so the
 * projection stays exact.
 *
 * Projection (true isometric, 30° axes):
 *   sx = (x - y) * cos30
 *   sy = (x + y) * sin30 - z
 *
 * Note the placement trick: to lay objects out in a row that reads as
 * HORIZONTAL on screen, walk them along (t, -t). That holds (x + y) constant,
 * so sy stays fixed while sx sweeps.
 */

const COS30 = Math.cos(Math.PI / 6);

type P = [number, number];

const proj = (x: number, y: number, z: number): P => [(x - y) * COS30, (x + y) * 0.5 - z];
const pts = (ps: P[]) => ps.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

interface Box {
  cx: number; cy: number; z: number;   // centre in iso space, z = underside
  w: number; d: number; h: number;     // extent along x, along y, thickness
}

interface Paint {
  top: string; left: string; right: string;
  stroke?: string; glow?: string; className?: string; opacity?: number;
}

/** Extruded slab: top face plus the two faces you can actually see. */
function slab(b: Box, p: Paint): string {
  const x0 = b.cx - b.w / 2, y0 = b.cy - b.d / 2;
  const x1 = x0 + b.w, y1 = y0 + b.d;
  const zt = b.z + b.h;

  const top: P[]   = [proj(x0, y0, zt), proj(x1, y0, zt), proj(x1, y1, zt), proj(x0, y1, zt)];
  const left: P[]  = [proj(x0, y0, zt), proj(x0, y1, zt), proj(x0, y1, b.z), proj(x0, y0, b.z)];
  const right: P[] = [proj(x1, y1, zt), proj(x0, y1, zt), proj(x0, y1, b.z), proj(x1, y1, b.z)];

  const st = p.stroke ? ` stroke="${p.stroke}" stroke-width="1" stroke-linejoin="round"` : '';
  const op = p.opacity !== undefined ? ` opacity="${p.opacity}"` : '';

  return `<g class="${p.className ?? ''}"${op}>
    ${p.glow ? `<polygon points="${pts(top)}" fill="${p.glow}" filter="url(#iso-blur)" opacity="0.7"/>` : ''}
    <polygon points="${pts(right)}" fill="${p.right}"${st}/>
    <polygon points="${pts(left)}"  fill="${p.left}"${st}/>
    <polygon points="${pts(top)}"   fill="${p.top}"${st}/>
  </g>`;
}

const topCentre = (b: Box): P => proj(b.cx, b.cy, b.z + b.h);
/** Front-most corner of the top face — where a label can sit without collisions. */
const frontCorner = (b: Box): P => proj(b.cx + b.w / 2, b.cy + b.d / 2, b.z + b.h);

export function isoDiagram(): string {
  // ── Layout ────────────────────────────────────────────────────────────
  const NODE_Z = 236;
  const BUS_Z = 108;
  const spread = 98;

  // (t, -t) keeps these on one screen-horizontal line.
  const nodes: Box[] = [-1, 0, 1].map((i) => ({
    cx: i * spread, cy: -i * spread, z: NODE_Z, w: 86, d: 86, h: 11,
  }));

  const chips: Box[] = nodes.map((n) => ({
    cx: n.cx, cy: n.cy, z: n.z + n.h, w: 46, d: 46, h: 17,
  }));

  const bus: Box = { cx: 0, cy: 0, z: BUS_Z, w: 286, d: 286, h: 3 };
  const l2:  Box = { cx: 0, cy: 0, z: 0,     w: 196, d: 196, h: 22 };

  // ── Wires ─────────────────────────────────────────────────────────────
  const busTop = topCentre(bus);
  const l2Top = topCentre(l2);

  const link = (a: P, b: P, delay: number) => {
    const d = `M ${a[0].toFixed(1)} ${a[1].toFixed(1)} L ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
    return {
      path: `<path d="${d}" fill="none" stroke="url(#iso-wire)" stroke-width="1.3" class="wire-flow" opacity="0.7"/>`,
      packet: `<circle r="2.8" fill="#7DD3FC" class="packet" style="offset-path:path('${d}');animation-delay:${delay}s"/>`,
    };
  };

  const wires = nodes.map((n, i) => link(proj(n.cx, n.cy, n.z), busTop, i * 1.1));
  const spine = link(busTop, l2Top, 0.55);

  // ── Labels ────────────────────────────────────────────────────────────
  const nodeLabel = (b: Box, i: number) => {
    const [x, y] = topCentre(b);
    return `<g transform="translate(${x.toFixed(1)},${(y - 26).toFixed(1)})" text-anchor="middle">
      <text font-family="'JetBrains Mono',monospace" font-size="10" fill="#EDEDF2" letter-spacing="0.08em">NODE ${i + 1}</text>
      <text y="12" font-family="'JetBrains Mono',monospace" font-size="8.5" fill="#6B6B78" letter-spacing="0.06em">L1 · LRU</text>
    </g>`;
  };

  const sideLabel = (p: P, dx: number, title: string, sub: string) => `
    <g transform="translate(${(p[0] + dx).toFixed(1)},${p[1].toFixed(1)})" text-anchor="${dx < 0 ? 'end' : 'start'}">
      <text font-family="'JetBrains Mono',monospace" font-size="10" fill="#EDEDF2" letter-spacing="0.08em">${title}</text>
      <text y="12" font-family="'JetBrains Mono',monospace" font-size="8.5" fill="#6B6B78" letter-spacing="0.05em">${sub}</text>
    </g>`;

  return `
<svg viewBox="-390 -340 780 560" role="img" aria-labelledby="iso-t iso-d" xmlns="http://www.w3.org/2000/svg">
  <title id="iso-t">LazyLayers cache architecture</title>
  <desc id="iso-d">Three application instances, each holding an in-process L1 memory cache, connected through an
    invalidation event bus to a shared Redis L2 store holding MessagePack-encoded payloads.</desc>

  <defs>
    <linearGradient id="iso-wire" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#22D3EE" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#6366F1" stop-opacity="0.3"/>
    </linearGradient>
    <filter id="iso-blur" x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation="13"/></filter>
    <linearGradient id="chip-top" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#5EEAD4"/><stop offset="100%" stop-color="#22D3EE"/>
    </linearGradient>
    <linearGradient id="l2-top" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#4F46E5"/><stop offset="55%" stop-color="#6D28D9"/><stop offset="100%" stop-color="#9333EA"/>
    </linearGradient>
    <linearGradient id="bus-top" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#22D3EE" stop-opacity="0.05"/>
      <stop offset="50%" stop-color="#22D3EE" stop-opacity="0.13"/>
      <stop offset="100%" stop-color="#22D3EE" stop-opacity="0.05"/>
    </linearGradient>
  </defs>

  <!-- L2 store -->
  ${slab(l2, { top: 'url(#l2-top)', left: '#221C63', right: '#1A1550', stroke: 'rgba(255,255,255,0.18)', glow: '#6D28D9' })}
  ${sideLabel(frontCorner(l2), 14, 'L2 · REDIS', 'msgpack + gzip on the wire')}

  <!-- Invalidation bus -->
  ${slab(bus, { top: 'url(#bus-top)', left: 'rgba(14,116,144,0.22)', right: 'rgba(14,116,144,0.16)', stroke: 'rgba(34,211,238,0.55)' })}
  ${sideLabel(proj(bus.cx - bus.w / 2, bus.cy + bus.d / 2, bus.z + bus.h), -14, 'EVENT BUS', 'del · pattern · set')}

  <!-- Wires under the nodes so they read as plugging in -->
  <g>${wires.map((w) => w.path).join('')}${spine.path}</g>

  <!-- Instances -->
  ${nodes.map((n, i) => `
    ${slab(n, { top: '#17171E', left: '#0D0D13', right: '#08080D', stroke: 'rgba(255,255,255,0.16)' })}
    ${slab(chips[i], {
      top: 'url(#chip-top)', left: '#0E7490', right: '#0A5A6E', stroke: 'rgba(255,255,255,0.28)',
      glow: '#22D3EE', className: `node-pulse${i === 0 ? ' node-pulse--b' : i === 2 ? ' node-pulse--c' : ''}`,
    })}
    ${nodeLabel(chips[i], i)}`).join('')}

  <!-- Packets on top -->
  <g>${wires.map((w) => w.packet).join('')}${spine.packet}</g>
</svg>`;
}
