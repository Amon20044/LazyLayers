import type { CacheKey, CacheOptions, EncodedCacheStore } from '../types/index.js';
import { deserialize, serialize } from '../utils/serializer.js';
import { decodeKVRecord, encodeKVRecord } from '../cloudflare/kvWire.js';
import { DEFAULT_CACHE_TTL_MS } from './defaults.js';
import { matchesPattern } from './pattern.js';

/** The subset of a Workers KV binding used by CloudflareKVStore. */
export interface CloudflareKVNamespace {
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options: { expirationTtl: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface CloudflareKVStoreOptions extends CacheOptions {
  /** Isolates this store's keys in a shared KV namespace. Default: `cache:`. */
  prefix?: string;
}

/**
 * Read-heavy, eventually consistent L2 backed by a Workers KV binding.
 * KV has no atomic compare-and-set, so this store deliberately does not expose
 * distributed locks or lease-checked publication.
 */
export class CloudflareKVStore<V> implements EncodedCacheStore<CacheKey, V> {
  readonly encodedFormat = 'lazy-layers-hc1' as const;
  private readonly prefix: string;

  constructor(
    private readonly namespace: CloudflareKVNamespace,
    private readonly options: CloudflareKVStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'cache:';
    if (!this.prefix) throw new RangeError('Cloudflare KV prefix cannot be empty');
    if (options.levels?.L2?.maxEntries !== undefined) {
      throw new RangeError('Cloudflare KV does not support L2 maxEntries');
    }
  }

  async set(key: CacheKey, value: V, options: CacheOptions = {}): Promise<void> {
    if (value === undefined) {
      await this.delete(key);
      return;
    }
    await this.setEncoded(key, serialize(value, this.codecOptions(options)), options);
  }

  async setEncoded(key: CacheKey, buffer: Uint8Array, options: CacheOptions = {}): Promise<void> {
    const ttlMs = this.ttl(options);
    const expiresAt = Date.now() + ttlMs;
    // KV only accepts physical expiration of at least 60 seconds. The wire
    // header enforces shorter logical TTLs during the extra retention time.
    const expirationTtl = Math.max(60, Math.ceil(ttlMs / 1_000));
    const value = encodeKVRecord(buffer, expiresAt);
    await this.namespace.put(this.key(key), value, { expirationTtl });
  }

  async get(key: CacheKey): Promise<V | undefined> {
    const entry = await this.getEncoded(key);
    return entry ? deserialize(entry.buffer) as V : undefined;
  }

  async getEncoded(key: CacheKey): Promise<{ buffer: Buffer; ttlRemainingMs: number } | undefined> {
    const raw = await this.namespace.get(this.key(key), 'arrayBuffer');
    if (raw === null) return undefined;
    const { payload, ttlRemainingMs } = decodeKVRecord(raw);
    if (ttlRemainingMs <= 0) return undefined;
    return { buffer: Buffer.from(payload), ttlRemainingMs };
  }

  async getOrSet(key: CacheKey, loader: () => Promise<V | undefined>, options?: CacheOptions): Promise<V | undefined> {
    const cached = await this.get(key);
    if (cached !== undefined) return cached;
    const value = await loader();
    if (value !== undefined) await this.set(key, value, options);
    return value;
  }

  async has(key: CacheKey): Promise<boolean> {
    return (await this.getEncoded(key)) !== undefined;
  }

  async delete(key: CacheKey): Promise<void> {
    await this.namespace.delete(this.key(key));
  }

  async deleteByPattern(pattern: string): Promise<void> {
    const firstWildcard = pattern.indexOf('*');
    if (firstWildcard === -1) return this.delete(pattern);
    const literalPrefix = firstWildcard === -1 ? pattern : pattern.slice(0, firstWildcard);
    let cursor: string | undefined;
    do {
      const page = await this.namespace.list({ prefix: this.prefix + literalPrefix, cursor });
      for (const item of page.keys) {
        if (item.name.startsWith(this.prefix) && matchesPattern(item.name.slice(this.prefix.length), pattern)) {
          await this.namespace.delete(item.name);
        }
      }
      if (page.list_complete) return;
      if (!page.cursor || page.cursor === cursor) throw new Error('Cloudflare KV list did not advance its cursor');
      cursor = page.cursor;
    } while (true);
  }

  async clear(): Promise<void> {
    await this.deleteByPattern('*');
  }

  async size(): Promise<number> {
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await this.namespace.list({ prefix: this.prefix, cursor });
      count += page.keys.filter((item) => item.name.startsWith(this.prefix)).length;
      if (page.list_complete) return count;
      if (!page.cursor || page.cursor === cursor) throw new Error('Cloudflare KV list did not advance its cursor');
      cursor = page.cursor;
    } while (true);
  }

  private key(key: CacheKey): string {
    const name = this.prefix + String(key);
    if (Buffer.byteLength(name, 'utf8') > 512) throw new RangeError('Cloudflare KV key exceeds 512 bytes');
    return name;
  }

  private ttl(options: CacheOptions): number {
    if (options.levels?.L2?.maxEntries !== undefined) {
      throw new RangeError('Cloudflare KV does not support L2 maxEntries');
    }
    const ttlMs = options.levels?.L2?.ttlMs ?? options.ttlMs
      ?? this.options.levels?.L2?.ttlMs ?? this.options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('Cloudflare KV TTL must be a positive safe integer');
    return ttlMs;
  }

  private codecOptions(options: CacheOptions) {
    return options.levels?.L2?.codec ?? this.options.levels?.L2?.codec ?? { format: 'json' as const, compression: 'none' as const };
  }
}
