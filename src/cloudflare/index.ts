import type { CacheKey, CacheOptions, CacheStore } from '../types/index.js';
import type { CloudflareKVNamespace } from '../cache/cloudflareKvStore.js';
import { matchesPattern } from '../cache/pattern.js';
import { decodeKVRecord, encodeKVRecord } from './kvWire.js';
import type { CloudflareInvalidationPublisher } from './invalidationQueue.js';
export {
  CloudflareQueueInvalidationPublisher,
  CloudflareQueueRestSender,
  parseCloudflareInvalidationMessage,
} from './invalidationQueue.js';
export type {
  CloudflareInvalidationMessage,
  CloudflareInvalidationPublisher,
  CloudflareQueueRestOptions,
  CloudflareQueueSender,
} from './invalidationQueue.js';
export type { CloudflareKVNamespace } from '../cache/cloudflareKvStore.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const JSON_PREFIX = 'HC1J';
const DEFAULT_TTL_MS = 60 * 60 * 1_000;

export interface CloudflareWorkerKVStoreOptions {
  /** Isolate application keys within the bound namespace. Default: `cache:`. */
  prefix?: string;
  /** Default: one hour. */
  ttlMs?: number;
  /** Bound a Worker pattern purge before it consumes too many KV operations. Default: 400. */
  maxPatternScanKeys?: number;
}

/** Workers-safe KV store. Its JSON wire format is readable by CloudflareKVStore on Node. */
export class CloudflareWorkerKVStore<V> implements CacheStore<CacheKey, V> {
  private readonly prefix: string;

  constructor(private readonly namespace: CloudflareKVNamespace, private readonly options: CloudflareWorkerKVStoreOptions = {}) {
    this.prefix = options.prefix ?? 'cache:';
    if (!this.prefix) throw new RangeError('Cloudflare KV prefix cannot be empty');
    const max = options.maxPatternScanKeys ?? 400;
    if (!Number.isSafeInteger(max) || max < 1 || max > 900) {
      throw new RangeError('Cloudflare KV maxPatternScanKeys must be between 1 and 900');
    }
  }

  async set(key: CacheKey, value: V, options: CacheOptions = {}): Promise<void> {
    if (value === undefined) return this.delete(key);
    const ttlMs = this.ttl(options);
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError('Cloudflare KV value is not JSON serializable');
    const raw = encodeKVRecord(encoder.encode(JSON_PREFIX + json), Date.now() + ttlMs);
    await this.namespace.put(this.key(key), raw, { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1_000)) });
  }

  async get(key: CacheKey): Promise<V | undefined> {
    return (await this.getWithTtl(key))?.value;
  }

  async getWithTtl(key: CacheKey): Promise<{ value: V; ttlRemainingMs: number } | undefined> {
    const raw = await this.namespace.get(this.key(key), 'arrayBuffer');
    if (raw === null) return undefined;
    const entry = decodeKVRecord(raw);
    if (entry.ttlRemainingMs <= 0) return undefined;
    const text = decoder.decode(entry.payload);
    if (!text.startsWith(JSON_PREFIX)) {
      throw new TypeError('Cloudflare Workers KV requires the JSON L2 codec for this key');
    }
    return { value: JSON.parse(text.slice(JSON_PREFIX.length)) as V, ttlRemainingMs: entry.ttlRemainingMs };
  }

  async getOrSet(key: CacheKey, loader: () => Promise<V | undefined>, options?: CacheOptions): Promise<V | undefined> {
    const cached = await this.get(key);
    if (cached !== undefined) return cached;
    const value = await loader();
    if (value !== undefined) await this.set(key, value, options);
    return value;
  }

  async has(key: CacheKey): Promise<boolean> { return (await this.getWithTtl(key)) !== undefined; }
  async delete(key: CacheKey): Promise<void> { await this.namespace.delete(this.key(key)); }

  async deleteByPattern(pattern: string): Promise<void> {
    const star = pattern.indexOf('*');
    if (star < 0) return this.delete(pattern);
    const prefix = this.prefix + (star < 0 ? pattern : pattern.slice(0, star));
    const max = this.options.maxPatternScanKeys ?? 400;
    const names: string[] = [];
    let scanned = 0;
    let cursor: string | undefined;
    do {
      const page = await this.namespace.list({ prefix, cursor, limit: Math.min(1_000, max - scanned + 1) });
      scanned += page.keys.length;
      if (scanned > max || (!page.list_complete && scanned >= max)) {
        throw new RangeError(`Cloudflare KV pattern scan exceeded ${max} keys; use a narrower pattern or a background purge`);
      }
      for (const entry of page.keys) {
        if (entry.name.startsWith(this.prefix) && matchesPattern(entry.name.slice(this.prefix.length), pattern)) {
          names.push(entry.name);
        }
      }
      if (page.list_complete) break;
      if (!page.cursor || page.cursor === cursor) throw new Error('Cloudflare KV list did not advance its cursor');
      cursor = page.cursor;
    } while (true);
    for (const name of names) await this.namespace.delete(name);
  }

  async clear(): Promise<void> { await this.deleteByPattern('*'); }

  async size(): Promise<number> {
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await this.namespace.list({ prefix: this.prefix, cursor });
      count += page.keys.length;
      if (page.list_complete) return count;
      if (!page.cursor || page.cursor === cursor) throw new Error('Cloudflare KV list did not advance its cursor');
      cursor = page.cursor;
    } while (true);
  }

  private key(key: CacheKey): string {
    const value = this.prefix + String(key);
    if (encoder.encode(value).byteLength > 512) throw new RangeError('Cloudflare KV key exceeds 512 bytes');
    return value;
  }

  private ttl(options: CacheOptions): number {
    if (options.levels?.L2?.maxEntries !== undefined) throw new RangeError('Cloudflare KV does not support L2 maxEntries');
    const ttlMs = options.levels?.L2?.ttlMs ?? options.ttlMs ?? this.options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('Cloudflare KV TTL must be a positive safe integer');
    return ttlMs;
  }
}

