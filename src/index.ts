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
  InspectableStore,
  InvalidationEvent,
  InvalidationType,
  KeyInspection,
  PatternEvent,
  SetEvent,
  StoreInspectOptions,
  StoreInspection,
} from './types/index.js';
export { isInspectableStore } from './types/index.js';
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
export type { BufferInspection, CacheEncoding, SerializedCacheValue } from './utils/serializer.js';
export {
  NULL_SENTINEL,
  GZIP_MIN_BYTES,
  GZIP_SAVINGS_THRESHOLD,
  deserialize,
  estimateValueBytes,
  getCompressionSavings,
  hasPrefix,
  inspectBuffer,
  serialize,
  serializeWithStats,
  shouldGzip,
  sizeSavings,
  stripPrefix,
} from './utils/serializer.js';
export {
  DEFAULT_OBSERVABILITY_MAX_EVENTS,
  DEFAULT_OBSERVABILITY_MAX_VALUE_BYTES,
  DEFAULT_OBSERVABILITY_PASSWORD,
  DEFAULT_OBSERVABILITY_PORT,
  DEFAULT_OBSERVABILITY_ROUTE,
  DEFAULT_OBSERVABILITY_USERNAME,
  ObservabilityCollector,
  ObservabilityInspector,
  TELEMETRY_CHANNEL_NAME,
  createObservabilityHandler,
  hasTelemetrySubscribers,
  normalizeRoute,
  publishTelemetry,
  renderDashboard,
  renderPrometheus,
  resolveObservabilityOptions,
  startObservabilityServer,
  subscribeTelemetry,
} from './observability/index.js';
export type {
  ConfigSnapshot,
  InspectorDeps,
  ObservabilityAuthOptions,
  ObservabilityCounters,
  ObservabilityHandlerDeps,
  ObservabilityOptions,
  ObservabilityPrometheusOptions,
  ObservabilityRequestHandler,
  ObservabilityServerHandle,
  ObservabilityServerOptions,
  OverviewSnapshot,
  PrometheusGauges,
  RecordedEvent,
  ResolvedObservabilityOptions,
  StartObservabilityServerOptions,
} from './observability/index.js';
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
