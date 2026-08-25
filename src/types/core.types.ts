export type CacheLevel = 'L1' | 'L2';
export type CacheKey = string | number;

export interface CacheLevelOptions {
    maxEntries?: number;
    ttlMs?: number;
}

export interface CacheLoaderContext {
    signal: AbortSignal;
}

export type CacheLoader<V> = (context?: CacheLoaderContext) => Promise<V | undefined>;

export interface InflightEntry<K extends CacheKey, V> {
    key: K;
    promise: Promise<V | undefined>;
    startedAt: number;
    expiresAt?: number;
}

export type InflightStore<K extends CacheKey, V> = Map<K, InflightEntry<K, V>>;

export interface InflightOptions {
    enabled?: boolean;
    ttlMs?: number;
    maxEntries?: number;
}

export interface NegativeCacheOptions {
    enabled?: boolean;
    ttlMs?: number;
    maxEntries?: number;
}

export interface FailSafeOptions {
    enabled?: boolean;
    staleTtlMs?: number;
}

export interface TimeoutOptions {
    softMs?: number;
    hardMs?: number;
}

export interface VersioningOptions {
    enabled?: boolean;
}

export interface DistributedLockOptions {
    enabled?: boolean;
    ttlMs?: number;
    waitTimeoutMs?: number;
    pollMs?: number;
}

export interface CacheOptions {
    ttlMs?: number;
    levels?: Partial<Record<CacheLevel, CacheLevelOptions>>;
    inflight?: InflightOptions;
    negativeCache?: NegativeCacheOptions;
    failSafe?: FailSafeOptions;
    timeouts?: TimeoutOptions;
    versioning?: VersioningOptions;
    distributedLock?: DistributedLockOptions;
}

export interface CacheEntry<V> {
    value: V;
    expiresAt?: number;
}

export interface CacheStore<K extends CacheKey, V> {
    set(key: K, value: V, options?: CacheOptions): Promise<void>;
    get(key: K): Promise<V | undefined>;
    getOrSet(key: K, loader: CacheLoader<V>, options?: CacheOptions): Promise<V | undefined>;
    has(key: K): Promise<boolean>;
    delete(key: K): Promise<void>;
    deleteByPattern(pattern: string): Promise<void>;
    clear(): Promise<void>;
    size(): Promise<number>;
}

/** Options for a single page of read-only store introspection (observability). */
export interface StoreInspectOptions {
    /** Opaque cursor returned by a previous page (`'0'`/undefined = start). */
    cursor?: string;
    /** Max keys to return in this page. */
    limit?: number;
    /** Glob pattern (e.g. `user:*`) to scope the scan. */
    match?: string;
    /** When false, return only metadata (no decoded values). */
    includeValues?: boolean;
    /** Decoded values larger than this many bytes are truncated. */
    maxValueBytes?: number;
}

/** One key's read-only snapshot for the dashboard. */
export interface KeyInspection {
    key: string;
    /** Remaining TTL in ms; `undefined` when unknown, `-1` when no expiry. */
    ttlRemainingMs?: number;
    /** Bytes on the wire (L2: actual stored buffer; L1: prospective wire size). */
    serializedBytes: number;
    /** Estimated decoded/in-memory size of the value (UTF-8 JSON byte length). */
    deserializedBytes: number;
    /** Saved fraction of wire vs decoded size in [0, 1) — higher = more compact. */
    compressionRatio: number;
    /** Wire encoding (`legacy` = unprefixed buffer). */
    encoding:
        | 'msgpack'
        | 'msgpack-gzip'
        | 'msgpack-zstd'
        | 'msgpack-lz4'
        | 'msgpack-snappy'
        | 'json'
        | 'legacy';
    /** Decoded value (omitted when includeValues is false or value truncated). */
    value?: unknown;
    /** True when the value was omitted because it exceeded maxValueBytes. */
    truncated?: boolean;
}

/** One page of store introspection. */
export interface StoreInspection {
    /** Total entries the layer reports (may be approximate for L2). */
    size: number;
    /** Cursor for the next page; absent/`'0'` means the scan is complete. */
    cursor?: string;
    keys: KeyInspection[];
}

/** A store that can be safely introspected without disturbing its state. */
export interface InspectableStore {
    inspect(options?: StoreInspectOptions): Promise<StoreInspection>;
}

/** Type guard for {@link InspectableStore}. */
export function isInspectableStore(store: unknown): store is InspectableStore {
    return typeof (store as InspectableStore | undefined)?.inspect === 'function';
}
