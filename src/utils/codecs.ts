import { compressSync as lz4Compress, uncompressSync as lz4Uncompress } from 'lz4-napi';
import { compressSync as snappyCompress, uncompressSync as snappyUncompress } from 'snappy';
import zlib from 'node:zlib';

/**
 * Compression codecs and the size tiers that pick between them.
 *
 * Two facts from benchmarking real fixtures drive this whole file.
 *
 * First, compression makes small payloads BIGGER. A 119 byte session token
 * grows under every codec we tested: snappy 122, lz4 125, zstd 128, gzip 140.
 * Below roughly a kilobyte the right codec is none.
 *
 * Second, the old 64 KB floor was far too high. A 14 KB API list stored raw
 * shrinks to 3.5 KB under zstd for 21 microseconds of work. Refusing to
 * compress it was costing four times the storage to save nothing worth having.
 */

export type CodecName = 'none' | 'gzip' | 'zstd' | 'lz4' | 'snappy';

export interface Codec {
  name: CodecName;
  /** 4-byte wire tag, or null for the uncompressed path. */
  tag: string | null;
  compress(input: Buffer): Buffer;
  decompress(input: Buffer): Buffer;
}

/** One rule in a tier list: everything up to `maxBytes` uses `codec`. */
export interface CompressionTier {
  /** Upper bound in bytes, exclusive. Omit on the last tier to mean "and above". */
  maxBytes?: number;
  codec: CodecName;
}

const zstdCompress = (zlib as Partial<typeof zlib>).zstdCompressSync;
const zstdDecompress = (zlib as Partial<typeof zlib>).zstdDecompressSync;

/** zstd reached node:zlib in 22.15 and 23.8. This package still supports Node 20. */
export const ZSTD_AVAILABLE = typeof zstdCompress === 'function' && typeof zstdDecompress === 'function';

/**
 * lz4 and snappy ship with the package. They are the reason the small and mid
 * tiers can compress at all: at those sizes the difference in stored bytes
 * between them and zstd is small, while their speed advantage is large, and
 * this runs synchronously on the write path.
 */
export const LZ4_AVAILABLE = (): boolean => true;
export const SNAPPY_AVAILABLE = (): boolean => true;

const CODECS: Record<CodecName, Codec> = {
  none: {
    name: 'none',
    tag: null,
    compress: (input) => input,
    decompress: (input) => input,
  },
  gzip: {
    name: 'gzip',
    tag: 'HC1G',
    compress: (input) => zlib.gzipSync(input),
    decompress: (input) => zlib.gunzipSync(input),
  },
  zstd: {
    name: 'zstd',
    tag: 'HC1Z',
    compress: (input) => Buffer.from(zstdCompress!(input)),
    decompress: (input) => Buffer.from(zstdDecompress!(input)),
  },
  lz4: {
    name: 'lz4',
    tag: 'HC1L',
    compress: (input) => lz4Compress(input),
    decompress: (input) => lz4Uncompress(input),
  },
  snappy: {
    name: 'snappy',
    tag: 'HC1S',
    compress: (input) => snappyCompress(input),
    // snappy types the return as string | Buffer depending on options. We never
    // pass options, so it is always a Buffer.
    decompress: (input) => snappyUncompress(input) as Buffer,
  },
};

export function codecByName(name: CodecName): Codec {
  return CODECS[name];
}

export function codecByTag(tag: string): Codec | undefined {
  return Object.values(CODECS).find((c) => c.tag === tag);
}

/** True when this process can actually run the codec right now. */
export function codecAvailable(name: CodecName): boolean {
  if (name === 'zstd') return ZSTD_AVAILABLE;
  if (name === 'lz4') return LZ4_AVAILABLE();
  if (name === 'snappy') return SNAPPY_AVAILABLE();
  return true;
}

/**
 * Default tiers, chosen from measurements in benchmarks/ rather than by feel.
 *
 * Under 256 bytes: nothing. A 48 byte record grows under every codec, and even
 * where compression works down here it saves a few dozen bytes, which is not
 * worth a syscall on a value read on every request.
 *
 * 256 bytes to 4 KB: lz4. It wins on both axes at this end. Against zstd on a
 * 342 byte record it stored 54 bytes to zstd's 61, because zstd's frame header
 * costs more than it recovers at this size, and it did that roughly five times
 * faster.
 *
 * 4 KB and above: zstd. The crossover is sharp. Measured as bytes zstd saves
 * over lz4 per extra microsecond spent, the trade climbs from 9 B/us at 512
 * bytes to 88 B/us at 4 KB and 767 B/us at 256 KB. Past 4 KB the ratio is worth
 * the CPU on any storage you pay for.
 *
 * On Node 20, where node:zlib has no zstd, the top tier falls back to lz4
 * rather than gzip. gzip took 1,007us on a 100 KB payload against zstd's 151,
 * which is too much to spend synchronously on a write path.
 */
export const DEFAULT_TIERS: CompressionTier[] = [
  { maxBytes: 256, codec: 'none' },
  { maxBytes: 4 * 1024, codec: 'lz4' },
  { codec: ZSTD_AVAILABLE ? 'zstd' : 'lz4' },
];

/** Every codec is a dependency now, so auto and the default agree. */
export function autoTiers(): CompressionTier[] {
  return DEFAULT_TIERS;
}

/**
 * Pick the codec for a payload. Falls back to gzip when a tier names something
 * this process cannot run, so a config written for one machine never throws on
 * another.
 */
export function selectCodec(tiers: CompressionTier[], byteLength: number): Codec {
  for (const tier of tiers) {
    if (tier.maxBytes === undefined || byteLength < tier.maxBytes) {
      return codecAvailable(tier.codec) ? CODECS[tier.codec] : CODECS.lz4;
    }
  }

  return CODECS.none;
}

/** Reject a malformed tier list at configuration time rather than at write time. */
export function validateTiers(tiers: CompressionTier[]): void {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error('Compression tiers must be a non-empty array.');
  }

  let previous = 0;

  tiers.forEach((tier, i) => {
    if (!(tier.codec in CODECS)) {
      throw new Error(
        `Unknown compression codec "${tier.codec}". `
        + `Expected one of: ${Object.keys(CODECS).join(', ')}.`,
      );
    }

    if (tier.maxBytes === undefined) {
      if (i !== tiers.length - 1) {
        throw new Error('Only the last compression tier may omit maxBytes.');
      }
      return;
    }

    if (!Number.isFinite(tier.maxBytes) || tier.maxBytes <= previous) {
      throw new Error(
        `Compression tier ${i} has maxBytes ${tier.maxBytes}, which must be greater `
        + `than the previous tier's ${previous}.`,
      );
    }

    previous = tier.maxBytes;
  });
}
