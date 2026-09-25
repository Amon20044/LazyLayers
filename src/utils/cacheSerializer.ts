import { deserializePortable, serializePortable } from './portableSerializer.js';
import {
  validateKVCompression,
  type CloudflareKVCompression,
} from './serializerPolicy.js';

export { deserializePortable, serializePortable } from './portableSerializer.js';
export {
  CACHE_NULL_SENTINEL,
  HC1_GZIP_TAG,
  HC1_JSON_TAG,
  HC1_LZ4_TAG,
  HC1_MSGPACK_TAG,
  HC1_SNAPPY_TAG,
  HC1_ZSTD_TAG,
  MAX_PORTABLE_DECODED_BYTES,
  MIN_COMPRESSION_SAVINGS,
  PORTABLE_GZIP_MIN_BYTES,
  shouldUsePortableGzip,
  validateKVCompression,
} from './serializerPolicy.js';

/**
 * Runtime-safe cache serializer. Adapters import this facade and call it.
 * They do not choose HC1 tags, sentinels, or compression thresholds.
 *
 * The Node process still has the full codec set in `serializer.ts`. This
 * facade is the Worker-safe path: web CompressionStream, MessagePack, and
 * the shared wire policy. It emits the same HC1M/HC1G/HC1J records that the
 * Node gzip policy emits, so the two runtimes can read each other.
 */
export interface CacheSerializer {
  serialize(value: unknown, compression?: CloudflareKVCompression): Promise<Uint8Array>;
  deserialize(payload: Uint8Array): Promise<unknown>;
}

export const cacheSerializer: CacheSerializer = {
  async serialize(value, compression = 'auto') {
    validateKVCompression(compression);
    return serializePortable(value, compression);
  },
  deserialize(payload) {
    return deserializePortable(payload);
  },
};

export async function serializeCacheValue(
  value: unknown,
  compression?: CloudflareKVCompression,
): Promise<Uint8Array> {
  return cacheSerializer.serialize(value, compression);
}

export async function deserializeCacheValue(payload: Uint8Array): Promise<unknown> {
  return cacheSerializer.deserialize(payload);
}
