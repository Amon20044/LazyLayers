import {
  MAX_RESULT_REFERENCE_BYTES,
  isReference,
  newOwner,
  operationKey,
  validateIdentity,
  validateNamespace,
  validateOwner,
  validateReference,
} from './keys.js';
import {
  BoundedOperationGate,
  DEFAULT_OPERATION_MAX_CONCURRENT,
  DEFAULT_OPERATION_MAX_QUEUED,
  DEFAULT_OPERATION_MAX_QUEUED_BYTES,
  DEFAULT_OPERATION_TIMEOUT_MS,
  DEFAULT_OPERATION_QUEUE_TIMEOUT_MS,
  type BoundedOperationGateOptions,
  type OperationGateRunOptions,
  RedisOperationTransport,
} from './redisTransport.js';
import { scriptErrorCode } from './scripts.js';
import {
  OperationConfigurationError,
  OperationError,
  OperationLeaseLostError,
  OperationProtocolError,
  OperationUnavailableError,
  OperationUnknownError,
  type BeginResult,
  type CompleteResult,
  type Identity,
  type Lease,
  type OperationStore,
  type RenewResult,
  type Status,
} from './types.js';

// Keep these in sync with the server-side protocol bounds.
export const DEFAULT_OPERATION_LEASE_MS = 30_000;
export const DEFAULT_OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_OPERATION_LEASE_MS = 3_600_000;
export const MAX_OPERATION_RETENTION_MS = 2_592_000_000;

export interface OperationStoreTransport {
  readonly namespace: string;
  canDispatch(): boolean;
  execute(key: string, args: readonly string[]): Promise<unknown>;
  close?(): void;
}

export interface OperationStoreOptions extends BoundedOperationGateOptions {
  /** Must match the namespace of the injected primary transport when supplied. */
  namespace?: string;
  leaseMs?: number;
  retentionMs?: number;
  gate?: BoundedOperationGate;
}

export interface OperationStoreFactoryOptions extends OperationStoreOptions {
  transport: OperationStoreTransport | RedisOperationTransport;
}

function positiveInteger(name: string, value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new OperationConfigurationError(`${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function wireString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  throw new InvalidReplyError('Redis transaction reply contained a non-string field');
}

function wireParts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new InvalidReplyError('Redis transaction reply was not an array');
  }
  return value.map(wireString);
}

function decimal(value: string, name: string, max: number, allowZero = false): number {
  const pattern = allowZero ? /^(?:0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/;
  if (!pattern.test(value)) throw new InvalidReplyError(`Redis reply contained an invalid ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1) || parsed > max) {
    throw new InvalidReplyError(`Redis reply contained an out-of-range ${name}`);
  }
  return parsed;
}

function protocolError(error: unknown): OperationProtocolError | undefined {
  if (error instanceof OperationProtocolError) return error;
  const code = scriptErrorCode(error);
  if (code?.startsWith('TX_') || /WRONGTYPE/i.test(error instanceof Error ? error.message : String(error))) {
    return new OperationProtocolError(`Redis transaction rejected the request (${code ?? 'WRONGTYPE'})`, error);
  }
  return undefined;
}

/** Invalid wire data after dispatch is unknown, even when the script committed. */
class InvalidReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReplyError';
  }
}

function bytesFor(key: string, args: readonly string[]): number {
  return Buffer.byteLength(key, 'utf8') + args.reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0);
}

/**
 * Redis-backed operation coordinator. It contains no L1/cache dependency,
 * local result map, stale fallback, or callback that can run a business side
 * effect. A caller must prepare/read its durable operation before `begin`.
 */
export class RedisOperationStore implements OperationStore {
  readonly namespace: string;
  readonly leaseMs: number;
  readonly retentionMs: number;
  private readonly gate: BoundedOperationGate;
  private closed = false;

