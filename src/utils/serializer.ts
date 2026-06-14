import { gunzipSync, gzipSync } from 'node:zlib';
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

const PREFIX_LEN = 4;
export const HC1M = Buffer.from('HC1M', 'ascii'); // msgpack
export const HC1G = Buffer.from('HC1G', 'ascii'); // gzip(msgpack)
export const HC1J = Buffer.from('HC1J', 'ascii'); // JSON debug

const PACKED_SENTINEL = pack(NULL_SENTINEL);
const SENTINEL_BUFFER: Buffer = Buffer.concat([HC1M, Buffer.from(PACKED_SENTINEL)]);

/** Payloads smaller than this are never gzipped. */
export const GZIP_MIN_BYTES = 64 * 1024; // 64 KB
/** Required minimum savings ratio for gzip to be worth it. */
export const GZIP_SAVINGS_THRESHOLD = 0.15;

export type CacheEncoding = 'msgpack' | 'msgpack-gzip' | 'json';

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
  } catch {
    // Last-resort: stringify, then pack — keeps serialize() total even for unsupported types.
    packed = Buffer.from(pack(String(value)));
  }

  if (packed.length >= GZIP_MIN_BYTES) {
    const compressed = gzipSync(packed);
    if (shouldGzip(packed.length, compressed.length)) {
      const buffer = withPrefix(HC1G, compressed);
      return {
        buffer,
        encoding: 'msgpack-gzip',
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
      if (hasPrefix(buffer, HC1M)) {
        try {
          const body = stripPrefix(buffer, HC1M);
          const unpacked = unpack(body);
          return unwrapSentinel(unpacked);
        } catch {
          return null;
        }
      }
      if (hasPrefix(buffer, HC1J)) {
        try {
          const body = stripPrefix(buffer, HC1J);
          const parsed = JSON.parse(body.toString('utf8'));
          return unwrapSentinel(parsed);
        } catch {
          return null;
        }
      }
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
