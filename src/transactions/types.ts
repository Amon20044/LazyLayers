/**
 * The transaction coordination API deliberately has no cache types in its
 * surface.  A Redis result is a coordination acknowledgement only; the
 * durable business record remains the source of truth for a payment.
 */

export type Identity = Readonly<{
  tenant: string;
  operation: string;
  idempotencyKey: string;
  fingerprint: string;
  durableId: string;
}>;

export type Lease = Readonly<{
  identity: Identity;
  owner: string;
  /** Advisory milliseconds remaining at the Redis server response boundary. */
  remainingMs: number;
}>;

export type BeginResult =
  | Readonly<{ kind: 'acquired'; lease: Lease; mustReconcile: true }>
  | Readonly<{ kind: 'in_progress'; remainingMs: number }>
  | Readonly<{ kind: 'completed'; resultRef: string }>
  | Readonly<{ kind: 'conflict' }>;

export type Status =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'in_progress'; remainingMs: number }>
  | Readonly<{ kind: 'recovery_required' }>
  | Readonly<{ kind: 'completed'; resultRef: string }>
  | Readonly<{ kind: 'conflict' }>;

export type RenewResult =
  | Readonly<{ kind: 'renewed'; remainingMs: number }>
  | Readonly<{ kind: 'lost' }>
  | Readonly<{ kind: 'conflict' }>;

export type CompleteResult =
  | Readonly<{ kind: 'completed'; resultRef: string }>
  | Readonly<{ kind: 'lost' }>
  | Readonly<{ kind: 'conflict' }>;

export interface OperationStore {
  begin(identity: Identity): Promise<BeginResult>;
  renew(lease: Lease): Promise<RenewResult>;
  complete(lease: Lease, committedResultRef: string): Promise<CompleteResult>;
  readStatus(identity: Identity): Promise<Status>;
  close(): Promise<void>;
}

/** Base for failures which are safe to expose without leaking key material. */
export class OperationError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'OperationError';
    this.code = code;
  }
}

/** The request did not reach Redis and may be retried with the same identity. */
export class OperationUnavailableError extends OperationError {
  readonly code: 'OPERATION_UNAVAILABLE' | 'OPERATION_GATE_CLOSED' = 'OPERATION_UNAVAILABLE';
  readonly beforeDispatch = true as const;

  constructor(message = 'Transaction coordination is unavailable', cause?: unknown) {
    super('OPERATION_UNAVAILABLE', message, cause);
    this.name = 'OperationUnavailableError';
  }
}

/** Delivery may have happened; the caller must reconcile the durable record. */
export class OperationUnknownError extends OperationError {
  readonly code = 'OPERATION_UNKNOWN' as const;
  readonly beforeDispatch = false as const;

  constructor(message = 'Transaction coordination outcome is unknown; reconcile authoritative state', cause?: unknown) {
    super('OPERATION_UNKNOWN', message, cause);
    this.name = 'OperationUnknownError';
  }
}

/** Local validation failed before any Redis command was sent. */
export class OperationValidationError extends OperationError {
  readonly code = 'OPERATION_INVALID_INPUT' as const;

  constructor(message: string) {
    super('OPERATION_INVALID_INPUT', message);
    this.name = 'OperationValidationError';
  }
}

/** Configuration cannot prove that the selected client is an authority. */
export class OperationConfigurationError extends OperationError {
  readonly code = 'OPERATION_INVALID_CONFIGURATION' as const;

  constructor(message: string) {
    super('OPERATION_INVALID_CONFIGURATION', message);
    this.name = 'OperationConfigurationError';
  }
}

/** A Redis-side protocol rejection was validated as a no-write error. */
export class OperationProtocolError extends OperationError {
  readonly code = 'OPERATION_PROTOCOL_ERROR' as const;
  readonly definitiveNoWrite = true as const;

  constructor(message: string, cause?: unknown) {
    super('OPERATION_PROTOCOL_ERROR', message, cause);
    this.name = 'OperationProtocolError';
  }
}

/** The local bounded dispatcher has been closed. */
export class OperationGateClosedError extends OperationUnavailableError {
  override readonly code = 'OPERATION_GATE_CLOSED' as const;

  constructor() {
    super('Transaction coordination dispatcher is closed');
    this.name = 'OperationGateClosedError';
  }
}

/** Caller-facing deadline after a command was admitted to Redis. */
export class OperationDispatchTimeoutError extends OperationError {
  readonly code = 'OPERATION_DISPATCH_TIMEOUT' as const;
  readonly beforeDispatch = false as const;

  constructor(message = 'Transaction command deadline elapsed') {
    super('OPERATION_DISPATCH_TIMEOUT', message);
    this.name = 'OperationDispatchTimeoutError';
  }
}

/** A local lease controller observed its advisory deadline elapse. */
export class OperationLeaseLostError extends Error {
  readonly code = 'OPERATION_LEASE_LOST' as const;

  constructor() {
    super('The local transaction lease deadline elapsed');
    this.name = 'OperationLeaseLostError';
  }
}