  constructor(transport: OperationStoreTransport, options?: OperationStoreOptions);
  constructor(options: OperationStoreFactoryOptions);
  constructor(
    transportOrOptions: OperationStoreTransport | OperationStoreFactoryOptions,
    options: OperationStoreOptions = {},
  ) {
    const hasTransport = typeof transportOrOptions === 'object'
      && transportOrOptions !== null
      && 'transport' in transportOrOptions;
    const transport = hasTransport
      ? (transportOrOptions as OperationStoreFactoryOptions).transport
      : transportOrOptions as OperationStoreTransport;
    const merged = hasTransport
      ? transportOrOptions as OperationStoreFactoryOptions
      : options;
    if (!transport || typeof transport.execute !== 'function' || typeof transport.canDispatch !== 'function') {
      throw new OperationConfigurationError('An explicit primary transaction transport is required');
    }
    const namespace = validateNamespace(merged.namespace ?? transport.namespace);
    if (namespace !== transport.namespace) {
      throw new OperationConfigurationError('Operation store and primary transport namespaces must match');
    }
    this.namespace = namespace;
    this.leaseMs = positiveInteger('leaseMs', merged.leaseMs ?? DEFAULT_OPERATION_LEASE_MS, MAX_OPERATION_LEASE_MS);
    this.retentionMs = positiveInteger('retentionMs', merged.retentionMs ?? DEFAULT_OPERATION_RETENTION_MS, MAX_OPERATION_RETENTION_MS);
    if (this.retentionMs < this.leaseMs) {
      throw new OperationConfigurationError('retentionMs must be at least leaseMs');
    }
    this.transport = transport;
    this.operationTimeoutMs = positiveInteger(
      'operationTimeoutMs',
      merged.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      Number.MAX_SAFE_INTEGER,
    );
    this.gate = merged.gate ?? new BoundedOperationGate({
      maxConcurrent: merged.maxConcurrent ?? DEFAULT_OPERATION_MAX_CONCURRENT,
      maxQueued: merged.maxQueued ?? DEFAULT_OPERATION_MAX_QUEUED,
      maxQueuedBytes: merged.maxQueuedBytes ?? DEFAULT_OPERATION_MAX_QUEUED_BYTES,
      queueTimeoutMs: merged.queueTimeoutMs ?? DEFAULT_OPERATION_QUEUE_TIMEOUT_MS,
      operationTimeoutMs: this.operationTimeoutMs,
    });
  }

  private readonly transport: OperationStoreTransport;

  async begin(input: Identity): Promise<BeginResult> {
    this.assertOpen();
    const identity = validateIdentity(input);
    const owner = newOwner();
    const args = ['begin', identity.fingerprint, identity.durableId, owner,
      String(this.leaseMs), String(this.retentionMs), ''];
    return this.dispatch('begin', identity, args, (wire) => this.decodeBegin(wire, identity, owner));
  }

  async renew(input: Lease): Promise<RenewResult> {
    this.assertOpen();
    const lease = this.validateLease(input);
    const args = ['renew', lease.identity.fingerprint, lease.identity.durableId, lease.owner,
      String(this.leaseMs), String(this.retentionMs), ''];
    return this.dispatch('renew', lease.identity, args, (wire) => this.decodeRenew(wire));
  }

  async complete(input: Lease, committedResultRef: string): Promise<CompleteResult> {
    this.assertOpen();
    const lease = this.validateLease(input);
    const resultRef = validateReference('committedResultRef', committedResultRef, MAX_RESULT_REFERENCE_BYTES);
    const args = ['complete', lease.identity.fingerprint, lease.identity.durableId, lease.owner,
      String(this.leaseMs), String(this.retentionMs), resultRef];
    return this.dispatch('complete', lease.identity, args, (wire) => this.decodeComplete(wire, resultRef));
  }

  async readStatus(input: Identity): Promise<Status> {
    this.assertOpen();
    const identity = validateIdentity(input);
    const args = ['read', identity.fingerprint, identity.durableId, '',
      String(this.leaseMs), String(this.retentionMs), ''];
    return this.dispatch('readStatus', identity, args, (wire) => this.decodeStatus(wire));
  }

  stats() {
    return this.gate.stats();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.gate.close();
    this.transport.close?.();
  }

  private assertOpen(): void {
    if (this.closed) throw new OperationUnavailableError('Transaction operation store is closed');
  }

