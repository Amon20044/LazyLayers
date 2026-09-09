import type { CacheKey } from '../types/index.js';

export interface DistributedLock {
  acquireLock(key: CacheKey, token: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: CacheKey, token: string): Promise<void>;
  /** Extend only a live lock owned by this token. RedisStore implements this. */
  renewLock?(key: CacheKey, token: string, ttlMs: number): Promise<boolean>;
}

export type { DistributedLockOptions } from '../types/core.types.js';

/** Another instance did not publish a value within the configured wait budget. */
export class DistributedLockTimeoutError extends Error {
  readonly code = 'DISTRIBUTED_LOCK_TIMEOUT';

  constructor(readonly key: CacheKey, readonly waitTimeoutMs: number) {
    super(`Timed out waiting ${waitTimeoutMs}ms for the cache load of ${String(key)}`);
    this.name = 'DistributedLockTimeoutError';
  }
}

export class DistributedLockLostError extends Error {
  readonly code = 'DISTRIBUTED_LOCK_LOST';

  constructor(readonly key: CacheKey) {
    super(`Lost the distributed cache lock for ${String(key)}`);
    this.name = 'DistributedLockLostError';
  }
}

export interface LoadLease {
  controller: AbortController;
  lost: Promise<never>;
  assertOwned(): void;
  stop(): void;
}

/** Renew serially, with a separate deadline so a hung renewal cannot keep ownership alive. */
export function maintainLock(
  key: CacheKey,
  ttlMs: number,
  acquiredAt: number,
  renew?: () => Promise<boolean>,
): LoadLease {
  const controller = new AbortController();
  let deadline = acquiredAt + ttlMs;
  let stopped = false;
  let error: DistributedLockLostError | undefined;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectLoss!: (error: Error) => void;
  const lost = new Promise<never>((_, reject) => { rejectLoss = reject; });
  // Ownership can be lost during the cache recheck before the loader races this promise.
  void lost.catch(() => {});

  const stop = () => {
    stopped = true;
    clearTimeout(renewalTimer);
    clearTimeout(expiryTimer);
  };
  const lose = () => {
    if (stopped) return;
    error = new DistributedLockLostError(key);
    stop();
    controller.abort(error);
    rejectLoss(error);
  };
  const assertOwned = () => {
    if (!stopped && Date.now() >= deadline) lose();
    if (error) throw error;
  };
  const schedule = () => {
    expiryTimer = setTimeout(lose, Math.max(0, deadline - Date.now()));
    expiryTimer.unref();
    if (!renew) return;
    renewalTimer = setTimeout(async () => {
      const startedAt = Date.now();
      try {
        assertOwned();
        const renewed = await renew();
        if (stopped) return;
        // A late acknowledgement cannot revive a lease whose local deadline passed.
        assertOwned();
        if (!renewed) { lose(); return; }
        deadline = startedAt + ttlMs;
        clearTimeout(expiryTimer);
        schedule();
      } catch {
        lose();
      }
    }, Math.max(1, Math.min(ttlMs / 3, (deadline - Date.now()) / 3)));
    renewalTimer.unref();
  };
  schedule();
  return { controller, lost, assertOwned, stop };
}

export function supportsDistributedLock(value: unknown): value is DistributedLock {
  return typeof value === 'object'
    && value !== null
    && 'acquireLock' in value
    && 'releaseLock' in value
    && typeof value.acquireLock === 'function'
    && typeof value.releaseLock === 'function';
}
