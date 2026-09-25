import { pack, unpack } from 'msgpackr';
import { MIN_COMPRESSION_SAVINGS, PORTABLE_GZIP_MIN_BYTES, type CloudflareKVCompression } from './serializerPolicy.js';

/** HC1 tags already used by the Node serializer. Workers need only this portable subset. */
const MSGPACK_TAG = new Uint8Array([72, 67, 49, 77]); // HC1M
const GZIP_TAG = new Uint8Array([72, 67, 49, 71]); // HC1G
const JSON_TAG = new Uint8Array([72, 67, 49, 74]); // HC1J, previous KV records
const SENTINEL = '__hybridcache_null__';
const PACKED_SENTINEL = pack(SENTINEL);
const MAX_DECODED_BYTES = 25 * 1024 * 1024;

/** Encodes the same HC1M/HC1G representation that Node's serializer emits with gzip policy. */
export async function serializePortable(value: unknown, compression: CloudflareKVCompression = 'auto'): Promise<Uint8Array> {
  if (value === SENTINEL) return withTag(JSON_TAG, new TextEncoder().encode(JSON.stringify(value)));
  const packed = pack(value === null ? SENTINEL : value);
  if (compression === 'auto' && packed.byteLength >= PORTABLE_GZIP_MIN_BYTES) {
    const gzipped = await transform(packed, new CompressionStream('gzip'), MAX_DECODED_BYTES);
    if (1 - gzipped.byteLength / packed.byteLength >= MIN_COMPRESSION_SAVINGS) {
      return withTag(GZIP_TAG, gzipped);
    }
  }
  return withTag(MSGPACK_TAG, packed);
}

/** Reads HC1M/HC1G plus uncompressed JSON from the first KV implementation. */
export async function deserializePortable(payload: Uint8Array): Promise<unknown> {
  if (hasTag(payload, JSON_TAG)) return JSON.parse(new TextDecoder().decode(payload.subarray(4)));
  if (hasTag(payload, MSGPACK_TAG)) {
    const bytes = payload.subarray(4);
    if (sameBytes(bytes, PACKED_SENTINEL)) return null;
    return unpack(bytes);
  }
  if (hasTag(payload, GZIP_TAG)) {
    const bytes = await transform(payload.subarray(4), new DecompressionStream('gzip'), MAX_DECODED_BYTES);
    if (sameBytes(bytes, PACKED_SENTINEL)) return null;
    return unpack(bytes);
  }
  throw new TypeError('Cloudflare Workers KV requires an HC1M, HC1G, or HC1J value');
}

function withTag(tag: Uint8Array, body: Uint8Array): Uint8Array {
  const result = new Uint8Array(tag.byteLength + body.byteLength);
  result.set(tag);
  result.set(body, tag.byteLength);
  return result;
}

function hasTag(bytes: Uint8Array, tag: Uint8Array): boolean {
  return bytes.byteLength >= tag.byteLength && tag.every((byte, index) => bytes[index] === byte);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
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
