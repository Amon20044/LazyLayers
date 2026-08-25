import zlib, { gunzipSync, gzipSync } from 'node:zlib';
import { pack, unpack } from 'msgpackr';

/**
 * Intelligent hybrid cache serializer (v2).
 *
 * Decision table:
 *   - Small payload (< GZIP_MIN_BYTES): msgpack only          -> HC1M
 *   - Large payload (>= GZIP_MIN_BYTES) AND gzip saves >= 15%: gzip(msgpack) -> HC1G
 *   - Large payload but gzip doesn't pay off: msgpack only    -> HC1M
 *   - CACHE_FORMAT=json or CACHE_DEBUG_SERIALIZATION=true:    -> HC1J  (JSON.stringify)
 *   - null/undefined: packed sentinel string                  -> HC1M
 *
 * Time/space complexity:
 *   - hasPrefix / stripPrefix : O(1) (fixed 4-byte compare)
 *   - msgpack pack/unpack     : O(n)
 *   - gzip / gunzip           : O(n) (higher CPU constant)
 *   - serialize / deserialize : O(n) on payload size
 *   - memory                  : O(stored bytes)
 */

export const NULL_SENTINEL = '__hybridcache_null__';

/**
 * Thrown when a value cannot be represented on the wire. Carries the original
 * msgpackr failure so the cause is not lost.
 */
export class CacheSerializationError extends Error {
  readonly valueType: string;

  constructor(value: unknown, readonly cause: unknown) {
    const type = value === null ? 'null' : typeof value;
    super(
      `LazyLayers cannot serialize a value of type ${type}. `
      + 'Common causes are circular references, functions and class instances '
      + 'with custom prototypes. The value was not written to L2 or broadcast.',
    );
    this.name = 'CacheSerializationError';
    this.valueType = type;
  }
}

const PREFIX_LEN = 4;
export const HC1M = Buffer.from('HC1M', 'ascii'); // msgpack
export const HC1G = Buffer.from('HC1G', 'ascii'); // gzip(msgpack)
export const HC1J = Buffer.from('HC1J', 'ascii'); // JSON debug
export const HC1Z = Buffer.from('HC1Z', 'ascii'); // zstd(msgpack)

/** Shared first three bytes. Used to recognise a tag we do not know yet. */
const PREFIX_FAMILY = Buffer.from('HC1', 'ascii');

/**
 * zstd landed in node:zlib in 22.15 and 23.8, and this package supports Node 20,
 * so it has to be detected rather than assumed.
 *
 * On our own fixtures zstd matches gzip's ratio to within a percentage point
 * while compressing roughly ten times faster, which matters because this runs
 * synchronously on the write path.
 */
const zstdCompress = (zlib as Partial<typeof import('node:zlib')>).zstdCompressSync;
const zstdDecompress = (zlib as Partial<typeof import('node:zlib')>).zstdDecompressSync;

export const ZSTD_AVAILABLE = typeof zstdCompress === 'function' && typeof zstdDecompress === 'function';

export type CompressionMode = 'gzip' | 'zstd' | 'auto';

/**
 * Which compressor new writes use. Reads always accept every format, so this
 * only ever affects what you produce.
 *
 * Defaults to gzip. A server still running an older build cannot decode HC1Z,
 * so switching is safe only once every reader in the fleet understands it.
 */
let compressionMode: CompressionMode = (process.env.CACHE_COMPRESSION as CompressionMode) ?? 'gzip';

export function configureCompression(mode: CompressionMode): void {
  compressionMode = mode;
}

function useZstd(): boolean {
  return ZSTD_AVAILABLE && (compressionMode === 'zstd' || compressionMode === 'auto');
}

const PACKED_SENTINEL = pack(NULL_SENTINEL);
const SENTINEL_BUFFER: Buffer = Buffer.concat([HC1M, Buffer.from(PACKED_SENTINEL)]);

/** Payloads smaller than this are never gzipped. */
export const GZIP_MIN_BYTES = 64 * 1024; // 64 KB
/** Required minimum savings ratio for gzip to be worth it. */
export const GZIP_SAVINGS_THRESHOLD = 0.15;

export type CacheEncoding = 'msgpack' | 'msgpack-gzip' | 'msgpack-zstd' | 'json';

export interface SerializedCacheValue {
  buffer: Buffer;
  encoding: CacheEncoding;
  originalBytes: number;
  storedBytes: number;
  /** Saved fraction relative to the raw msgpack (or JSON) size, e.g. 0.75 = 75% saved. */
  compressionRatio: number;
  compressed: boolean;
}

/** O(1) — compares only the first PREFIX_LEN bytes. */
export function hasPrefix(buffer: Buffer, prefix: Buffer): boolean {
  if (buffer.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buffer[i] !== prefix[i]) return false;
  }
  return true;
}

/** O(1) for fixed-length prefix — returns a view over the remaining bytes (no copy). */
export function stripPrefix(buffer: Buffer, prefix: Buffer): Buffer {
  return buffer.subarray(prefix.length);
}

