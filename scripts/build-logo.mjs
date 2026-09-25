import { writeFileSync } from 'node:fs';
import { INK, LIME, markBody } from './logo.mjs';

/**
 * The favicon renders on whatever chrome the browser gives it, so it cannot
 * follow the site theme. It gets the lime as the body and the dark ink as the
 * detail, which stays legible on both light and dark tab bars.
 */
/** Favicon with a lime plate behind it, so the mark reads on any tab bar. */
function faviconSvg(size = 512) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}" role="img" aria-label="LazyLayers">
  <rect width="512" height="512" rx="112" fill="${LIME}"/>
  <g transform="translate(256 256) scale(0.78) translate(-349.5 -337.5)">
    ${markBody(INK.light, '#8FAE2E')}
  </g>
</svg>`;
}
writeFileSync('site/public/favicon.svg', faviconSvg());
console.log('wrote site/public/favicon.svg');
