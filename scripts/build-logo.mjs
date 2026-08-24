import { writeFileSync, mkdirSync } from 'node:fs';
import { INK, LIME, VIEWBOX, markBody, markSvg } from './logo.mjs';

/** Header lockup: mark on the left, wordmark beside it. */
function lockup(ink, lime) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 200" width="304" height="80" fill="none" role="img" aria-label="LazyLayers">
  <g transform="translate(0 -8) scale(0.425)">
    <g transform="translate(-95 -91)">
      ${markBody(ink, lime)}
    </g>
  </g>
  <text x="248" y="128" font-family="Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif"
        font-size="104" font-weight="700" letter-spacing="-3.5" fill="${ink}">Lazy<tspan fill="${lime}">Layers</tspan></text>
</svg>`;
}

mkdirSync('docs/logo', { recursive: true });
writeFileSync('docs/logo/lazylayers-light.svg', lockup(INK.light, LIME));
writeFileSync('docs/logo/lazylayers-dark.svg',  lockup(INK.dark,  LIME));

/**
 * The favicon renders on whatever chrome the browser gives it, so it cannot
 * follow the site theme. It gets the lime as the body and the dark ink as the
 * detail, which stays legible on both light and dark tab bars.
 */
writeFileSync('docs/favicon.svg', markSvg(INK.light, LIME, 512));
writeFileSync('site/public/favicon.svg', markSvg(INK.light, LIME, 512));

console.log('wrote docs/logo/{light,dark}, docs/favicon.svg, site/public/favicon.svg');

/** Favicon with a lime plate behind it, so the mark reads on any tab bar. */
function faviconSvg(size = 512) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}" role="img" aria-label="LazyLayers">
  <rect width="512" height="512" rx="112" fill="${LIME}"/>
  <g transform="translate(256 256) scale(0.78) translate(-349.5 -337.5)">
    ${markBody(INK.light, '#8FAE2E')}
  </g>
</svg>`;
}
writeFileSync('docs/favicon.svg', faviconSvg());
writeFileSync('site/public/favicon.svg', faviconSvg());
console.log('favicon replated');
