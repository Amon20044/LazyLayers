/**
 * Single source of truth for the LazyLayers mark.
 *
 * The artwork is two inks: a solid body and a lime highlight that traces the
 * extruded edges. The body flips with the theme (dark ink on light, light ink
 * on dark) while the lime stays put in both, so the mark keeps its identity.
 */

export const INK  = { light: '#30302C', dark: '#F2F3EC' };
export const LIME = '#D3F15D';

/** Tight square crop around the art (raw extents are x 128-570, y 107-584). */
export const VIEWBOX = '95 91 509 509';

/** Lime paths: three extrusion slivers plus three edge highlights. */
export const LIME_PATHS = [
  'M570 443 L350 561 L129 444 L128 462 L350 584 L563 472 L570 443 Z',
  'M128 378 L349 496 L570 378 L566 405 L351 518 L128 399 L128 378 Z',
  'M207 139 L230 150 L230 349 L207 338 L207 139 Z',
  'M404 107 L426 118 L427 299 L404 287 L404 107 Z',
  'M326 328 L480 411 L447 416 L326 351 L326 328 Z',
];

/** Body paths: the bottom slab and the main folded layer stack. */
export const INK_PATHS = [
  'M131 443 L349 559 L568 443 L531 424 L351 520 L170 425 L131 443 Z',
  'M403 107 L326 146 L326 326 L481 413 L373 429 L208 341 L205 139 L129 178 '
    + 'L129 377 L347 493 L569 377 L403 288 L403 107 Z',
];

/** Paint order matters: bottom slab, then lime, then the main body on top. */
export function markBody(ink, lime) {
  return [
    `<path d="${INK_PATHS[0]}" fill="${ink}"/>`,
    ...LIME_PATHS.map((d) => `<path d="${d}" fill="${lime}"/>`),
    `<path d="${INK_PATHS[1]}" fill="${ink}"/>`,
  ].join('\n  ');
}

/** Standalone square mark, for favicons and anywhere a bare icon is needed. */
export function markSvg(ink = INK.light, lime = LIME, size) {
  const dims = size ? ` width="${size}" height="${size}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}"${dims} fill="none" role="img" aria-label="LazyLayers">
  ${markBody(ink, lime)}
</svg>`;
}
