/**
 * Shared isometric primitives.
 *
 * Projection (true isometric, 30° axes):
 *   sx = (x - y) * cos30
 *   sy = (x + y) * sin30 - z
 *
 * Placement trick used throughout: to lay objects out in a row that reads as
 * HORIZONTAL on screen, walk them along (t, -t). That holds (x + y) constant,
 * so sy stays fixed while sx sweeps.
 */

const COS30 = Math.cos(Math.PI / 6);

export type P = [number, number];
export type V = { x: number; y: number };

export const proj = (x: number, y: number, z: number): P => [(x - y) * COS30, (x + y) * 0.5 - z];
export const pts = (ps: P[]) => ps.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

export interface Box { cx: number; cy: number; z: number; w: number; d: number; h: number }
export interface Paint {
  top: string; left: string; right: string;
  stroke?: string; glow?: string; className?: string; opacity?: number;
}

/** Extruded slab: top face plus the two faces you can actually see. */
export function slab(b: Box, p: Paint): string {
  const x0 = b.cx - b.w / 2, y0 = b.cy - b.d / 2;
  const x1 = x0 + b.w, y1 = y0 + b.d;
  const zt = b.z + b.h;

  const top: P[]   = [proj(x0, y0, zt), proj(x1, y0, zt), proj(x1, y1, zt), proj(x0, y1, zt)];
  const left: P[]  = [proj(x0, y0, zt), proj(x0, y1, zt), proj(x0, y1, b.z), proj(x0, y0, b.z)];
  const right: P[] = [proj(x1, y1, zt), proj(x0, y1, zt), proj(x0, y1, b.z), proj(x1, y1, b.z)];

  const st = p.stroke ? ` stroke="${p.stroke}" stroke-width="1" stroke-linejoin="round"` : '';
  const op = p.opacity !== undefined ? ` opacity="${p.opacity}"` : '';

  return `<g class="${p.className ?? ''}"${op}>
    ${p.glow ? `<polygon points="${pts(top)}" fill="${p.glow}" filter="url(#iso-blur)" opacity="0.62"/>` : ''}
    <polygon points="${pts(right)}" fill="${p.right}"${st}/>
    <polygon points="${pts(left)}"  fill="${p.left}"${st}/>
    <polygon points="${pts(top)}"   fill="${p.top}"${st}/>
  </g>`;
}

/**
 * A flat ribbon lying in a plane at height z, running between two points in
 * iso space. Needed for the bus lanes — a plain box can't express them because
 * they run diagonally across both axes.
 */
export function channel(a: V, b: V, z: number, width: number, fill: string, stroke: string, cls = ''): string {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (width / 2);
  const ny = (dx / len) * (width / 2);

  const quad: P[] = [
    proj(a.x + nx, a.y + ny, z), proj(b.x + nx, b.y + ny, z),
    proj(b.x - nx, b.y - ny, z), proj(a.x - nx, a.y - ny, z),
  ];
  return `<polygon class="${cls}" points="${pts(quad)}" fill="${fill}" stroke="${stroke}" stroke-width="0.9" stroke-linejoin="round"/>`;
}

/** Straight path between two iso points at a given height — a packet rail. */
export const rail = (a: V, b: V, z: number, za = z): string => {
  const [ax, ay] = proj(a.x, a.y, za);
  const [bx, by] = proj(b.x, b.y, z);
  return `M ${ax.toFixed(1)} ${ay.toFixed(1)} L ${bx.toFixed(1)} ${by.toFixed(1)}`;
};

export const topCentre = (b: Box): P => proj(b.cx, b.cy, b.z + b.h);

/** Shared <defs> every diagram relies on. */
export const ISO_DEFS = `
  <filter id="iso-blur" x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation="12"/></filter>
  <linearGradient id="chip-top" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#5EEAD4"/><stop offset="100%" stop-color="#22D3EE"/>
  </linearGradient>
  <linearGradient id="chip-stale" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#FB7185"/><stop offset="100%" stop-color="#F43F5E"/>
  </linearGradient>
  <linearGradient id="l2-top" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#4F46E5"/><stop offset="55%" stop-color="#6D28D9"/><stop offset="100%" stop-color="#9333EA"/>
  </linearGradient>
  <linearGradient id="lane-fill" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#22D3EE" stop-opacity="0.46"/>
    <stop offset="100%" stop-color="#22D3EE" stop-opacity="0.16"/>
  </linearGradient>
  <linearGradient id="hub-top" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#67E8F9"/><stop offset="100%" stop-color="#22D3EE"/>
  </linearGradient>`;

/** Node/label typography used across diagrams. */
/**
 * Diagram label. `scale` compensates for how far the SVG shrinks in its
 * container — the hero sits in a narrow column and renders at ~0.7, so its
 * labels need larger units to come out the same size as the full-width ones.
 */
export const isoLabel = (
  p: P, dx: number, dy: number, title: string, sub: string, scale = 1,
): string => `
  <g transform="translate(${(p[0] + dx).toFixed(1)},${(p[1] + dy).toFixed(1)})" text-anchor="${dx < 0 ? 'end' : dx === 0 ? 'middle' : 'start'}">
    <text class="iso-t" font-family="Inter,system-ui,sans-serif" font-size="${(14 * scale).toFixed(1)}"
          font-weight="600" fill="#F4F4F8" letter-spacing="0.05em">${title}</text>
    ${sub ? `<text class="iso-s" y="${(18 * scale).toFixed(1)}" font-family="'JetBrains Mono',monospace"
          font-size="${(11.5 * scale).toFixed(1)}" fill="#B6B7C8" letter-spacing="0.03em">${sub}</text>` : ''}
  </g>`;