/** Saved fraction relative to original. 100KB -> 25KB returns 0.75. */
export function getCompressionSavings(originalBytes: number, compressedBytes: number): number {
  if (originalBytes <= 0) return 0;
  const saved = 1 - compressedBytes / originalBytes;
  return saved < 0 ? 0 : saved;
}

/** Apply gzip only if it saves at least GZIP_SAVINGS_THRESHOLD vs the msgpack baseline. */
export function shouldGzip(packedLength: number, compressedLength: number): boolean {
  if (packedLength < GZIP_MIN_BYTES) return false;
  return getCompressionSavings(packedLength, compressedLength) >= GZIP_SAVINGS_THRESHOLD;
}

function isDebugJsonMode(): boolean {
  return (
    process.env.CACHE_FORMAT === 'json' ||
    process.env.CACHE_DEBUG_SERIALIZATION === 'true'
  );
}

function withPrefix(prefix: Buffer, payload: Buffer | Uint8Array): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([prefix, body], prefix.length + body.length);
}

/**
 * Serialize and return rich stats. `serialize` is just a convenience wrapper around `.buffer`.
 */
export function serializeWithStats(value: unknown): SerializedCacheValue {
  // null/undefined sentinel — keep it tiny and prefix-tagged so decode is uniform.
  if (value === null || value === undefined) {
    const buffer = SENTINEL_BUFFER;
    const originalBytes = PACKED_SENTINEL.length;
    return {
      buffer,
      encoding: 'msgpack',
      originalBytes,
      storedBytes: buffer.length,
      compressionRatio: 0,
      compressed: false,
    };
  }

  /*
   * A caller who genuinely caches the sentinel string would otherwise produce
   * bytes identical to a cached null, and read back null instead of their own
   * value. Route it through the JSON encoding instead.
   *
   * This is deliberately a write-side fix. Adding a fourth prefix would be
   * cleaner but would break rolling deploys, because a server still running the
   * old build would decode the unknown prefix as garbage. HC1J is understood by
   * every version that has ever shipped.
   */
  if (value === NULL_SENTINEL) {
    const jsonBuffer = Buffer.from(JSON.stringify(value), 'utf8');
    const buffer = withPrefix(HC1J, jsonBuffer);
    return {
      buffer,
      encoding: 'json',
      originalBytes: jsonBuffer.length,
      storedBytes: buffer.length,
      compressionRatio: 0,
      compressed: false,
    };
  }

  // JSON debug mode — readable values, larger size.
  if (isDebugJsonMode()) {
    const json = JSON.stringify(value);
    const jsonBuffer = Buffer.from(json, 'utf8');
    const buffer = withPrefix(HC1J, jsonBuffer);
    return {
      buffer,
      encoding: 'json',
      originalBytes: jsonBuffer.length,
      storedBytes: buffer.length,
      compressionRatio: 0,
      compressed: false,
    };
  }

  // Production path: msgpack, optionally gzipped for large payloads.
  let packed: Buffer;
  try {
    packed = Buffer.from(pack(value));
  } catch (error) {
    /*
     * Previously this fell back to pack(String(value)), which turned a circular
     * object into the literal string "[object Object]" and stored it as though
     * the write had succeeded. The caller got garbage back with no error, no
     * event, and no way to notice.
     *
     * Failing loudly is the safer trade. L1 holds the real object either way
     * because it never serializes, and both the L2 write and the bus publish
     * are already wrapped in fail-open guards, so an unserializable value
     * degrades to "not shared" instead of "silently wrong everywhere".
     */
    throw new CacheSerializationError(value, error);
  }

  if (packed.length >= GZIP_MIN_BYTES) {
    const zstd = useZstd();
    const compressed = zstd ? zstdCompress!(packed) : gzipSync(packed);

    // Same rule either way: compression has to earn its CPU before we keep it.
    if (shouldGzip(packed.length, compressed.length)) {
      const buffer = withPrefix(zstd ? HC1Z : HC1G, Buffer.from(compressed));
      return {
        buffer,
        encoding: zstd ? 'msgpack-zstd' : 'msgpack-gzip',
        originalBytes: packed.length,
        storedBytes: buffer.length,
        compressionRatio: getCompressionSavings(packed.length, compressed.length),
        compressed: true,
      };
    }
  }

  const buffer = withPrefix(HC1M, packed);
  return {
    buffer,
    encoding: 'msgpack',
    originalBytes: packed.length,
    storedBytes: buffer.length,
    compressionRatio: 0,
    compressed: false,
  };
}

/** Always returns a Buffer suitable for `redis.set(key, buffer, 'EX', ttl)`. */
export function serialize(value: unknown): Buffer {
  return serializeWithStats(value).buffer;
}

