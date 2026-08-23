/**
 * Generates public/og.png (1200x630) from an inline SVG.
 * Run: node scripts/make-og.mjs
 *
 * Text is rasterised with system fonts, so it is kept to weights/families that
 * exist on any macOS or Linux CI box rather than the webfonts the site uses.
 */
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'og.png');

const COS30 = Math.cos(Math.PI / 6);
const proj = (x, y, z) => [(x - y) * COS30, (x + y) * 0.5 - z];
const pts = (ps) => ps.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ');

function slab({ cx, cy, z, w, d, h }, { top, left, right, stroke }) {
  const x0 = cx - w / 2, y0 = cy - d / 2, x1 = x0 + w, y1 = y0 + d, zt = z + h;
  const t = [proj(x0, y0, zt), proj(x1, y0, zt), proj(x1, y1, zt), proj(x0, y1, zt)];
  const l = [proj(x0, y0, zt), proj(x0, y1, zt), proj(x0, y1, z), proj(x0, y0, z)];
  const r = [proj(x1, y1, zt), proj(x0, y1, zt), proj(x0, y1, z), proj(x1, y1, z)];
  const st = stroke ? ` stroke="${stroke}" stroke-width="1.2" stroke-linejoin="round"` : '';
  return `<polygon points="${pts(r)}" fill="${right}"${st}/>
          <polygon points="${pts(l)}" fill="${left}"${st}/>
          <polygon points="${pts(t)}" fill="${top}"${st}/>`;
}

const nodes = [-1, 0, 1].map((i) => ({ cx: i * 74, cy: -i * 74, z: 176, w: 64, d: 64, h: 9 }));
const chips = nodes.map((n) => ({ cx: n.cx, cy: n.cy, z: n.z + n.h, w: 34, d: 34, h: 13 }));
const bus = { cx: 0, cy: 0, z: 82, w: 214, d: 214, h: 3 };
const l2 = { cx: 0, cy: 0, z: 0, w: 148, d: 148, h: 16 };

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#050507"/><stop offset="100%" stop-color="#0A0A12"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.72" cy="0.45" r="0.55">
      <stop offset="0%" stop-color="#6366F1" stop-opacity="0.34"/>
      <stop offset="100%" stop-color="#6366F1" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="0.2" cy="0.15" r="0.5">
      <stop offset="0%" stop-color="#22D3EE" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#22D3EE" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="mark" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#22D3EE"/><stop offset="50%" stop-color="#6366F1"/><stop offset="100%" stop-color="#A855F7"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#5EEAD4"/><stop offset="100%" stop-color="#818CF8"/>
    </linearGradient>
    <linearGradient id="chipTop" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#5EEAD4"/><stop offset="100%" stop-color="#22D3EE"/>
    </linearGradient>
    <linearGradient id="l2Top" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#4F46E5"/><stop offset="55%" stop-color="#6D28D9"/><stop offset="100%" stop-color="#9333EA"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect width="1200" height="630" fill="url(#glow2)"/>

  <g stroke="#FFFFFF" stroke-opacity="0.05" stroke-width="1">
    ${Array.from({ length: 19 }, (_, i) => `<line x1="${i * 64}" y1="0" x2="${i * 64}" y2="630"/>`).join('')}
    ${Array.from({ length: 10 }, (_, i) => `<line x1="0" y1="${i * 64}" x2="1200" y2="${i * 64}"/>`).join('')}
  </g>

  <!-- brand -->
  <g transform="translate(80,74)">
    <path d="M16 3 L29 10.5 L16 18 L3 10.5 Z" fill="url(#mark)"/>
    <path d="M3 16 L16 23.5 L29 16" stroke="url(#mark)" stroke-width="2.2" fill="none" stroke-linejoin="round" opacity="0.7"/>
    <text x="42" y="17" font-family="Helvetica, Arial, sans-serif" font-size="21" font-weight="600" fill="#F2F2F4">LazyLayers</text>
  </g>

  <text x="80" y="238" font-family="Helvetica, Arial, sans-serif" font-size="78" font-weight="700" fill="#FFFFFF" letter-spacing="-2.5">Cache more.</text>
  <text x="80" y="322" font-family="Helvetica, Arial, sans-serif" font-size="78" font-weight="700" fill="url(#accent)" letter-spacing="-2.5">Store less.</text>

  <text x="80" y="392" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="#9A9AA4">22–92% fewer bytes in Redis than JSON-based caching.</text>
  <text x="80" y="426" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="#9A9AA4">Measured against bentocache.</text>

  <g transform="translate(80,486)">
    <rect x="0" y="0" width="330" height="46" rx="9" fill="#FFFFFF" fill-opacity="0.04" stroke="#FFFFFF" stroke-opacity="0.14"/>
    <text x="20" y="30" font-family="Menlo, monospace" font-size="17" fill="#E4E4EA">$ npm i lazy-layers-cache</text>
  </g>

  <!-- isometric stack -->
  <g transform="translate(892,330)">
    ${slab(l2, { top: 'url(#l2Top)', left: '#221C63', right: '#1A1550', stroke: 'rgba(255,255,255,0.2)' })}
    ${slab(bus, { top: 'rgba(34,211,238,0.10)', left: 'rgba(14,116,144,0.22)', right: 'rgba(14,116,144,0.16)', stroke: 'rgba(34,211,238,0.5)' })}
    ${nodes.map((n, i) => slab(n, { top: '#17171E', left: '#0D0D13', right: '#08080D', stroke: 'rgba(255,255,255,0.17)' })
      + slab(chips[i], { top: 'url(#chipTop)', left: '#0E7490', right: '#0A5A6E', stroke: 'rgba(255,255,255,0.3)' })).join('')}
  </g>
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 }, font: { loadSystemFonts: true } })
  .render()
  .asPng();

writeFileSync(out, png);
console.log(`wrote ${out} (${(png.length / 1024).toFixed(1)} kB)`);

// apple-touch-icon (180x180) from the same mark
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 32 32">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#22D3EE"/><stop offset="50%" stop-color="#6366F1"/><stop offset="100%" stop-color="#A855F7"/>
  </linearGradient></defs>
  <rect width="32" height="32" fill="#08080B"/>
  <path d="M16 6 L26.5 12 L16 18 L5.5 12 Z" fill="url(#g)"/>
  <path d="M5.5 16.6 L16 22.6 L26.5 16.6" stroke="url(#g)" stroke-width="2" stroke-linejoin="round" fill="none" opacity="0.72"/>
  <path d="M5.5 21.2 L16 27.2 L26.5 21.2" stroke="url(#g)" stroke-width="2" stroke-linejoin="round" fill="none" opacity="0.4"/>
</svg>`;
const iconPng = new Resvg(iconSvg, { fitTo: { mode: 'width', value: 180 } }).render().asPng();
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'apple-touch-icon.png'), iconPng);
console.log('wrote apple-touch-icon.png');
