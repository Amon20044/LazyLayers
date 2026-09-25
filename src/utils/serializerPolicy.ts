/**
 * Shared HC1 wire policy. Node codecs and the Worker facade both read these
 * constants. Adapters must not copy the thresholds or invent their own tags.
 */
export const PORTABLE_GZIP_MIN_BYTES = 1_024;
export const MIN_COMPRESSION_SAVINGS = 0.15;
/** Decoded gzip body cap. Matches the Cloudflare KV value limit. */
export const MAX_PORTABLE_DECODED_BYTES = 25 * 1024 * 1024;

export const HC1_TAG_BYTES = 4;
export const HC1_MSGPACK_TAG = 'HC1M';
export const HC1_GZIP_TAG = 'HC1G';
export const HC1_JSON_TAG = 'HC1J';
export const HC1_ZSTD_TAG = 'HC1Z';
export const HC1_LZ4_TAG = 'HC1L';
export const HC1_SNAPPY_TAG = 'HC1S';
export const HC1_FAMILY = 'HC1';

/** Packed in HC1M to mean a cached null. A real copy of this string uses HC1J. */
export const CACHE_NULL_SENTINEL = '__hybridcache_null__';

export type CloudflareKVCompression = 'auto' | 'none';

export function validateKVCompression(mode: CloudflareKVCompression | undefined): void {
  if (mode !== undefined && mode !== 'auto' && mode !== 'none') {
    throw new TypeError('Cloudflare KV compression must be auto or none');
  }
}

export function tagBytes(tag: string): Uint8Array {
  return new TextEncoder().encode(tag);
}

export function hasWireTag(bytes: Uint8Array, tag: string): boolean {
  if (bytes.byteLength < HC1_TAG_BYTES || tag.length !== HC1_TAG_BYTES) return false;
  for (let index = 0; index < HC1_TAG_BYTES; index += 1) {
    if (bytes[index] !== tag.charCodeAt(index)) return false;
  }
  return true;
}

export function wireTag(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength < HC1_TAG_BYTES) return undefined;
  const tag = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  return tag.startsWith(HC1_FAMILY) ? tag : undefined;
}

export function withWireTag(tag: string, body: Uint8Array): Uint8Array {
  const prefix = tagBytes(tag);
  const result = new Uint8Array(prefix.byteLength + body.byteLength);
  result.set(prefix);
  result.set(body, prefix.byteLength);
  return result;
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Gzip earns its CPU only above the shared floor and savings threshold. */
export function shouldUsePortableGzip(packedBytes: number, gzippedBytes: number): boolean {
  if (packedBytes < PORTABLE_GZIP_MIN_BYTES) return false;
  return 1 - gzippedBytes / packedBytes >= MIN_COMPRESSION_SAVINGS;
}
