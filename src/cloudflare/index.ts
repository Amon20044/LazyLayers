import type { CacheKey, CacheOptions, CacheStore } from '../types/index.js';
import type { CloudflareKVNamespace } from '../cache/cloudflareKvStore.js';
import { matchesPattern } from '../cache/pattern.js';
import { decodeKVRecord, encodeKVRecord } from './kvWire.js';
import { decodePortableCacheRecord, serializeCacheValue } from '../utils/cacheSerializer.js';
import { resolveDecodeLimits, validateKVCompression, type CloudflareKVCompression, type DecodeLimits, type ResolvedDecodeLimits } from '../utils/serializerPolicy.js';
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
export type { CloudflareKVCompression, DecodeLimits, DecodedCacheRecord } from '../utils/serializerPolicy.js';
export { cacheSerializer, deserializeCacheValue, serializeCacheValue, decodePortableCacheRecord } from '../utils/cacheSerializer.js';

const DEFAULT_TTL_MS = 60 * 60 * 1_000;

export interface CloudflareWorkerKVStoreOptions {
  /** Isolate application keys within the bound namespace. Default: `cache:`. */
  prefix?: string;
  /** Default: one hour. */
  ttlMs?: number;
  /** Bound a Worker pattern purge before it consumes too many KV operations. Default: 400. */
  maxPatternScanKeys?: number;
  /** Adaptive gzip for HC1 MessagePack values (default), or none. */
  compression?: CloudflareKVCompression;
  /** Limits for internal KV decode. Default: 25 MiB wire/expanded, bounded depth and collections. */
  decodeLimits?: DecodeLimits;
}

/** Workers-safe KV store. It reads/writes the portable HC1 formats used by Node. */
export class CloudflareWorkerKVStore<V> implements CacheStore<CacheKey, V> {
  private readonly prefix: string;
  private readonly decodeLimits: ResolvedDecodeLimits;

  constructor(private readonly namespace: CloudflareKVNamespace, private readonly options: CloudflareWorkerKVStoreOptions = {}) {
    this.prefix = options.prefix ?? 'cache:';
    this.decodeLimits = resolveDecodeLimits(options.decodeLimits);
    if (!this.prefix) throw new RangeError('Cloudflare KV prefix cannot be empty');
    validateKVCompression(options.compression);
    const max = options.maxPatternScanKeys ?? 400;
    if (!Number.isSafeInteger(max) || max < 1 || max > 900) {
      throw new RangeError('Cloudflare KV maxPatternScanKeys must be between 1 and 900');
    }
  }

