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

/**
 * A slab is painted by ROLE, not by colour. Each kind resolves to
 * `.d-<kind>-top` / `-left` / `-right` classes in CSS, so the whole diagram
 * palette flips with the theme without this file knowing about themes.
 */
export type Kind = 'node' | 'chip' | 'chip-stale' | 'l2' | 'riser' | 'pad' | 'hub' | 'spine' | 'collar';

export interface Paint {
  kind: Kind;
  /** Soft bloom under the top face, for pieces that should read as lit. */
  glow?: boolean;
  className?: string;
  opacity?: number;
}

/**
 * Extruded slab: the top face plus the two side faces that actually face the
 * viewer.
 *
 * Which two? Points differing along (1,1,1) project to the same screen point,
 * so (1,1,1) is this projection's depth axis, and since we can see the top the
 * camera sits on the +(1,1,1) side. A face is therefore visible when its
 * outward normal dots positively with (1,1,1) — that is `x = x1` (which lands
 * on screen-RIGHT) and `y = y1` (screen-LEFT). The `x0` and `y0` faces are
 * always hidden.
 *
 * `paint.left` / `paint.right` are named for where the face lands on screen.
 */
export function slab(b: Box, p: Paint): string {
  const x0 = b.cx - b.w / 2, y0 = b.cy - b.d / 2;
  const x1 = x0 + b.w, y1 = y0 + b.d;
  const zt = b.z + b.h;

  const top: P[]   = [proj(x0, y0, zt), proj(x1, y0, zt), proj(x1, y1, zt), proj(x0, y1, zt)];
  // y = y1 — hangs below the diamond's lower-left edge.
  const left: P[]  = [proj(x1, y1, zt), proj(x0, y1, zt), proj(x0, y1, b.z), proj(x1, y1, b.z)];
  // x = x1 — hangs below the diamond's lower-right edge.
  const right: P[] = [proj(x1, y0, zt), proj(x1, y1, zt), proj(x1, y1, b.z), proj(x1, y0, b.z)];

  const k = p.kind;
  const op = p.opacity !== undefined ? ` opacity="${p.opacity}"` : '';

  return `<g class="d-slab ${p.className ?? ''}"${op}>
    ${p.glow ? `<polygon class="d-glow d-${k}-glow" points="${pts(top)}" filter="url(#iso-blur)"/>` : ''}
    <polygon class="d-${k}-left"  points="${pts(left)}"/>
    <polygon class="d-${k}-right" points="${pts(right)}"/>
    <polygon class="d-${k}-top"   points="${pts(top)}"/>
  </g>`;
}

/**
 * A flat ribbon lying in a plane at height z, running between two points in
 * iso space. Needed for the bus lanes — a plain box can't express them because
 * they run diagonally across both axes.
 */
export function channel(a: V, b: V, z: number, width: number, cls = ''): string {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (width / 2);
  const ny = (dx / len) * (width / 2);

  const quad: P[] = [
    proj(a.x + nx, a.y + ny, z), proj(b.x + nx, b.y + ny, z),
    proj(b.x - nx, b.y - ny, z), proj(a.x - nx, a.y - ny, z),
  ];
  return `<polygon class="d-lane ${cls}" points="${pts(quad)}"/>`;
}

/** Straight path between two iso points at a given height — a packet rail. */
export const rail = (a: V, b: V, z: number, za = z): string => {
  const [ax, ay] = proj(a.x, a.y, za);
  const [bx, by] = proj(b.x, b.y, z);
  return `M ${ax.toFixed(1)} ${ay.toFixed(1)} L ${bx.toFixed(1)} ${by.toFixed(1)}`;
};

export const topCentre = (b: Box): P => proj(b.cx, b.cy, b.z + b.h);

/**
 * A grid of slots laid flat on a slab's top face, so an L1 chip reads as a
 * cache holding entries rather than a solid block. `lit` marks the occupied
 * slots — leaving some dark is what makes it look like an LRU with room left.
 */
export function slots(b: Box, n = 3, lit: number[] = []): string {
  const inset = b.w * 0.15;
  const cell = (b.w - inset * 2) / n;
  const gap = cell * 0.22;
  const s = cell - gap;
  const z = b.z + b.h;
  const x0 = b.cx - b.w / 2 + inset;
  const y0 = b.cy - b.d / 2 + inset;

  let out = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const ax = x0 + c * cell, ay = y0 + r * cell;
      const quad: P[] = [
        proj(ax, ay, z), proj(ax + s, ay, z), proj(ax + s, ay + s, z), proj(ax, ay + s, z),
      ];
      const on = lit.includes(r * n + c);
      out += `<polygon class="d-slot${on ? ' d-slot--on' : ''}" points="${pts(quad)}"/>`;
    }
  }
  return out;
}

/** Shared <defs> every diagram relies on. */
export const ISO_DEFS = `
  <filter id="iso-blur" x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation="12"/></filter>`;

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
          font-weight="600" letter-spacing="0.05em">${title}</text>
    ${sub ? `<text class="iso-s" y="${(18 * scale).toFixed(1)}" font-family="'JetBrains Mono',monospace"
          font-size="${(11.5 * scale).toFixed(1)}" letter-spacing="0.03em">${sub}</text>` : ''}
  </g>`;
