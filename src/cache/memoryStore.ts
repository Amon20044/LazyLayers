import { LRUCache } from 'lru-cache';

import type {
  CacheEntry,
  CacheKey,
  CacheOptions,
  CacheStore,
  InspectableStore,
  KeyInspection,
  StoreInspectOptions,
  StoreInspection,
} from '../types/index.js';
import { matchesPattern } from './pattern.js';
import { estimateValueBytes, serializeWithStats, sizeSavings } from '../utils/serializer.js';
import { DEFAULT_CACHE_TTL_MS, DEFAULT_L1_MAX_ENTRIES } from './defaults.js';

/** Default keys-per-page when a dashboard inspects the L1 layer. */
const DEFAULT_INSPECT_LIMIT = 100;
/** Default truncation threshold for decoded values (256 KB). */
const DEFAULT_MAX_VALUE_BYTES = 256 * 1024;

export class MemoryStore<K extends CacheKey, V> implements CacheStore<K, V>, InspectableStore {
  private readonly cache: LRUCache<K, CacheEntry<V>>;
  private readonly options: CacheOptions;

  constructor(options: CacheOptions = {}) {
    this.options = options;
    const levelOptions = options.levels?.L1;

    this.cache = new LRUCache<K, CacheEntry<V>>({
      max: levelOptions?.maxEntries ?? DEFAULT_L1_MAX_ENTRIES,
      ttl: levelOptions?.ttlMs ?? options.ttlMs ?? DEFAULT_CACHE_TTL_MS,
    });
  }




  async set(key: K, value: V, options: CacheOptions = {}): Promise<void> {
    const ttl = options.levels?.L1?.ttlMs
      ?? options.ttlMs
      ?? this.options.levels?.L1?.ttlMs
      ?? this.options.ttlMs
      ?? DEFAULT_CACHE_TTL_MS;

    this.cache.set(key, { value }, { ttl });
  }

  async get(key: K): Promise<V | undefined> {
    return this.cache.get(key)?.value;
  }

  async getOrSet(key: K, loader: () => Promise<V | undefined>, options?: CacheOptions): Promise<V | undefined> {
    const cached = await this.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const value = await loader();

    if (value === undefined) {
      return undefined;
    }

    await this.set(key, value, options);

    return value;
  }

  async has(key: K): Promise<boolean> {
    return this.cache.has(key);
  }

  async delete(key: K): Promise<void> {
    this.cache.delete(key);
  }

  async deleteByPattern(pattern: string): Promise<void> {
    for (const key of this.cache.keys()) {
      if (matchesPattern(String(key), pattern)) {
        this.cache.delete(key);
      }
    }
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }

  async size(): Promise<number> {
    return this.cache.size;
  }

  /**
   * Read-only snapshot of the LRU contents for the observability dashboard.
   *
   * Uses `peek()` so reading values NEVER changes recency/eviction order, making
   * inspection side-effect free. The cursor is a numeric offset over the filtered
   * key set; pages are bounded by `limit`, so this is safe to call on demand.
   */
  async inspect(options: StoreInspectOptions = {}): Promise<StoreInspection> {
    const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_INSPECT_LIMIT;
    const offset = Number.parseInt(options.cursor ?? '0', 10) || 0;
    const includeValues = options.includeValues !== false;
    const maxValueBytes = options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;

    let index = 0;
    const keys: KeyInspection[] = [];

    for (const rawKey of this.cache.keys()) {
      const key = String(rawKey);

      if (options.match && !matchesPattern(key, options.match)) {
        continue;
      }

      if (index < offset) {
        index += 1;
        continue;
      }

      if (keys.length >= limit) {
        break;
      }

      index += 1;

      const entry = this.cache.peek(rawKey);
      const value = entry?.value;
      const deserializedBytes = estimateValueBytes(value);
      const remaining = this.cache.getRemainingTTL(rawKey);

      // Compute the prospective wire size so the dashboard can compare in-memory
      // vs serialized footprint — but skip serializing values past the cap so a
      // page of huge objects can't turn inspection into heavy CPU work.
      let serializedBytes = deserializedBytes;
      let encoding: KeyInspection['encoding'] = 'msgpack';
      const overCap = deserializedBytes > maxValueBytes;

      if (!overCap) {
        const stats = serializeWithStats(value);
        serializedBytes = stats.storedBytes;
        encoding = stats.encoding;
      }

      const inspection: KeyInspection = {
        key,
        ttlRemainingMs: Number.isFinite(remaining) ? remaining : -1,
        serializedBytes,
        deserializedBytes,
        compressionRatio: sizeSavings(serializedBytes, deserializedBytes),
        encoding,
      };

      if (includeValues) {
        if (overCap) {
          inspection.truncated = true;
        } else {
          inspection.value = value;
        }
      }

      keys.push(inspection);
    }

    const nextOffset = offset + keys.length;

    return {
      size: this.cache.size,
      cursor: keys.length === limit ? String(nextOffset) : undefined,
      keys,
    };
  }
}