  private validateLease(input: Lease): Lease {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new OperationError('OPERATION_INVALID_INPUT', 'lease must be an object');
    }
    const identity = validateIdentity(input.identity);
    const owner = validateOwner(input.owner);
    if (!Number.isFinite(input.remainingMs) || input.remainingMs < 0 || input.remainingMs > this.leaseMs) {
      throw new OperationError('OPERATION_INVALID_INPUT', `lease remainingMs must be from 0 to ${this.leaseMs}`);
    }
    return Object.freeze({ identity, owner, remainingMs: input.remainingMs });
  }

  private async dispatch<T>(
    operation: string,
    identity: Identity,
    args: readonly string[],
    decode: (wire: unknown) => T,
  ): Promise<T> {
    const key = operationKey(this.namespace, identity);
    const deadline = monotonicNow() + this.operationTimeoutMs;
    const runOptions: OperationGateRunOptions = {
      deadline,
      bytes: bytesFor(key, args),
    };
    let dispatched = false;
    try {
      const wire = await this.gate.run(operation, async () => {
        if (monotonicNow() >= deadline) {
          throw new OperationUnavailableError('Transaction dispatch deadline elapsed');
        }
        if (!this.transport.canDispatch()) {
          throw new OperationUnavailableError('Transaction primary is not ready');
        }
        // From this point a connection may deliver the mutation even if the
        // promise later rejects, so every ordinary failure is unknown.
        dispatched = true;
        return this.transport.execute(key, args);
      }, runOptions);
      return decode(wire);
    } catch (error) {
      const definite = protocolError(error);
      if (definite) throw definite;
      if (error instanceof OperationConfigurationError) throw error;
      // Once the gate has started the underlying promise, even a timeout
      // represented as OperationUnavailableError is ambiguous: Redis may have
      // accepted the command. Only failures observed before that boundary are
      // safe to retry without reconciliation.
      if (error instanceof OperationUnavailableError && !dispatched) throw error;
      if (!dispatched) {
        throw new OperationUnavailableError(`Transaction ${operation} was not dispatched`, error);
      }
      if (error instanceof OperationUnknownError) throw error;
      throw new OperationUnknownError(`Transaction ${operation} outcome is unknown; reconcile authoritative state`, error);
    }
  }

  private readonly operationTimeoutMs: number;

  private decodeBegin(wire: unknown, identity: Identity, expectedOwner: string): BeginResult {
    const parts = wireParts(wire);
    switch (parts[0]) {
      case 'acquired': {
        if (parts.length !== 4 || parts[1] !== expectedOwner || parts[3] !== 'reconcile') {
          throw new InvalidReplyError('Invalid acquired transaction reply');
        }
        const remainingMs = decimal(parts[2], 'lease duration', this.leaseMs);
        return Object.freeze({
          kind: 'acquired' as const,
          lease: Object.freeze({ identity, owner: expectedOwner, remainingMs }),
          mustReconcile: true as const,
        });
      }
      case 'in_progress':
        if (parts.length !== 2) throw new InvalidReplyError('Invalid in-progress transaction reply');
        return Object.freeze({ kind: 'in_progress' as const, remainingMs: decimal(parts[1], 'lease duration', this.leaseMs) });
      case 'completed':
        if (parts.length !== 2 || !isReference(parts[1], MAX_RESULT_REFERENCE_BYTES)) {
          throw new InvalidReplyError('Invalid completed transaction reply');
        }
        return Object.freeze({ kind: 'completed' as const, resultRef: parts[1] });
      case 'conflict':
        if (parts.length !== 1) throw new InvalidReplyError('Invalid conflict transaction reply');
        return Object.freeze({ kind: 'conflict' as const });
      default:
        throw new InvalidReplyError('Unknown transaction begin reply');
    }
  }

  private decodeRenew(wire: unknown): RenewResult {
    const parts = wireParts(wire);
    switch (parts[0]) {
      case 'renewed':
        if (parts.length !== 2) throw new InvalidReplyError('Invalid renewed transaction reply');
        return Object.freeze({ kind: 'renewed' as const, remainingMs: decimal(parts[1], 'lease duration', this.leaseMs) });
      case 'lost':
        if (parts.length !== 1) throw new InvalidReplyError('Invalid lost transaction reply');
        return Object.freeze({ kind: 'lost' as const });
      case 'conflict':
        if (parts.length !== 1) throw new InvalidReplyError('Invalid conflict transaction reply');
        return Object.freeze({ kind: 'conflict' as const });
      default:
        throw new InvalidReplyError('Unknown transaction renew reply');
    }
  }

  private decodeComplete(wire: unknown, expectedResultRef: string): CompleteResult {
    const parts = wireParts(wire);
    switch (parts[0]) {
      case 'completed':
        if (parts.length !== 2 || parts[1] !== expectedResultRef) {
          throw new InvalidReplyError('Invalid completed transaction reply');
        }
        return Object.freeze({ kind: 'completed' as const, resultRef: parts[1] });
      case 'lost':
        if (parts.length !== 1) throw new InvalidReplyError('Invalid lost transaction reply');
        return Object.freeze({ kind: 'lost' as const });
      case 'conflict':
        if (parts.length !== 1) throw new InvalidReplyError('Invalid conflict transaction reply');
        return Object.freeze({ kind: 'conflict' as const });
      default:
        throw new InvalidReplyError('Unknown transaction complete reply');
    }
  }

  private decodeStatus(wire: unknown): Status {
    const parts = wireParts(wire);
    switch (parts[0]) {
      case 'missing':
        if (parts.length !== 1) throw new InvalidReplyError('Invalid missing transaction reply');
        return Object.freeze({ kind: 'missing' as const });
      case 'in_progress':
        if (parts.length !== 2) throw new InvalidReplyError('Invalid in-progress transaction reply');
        return Object.freeze({ kind: 'in_progress' as const, remainingMs: decimal(parts[1], 'lease duration', this.leaseMs) });
      case 'recovery_required':
        if (parts.length !== 1) throw new InvalidReplyError('Invalid recovery transaction reply');
        return Object.freeze({ kind: 'recovery_required' as const });
      case 'completed':
        if (parts.length !== 2 || !isReference(parts[1], MAX_RESULT_REFERENCE_BYTES)) {
          throw new InvalidReplyError('Invalid completed transaction reply');
        }
        return Object.freeze({ kind: 'completed' as const, resultRef: parts[1] });
      case 'conflict':
        if (parts.length !== 1) throw new InvalidReplyError('Invalid conflict transaction reply');
        return Object.freeze({ kind: 'conflict' as const });
      default:
        throw new InvalidReplyError('Unknown transaction read reply');
    }
  }
}

