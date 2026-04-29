import type { CacheKey } from '../types/index.js';

export interface DistributedLock {
  acquireLock(key: CacheKey, token: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: CacheKey, token: string): Promise<void>;
}

export interface DistributedLockOptions {
  enabled?: boolean;
  ttlMs?: number;
  waitTimeoutMs?: number;
  pollMs?: number;
}

export function supportsDistributedLock(value: unknown): value is DistributedLock {
  return typeof value === 'object'
    && value !== null
    && 'acquireLock' in value
    && 'releaseLock' in value
    && typeof value.acquireLock === 'function'
    && typeof value.releaseLock === 'function';
}
