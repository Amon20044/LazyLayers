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