/** Factory form for dependency-injection containers. */
export function createOperationStore(options: OperationStoreFactoryOptions): RedisOperationStore {
  return new RedisOperationStore(options);
}

export interface OperationLeaseController {
  readonly signal: AbortSignal;
  readonly lost: Promise<never>;
  assertLive(): void;
  stop(): void;
}

export interface OperationLeaseControllerOptions {
  /** Monotonic timestamp captured immediately before the acquisition dispatch. */
  startedAt?: number;
}

/**
 * Serial lease renewal helper. Timers are advisory and never authorize a
 * mutation; Redis performs the owner check on every renew/complete command.
 */
export function maintainOperationLease(
  store: Pick<OperationStore, 'renew'>,
  lease: Lease,
  options: OperationLeaseControllerOptions = {},
): OperationLeaseController {
  const controller = new AbortController();
  const startedAt = options.startedAt ?? monotonicNow();
  let deadline = startedAt + Math.max(0, lease.remainingMs);
  let stopped = false;
  let lostError: Error | undefined;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectLost!: (error: Error) => void;
  const lost = new Promise<never>((_, reject) => { rejectLost = reject; });
  void lost.catch(() => undefined);

  const stop = () => {
    stopped = true;
    if (renewalTimer) clearTimeout(renewalTimer);
    if (expiryTimer) clearTimeout(expiryTimer);
  };
  const lose = () => {
    if (stopped || lostError) return;
    lostError = new OperationLeaseLostError();
    stop();
    controller.abort(lostError);
    rejectLost(lostError);
  };
  const assertLive = () => {
    if (!stopped && monotonicNow() >= deadline) lose();
    if (lostError) throw lostError;
  };
  const schedule = () => {
    if (stopped) return;
    const remaining = deadline - monotonicNow();
    if (remaining <= 0) { lose(); return; }
    expiryTimer = setTimeout(lose, Math.max(1, remaining));
    expiryTimer.unref?.();
    renewalTimer = setTimeout(async () => {
      const requestStartedAt = monotonicNow();
      try {
        assertLive();
        const renewed = await store.renew(lease);
        if (stopped) return;
        const responseAt = monotonicNow();
        if (responseAt >= deadline || renewed.kind !== 'renewed') { lose(); return; }
        // The response's remaining duration is measured remotely. Anchoring
        // it to request start subtracts all observed request/promotion time.
        deadline = requestStartedAt + renewed.remainingMs;
        if (deadline <= responseAt) { lose(); return; }
        if (expiryTimer) clearTimeout(expiryTimer);
        schedule();
      } catch {
        lose();
      }
    }, Math.max(1, Math.min(remaining / 3, remaining)));
    renewalTimer.unref?.();
  };

  if (deadline <= monotonicNow()) lose();
  else schedule();
  return { signal: controller.signal, lost, assertLive, stop };
}