export interface BufferInspection {
  /** Wire encoding detected from the 4-byte prefix (or `legacy` when absent). */
  encoding: CacheEncoding | 'legacy';
  /** Total bytes stored on the wire (including prefix). */
  storedBytes: number;
  /** Fully decoded value, ready to render in a dashboard. */
  value: unknown;
}

/**
 * Read-only introspection of an already-stored buffer. Detects the encoding from
 * the prefix and decodes the value WITHOUT re-serializing — used by the
 * observability inspector. O(n) on payload (decode only), O(1) for the encoding
 * tag. Never throws: a corrupt buffer decodes to `null` like {@link deserialize}.
 */
export function inspectBuffer(raw: Buffer | Uint8Array): BufferInspection {
  const buffer = Buffer.isBuffer(raw)
    ? raw
    : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);

  let encoding: CacheEncoding | 'legacy' = 'legacy';

  if (buffer.length >= PREFIX_LEN) {
    if (hasPrefix(buffer, HC1G)) encoding = 'msgpack-gzip';
    else if (hasPrefix(buffer, HC1M)) encoding = 'msgpack';
    else if (hasPrefix(buffer, HC1J)) encoding = 'json';
  }

  return {
    encoding,
    storedBytes: buffer.length,
    value: deserialize(buffer),
  };
}

/**
 * Cheap estimate of a decoded value's in-memory footprint (UTF-8 byte length of
 * its JSON form). Used by the dashboard to show serialized-vs-deserialized size.
 * O(n); never throws (unsupported values estimate to 0).
 */
export function estimateValueBytes(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length;

  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

/** Saved fraction of wire size vs decoded size, clamped to [0, 1). */
export function sizeSavings(serializedBytes: number, deserializedBytes: number): number {
  if (deserializedBytes <= 0) return 0;
  const saved = 1 - serializedBytes / deserializedBytes;
  return saved < 0 ? 0 : saved;
}

function unwrapSentinel<T>(value: T): T | null {
  return value === NULL_SENTINEL ? null : value;
}

/**
 * Decode a value pulled from Redis (or anywhere). Supports:
 *   - HC1M / HC1G / HC1J prefixed buffers (current format)
 *   - Legacy raw msgpack buffers (older clients)
 *   - Legacy JSON strings / JSON-as-buffer
 *   - Plain strings (returned as-is if not JSON)
 *   - null/undefined -> null
 */
export function deserialize(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;

  if (raw instanceof Uint8Array && !Buffer.isBuffer(raw)) {
    raw = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  }

  if (Buffer.isBuffer(raw)) {
    const buffer = raw;

    if (buffer.length >= PREFIX_LEN) {
      if (hasPrefix(buffer, HC1G)) {
        try {
          const body = stripPrefix(buffer, HC1G);
          const unpacked = unpack(gunzipSync(body));
          return unwrapSentinel(unpacked);
        } catch {
          return null;
        }
      }
      if (hasPrefix(buffer, HC1Z)) {
        try {
          if (!zstdDecompress) {
            // Written by a newer server than this one. Report a miss so the
            // caller reloads, rather than handing back a wrong value.
            return null;
          }

          return unpack(zstdDecompress(stripPrefix(buffer, HC1Z)));
        } catch {
          return null;
        }
      }

      if (hasPrefix(buffer, HC1M)) {
        // Compare the whole buffer rather than the decoded value. Unwrapping
        // after decode meant a caller who legitimately cached the sentinel
        // string got null back instead of their own value.
        if (buffer.equals(SENTINEL_BUFFER)) {
          return null;
        }

        try {
          return unpack(stripPrefix(buffer, HC1M));
        } catch {
          return null;
        }
      }
      if (hasPrefix(buffer, HC1J)) {
        // No sentinel unwrapping here. Reaching this branch with the sentinel
        // string means a caller stored it on purpose.
        try {
          return JSON.parse(stripPrefix(buffer, HC1J).toString('utf8'));
        } catch {
          return null;
        }
      }
    }

    /*
     * A tag in our own family that we do not recognise belongs to a format from
     * a newer release. Falling through to the legacy decoder would let msgpack
     * read the tag bytes as data and return a plausible wrong value, so treat
     * it as a miss instead. This is what makes adding a fifth encoding safe.
     */
    if (buffer.length >= PREFIX_FAMILY.length && hasPrefix(buffer, PREFIX_FAMILY)) {
      return null;
    }

    // Legacy: raw msgpack with no prefix.
    try {
      const unpacked = unpack(buffer);
      return unwrapSentinel(unpacked);
    } catch {
      // Legacy: JSON serialized as bytes.
      try {
        const parsed = JSON.parse(buffer.toString('utf8'));
        return unwrapSentinel(parsed);
      } catch {
        return null;
      }
    }
  }

  if (typeof raw === 'string') {
    if (raw === NULL_SENTINEL) return null;
    try {
      const parsed = JSON.parse(raw);
      return unwrapSentinel(parsed);
    } catch {
      return raw;
    }
  }

  return raw;
}
