import { LRUCache } from 'lru-cache';
import type { CacheKey, CacheOptions, EncodedCacheStore, InspectableStore, KeyInspection, StoreInspectOptions, StoreInspection } from '../types/index.js';
import { deserialize, serializeWithStats, sizeSavings } from '../utils/serializer.js';
import { DEFAULT_CACHE_TTL_MS, DEFAULT_L1_MAX_ENTRIES } from './defaults.js';
import { getDefaultMemoryBudget, type MemoryBudget } from './memoryBudget.js';
import { matchesPattern } from './pattern.js';

interface Entry { buffer: Buffer; bytes: number; originalBytes?: number; }
const ENTRY_OVERHEAD = 160;
const HISTORY_BYTES = 4096;
const MAX_EVICTIONS_PER_WRITE = 16;
export interface MemoryStoreStats {
  retainedBytes: number;
  entries: number;
  admitted: number;
  rejected: number;
  budget: ReturnType<MemoryBudget['snapshot']>;
}

/** Encoded LRU with shared byte accounting. The ledger is not a process RSS limit. */
export class MemoryStore<K extends CacheKey, V> implements EncodedCacheStore<K, V>, InspectableStore {
  readonly encodedFormat = 'lazy-layers-hc1' as const;
  readonly memoryBudget: MemoryBudget;
  private readonly cache: LRUCache<K, Entry>;
  private history?: Uint8Array;
  private readonly unregister: () => void;
  private decayCursor = 0;
  private accesses = 0;
  private bytes = 0;
  private rejected = 0;
  private admitted = 0;
  private closed = false;

  constructor(private readonly options: CacheOptions = {}) {
    const l1 = options.levels?.L1;
    const configuredBudget = l1?.maxMemory !== undefined || l1?.minMemory !== undefined || l1?.autoEvict !== undefined;
    this.memoryBudget = options.memoryBudget ?? getDefaultMemoryBudget(configuredBudget ? {
      maxMemory: l1?.maxMemory ?? '20%', minMemory: l1?.minMemory,
      sampleIntervalMs: l1?.autoEvict?.enabled === false ? 0 : undefined,
    } : undefined);
    const max = l1?.maxEntries ?? DEFAULT_L1_MAX_ENTRIES;
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('L1 maxEntries must be a positive safe integer');
    const maxEntryBytes = l1?.admission?.maxEntryBytes;
    if (maxEntryBytes !== undefined && (!Number.isSafeInteger(maxEntryBytes) || maxEntryBytes < 1)) {
      throw new RangeError('L1 admission.maxEntryBytes must be a positive safe integer');
    }
    this.ttl({});
    this.cache = new LRUCache<K, Entry>({
      max,
      dispose: (entry) => {
        this.bytes -= entry.bytes;
        this.memoryBudget.release(entry.bytes, 'fresh');
      },
    });
    if (this.memoryBudget.tryReserve(HISTORY_BYTES, 'metadata')) this.history = new Uint8Array(HISTORY_BYTES);
    this.unregister = this.memoryBudget.register(() => this.cache.pop() !== undefined);
  }

  async set(key: K, value: V, options: CacheOptions = {}): Promise<void> {
    this.ttl(options);
    if (value === undefined) { await this.delete(key); return; }
    let encoded;
    try { encoded = serializeWithStats(value); }
    catch {
      this.cache.delete(key);
      this.rejected++;
      return;
    }
    await this.setEncoded(key, encoded.buffer, options, encoded.originalBytes);
  }

  async setEncoded(key: K, buffer: Uint8Array, options: CacheOptions = {}, originalBytes?: number): Promise<void> {
    if (this.closed) return;
    const ttl = this.ttl(options);
    const bytes = buffer.byteLength + Buffer.byteLength(String(key)) * 2 + ENTRY_OVERHEAD;
    const prior = this.cache.peek(key);
    const snapshot = this.memoryBudget.snapshot();
    const maxEntry = this.options.levels?.L1?.admission?.maxEntryBytes
      ?? Math.min(16 * 1024 * 1024, Math.max(1, Math.floor(snapshot.hardCap / 4)));
    // Reject before allocation or eviction. A failed replacement cannot keep an obsolete value.
    if (bytes > maxEntry || bytes > snapshot.target || snapshot.pressureState !== 'normal') {
      this.cache.delete(key); this.rejected++; return;
    }
    const needsSpace = snapshot.accountedBytes + bytes - (prior?.bytes ?? 0) > snapshot.target
      || (!prior && this.cache.size >= this.cache.max);
    if (!prior && needsSpace && this.options.levels?.L1?.admission?.enabled !== false && !this.worthAdmitting(key, bytes)) {
      this.rejected++; return;
    }
    this.cache.delete(key);
    let reserved = this.memoryBudget.tryReserve(bytes, 'fresh');
    for (let n = 0; !reserved && n < MAX_EVICTIONS_PER_WRITE; n++) {
      if (!this.cache.pop()) break;
      reserved = this.memoryBudget.tryReserve(bytes, 'fresh');
    }
    if (!reserved) { this.rejected++; return; }
    try {
      // Unpooled ownership prevents a tiny view retaining a much larger backing allocation.
      const owned = Buffer.allocUnsafeSlow(buffer.byteLength);
      owned.set(buffer);
      this.cache.set(key, { buffer: owned, bytes, originalBytes }, { ttl });
      this.bytes += bytes;
      this.admitted++;
    } catch (error) {
      this.memoryBudget.release(bytes, 'fresh');
      throw error;
    }
  }

