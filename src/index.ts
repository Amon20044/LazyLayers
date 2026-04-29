import { HybridCache, type HybridCacheOptions } from './cache/index.js';
import type { CacheKey } from './types/index.js';

export function createCache<K extends CacheKey, V>(options?: HybridCacheOptions<K, V>): HybridCache<K, V> {
  return new HybridCache<K, V>(options);
}

export type {
  BaseInvalidationEvent,
  CacheEntry,
  CacheKey,
  CacheLevel,
  CacheLevelOptions,
  CacheLoader,
  CacheOptions,
  CacheStore,
  DeleteEvent,
  InflightEntry,
  InflightOptions,
  InflightStore,
  InvalidationEvent,
  InvalidationType,
  PatternEvent,
} from './types/index.js';
export type {
  CircuitBreakerOptions,
  CircuitBreakerState,
  CacheEvent,
  CacheEventHandler,
  DistributedLock,
  DistributedLockOptions,
  HybridCacheOptions,
  HybridCacheResilienceOptions,
  RedisStoreOptions,
} from './cache/index.js';
export {
  CircuitBreaker,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_INFLIGHT_TTL_MS,
  DEFAULT_L1_MAX_ENTRIES,
  HybridCache,
  MemoryStore,
  RedisStore,
} from './cache/index.js';
export type { CacheLoggerOptions, CacheRuntimeEnv } from './utils/debugLog.js';
export type {
  EventBus,
  EventBusHealth,
  EventBusRetryQueueOptions,
  NatsEventBusHealth,
  NatsEventBusMode,
  NatsEventBusOptions,
  NatsJetStreamOptions,
  RabbitMQEventBusHealth,
  RabbitMQEventBusOptions,
  RedisEventBusHealth,
  RedisEventBusOptions,
} from './event-bus/index.js';
export { NatsEventBus, RabbitMQEventBus, RedisEventBus } from './event-bus/index.js';
