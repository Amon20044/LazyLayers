import { LazyLayersCache, type LazyLayersCacheOptions } from './cache/index.js';
import type { CacheKey } from './types/index.js';

export function createCache<K extends CacheKey = string, V = unknown>(
  options?: LazyLayersCacheOptions<K, V>,
): LazyLayersCache<K, V> {
  return new LazyLayersCache<K, V>(options);
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
  SetEvent,
} from './types/index.js';
export type {
  CacheLayer,
  CircuitBreakerOptions,
  CircuitBreakerState,
  CacheEvent,
  CacheEventHandler,
  DistributedLock,
  DistributedLockOptions,
  HybridCacheOptions,
  HybridCacheResilienceOptions,
  LazyLayersCacheOptions,
  RedisStoreOptions,
} from './cache/index.js';
export {
  CircuitBreaker,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_INFLIGHT_TTL_MS,
  DEFAULT_L1_MAX_ENTRIES,
  HybridCache,
  LazyLayersCache,
  MemoryStore,
  RedisStore,
} from './cache/index.js';
export type { CacheLoggerOptions, CacheRuntimeEnv } from './utils/debugLog.js';
export type { CacheEncoding, SerializedCacheValue } from './utils/serializer.js';
export {
  NULL_SENTINEL,
  GZIP_MIN_BYTES,
  GZIP_SAVINGS_THRESHOLD,
  deserialize,
  getCompressionSavings,
  hasPrefix,
  serialize,
  serializeWithStats,
  shouldGzip,
  stripPrefix,
} from './utils/serializer.js';
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
