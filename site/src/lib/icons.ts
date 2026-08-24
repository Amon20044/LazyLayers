/**
 * Brand marks, taken from `simple-icons` (CC0-1.0) so these are the projects'
 * real logos rather than approximations.
 *
 * simple-icons is a devDependency and this module is only ever imported by the
 * build-time renderers, so the paths are inlined into the static HTML and none
 * of the icon set reaches the client bundle.
 *
 * The icons are CC0, but the *trademarks* they represent are not — see the
 * notice in the footer. Use here is nominative: naming the technologies this
 * library talks to, with no claim of affiliation or endorsement.
 */

import {
  siNodedotjs,
  siTypescript,
  siRedis,
  siRabbitmq,
  siNatsdotio,
} from 'simple-icons';

interface Mark {
  title: string;
  /** Single path, drawn for a 24x24 viewBox. */
  path: string;
  colour: string;
}

const si = (i: { title: string; path: string; hex: string }): Mark => ({
  title: i.title,
  path: i.path,
  colour: `#${i.hex}`,
});

/**
 * MessagePack has no entry in simple-icons and no widely-recognised mark, so
 * this one is a generic "packed bytes" glyph — deliberately abstract, and not
 * presented as a logo.
 */
const MSGPACK_GLYPH =
  'M2.4 8h4a1.2 1.2 0 0 1 1.2 1.2v5.6A1.2 1.2 0 0 1 6.4 16h-4a1.2 1.2 0 0 1-1.2-1.2V9.2A1.2 1.2 0 0 1 2.4 8Z'
  + 'M10 6h4a1.2 1.2 0 0 1 1.2 1.2v9.6A1.2 1.2 0 0 1 14 18h-4a1.2 1.2 0 0 1-1.2-1.2V7.2A1.2 1.2 0 0 1 10 6Z'
  + 'M17.6 9.4h4a1.2 1.2 0 0 1 1.2 1.2v2.8a1.2 1.2 0 0 1-1.2 1.2h-4a1.2 1.2 0 0 1-1.2-1.2v-2.8a1.2 1.2 0 0 1 1.2-1.2Z';

const MARKS = {
  node:    si(siNodedotjs),
  ts:      si(siTypescript),
  redis:   si(siRedis),
  rabbit:  si(siRabbitmq),
  nats:    si(siNatsdotio),
  msgpack: { title: 'MessagePack', path: MSGPACK_GLYPH, colour: '#22D3EE' },
} satisfies Record<string, Mark>;

export type IconName = keyof typeof MARKS;

export const BRAND = Object.fromEntries(
  Object.entries(MARKS).map(([k, v]) => [k, v.colour]),
) as Record<IconName, string>;

export const TITLE = Object.fromEntries(
  Object.entries(MARKS).map(([k, v]) => [k, v.title]),
) as Record<IconName, string>;

/** Bare <g> for embedding in an existing SVG. Colour via `currentColor`. */
export const mark = (name: IconName): string =>
  `<path d="${MARKS[name].path}" fill="currentColor"/>`;

/** Standalone <svg> for HTML. `size` is CSS px. */
export function icon(name: IconName, size = 20, colour = MARKS[name].colour): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" role="img"
    aria-label="${MARKS[name].title}" style="color:${colour}">${mark(name)}</svg>`;
}

/** Positioned mark for use inside a diagram's own coordinate space. */
export function markAt(name: IconName, x: number, y: number, size: number, colour: string): string {
  const s = size / 24;
  return `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${s.toFixed(3)})"
    style="color:${colour}">${mark(name)}</g>`;
}
