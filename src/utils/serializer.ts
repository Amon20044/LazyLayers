import { pack, unpack } from 'msgpackr';

/**
 * Sentinel used for null/undefined caching.
 * Packed once at module load — avoids re-packing on every serialize call.
 */
export const NULL_SENTINEL = '__hybridcache_null__';
const PACKED_SENTINEL = pack(NULL_SENTINEL);

/**
 * Serialize any JS value into Buffer (msgpack).
 */
export function serialize(value: unknown): Buffer {
  if (value === null || value === undefined) return PACKED_SENTINEL;
  try {
    return pack(value);
  } catch {
    return pack(String(value));
  }
}

/**
 * Deserialize Redis/L2 value into JS value.
 */
export function deserialize(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;

  if (Buffer.isBuffer(raw)) {
    try {
      const val = unpack(raw);
      return val === NULL_SENTINEL ? null : val;
    } catch {
      // Legacy JSON fallback (Buffer containing stringified JSON)
      try {
        const str = raw.toString('utf8');
        const parsed = JSON.parse(str);
        return parsed === NULL_SENTINEL ? null : parsed;
      } catch {
        return null;
      }
    }
  }

  if (typeof raw === 'string') {
    if (raw === NULL_SENTINEL) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed === NULL_SENTINEL ? null : parsed;
    } catch {
      return raw;
    }
  }

  return raw;
}