import type { Redis as IORedis } from 'ioredis';

import {
  OperationDispatchTimeoutError,
  OperationConfigurationError,
  OperationGateClosedError,
  OperationUnavailableError,
} from './types.js';
import {
  registerOperationScript,
  OPERATION_COORDINATION_LUA,
  OPERATION_COORDINATION_SHA1,
  scriptIsNoScript,
  TRANSACTION_SCRIPT_COMMAND,
  type RedisScriptClient,
} from './scripts.js';
import {
  MAX_NAMESPACE_BYTES,
  validateNamespace,
  validateReference,
} from './keys.js';

/** A directly injected ioredis primary (never a replica or a cache wrapper). */
export type RedisOperationClient = RedisScriptClient & {
  readonly status?: string;
  readonly isCluster?: boolean;
  /** ioredis exposes `role` as a command method; adapters may expose a string. */
  readonly role?: unknown;
  readonly isReplica?: boolean;
  readonly readOnly?: boolean;
  readonly options?: Readonly<{
    enableOfflineQueue?: boolean;
    autoResendUnfulfilledCommands?: boolean;
    keyPrefix?: string;
    readOnly?: boolean;
    role?: string;
  }>;
};

/** The concrete type is useful to consumers that keep an ioredis client in DI. */
export type IORedisOperationClient = IORedis;

export interface RedisOperationTransportOptions {
  /** Explicit, isolated key namespace; it is part of every operation key. */
  namespace: string;
  /** Deployment label for diagnostics. It does not prove cross-process identity. */
  authorityId: string;
  /** Transaction requests must always route to the primary. */
  route?: 'primary';
  /** Cluster mode is accepted only after the caller opts into its certification. */
  clusterValidated?: boolean;
  /** Override the generated ioredis command name for a shared client. */
  commandName?: string;
  /** Permit clients whose routing flags are not inspectable (test adapters only). */
  allowUnknownClientOptions?: boolean;
}

export class RedisRoutingError extends OperationConfigurationError {
  constructor(message: string) {
    super(message);
    this.name = 'RedisRoutingError';
  }
}

type TransportCommand = (...args: Array<string | number | Buffer>) => Promise<unknown>;

function asClient(value: RedisOperationClient): RedisOperationClient {
  if (typeof value !== 'object' || value === null) {
    throw new OperationConfigurationError('An explicit Redis primary client is required');
  }
  if (typeof value.evalsha !== 'function' && typeof value.eval !== 'function'
      && typeof value.defineCommand !== 'function') {
    throw new OperationConfigurationError('Redis client cannot execute transaction scripts');
  }
  return value;
}

function asOptions(client: RedisOperationClient): RedisOperationClient['options'] {
  const value = client.options;
  return typeof value === 'object' && value !== null ? value : undefined;
}

function assertPrimary(
  client: RedisOperationClient,
  options: RedisOperationTransportOptions,
): void {
  if (options.route !== undefined && options.route !== 'primary') {
    throw new OperationConfigurationError('Transaction coordination accepts primary routing only');
  }
  // ioredis exposes ROLE as a command function and reports the configured
  // direct-server role as `master`; adapters may expose the clearer `primary`.
  if (typeof client.role === 'string' && client.role !== 'primary' && client.role !== 'master') {
    throw new OperationConfigurationError('Transaction coordination client is not a Redis primary');
  }
  if (client.isReplica === true || client.readOnly === true) {
    throw new OperationConfigurationError('Transaction coordination cannot use a Redis replica');
  }
  const clientOptions = asOptions(client);
  if (clientOptions?.role !== undefined && clientOptions.role !== 'primary' && clientOptions.role !== 'master') {
    throw new OperationConfigurationError('Transaction coordination client options select a non-primary route');
  }
  if (clientOptions?.readOnly === true) {
    throw new OperationConfigurationError('Transaction coordination client is configured read-only');
  }
  if (clientOptions?.keyPrefix) {
    throw new OperationConfigurationError('Configure no Redis keyPrefix; transaction keys carry their own namespace');
  }
  if (clientOptions?.enableOfflineQueue !== undefined && clientOptions.enableOfflineQueue !== false) {
    throw new OperationConfigurationError('Redis enableOfflineQueue must be false for transaction coordination');
  }
  if (clientOptions?.autoResendUnfulfilledCommands !== undefined
      && clientOptions.autoResendUnfulfilledCommands !== false) {
    throw new OperationConfigurationError('Redis autoResendUnfulfilledCommands must be false for transaction coordination');
  }
  if (client.isCluster === true && options.clusterValidated !== true) {
    throw new OperationConfigurationError('Redis Cluster routing requires explicit certification before transaction use');
  }
  if (clientOptions === undefined && options.allowUnknownClientOptions !== true) {
    // A small fake/client adapter can be used when no ioredis options object is
    // exposed, but production callers must opt into that fact explicitly.
    throw new OperationConfigurationError('Redis client routing/retry options are not inspectable');
  }
}