export interface CloudflareWorkerCacheOptions<V> extends CloudflareWorkerKVStoreOptions {
  /** Optional per-isolate memory shared by cache instances. */
  l1?: CloudflareWorkerMemoryStore<V>;
  /** Maximum L1 age. Default: 10 seconds. */
  l1TtlMs?: number;
  /** Called when an L2 read or fill fails and getOrSet falls back to the loader or L1. */
  onError?: (error: unknown, operation: 'get' | 'set') => void;
  /** Optional durable Queue publication after application invalidations. */
  invalidationPublisher?: CloudflareInvalidationPublisher;
}

/** In-memory L1 values only. Safe to reuse across Worker requests. */
export class CloudflareWorkerMemoryStore<V> {
  private readonly entries = new Map<string, { json: string; expiresAt: number }>();
  constructor(readonly maxEntries = 1_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new RangeError('L1 maxEntries must be positive');
  }
  get(key: CacheKey): V | undefined {
    const name = String(key);
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) { this.entries.delete(name); return undefined; }
    this.entries.delete(name);
    this.entries.set(name, entry);
    return JSON.parse(entry.json) as V;
  }
  set(key: CacheKey, value: V, ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('L1 TTL must be positive');
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError('Worker L1 value is not JSON serializable');
    const name = String(key);
    this.entries.delete(name);
    this.entries.set(name, { json, expiresAt: Date.now() + ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
  delete(key: CacheKey): void { this.entries.delete(String(key)); }
  deleteByPattern(pattern: string): void {
    for (const key of this.entries.keys()) if (matchesPattern(key, pattern)) this.entries.delete(key);
  }
  clear(): void { this.entries.clear(); }
}

/** Request-scoped cache facade with an optional reusable in-memory L1. */
export class CloudflareWorkerCache<V> {
  readonly l2: CloudflareWorkerKVStore<V>;
  private readonly inflight = new Map<string, Promise<V | undefined>>();
  private readonly generations = new Map<string, number>();
  private readonly l1TtlMs: number;

  constructor(namespace: CloudflareKVNamespace, private readonly options: CloudflareWorkerCacheOptions<V> = {}) {
    this.l2 = new CloudflareWorkerKVStore<V>(namespace, options);
    this.l1TtlMs = options.l1TtlMs ?? 10_000;
    if (!Number.isSafeInteger(this.l1TtlMs) || this.l1TtlMs <= 0) throw new RangeError('L1 TTL must be positive');
  }

  async get(key: CacheKey): Promise<V | undefined> {
    const local = this.options.l1?.get(this.localKey(key));
    if (local !== undefined) return local;
    const entry = await this.l2.getWithTtl(key);
    if (entry) this.options.l1?.set(this.localKey(key), entry.value, Math.max(1, Math.floor(Math.min(this.l1TtlMs, entry.ttlRemainingMs))));
    return entry?.value;
  }

  async getOrSet(key: CacheKey, loader: () => Promise<V | undefined>, options?: CacheOptions): Promise<V | undefined> {
    const cached = await this.get(key).catch((error: unknown) => {
      this.reportError(error, 'get');
      return undefined;
    });
    if (cached !== undefined) return cached;
    const name = String(key);
    const pending = this.inflight.get(name);
    if (pending) return pending;
    const generation = this.generations.get(name) ?? 0;
    const promise = (async () => {
      const value = await loader();
      if (value !== undefined && (this.generations.get(name) ?? 0) === generation) {
        try { await this.set(key, value, options); }
        catch (error) {
          this.reportError(error, 'set');
          this.options.l1?.set(this.localKey(key), value, this.l1TtlMs);
        }
      }
      return value;
    })();
    this.inflight.set(name, promise);
    try { return await promise; }
    finally { this.inflight.delete(name); }
  }

  async set(key: CacheKey, value: V, options: CacheOptions = {}): Promise<void> {
    if (value === undefined) return this.delete(key);
    const name = String(key);
    this.generations.set(name, (this.generations.get(name) ?? 0) + 1);
    this.options.l1?.delete(this.localKey(key));
    await this.l2.set(key, value, options);
    const ttlMs = options.levels?.L2?.ttlMs ?? options.ttlMs ?? this.options.ttlMs ?? DEFAULT_TTL_MS;
    this.options.l1?.set(this.localKey(key), value, Math.min(this.l1TtlMs, ttlMs));
  }

  async has(key: CacheKey): Promise<boolean> { return (await this.get(key)) !== undefined; }
  async delete(key: CacheKey): Promise<void> {
    const name = String(key);
    this.generations.set(name, (this.generations.get(name) ?? 0) + 1);
    this.options.l1?.delete(this.localKey(key));
    await this.invalidateWithQueue(() => this.l2.delete(key), () => this.options.invalidationPublisher!.publishKey(String(key)));
  }
  async invalidate(key: CacheKey): Promise<void> { await this.delete(key); }
  async deleteByPattern(pattern: string): Promise<void> {
    for (const key of this.inflight.keys()) {
      if (matchesPattern(key, pattern)) this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    }
    this.options.l1?.deleteByPattern(`${this.options.prefix ?? 'cache:'}${pattern}`);
    await this.invalidateWithQueue(() => this.l2.deleteByPattern(pattern), () => this.options.invalidationPublisher!.publishPattern(pattern));
  }
  async invalidateByPattern(pattern: string): Promise<void> { await this.deleteByPattern(pattern); }
  async clear(): Promise<void> { await this.deleteByPattern('*'); }
  async size(): Promise<number> { return this.l2.size(); }
  async prewarm(key: CacheKey, loader: () => Promise<V | undefined>, options?: CacheOptions): Promise<V | undefined> {
    return this.getOrSet(key, loader, options);
  }
  async close(): Promise<void> { this.inflight.clear(); }

  private localKey(key: CacheKey): string { return `${this.options.prefix ?? 'cache:'}${String(key)}`; }
  private reportError(error: unknown, operation: 'get' | 'set'): void {
    try { this.options.onError?.(error, operation); } catch { /* preserve cache fallback */ }
  }
  private async invalidateWithQueue(local: () => Promise<void>, publish: () => Promise<void>): Promise<void> {
    let localError: unknown;
    try { await local(); } catch (error) { localError = error; }
    if (localError instanceof RangeError) throw localError;
    if (!this.options.invalidationPublisher) {
      if (localError) throw localError;
      return;
    }
    await publish();
  }
}