  async set(key: CacheKey, value: V, options: CacheOptions = {}): Promise<void> {
    if (value === undefined) return this.delete(key);
    const ttlMs = this.ttl(options);
    const payload = await serializeCacheValue(value, this.options.compression);
    const raw = encodeKVRecord(payload, Date.now() + ttlMs);
    await this.namespace.put(this.key(key), raw, { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1_000)) });
  }

  async get(key: CacheKey): Promise<V | undefined> {
    return (await this.getWithTtl(key))?.value;
  }

  async getWithTtl(key: CacheKey): Promise<{ value: V; ttlRemainingMs: number } | undefined> {
    const raw = await this.namespace.get(this.key(key), 'arrayBuffer');
    if (raw === null) return undefined;
    if (raw.byteLength > this.decodeLimits.maxEncodedBytes + 12) return undefined;
    let entry;
    try { entry = decodeKVRecord(raw); }
    catch { return undefined; }
    if (entry.ttlRemainingMs <= 0) return undefined;
    const decoded = await decodePortableCacheRecord(entry.payload, this.decodeLimits);
    return decoded.hit ? { value: decoded.value as V, ttlRemainingMs: entry.ttlRemainingMs } : undefined;
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
    if (new TextEncoder().encode(value).byteLength > 512) throw new RangeError('Cloudflare KV key exceeds 512 bytes');
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
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
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
    return structuredClone(entry.value);
  }
  set(key: CacheKey, value: V, ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('L1 TTL must be positive');
    const snapshot = structuredClone(value);
    const name = String(key);
    this.entries.delete(name);
    this.entries.set(name, { value: snapshot, expiresAt: Date.now() + ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
  delete(key: CacheKey): void { this.entries.delete(String(key)); }
  deleteByPattern(pattern: string): void {
    for (const key of this.entries.keys()) if (matchesPattern(key, pattern)) this.entries.delete(key);
  }
  clear(): void { this.entries.clear(); }
}

/** Request-scoped cache facade with an optional reusable in-memory L1. */
interface WorkerKeyRevision { revision: number; references: number }
interface WorkerMutationGuard { name: string; state: WorkerKeyRevision; revision: number; epoch: number }

/** Terminal facade closure; the separately owned KV and reusable L1 remain usable. */
export class CloudflareWorkerCacheClosedError extends Error {
  readonly code = 'CACHE_CLOSED';
  constructor() { super('Cloudflare Worker cache is closed'); this.name = 'CloudflareWorkerCacheClosedError'; }
}

export class CloudflareWorkerCache<V> {
  readonly l2: CloudflareWorkerKVStore<V>;
  private readonly inflight = new Map<string, Promise<V | undefined>>();
  private readonly keyRevisions = new Map<string, WorkerKeyRevision>();
  private readonly l1TtlMs: number;
  private closed = false;
  private epoch = 0;

  constructor(namespace: CloudflareKVNamespace, private readonly options: CloudflareWorkerCacheOptions<V> = {}) {
    this.l2 = new CloudflareWorkerKVStore<V>(namespace, options);
    this.l1TtlMs = options.l1TtlMs ?? 10_000;
    if (!Number.isSafeInteger(this.l1TtlMs) || this.l1TtlMs <= 0) throw new RangeError('L1 TTL must be positive');
  }

  async get(key: CacheKey): Promise<V | undefined> {
    this.ensureOpen();
    const guard = this.observeKey(key);
    try {
      const local = this.options.l1?.get(this.localKey(key));
      if (local !== undefined) return local;
      const startedAt = performance.now();
      const entry = await this.l2.getWithTtl(key);
      if (!entry) return undefined;
      const remaining = Math.floor(Math.min(this.l1TtlMs, entry.ttlRemainingMs - (performance.now() - startedAt)));
      if (remaining <= 0) return undefined;
      if (this.isCurrent(guard)) this.options.l1?.set(this.localKey(key), entry.value, remaining);
      return entry.value;
    } finally { this.releaseKey(guard); }
  }

  async getOrSet(key: CacheKey, loader: () => Promise<V | undefined>, options?: CacheOptions): Promise<V | undefined> {
    this.ensureOpen();
    const cached = await this.get(key).catch((error: unknown) => {
      this.reportError(error, 'get');
      return undefined;
    });
    if (cached !== undefined) return cached;
    this.ensureOpen();
    const name = String(key);
    const pending = this.inflight.get(name);
    if (pending) return pending;
    const guard = this.observeKey(key);
    // Register before a custom loader can reenter or yield to a second request.
    const promise = Promise.resolve().then(async () => {
      if (this.closed) throw new CloudflareWorkerCacheClosedError();
      const value = await loader();
      if (value !== undefined && this.isCurrent(guard)) {
        const publicationStarted = performance.now();
        try { await this.publishValue(key, value, options ?? {}, guard); }
        catch (error) {
          this.reportError(error, 'set');
          const ttlMs = options?.levels?.L2?.ttlMs ?? options?.ttlMs ?? this.options.ttlMs ?? DEFAULT_TTL_MS;
          const remaining = Math.floor(Math.min(this.l1TtlMs, ttlMs - (performance.now() - publicationStarted)));
          if (this.isCurrent(guard) && remaining > 0) this.options.l1?.set(this.localKey(key), value, remaining);
        }
      }
      return value;
    });
    this.inflight.set(name, promise);
    try { return await promise; }
    finally {
      if (this.inflight.get(name) === promise) this.inflight.delete(name);
      this.releaseKey(guard);
    }
  }

  async set(key: CacheKey, value: V, options: CacheOptions = {}): Promise<void> {
    this.ensureOpen();
    if (value === undefined) return this.delete(key);
    const guard = this.observeKey(key, true);
    try {
      this.inflight.delete(String(key));
      this.options.l1?.delete(this.localKey(key));
      await this.publishValue(key, value, options, guard);
    } finally { this.releaseKey(guard); }
  }

  async has(key: CacheKey): Promise<boolean> { return (await this.get(key)) !== undefined; }
  async delete(key: CacheKey): Promise<void> {
    this.ensureOpen();
    const guard = this.observeKey(key, true);
    try {
      this.inflight.delete(String(key));
      this.options.l1?.delete(this.localKey(key));
      await this.invalidateWithQueue(() => this.l2.delete(key), () => this.options.invalidationPublisher!.publishKey(String(key)));
    } finally { this.releaseKey(guard); }
  }
  async invalidate(key: CacheKey): Promise<void> { await this.delete(key); }
  async deleteByPattern(pattern: string): Promise<void> {
    this.ensureOpen();
    for (const [key, state] of this.keyRevisions) {
      if (matchesPattern(key, pattern)) { state.revision += 1; this.inflight.delete(key); }
    }
    this.options.l1?.deleteByPattern(`${this.options.prefix ?? 'cache:'}${pattern}`);
    await this.invalidateWithQueue(() => this.l2.deleteByPattern(pattern), () => this.options.invalidationPublisher!.publishPattern(pattern));
  }
  async invalidateByPattern(pattern: string): Promise<void> { await this.deleteByPattern(pattern); }
  async clear(): Promise<void> { await this.deleteByPattern('*'); }
  async size(): Promise<number> { this.ensureOpen(); return this.l2.size(); }
  async prewarm(key: CacheKey, loader: () => Promise<V | undefined>, options?: CacheOptions): Promise<V | undefined> {
    return this.getOrSet(key, loader, options);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.epoch += 1;
    this.inflight.clear(); this.keyRevisions.clear();
  }

  private async publishValue(key: CacheKey, value: V, options: CacheOptions, guard: WorkerMutationGuard): Promise<void> {
    if (!this.isCurrent(guard)) return;
    const startedAt = performance.now();
    await this.l2.set(key, value, options);
    // A dispatched KV write cannot be conditionally cancelled. This check
    // protects local publication, not KV's eventual shared mutation ordering.
    if (!this.isCurrent(guard)) return;
    const ttlMs = options.levels?.L2?.ttlMs ?? options.ttlMs ?? this.options.ttlMs ?? DEFAULT_TTL_MS;
    const remaining = Math.floor(Math.min(this.l1TtlMs, ttlMs - (performance.now() - startedAt)));
    if (remaining > 0) this.options.l1?.set(this.localKey(key), value, remaining);
  }

  private observeKey(key: CacheKey, mutate = false): WorkerMutationGuard {
    const name = String(key);
    let state = this.keyRevisions.get(name);
    if (!state) { state = { revision: 0, references: 0 }; this.keyRevisions.set(name, state); }
    state.references += 1;
    if (mutate) state.revision += 1;
    return { name, state, revision: state.revision, epoch: this.epoch };
  }

  private releaseKey(guard: WorkerMutationGuard): void {
    guard.state.references -= 1;
    if (guard.state.references === 0 && this.keyRevisions.get(guard.name) === guard.state) this.keyRevisions.delete(guard.name);
  }

  private isCurrent(guard: WorkerMutationGuard): boolean {
    return !this.closed && guard.epoch === this.epoch && guard.state.revision === guard.revision
      && this.keyRevisions.get(guard.name) === guard.state;
  }

  private ensureOpen(): void { if (this.closed) throw new CloudflareWorkerCacheClosedError(); }

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