  async get(key: K): Promise<V | undefined> {
    this.record(key);
    const entry = this.cache.get(key);
    return entry ? deserialize(entry.buffer) as V : undefined;
  }

  async getEncoded(key: K): Promise<{ buffer: Buffer; ttlRemainingMs: number; originalBytes?: number } | undefined> {
    this.record(key);
    const entry = this.cache.get(key);
    return entry ? { buffer: Buffer.from(entry.buffer), ttlRemainingMs: this.cache.getRemainingTTL(key), originalBytes: entry.originalBytes } : undefined;
  }

  async getOrSet(key: K, loader: () => Promise<V | undefined>, options?: CacheOptions): Promise<V | undefined> {
    const cached = await this.get(key);
    if (cached !== undefined) return cached;
    const value = await loader();
    if (value !== undefined) await this.set(key, value, options);
    return value;
  }
  async has(key: K): Promise<boolean> {
    this.cache.purgeStale();
    return this.cache.has(key);
  }
  async delete(key: K): Promise<void> { this.cache.delete(key); }
  async deleteByPattern(pattern: string): Promise<void> {
    for (const key of this.cache.keys()) if (matchesPattern(String(key), pattern)) this.cache.delete(key);
  }
  async clear(): Promise<void> { this.cache.clear(); }
  async size(): Promise<number> {
    this.cache.purgeStale();
    return this.cache.size;
  }
  stats(): MemoryStoreStats {
    this.cache.purgeStale();
    return { retainedBytes: this.bytes, entries: this.cache.size, admitted: this.admitted, rejected: this.rejected, budget: this.memoryBudget.snapshot() };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    if (this.history) this.memoryBudget.release(HISTORY_BYTES, 'metadata');
    this.history = undefined;
    this.unregister();
  }

  async inspect(options: StoreInspectOptions = {}): Promise<StoreInspection> {
    const limit = Math.min(1000, Math.max(1, Math.floor(options.limit ?? 100)));
    const offset = Math.max(0, Number.parseInt(options.cursor ?? '0', 10) || 0);
    const maxValueBytes = options.maxValueBytes ?? 256 * 1024;
    const keys: KeyInspection[] = [];
    let index = 0;
    for (const rawKey of this.cache.keys()) {
      if (options.match && !matchesPattern(String(rawKey), options.match)) continue;
      if (index++ < offset) continue;
      if (keys.length === limit) break;
      const entry = this.cache.peek(rawKey);
      if (!entry) continue;
      const tag = entry.buffer.toString('ascii', 0, 4);
      const encoding: KeyInspection['encoding'] = ({ HC1M: 'msgpack', HC1J: 'json', HC1G: 'msgpack-gzip', HC1Z: 'msgpack-zstd', HC1L: 'msgpack-lz4', HC1S: 'msgpack-snappy' } as Record<string, KeyInspection['encoding']>)[tag] ?? 'legacy';
      const remaining = this.cache.getRemainingTTL(rawKey);
      const originalBytes = entry.originalBytes ?? entry.buffer.byteLength;
      const key: KeyInspection = {
        key: String(rawKey), ttlRemainingMs: Number.isFinite(remaining) ? remaining : -1,
        serializedBytes: entry.buffer.byteLength, deserializedBytes: originalBytes,
        compressionRatio: sizeSavings(entry.buffer.byteLength, originalBytes), encoding,
      };
      if (options.includeValues !== false) {
        // An unknown expanded size is unsafe to decode for a dashboard preview.
        if (entry.originalBytes === undefined || originalBytes > maxValueBytes) key.truncated = true;
        else key.value = deserialize(entry.buffer);
      }
      keys.push(key);
    }
    return { size: this.cache.size, cursor: keys.length === limit ? String(offset + keys.length) : undefined, keys };
  }

  private ttl(options: CacheOptions): number {
    const ttl = options.levels?.L1?.ttlMs ?? options.ttlMs ?? this.options.levels?.L1?.ttlMs ?? this.options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0) throw new RangeError('L1 ttlMs must be positive and finite');
    return ttl;
  }
  private hash(key: K): number {
    const text = String(key);
    let hash = typeof key === 'number' ? 2166136260 : 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return (hash >>> 0) % HISTORY_BYTES;
  }
  private record(key: K): void {
    if (!this.history) return;
    if (++this.accesses % 8 === 0) {
      for (let i = 0; i < 8; i++) this.history[this.decayCursor++ % HISTORY_BYTES] >>>= 1;
    }
    const hash = this.hash(key);
    this.history[hash] = Math.min(255, this.history[hash] + 1);
  }
  private worthAdmitting(key: K, bytes: number): boolean {
    if (!this.history) return false;
    const candidate = Math.max(1, this.history[this.hash(key)]) / bytes;
    let sampled = 0;
    for (const pair of this.cache.rentries()) {
      const [victim, entry] = pair as [K, Entry];
      if (candidate >= Math.max(1, this.history[this.hash(victim)]) / entry.bytes) return true;
      if (++sampled === 8) break;
    }
    return sampled === 0;
  }
}
