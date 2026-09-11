export interface L2OperationGateOptions {
  maxConcurrent?: number;
  maxQueued?: number;
  maxQueuedBytes?: number;
  queueTimeoutMs?: number;
  operationTimeoutMs?: number;
}

export const DEFAULT_L2_GATE_MAX_CONCURRENT = 64;
export const DEFAULT_L2_GATE_MAX_QUEUED = 1_024;
export const DEFAULT_L2_GATE_MAX_QUEUED_BYTES = 32 * 1024 * 1024;
export const DEFAULT_L2_GATE_QUEUE_TIMEOUT_MS = 250;
export const DEFAULT_L2_GATE_OPERATION_TIMEOUT_MS = 2_000;

export class L2OperationOverloadError extends Error {
  readonly code = 'L2_OPERATION_OVERLOADED';
  constructor(readonly operation: string) { super(`L2 operation queue is full for ${operation}`); this.name = 'L2OperationOverloadError'; }
}
export class L2OperationTimeoutError extends Error {
  readonly code = 'L2_OPERATION_TIMEOUT';
  constructor(readonly operation: string, readonly timeoutMs: number) { super(`L2 operation timed out after ${timeoutMs}ms: ${operation}`); this.name = 'L2OperationTimeoutError'; }
}
export class L2OperationClosedError extends Error {
  readonly code = 'L2_OPERATION_CLOSED';
  constructor() { super('L2 operation gate is closed'); this.name = 'L2OperationClosedError'; }
}

interface Waiter<T> { operation: string; bytes: number; call: () => Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout>; }

export class L2OperationGate {
  private active = 0;
  private queuedBytes = 0;
  private readonly queue: Waiter<unknown>[] = [];
  private closed = false;
  private rejected = 0;
  private expired = 0;
  private commandTimeouts = 0;
  private readonly options: Required<L2OperationGateOptions>;
  constructor(options: L2OperationGateOptions = {}) {
    this.options = defaultL2OperationGateOptions(options);
    if (!Number.isFinite(this.options.maxConcurrent) || this.options.maxConcurrent <= 0 || !Number.isFinite(this.options.maxQueued) || this.options.maxQueued < 0 || !Number.isFinite(this.options.maxQueuedBytes) || this.options.maxQueuedBytes < 0 || !Number.isFinite(this.options.queueTimeoutMs) || this.options.queueTimeoutMs < 0 || !Number.isFinite(this.options.operationTimeoutMs) || this.options.operationTimeoutMs <= 0) throw new RangeError('Invalid L2 operation gate limits');
  }
  run<T>(operation: string, call: () => Promise<T>, payloadBytes = 0): Promise<T> {
    const bytes = Math.max(0, Number.isFinite(payloadBytes) ? payloadBytes : 0);
    if (this.closed) return Promise.reject(new L2OperationClosedError());
    if (this.active < this.options.maxConcurrent && this.queue.length === 0) return this.start(operation, call);
    if (this.queue.length >= this.options.maxQueued || this.queuedBytes + bytes > this.options.maxQueuedBytes) { this.rejected += 1; return Promise.reject(new L2OperationOverloadError(operation)); }
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = { operation, bytes, call, resolve, reject, timer: setTimeout(() => { const i = this.queue.indexOf(waiter as Waiter<unknown>); if (i >= 0) { this.queue.splice(i, 1); this.queuedBytes -= bytes; this.expired += 1; reject(new L2OperationOverloadError(operation)); } }, this.options.queueTimeoutMs) };
      this.queue.push(waiter as Waiter<unknown>); this.queuedBytes += bytes;
    });
  }
  stats() { return { active: this.active, queued: this.queue.length, queuedBytes: this.queuedBytes, rejected: this.rejected, expired: this.expired, commandTimeouts: this.commandTimeouts, closed: this.closed }; }
  close(): void { this.closed = true; for (const waiter of this.queue) { clearTimeout(waiter.timer); waiter.reject(new L2OperationClosedError()); } this.queue.length = 0; this.queuedBytes = 0; }
  private start<T>(operation: string, call: () => Promise<T>): Promise<T> {
    this.active += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { this.commandTimeouts += 1; reject(new L2OperationTimeoutError(operation, this.options.operationTimeoutMs)); }, this.options.operationTimeoutMs); });
    // The gate retains active work until the underlying operation settles, even
    // when the caller-facing deadline has elapsed.
    const underlying = Promise.resolve().then(call);
    underlying.finally(() => { if (timer) clearTimeout(timer); this.active -= 1; this.pump(); }).catch(() => undefined);
    return Promise.race([underlying, timeout]);
  }
  private pump(): void { if (this.closed || this.active >= this.options.maxConcurrent) return; const waiter = this.queue.shift(); if (!waiter) return; this.queuedBytes -= waiter.bytes; clearTimeout(waiter.timer); this.start(waiter.operation, waiter.call).then(waiter.resolve, waiter.reject); }
}

export function defaultL2OperationGateOptions(options: L2OperationGateOptions = {}): Required<L2OperationGateOptions> {
  return { maxConcurrent: options.maxConcurrent ?? DEFAULT_L2_GATE_MAX_CONCURRENT, maxQueued: options.maxQueued ?? DEFAULT_L2_GATE_MAX_QUEUED, maxQueuedBytes: options.maxQueuedBytes ?? DEFAULT_L2_GATE_MAX_QUEUED_BYTES, queueTimeoutMs: options.queueTimeoutMs ?? DEFAULT_L2_GATE_QUEUE_TIMEOUT_MS, operationTimeoutMs: options.operationTimeoutMs ?? DEFAULT_L2_GATE_OPERATION_TIMEOUT_MS };
}