/**
 * Primary-only Redis adapter. It owns no client and never reads a replica.
 * `defineCommand` is registered once per client; a NOSCRIPT response is the
 * only condition that permits a bounded EVAL recovery.
 */
export class RedisOperationTransport {
  readonly namespace: string;
  readonly authorityId: string;
  readonly commandName: string;
  private closed = false;

  constructor(
    private readonly client: RedisOperationClient,
    options: RedisOperationTransportOptions,
  ) {
    this.client = asClient(client);
    this.namespace = validateNamespace(options.namespace);
    this.authorityId = validateReference('authorityId', options.authorityId, MAX_NAMESPACE_BYTES);
    assertPrimary(this.client, options);
    this.commandName = options.commandName ?? TRANSACTION_SCRIPT_COMMAND;
    registerOperationScript(this.client, this.commandName);
    if (typeof this.client.evalsha !== 'function' && typeof this.client.eval !== 'function'
        && typeof this.getRegisteredCommand() !== 'function') {
      throw new OperationConfigurationError('Redis client did not expose a registered transaction command');
    }
  }

  /** The store calls this before setting its conservative dispatch boundary. */
  canDispatch(): boolean {
    if (this.closed) return false;
    const status = this.client.status;
    if (status === undefined) return true;
    return status === 'ready';
  }

  assertDispatchable(): void {
    if (this.closed) throw new OperationUnavailableError('Transaction Redis transport is closed');
    if (!this.canDispatch()) {
      throw new OperationUnavailableError('Transaction Redis primary is not ready');
    }
  }

  /** Execute one script command against exactly one operation key. */
  async execute(key: string, args: readonly string[]): Promise<unknown> {
    this.assertDispatchable();
    const commandArgs = [key, ...args] as Array<string | number | Buffer>;
    const command = this.getRegisteredCommand();
    try {
      if (command) {
        return await command(...commandArgs);
      }
      if (typeof this.client.evalsha === 'function') {
        return await this.client.evalsha(OPERATION_COORDINATION_SHA1, 1, ...commandArgs);
      }
      if (typeof this.client.eval === 'function') {
        return await this.client.eval(OPERATION_COORDINATION_LUA, 1, ...commandArgs);
      }
      throw new OperationConfigurationError('Redis client cannot execute transaction scripts');
    } catch (error) {
      // Redis resolves EVALSHA lookup before running a script. EVAL is safe for
      // this one definite no-execution error. Never retry connection failures.
      if (!scriptIsNoScript(error) || typeof this.client.eval !== 'function') throw error;
      return await this.client.eval(OPERATION_COORDINATION_LUA, 1, ...commandArgs);
    }
  }

  /** Mark this adapter closed without disconnecting the caller-owned client. */
  close(): void {
    this.closed = true;
  }

  private getRegisteredCommand(): TransportCommand | undefined {
    const value = this.client[this.commandName];
    return typeof value === 'function'
      ? (value as TransportCommand).bind(this.client)
      : undefined;
  }
}

