export type InvalidationType = 'del' | 'pattern' | 'set';

export interface BaseInvalidationEvent {
  id?: string;
  type: InvalidationType;
  source: string;
  ts: number;
  generation?: number;
  /** Optional isolation scope; scoped caches reject unscoped or other-scope events. */
  namespace?: string;
  /** Preserves numeric CacheKey identity without changing legacy string keys. */
  keyTypes?: Array<'string' | 'number'>;
}

export interface DeleteEvent extends BaseInvalidationEvent {
  type: 'del';
  keys: string[];
}

export interface PatternEvent extends BaseInvalidationEvent {
  type: 'pattern';
  pattern: string;
}

export interface SetEvent extends BaseInvalidationEvent {
  type: 'set';
  keys: string[];
  value: unknown;
  ttlMs?: number;
}

export type InvalidationEvent = DeleteEvent | PatternEvent | SetEvent;
