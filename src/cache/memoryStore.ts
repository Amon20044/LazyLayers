import { LRUCache } from 'lru-cache';

import type { CacheEntry, CacheKey, CacheOptions, CacheStore } from '../types/index.js';
import { matchesPattern } from './pattern.js';
import { DEFAULT_CACHE_TTL_MS, DEFAULT_L1_MAX_ENTRIES } from './defaults.js';

export class MemoryStore<K extends CacheKey, V> implements CacheStore<K, V> {
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
}