/** Alias that reads naturally in dependency-injection configurations. */
export const PrimaryRedisOperationTransport = RedisOperationTransport;

export const DEFAULT_OPERATION_MAX_CONCURRENT = 64;
export const DEFAULT_OPERATION_MAX_QUEUED = 1024;
export const DEFAULT_OPERATION_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
export const DEFAULT_OPERATION_QUEUE_TIMEOUT_MS = 250;
export const DEFAULT_OPERATION_TIMEOUT_MS = 2_000;

export interface BoundedOperationGateOptions {
  maxConcurrent?: number;
  maxQueued?: number;
  maxQueuedBytes?: number;
  queueTimeoutMs?: number;
  operationTimeoutMs?: number;
}

export interface OperationGateRunOptions {
  deadline?: number;
  bytes?: number;
  signal?: AbortSignal;
}

interface GateWaiter<T> {
  operation: string;
  bytes: number;
  deadline: number;
  call: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function positiveInteger(name: string, value: number, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new OperationConfigurationError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer`);
  }
  return value;
}

/**
 * Neutral bounded work gate for transaction commands. A caller timeout does
 * not free an active slot until the underlying Redis promise settles.
 */
export class BoundedOperationGate {
  private active = 0;
  private activeBytes = 0;
  private queuedBytes = 0;
  private readonly queue: Array<GateWaiter<unknown>> = [];
  private closed = false;
  private rejected = 0;
  private expired = 0;
  private commandTimeouts = 0;
  private readonly options: Required<BoundedOperationGateOptions>;

  constructor(options: BoundedOperationGateOptions = {}) {
    this.options = {
      maxConcurrent: options.maxConcurrent ?? DEFAULT_OPERATION_MAX_CONCURRENT,
      maxQueued: options.maxQueued ?? DEFAULT_OPERATION_MAX_QUEUED,
      maxQueuedBytes: options.maxQueuedBytes ?? DEFAULT_OPERATION_MAX_QUEUED_BYTES,
      queueTimeoutMs: options.queueTimeoutMs ?? DEFAULT_OPERATION_QUEUE_TIMEOUT_MS,
      operationTimeoutMs: options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    };
    positiveInteger('maxConcurrent', this.options.maxConcurrent);
    positiveInteger('maxQueued', this.options.maxQueued, true);
    positiveInteger('maxQueuedBytes', this.options.maxQueuedBytes, true);
    positiveInteger('queueTimeoutMs', this.options.queueTimeoutMs, true);
    positiveInteger('operationTimeoutMs', this.options.operationTimeoutMs);
  }

  run<T>(
    operation: string,
    call: () => Promise<T>,
    options: OperationGateRunOptions | number = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(new OperationGateClosedError());
    const runOptions: OperationGateRunOptions = typeof options === 'number' ? { bytes: options } : options;
    const bytes = runOptions.bytes ?? 0;
    if (!Number.isFinite(bytes) || bytes < 0 || !Number.isSafeInteger(Math.ceil(bytes))) {
      return Promise.reject(new OperationUnavailableError('Invalid transaction dispatch size'));
    }
    const deadline = runOptions.deadline ?? monotonicNow() + this.options.operationTimeoutMs;
    if (!Number.isFinite(deadline)) return Promise.reject(new OperationUnavailableError('Invalid transaction dispatch deadline'));
    if (monotonicNow() >= deadline) return Promise.reject(new OperationUnavailableError('Transaction dispatch deadline elapsed'));
    if (this.active < this.options.maxConcurrent && this.queue.length === 0) {
      return this.start(operation, call, bytes, deadline);
    }
    if (this.queue.length >= this.options.maxQueued || this.queuedBytes + bytes > this.options.maxQueuedBytes) {
      this.rejected += 1;
      return Promise.reject(new OperationUnavailableError(`Transaction dispatch queue is full for ${operation}`));
    }
    return new Promise<T>((resolve, reject) => {
      const waiter: GateWaiter<T> = {
        operation,
        bytes,
        deadline,
        call,
        resolve,
        reject,
        timer: setTimeout(() => this.expire(waiter as GateWaiter<unknown>), this.waitMs(deadline)),
        signal: runOptions.signal,
      };
      if (runOptions.signal?.aborted) {
        clearTimeout(waiter.timer);
        reject(new OperationUnavailableError(`Transaction dispatch was cancelled for ${operation}`));
        return;
      }
      if (runOptions.signal) {
        waiter.abort = () => {
          const index = this.queue.indexOf(waiter as GateWaiter<unknown>);
          if (index < 0) return;
          this.queue.splice(index, 1);
          this.queuedBytes -= bytes;
          clearTimeout(waiter.timer);
          reject(new OperationUnavailableError(`Transaction dispatch was cancelled for ${operation}`));
        };
        runOptions.signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.queue.push(waiter as GateWaiter<unknown>);
      this.queuedBytes += bytes;
    });
  }

  stats() {
    return {
      active: this.active,
      queued: this.queue.length,
      queuedBytes: this.queuedBytes,
      activeBytes: this.activeBytes,
      retainedBytes: this.queuedBytes + this.activeBytes,
      rejected: this.rejected,
      expired: this.expired,
      commandTimeouts: this.commandTimeouts,
      closed: this.closed,
    } as const;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.queue) {
      clearTimeout(waiter.timer);
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.reject(new OperationGateClosedError());
    }
    this.queue.length = 0;
    this.queuedBytes = 0;
  }

  private waitMs(deadline: number): number {
    return Math.max(1, Math.min(this.options.queueTimeoutMs, deadline - monotonicNow()));
  }

  private expire(waiter: GateWaiter<unknown>): void {
    const index = this.queue.indexOf(waiter);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.queuedBytes -= waiter.bytes;
    this.expired += 1;
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
    waiter.reject(new OperationUnavailableError(`Transaction dispatch queue expired for ${waiter.operation}`));
  }

  private start<T>(operation: string, call: () => Promise<T>, bytes: number, deadline: number): Promise<T> {
    this.active += 1;
    this.activeBytes += bytes;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = Math.max(1, deadline - monotonicNow());
    const underlying = Promise.resolve().then(call);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.commandTimeouts += 1;
        reject(new OperationDispatchTimeoutError(`Transaction command timed out after ${Math.ceil(timeoutMs)}ms`));
      }, timeoutMs);
    });
    underlying.finally(() => {
      if (timer) clearTimeout(timer);
      this.active -= 1;
      this.activeBytes -= bytes;
      this.pump();
    }).catch(() => undefined);
    return Promise.race([underlying, timeout]);
  }

  private pump(): void {
    if (this.closed) return;
    while (this.active < this.options.maxConcurrent) {
      const waiter = this.queue.shift();
      if (!waiter) return;
      this.queuedBytes -= waiter.bytes;
      clearTimeout(waiter.timer);
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
      if (monotonicNow() >= waiter.deadline) {
        this.expired += 1;
        waiter.reject(new OperationUnavailableError(`Transaction dispatch deadline elapsed for ${waiter.operation}`));
        continue;
      }
      this.start(waiter.operation, waiter.call, waiter.bytes, waiter.deadline)
        .then(waiter.resolve, waiter.reject);
    }
  }
}

export function defaultOperationGateOptions(
  options: BoundedOperationGateOptions = {},
): Required<BoundedOperationGateOptions> {
  return {
    maxConcurrent: options.maxConcurrent ?? DEFAULT_OPERATION_MAX_CONCURRENT,
    maxQueued: options.maxQueued ?? DEFAULT_OPERATION_MAX_QUEUED,
    maxQueuedBytes: options.maxQueuedBytes ?? DEFAULT_OPERATION_MAX_QUEUED_BYTES,
    queueTimeoutMs: options.queueTimeoutMs ?? DEFAULT_OPERATION_QUEUE_TIMEOUT_MS,
    operationTimeoutMs: options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
  };
}
