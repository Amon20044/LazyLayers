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

/* Classes, not hex — the byte grid re-colours with the theme like the
   diagrams do. Values are deliberately the quiet one: they are the bytes that
   actually carry information. */
const CLS = {
  s: 'bv-struct', // structural punctuation
  k: 'bv-key',    // key names
  v: 'bv-value',  // values
} as const;

export const BYTE_FILL = {
  s: 'var(--bv-struct)', k: 'var(--bv-key)', v: 'var(--bv-value)',
} as const;

function grid(count: number, at: (i: number) => string, y0: number): string {
  let out = '';
  for (let i = 0; i < count; i++) {
    const x = (i % PER_ROW) * PITCH;
    const y = y0 + Math.floor(i / PER_ROW) * PITCH;
    out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${CELL}" height="${CELL}" rx="1.8"
      class="bv-cell ${at(i)}" style="--i:${i}"/>`;
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
          class="v-muted" letter-spacing="0.12em">${label}</text>
    <text x="${width}" y="${y}" text-anchor="end" font-family="Inter,system-ui,sans-serif"
          font-size="15" font-weight="600" class="${colour}">${value}</text>`;

  return `
<svg viewBox="0 -14 ${width} ${height + 14}" role="img" aria-labelledby="bv-t bv-d"
     xmlns="http://www.w3.org/2000/svg" class="byteviz">
  <title id="bv-t">Byte-for-byte comparison of one cached session record</title>
  <desc id="bv-d">The JSON encoding of one session record uses 212 bytes: 21 of structural punctuation,
    64 of repeated key names and 127 of actual values. The MessagePack encoding of the same record uses
    123 bytes in total — fewer than JSON spends on values alone.</desc>

  <g>
    ${heading(0, 'JSON', `${BUDGET.total} B`, 'v-strong')}
    ${grid(kinds.length, (i) => CLS[kinds[i] as keyof typeof CLS], jsonY)}
  </g>

  <g>
    ${heading(mpY - 26, 'MESSAGEPACK', `${BUDGET.binaryTotal} B`, 'v-mint')}
    ${grid(mpBytes, () => 'bv-bin', mpY)}
  </g>

</svg>`;
}

export const BYTE_LEGEND = [
  { fill: BYTE_FILL.s, label: 'Punctuation', value: BUDGET.structural },
  { fill: BYTE_FILL.k, label: 'Key names', value: BUDGET.keys },
  { fill: BYTE_FILL.v, label: 'Actual values', value: BUDGET.values },
];
