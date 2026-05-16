import type { CacheKey, CacheLevel } from '../types/index.js';
import type { CircuitBreakerState } from './circuitBreaker.js';

export type CacheEvent =
  | { type: 'hit'; key: CacheKey; level: CacheLevel }
  | { type: 'miss'; key: CacheKey; level: CacheLevel | 'negative' }
  | { type: 'set'; key: CacheKey; levels: CacheLevel[] }
  | { type: 'delete'; key: CacheKey }
  | { type: 'delete-pattern'; pattern: string }
  | { type: 'loader:start'; key: CacheKey }
  | { type: 'loader:success'; key: CacheKey; durationMs: number }
  | { type: 'loader:error'; key: CacheKey; durationMs: number; error: unknown }
  | { type: 'loader:timeout'; key: CacheKey; timeoutMs: number }
  | { type: 'inflight:reuse'; key: CacheKey }
  | { type: 'inflight:bypass'; key: CacheKey; reason: string }
  | { type: 'stale:hit'; key: CacheKey; reason: 'loader-error' | 'soft-timeout' | 'hard-timeout' }
  | { type: 'negative:set'; key: CacheKey; ttlMs: number }
  | { type: 'l2:error'; operation: string; key: CacheKey | string; state: CircuitBreakerState; error: unknown }
  | { type: 'l2:skipped'; operation: string; key: CacheKey | string; state: CircuitBreakerState }
  | { type: 'event-bus:publish-error'; eventType: string; state: CircuitBreakerState; error: unknown }
  | { type: 'event-bus:publish-skipped'; eventType: string; state: CircuitBreakerState }
  | { type: 'invalidation:received'; eventId: string; eventType: string }
  | { type: 'invalidation:duplicate'; eventId: string }
  | { type: 'set:received'; key: CacheKey; level: CacheLevel }
  | { type: 'set:broadcast'; key: CacheKey };

export type CacheEventHandler = (event: CacheEvent) => void;
