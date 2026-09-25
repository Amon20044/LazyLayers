import { pack, unpack } from 'msgpackr';
import {
  CACHE_NULL_SENTINEL,
  HC1_GZIP_TAG,
  HC1_JSON_TAG,
  HC1_LZ4_TAG,
  HC1_MSGPACK_TAG,
  HC1_SNAPPY_TAG,
  HC1_TAG_BYTES,
  HC1_ZSTD_TAG,
  MAX_PORTABLE_DECODED_BYTES,
  PORTABLE_GZIP_MIN_BYTES,
  hasWireTag,
  sameBytes,
  shouldUsePortableGzip,
  wireTag,
  withWireTag,
  type CloudflareKVCompression,
} from './serializerPolicy.js';

const PACKED_SENTINEL = pack(CACHE_NULL_SENTINEL);

/**
 * Worker-safe HC1 codec. It writes the same HC1M/HC1G/HC1J bytes as the Node
 * serializer's portable gzip policy, and reads those records back. Node-only
 * HC1L/HC1Z/HC1S tags are recognised and rejected rather than decoded as data.
 */
export async function serializePortable(
  value: unknown,
  compression: CloudflareKVCompression = 'auto',
): Promise<Uint8Array> {
  if (value === undefined) return serializePortable(null, 'none');
  if (value === CACHE_NULL_SENTINEL) {
    return withWireTag(HC1_JSON_TAG, new TextEncoder().encode(JSON.stringify(value)));
  }
  let packed: Uint8Array;
  try {
    packed = pack(value === null ? CACHE_NULL_SENTINEL : value);
  } catch (cause) {
    const type = value === null ? 'null' : typeof value;
    throw new TypeError(
      `LazyLayers cannot serialize a value of type ${type}. `
      + 'Common causes are circular references, functions and class instances.',
      { cause },
    );
  }
  if (compression === 'auto' && packed.byteLength >= PORTABLE_GZIP_MIN_BYTES) {
    const gzipped = await transform(packed, new CompressionStream('gzip'), MAX_PORTABLE_DECODED_BYTES);
    if (shouldUsePortableGzip(packed.byteLength, gzipped.byteLength)) {
      return withWireTag(HC1_GZIP_TAG, gzipped);
    }
  }
  return withWireTag(HC1_MSGPACK_TAG, packed);
}

/** Reads HC1M/HC1G plus earlier HC1J records. Other HC1 tags are a miss. */
export async function deserializePortable(payload: Uint8Array): Promise<unknown> {
  if (hasWireTag(payload, HC1_JSON_TAG)) {
    return JSON.parse(new TextDecoder().decode(payload.subarray(HC1_TAG_BYTES)));
  }
  if (hasWireTag(payload, HC1_MSGPACK_TAG)) {
    const bytes = payload.subarray(HC1_TAG_BYTES);
    if (sameBytes(bytes, PACKED_SENTINEL)) return null;
    return unpack(bytes);
  }
  if (hasWireTag(payload, HC1_GZIP_TAG)) {
    const bytes = await transform(
      payload.subarray(HC1_TAG_BYTES),
      new DecompressionStream('gzip'),
      MAX_PORTABLE_DECODED_BYTES,
    );
    if (sameBytes(bytes, PACKED_SENTINEL)) return null;
    return unpack(bytes);
  }
  const tag = wireTag(payload);
  if (tag === HC1_LZ4_TAG || tag === HC1_ZSTD_TAG || tag === HC1_SNAPPY_TAG || tag !== undefined) {
    // Same miss as the Node reader for a tag this runtime cannot run.
    return null;
  }
  throw new TypeError('Cloudflare Workers KV requires an HC1M, HC1G, or HC1J value');
}

async function transform(input: Uint8Array, codec: CompressionStream | DecompressionStream, maxBytes: number): Promise<Uint8Array> {
  const source = new ReadableStream<BufferSource>({
    start(controller) { controller.enqueue(Uint8Array.from(input)); controller.close(); },
  });
  const reader = source.pipeThrough(codec).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new RangeError('Cloudflare KV decoded value exceeds 25 MiB');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}
