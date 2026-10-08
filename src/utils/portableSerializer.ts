import { pack, unpack, Unpackr } from 'msgpackr';
import { isSafeJson, isSafeMessagePack } from './decodeValidation.js';
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
  resolveDecodeLimits,
  type CloudflareKVCompression,
  type DecodeLimits,
  type DecodedCacheRecord,
} from './serializerPolicy.js';

const PACKED_SENTINEL = pack(CACHE_NULL_SENTINEL);
// Internal strict reads return owned binary values, never views into a record.
const strictUnpackr = new Unpackr({ useRecords: false, structuredClone: false, copyBuffers: true });

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
export async function deserializePortable(payload: Uint8Array, options?: DecodeLimits): Promise<unknown> {
  // Keep the exported one-argument reader compatible. Built-in stores use the
  // strict record capability below, and callers may opt in with explicit limits.
  const limits = options === undefined ? undefined : resolveDecodeLimits(options);
  if (limits && payload.byteLength > limits.maxEncodedBytes) throw new RangeError('Cloudflare KV encoded value exceeds configured limit');
  if (hasWireTag(payload, HC1_JSON_TAG)) {
    const bytes = payload.subarray(HC1_TAG_BYTES);
    if (limits && !isSafeJson(bytes, limits)) throw new RangeError('Cloudflare KV JSON value exceeds decode limits or is malformed');
    return JSON.parse(new TextDecoder('utf-8', { fatal: limits !== undefined }).decode(bytes));
  }
  if (hasWireTag(payload, HC1_MSGPACK_TAG)) {
    const bytes = payload.subarray(HC1_TAG_BYTES);
    if (limits && !isSafeMessagePack(bytes, limits)) throw new RangeError('Cloudflare KV MessagePack value exceeds decode limits or is malformed');
    if (sameBytes(bytes, PACKED_SENTINEL)) return null;
    return limits ? strictUnpackr.unpack(bytes) : unpack(bytes);
  }
  if (hasWireTag(payload, HC1_GZIP_TAG)) {
    const bytes = await transform(
      payload.subarray(HC1_TAG_BYTES),
      new DecompressionStream('gzip'),
      limits?.maxDecodedBytes ?? MAX_PORTABLE_DECODED_BYTES,
    );
    if (limits && !isSafeMessagePack(bytes, limits)) throw new RangeError('Cloudflare KV MessagePack value exceeds decode limits or is malformed');
    if (sameBytes(bytes, PACKED_SENTINEL)) return null;
    return limits ? strictUnpackr.unpack(bytes) : unpack(bytes);
  }
  const tag = wireTag(payload);
  if (tag === HC1_LZ4_TAG || tag === HC1_ZSTD_TAG || tag === HC1_SNAPPY_TAG || tag !== undefined) {
    // Same miss as the Node reader for a tag this runtime cannot run.
    return null;
  }
  throw new TypeError('Cloudflare Workers KV requires an HC1M, HC1G, or HC1J value');
}

/** Strict store capability: unsupported/corrupt records miss, cached null hits. */
export async function decodePortableCacheRecord(payload: Uint8Array, options?: DecodeLimits): Promise<DecodedCacheRecord> {
  const limits = resolveDecodeLimits(options);
  if (!hasWireTag(payload, HC1_MSGPACK_TAG) && !hasWireTag(payload, HC1_JSON_TAG) && !hasWireTag(payload, HC1_GZIP_TAG)) return { hit: false };
  try { return { hit: true, value: await deserializePortable(payload, limits) }; }
  catch { return { hit: false }; }
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
        throw new RangeError(maxBytes === MAX_PORTABLE_DECODED_BYTES
          ? 'Cloudflare KV decoded value exceeds 25 MiB'
          : 'Cloudflare KV transformed value exceeds configured limit');
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
