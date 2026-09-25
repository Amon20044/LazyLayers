const HEADER = new Uint8Array([76, 76, 75, 49]); // LLK1
const HEADER_BYTES = 12;

export function encodeKVRecord(payload: Uint8Array, expiresAt: number): Uint8Array {
  if (!Number.isSafeInteger(expiresAt)) throw new RangeError('Cloudflare KV expiration exceeds the safe date range');
  if (payload.byteLength + HEADER_BYTES > 25 * 1024 * 1024) {
    throw new RangeError('Cloudflare KV value exceeds 25 MiB');
  }
  const value = new Uint8Array(HEADER_BYTES + payload.byteLength);
  value.set(HEADER);
  new DataView(value.buffer).setFloat64(4, expiresAt);
  value.set(payload, HEADER_BYTES);
  return value;
}

export function decodeKVRecord(raw: ArrayBuffer): { payload: Uint8Array; ttlRemainingMs: number } {
  const value = new Uint8Array(raw);
  if (value.byteLength < HEADER_BYTES || !HEADER.every((byte, index) => value[index] === byte)) {
    throw new TypeError('Cloudflare KV cache entry has an unsupported wire header');
  }
  const expiresAt = new DataView(raw).getFloat64(4);
  if (!Number.isSafeInteger(expiresAt)) throw new TypeError('Cloudflare KV cache entry has invalid expiration');
  return { payload: value.subarray(HEADER_BYTES), ttlRemainingMs: expiresAt - Date.now() };
}
