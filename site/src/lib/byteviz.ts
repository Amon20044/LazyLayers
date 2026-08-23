/**
 * "Where the bytes go" — every byte of a real cached record, drawn.
 *
 * Top block: the 212-byte JSON document, one cell per character, coloured by
 * what that byte is actually paying for. Bottom block: the 123 bytes msgpackr
 * writes for the same record. The point lands without a sentence of copy —
 * the second block is visibly smaller than the *values alone* in the first.
 */

import { KINDS, MP_HEX, BUDGET } from './bytes';

const PER_ROW = 44;
const CELL = 9;
const GAP = 2.4;
const PITCH = CELL + GAP;

const FILL = {
  s: '#F59E0B', // structural punctuation
  k: '#FB7185', // key names
  v: '#3F3F51', // values
} as const;

function grid(count: number, at: (i: number) => string, y0: number): string {
  let out = '';
  for (let i = 0; i < count; i++) {
    const x = (i % PER_ROW) * PITCH;
    const y = y0 + Math.floor(i / PER_ROW) * PITCH;
    out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${CELL}" height="${CELL}" rx="1.8"
      fill="${at(i)}" class="bv-cell" style="--i:${i}"/>`;
  }
  return out;
}

export function byteViz(): string {
  const kinds = KINDS.split('');
  const jsonRows = Math.ceil(kinds.length / PER_ROW);
  const mpBytes = MP_HEX.length / 2;

  const jsonY = 26;
  const mpY = jsonY + jsonRows * PITCH + 62;
  const mpRows = Math.ceil(mpBytes / PER_ROW);
  const height = mpY + mpRows * PITCH + 16;
  const width = PER_ROW * PITCH;

  const heading = (y: number, label: string, value: string, colour: string) => `
    <text x="0" y="${y}" font-family="'JetBrains Mono',monospace" font-size="10"
          fill="#6B6B78" letter-spacing="0.12em">${label}</text>
    <text x="${width}" y="${y}" text-anchor="end" font-family="Inter,system-ui,sans-serif"
          font-size="15" font-weight="600" fill="${colour}">${value}</text>`;

  return `
<svg viewBox="0 -14 ${width} ${height + 14}" role="img" aria-labelledby="bv-t bv-d"
     xmlns="http://www.w3.org/2000/svg" class="byteviz">
  <title id="bv-t">Byte-for-byte comparison of one cached session record</title>
  <desc id="bv-d">The JSON encoding of one session record uses 212 bytes: 21 of structural punctuation,
    64 of repeated key names and 127 of actual values. The MessagePack encoding of the same record uses
    123 bytes in total — fewer than JSON spends on values alone.</desc>

  <g>
    ${heading(0, 'JSON', `${BUDGET.total} B`, '#E8E8EE')}
    ${grid(kinds.length, (i) => FILL[kinds[i] as keyof typeof FILL], jsonY)}
  </g>

  <g>
    ${heading(mpY - 26, 'MESSAGEPACK', `${BUDGET.binaryTotal} B`, '#5EEAD4')}
    ${grid(mpBytes, () => 'url(#bv-bin)', mpY)}
  </g>

  <defs>
    <linearGradient id="bv-bin" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#5EEAD4"/><stop offset="100%" stop-color="#22D3EE"/>
    </linearGradient>
  </defs>
</svg>`;
}

export const BYTE_LEGEND = [
  { fill: FILL.s, label: 'Punctuation', value: BUDGET.structural },
  { fill: FILL.k, label: 'Key names', value: BUDGET.keys },
  { fill: FILL.v, label: 'Actual values', value: BUDGET.values },
];
