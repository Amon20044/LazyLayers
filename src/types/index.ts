export type {
  CacheEntry,
  CacheKey,
  CacheLevel,
  CacheLevelOptions,
  CacheLoader,
  CacheOptions,
  CacheStore,
  EncodedCacheStore,
  DistributedLockOptions,
  InflightEntry,
  InflightOptions,
  InflightStore,
  OriginLoadOptions,
  InspectableStore,
  KeyInspection,
  StoreInspectOptions,
  StoreInspection,
} from './core.types.js';
export { isInspectableStore } from './core.types.js';

export type {
  BaseInvalidationEvent,
  DeleteEvent,
  InvalidationEvent,
  InvalidationType,
  PatternEvent,
  SetEvent,
} from './event.types.js';
