import type { CacheKey, OriginLoadOptions } from '../types/index.js';

export const DEFAULT_ORIGIN_MAX_CONCURRENT = 32;
export const DEFAULT_ORIGIN_MAX_QUEUED = 1_024;
export const DEFAULT_ORIGIN_QUEUE_TIMEOUT_MS = 1_000;

export class OriginLoadOverloadError extends Error {
  readonly code = 'ORIGIN_LOAD_OVERLOADED';
  constructor(readonly key: CacheKey) {
    super('Origin load queue is full or its wait deadline expired');
    this.name = 'OriginLoadOverloadError';
  }
}

export class OriginLoadClosedError extends Error {
  readonly code = 'ORIGIN_LOAD_CLOSED';
  constructor() {
    super('Origin load gate is closed');
    this.name = 'OriginLoadClosedError';
  }
}

interface Waiter<K> { key: K; resolve: (release: () => void) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout>; }

/** A finite FIFO gate. Same-key sharing happens in HybridCache before admission. */
export class OriginLoadGate<K extends CacheKey = string> {
  private active = 0;
  private readonly queued = new Set<Waiter<K>>();
  private closed = false;
  private rejected = 0;
  private maxObserved = 0;
  private readonly options: Required<Pick<OriginLoadOptions, 'maxConcurrent' | 'maxQueued' | 'queueTimeoutMs'>>;

  constructor(options: OriginLoadOptions = {}) {
    this.options = {
      maxConcurrent: options.maxConcurrent ?? DEFAULT_ORIGIN_MAX_CONCURRENT,
      maxQueued: options.maxQueued ?? DEFAULT_ORIGIN_MAX_QUEUED,
      queueTimeoutMs: options.queueTimeoutMs ?? DEFAULT_ORIGIN_QUEUE_TIMEOUT_MS,
    };
    if (![this.options.maxConcurrent, this.options.maxQueued, this.options.queueTimeoutMs].every(Number.isSafeInteger)
      || this.options.maxConcurrent <= 0 || this.options.maxQueued < 0 || this.options.queueTimeoutMs < 0) {
      throw new RangeError('originLoad maxConcurrent must be positive; maxQueued and queueTimeoutMs must be non-negative and finite');
    }
  }

  async acquire(key: K): Promise<() => void> {
    if (this.closed) throw new OriginLoadClosedError();
    if (this.active < this.options.maxConcurrent) {
      this.active += 1;
      this.maxObserved = Math.max(this.maxObserved, this.active);
      return this.reservation();
    }
    if (this.queued.size >= this.options.maxQueued || this.options.maxQueued === 0) { this.rejected += 1; throw new OriginLoadOverloadError(key); }
    return new Promise((resolve, reject) => {
      const waiter: Waiter<K> = {
        key, resolve, reject,
        timer: setTimeout(() => {
          if (this.queued.delete(waiter)) {
            this.rejected += 1;
            reject(new OriginLoadOverloadError(key));
          }
        }, this.options.queueTimeoutMs),
      };
      this.queued.add(waiter);
    });
  }

  stats(): { active: number; queued: number; rejected: number; maxObserved: number; closed: boolean } {
    return { active: this.active, queued: this.queued.size, rejected: this.rejected, maxObserved: this.maxObserved, closed: this.closed };
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.queued) { clearTimeout(waiter.timer); waiter.reject(new OriginLoadClosedError()); }
    this.queued.clear();
  }

  private reservation(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    if (this.active > 0) this.active -= 1;
    const next = this.queued.values().next().value;
    if (!next) return;
    this.queued.delete(next);
    clearTimeout(next.timer);
    this.active += 1;
    this.maxObserved = Math.max(this.maxObserved, this.active);
    next.resolve(this.reservation());
  }
}
