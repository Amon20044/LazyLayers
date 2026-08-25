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
 * lz4 and snappy are native modules and deliberately not dependencies. They are
 * resolved once, on first use, and stay unavailable if they are not installed.
 * Wrapping the require keeps a missing optional module from becoming a crash.
 */
function optional<T>(specifier: string): T | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const req: NodeRequire = eval('require');
    return req(specifier) as T;
  } catch {
    return undefined;
  }
}

interface Lz4Module { compressSync(b: Buffer): Buffer; uncompressSync(b: Buffer): Buffer }
interface SnappyModule { compressSync(b: Buffer): Buffer; uncompressSync(b: Buffer): Buffer }

let lz4Resolved = false;
let lz4Module: Lz4Module | undefined;
let snappyResolved = false;
let snappyModule: SnappyModule | undefined;

function lz4(): Lz4Module | undefined {
  if (!lz4Resolved) {
    lz4Module = optional<Lz4Module>('lz4-napi');
    lz4Resolved = true;
  }
  return lz4Module;
}

function snappy(): SnappyModule | undefined {
  if (!snappyResolved) {
    snappyModule = optional<SnappyModule>('snappy');
    snappyResolved = true;
  }
  return snappyModule;
}

export const LZ4_AVAILABLE = (): boolean => lz4() !== undefined;
export const SNAPPY_AVAILABLE = (): boolean => snappy() !== undefined;

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
    compress: (input) => lz4()!.compressSync(input),
    decompress: (input) => lz4()!.uncompressSync(input),
  },
  snappy: {
    name: 'snappy',
    tag: 'HC1S',
    compress: (input) => snappy()!.compressSync(input),
    decompress: (input) => snappy()!.uncompressSync(input),
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
 * Default tiers.
 *
 * gzip rather than zstd on purpose: a server still running an older build
 * cannot read HC1Z, so the safe default is the format every release
 * understands. Opt into the faster codec once the whole fleet is upgraded.
 */
export const DEFAULT_TIERS: CompressionTier[] = [
  { maxBytes: 1024, codec: 'none' },
  { codec: 'gzip' },
];

/** Tiers using the fastest codec each machine actually has installed. */
export function autoTiers(): CompressionTier[] {
  const large: CodecName = ZSTD_AVAILABLE ? 'zstd' : 'gzip';
  const mid: CodecName = LZ4_AVAILABLE() ? 'lz4' : SNAPPY_AVAILABLE() ? 'snappy' : large;

  return [
    { maxBytes: 1024, codec: 'none' },
    { maxBytes: 256 * 1024, codec: mid },
    { codec: large },
  ];
}

/**
 * Pick the codec for a payload. Falls back to gzip when a tier names something
 * this process cannot run, so a config written for one machine never throws on
 * another.
 */
export function selectCodec(tiers: CompressionTier[], byteLength: number): Codec {
  for (const tier of tiers) {
    if (tier.maxBytes === undefined || byteLength < tier.maxBytes) {
      return codecAvailable(tier.codec) ? CODECS[tier.codec] : CODECS.gzip;
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
