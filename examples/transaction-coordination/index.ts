/**
 * Ticketing example for the transaction coordinator.
 *
 * The adapters below are intentionally in-memory so the example can run
 * without a database, payment account, or external service. They model the
 * invariants a production adapter must enforce in a short durable transaction:
 *
 *   - a seat is a resource row, independent of an idempotency key;
 *   - a reservation is held before the caller leaves the request;
 *   - provider identity is stable for recovery and duplicate requests;
 *   - Redis only coordinates work and never decides a ticket or payment result.
 *
 * Replace FakeDurableTicketDb with PostgreSQL/another transactional primary,
 * and FakeIdempotentPaymentProvider with the provider's documented idempotency
 * and reconciliation API. A Redis lease does not make an external charge
 * exactly once.
 */

import {
  RedisOperationStore,
  RedisOperationTransport,
  fingerprintFields,
  paymentProviderKey,
  validateAmountMinor,
  type Identity,
  type OperationStore,
  type BeginResult,
  type RedisOperationClient,
} from '../../dist/transactions/index.js';
import { pathToFileURL } from 'node:url';

export type TicketResult =
  | Readonly<{ kind: 'held'; reservationId: string; showId: string; seatId: string; expiresAt: number }>
  | Readonly<{ kind: 'confirmed'; reservationId: string; showId: string; seatId: string; providerTransactionId: string }>
  | Readonly<{ kind: 'released'; reservationId: string; showId: string; seatId: string }>
  | Readonly<{ kind: 'declined'; reason: string; showId: string; seatId: string }>;

export type TicketRequest = Readonly<{
  tenant: string;
  showId: string;
  seatId: string;
  buyerId: string;
  idempotencyKey: string;
  holdMs?: number;
}>;

export type ConfirmRequest = Readonly<{
  tenant: string;
  reservationId: string;
  buyerId: string;
  currency: string;
  amountMinor: string;
  idempotencyKey: string;
}>;

export type ReleaseRequest = Readonly<{
  tenant: string;
  reservationId: string;
  buyerId: string;
  idempotencyKey: string;
}>;

type SeatState = 'available' | 'held' | 'confirmed';
type OperationKind = 'reserve' | 'confirm' | 'release';

interface SeatRow {
  readonly key: string;
  readonly showId: string;
  readonly seatId: string;
  state: SeatState;
  reservationId?: string;
  expiresAt?: number;
}

interface ReservationRow {
  readonly reservationId: string;
  readonly tenant: string;
  readonly showId: string;
  readonly seatId: string;
  readonly buyerId: string;
  state: 'held' | 'confirmed' | 'released';
  expiresAt: number;
}

interface DurableOperation {
  readonly durableId: string;
  readonly tenant: string;
  readonly kind: OperationKind;
  readonly fingerprint: string;
  readonly providerKey?: string;
  readonly reservationId?: string;
  readonly idempotencyKey: string;
  state: 'pending' | 'completed';
  attemptVersion: number;
  resultRef?: string;
  result?: TicketResult;
}

interface PreparedOperation {
  readonly operation: DurableOperation;
  readonly isFinal: boolean;
}

export interface OperationAttempt {
  readonly operation: DurableOperation;
  readonly version: number;
}

export type PaymentOutcome =
  | Readonly<{ kind: 'approved'; providerTransactionId: string }>
  | Readonly<{ kind: 'declined'; reason: string }>
  | Readonly<{ kind: 'unknown' }>;

function idPart(name: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9:_./-]+$/.test(value)) {
    throw new TypeError(`${name} must be a non-empty identifier`);
  }
  return value;
}

function positiveMs(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 3_600_000) {
    throw new TypeError('holdMs must be a positive integer no greater than one hour');
  }
  return result;
}

function seatKey(showId: string, seatId: string): string {
  return `${idPart('showId', showId)}:${idPart('seatId', seatId)}`;
}

function freezeResult<T extends TicketResult>(result: T): T {
  return Object.freeze(result);
}

/**
 * A tiny Redis-primary test double. It implements the same one-record state
 * machine as OPERATION_COORDINATION_LUA and is useful for running the example
 * on a laptop without starting Redis.
 */
export class FakePrimaryRedis {
  private readonly records = new Map<string, {
    fingerprint: string;
    durableId: string;
    owner: string;
    state: 'pending' | 'completed';
    leaseUntilMs: number;
    retainUntilMs: number;
    resultRef: string;
  }>();

  defineCommand(name: string): void {
    Object.defineProperty(this, name, {
      configurable: true,
      value: (...args: Array<string | number | Buffer>) => this.execute(args.map(String)),
    });
  }

  private execute(args: string[]): string[] {
    if (args.length !== 8) throw new Error('ERR TX_INVALID_ARGS');
    const [key, command, fingerprint, durableId, owner, leaseText, retentionText, resultRef] = args;
    const leaseMs = Number(leaseText);
    const retentionMs = Number(retentionText);
    if (!Number.isSafeInteger(leaseMs) || !Number.isSafeInteger(retentionMs) || leaseMs < 1 || retentionMs < leaseMs) {
      throw new Error('ERR TX_INVALID_TTL');
    }
    const now = Date.now();
    let record = this.records.get(key);
    if (record && record.retainUntilMs <= now) {
      this.records.delete(key);
      record = undefined;
    }
    if (record && (record.fingerprint !== fingerprint || record.durableId !== durableId)) return ['conflict'];
    if (command === 'read') {
      if (!record) return ['missing'];
      if (record.state === 'completed') return ['completed', record.resultRef];
      const remaining = Math.max(0, record.leaseUntilMs - now);
      return remaining === 0 ? ['recovery_required'] : ['in_progress', String(remaining)];
    }
    if (record?.state === 'completed') {
      if (command === 'renew') return ['lost'];
      if (command === 'complete' && record.resultRef !== resultRef) return ['conflict'];
      return ['completed', record.resultRef];
    }
    if (command === 'begin') {
      if (record && record.leaseUntilMs > now) {
        return record.owner === owner
          ? ['acquired', owner, String(record.leaseUntilMs - now), 'reconcile']
          : ['in_progress', String(record.leaseUntilMs - now)];
      }
      const retainUntilMs = Math.max(record?.retainUntilMs ?? 0, now + retentionMs);
      record = {
        fingerprint,
        durableId,
        owner,
        state: 'pending',
        leaseUntilMs: now + leaseMs,
        retainUntilMs,
        resultRef: '',
      };
      this.records.set(key, record);
      return ['acquired', owner, String(leaseMs), 'reconcile'];
    }
    if (!record || record.owner !== owner || record.leaseUntilMs <= now) return ['lost'];
    if (command === 'renew') {
      record.leaseUntilMs = now + leaseMs;
      record.retainUntilMs = Math.max(record.retainUntilMs, now + retentionMs);
      return ['renewed', String(leaseMs)];
    }
    if (command !== 'complete' || resultRef.length === 0) throw new Error('ERR TX_INVALID_COMMAND');
    record.state = 'completed';
    record.resultRef = resultRef;
    record.leaseUntilMs = 0;
    record.retainUntilMs = Math.max(record.retainUntilMs, now + retentionMs);
    return ['completed', resultRef];
  }
}

/**
 * Durable seat and operation store. Each method is the boundary of a short
 * database transaction in the real implementation; no Redis status is used
 * to decide whether a seat is available.
 */
export class FakeDurableTicketDb {
  private sequence = 0;
  private readonly seats = new Map<string, SeatRow>();
  private readonly reservations = new Map<string, ReservationRow>();
  private readonly operations = new Map<string, DurableOperation>();
  private readonly operationsById = new Map<string, DurableOperation>();

  addSeat(showId: string, seatId: string): void {
    const key = seatKey(showId, seatId);
    this.seats.set(key, { key, showId, seatId, state: 'available' });
  }

  async prepareReservation(input: TicketRequest): Promise<PreparedOperation> {
    const showId = idPart('showId', input.showId);
    const seatId = idPart('seatId', input.seatId);
    const buyerId = idPart('buyerId', input.buyerId);
    const tenant = idPart('tenant', input.tenant);
    const holdMs = positiveMs(input.holdMs, 5 * 60_000);
    const key = seatKey(showId, seatId);
    const fingerprint = fingerprintFields('ticket-reservation-v1', [tenant, showId, seatId, buyerId, String(holdMs)]);
    const operationKey = `${tenant}|reserve|${idPart('idempotencyKey', input.idempotencyKey)}`;
    const previous = this.operations.get(operationKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
      return { operation: previous, isFinal: previous.state === 'completed' };
    }
    const now = Date.now();
    const seat = this.seats.get(key);
    if (!seat) throw new Error('SEAT_NOT_FOUND');
    this.expireSeat(seat, now);
    // Let concurrent callers reach the same transaction boundary. A real
    // adapter replaces this yield with `SELECT ... FOR UPDATE` (or a serializable
    // transaction) and rechecks the row while holding the database lock.
    await Promise.resolve();
    const durableId = `reservation-${++this.sequence}`;
    const reservation: ReservationRow = {
      reservationId: durableId,
      tenant,
      showId,
      seatId,
      buyerId,
      state: 'held',
      expiresAt: now + holdMs,
    };
    this.reservations.set(durableId, reservation);
    let operation: DurableOperation;
    if (seat.state !== 'available') {
      reservation.state = 'released';
      operation = this.finalOperation({
        durableId,
        tenant,
        kind: 'reserve',
        fingerprint,
        idempotencyKey: input.idempotencyKey,
        result: freezeResult({ kind: 'declined', reason: 'seat_unavailable', showId, seatId }),
      });
      this.saveOperation(operationKey, operation);
      return { operation, isFinal: true };
    }
    // This is the resource invariant: the seat row is claimed atomically,
    // independently of the request's idempotency key.
    seat.state = 'held';
    seat.reservationId = durableId;
    seat.expiresAt = reservation.expiresAt;
    operation = {
      durableId,
      tenant,
      kind: 'reserve',
      fingerprint,
      idempotencyKey: input.idempotencyKey,
      reservationId: durableId,
      state: 'pending',
      attemptVersion: 0,
    };
    this.saveOperation(operationKey, operation);
    return { operation, isFinal: false };
  }

  async prepareConfirm(input: ConfirmRequest): Promise<PreparedOperation> {
    const tenant = idPart('tenant', input.tenant);
    const reservationId = idPart('reservationId', input.reservationId);
    const buyerId = idPart('buyerId', input.buyerId);
    const currency = idPart('currency', input.currency);
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('INVALID_CURRENCY');
    const amountMinor = validateAmountMinor(input.amountMinor);
    const fingerprint = fingerprintFields('ticket-confirm-v1', [tenant, reservationId, buyerId, currency, amountMinor]);
    const operationKey = `${tenant}|confirm|${idPart('idempotencyKey', input.idempotencyKey)}`;
    const previous = this.operations.get(operationKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
      return { operation: previous, isFinal: previous.state === 'completed' };
    }
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.tenant !== tenant || reservation.buyerId !== buyerId) {
      return this.prepareFinalPayment(operationKey, {
        tenant, reservationId, fingerprint, input,
      }, { kind: 'declined', reason: 'reservation_not_found' });
    }
    const seat = this.seats.get(seatKey(reservation.showId, reservation.seatId));
    if (!seat || reservation.state !== 'held' || reservation.expiresAt <= Date.now() || seat.reservationId !== reservationId) {
      if (reservation.state === 'held') this.releaseReservation(reservation, seat);
      return this.prepareFinalPayment(operationKey, {
        tenant, reservationId, fingerprint, input,
      }, { kind: 'declined', reason: 'reservation_expired' });
    }
    const durableId = `payment-${++this.sequence}`;
    const operation: DurableOperation = {
      durableId,
      tenant,
      kind: 'confirm',
      fingerprint,
      idempotencyKey: input.idempotencyKey,
      reservationId,
      providerKey: paymentProviderKey(durableId, 'fake-ticketing-provider'),
      state: 'pending',
      attemptVersion: 0,
    };
    this.saveOperation(operationKey, operation);
    return { operation, isFinal: false };
  }

  async prepareRelease(input: ReleaseRequest): Promise<PreparedOperation> {
    const tenant = idPart('tenant', input.tenant);
    const reservationId = idPart('reservationId', input.reservationId);
    const buyerId = idPart('buyerId', input.buyerId);
    const fingerprint = fingerprintFields('ticket-release-v1', [tenant, reservationId, buyerId]);
    const operationKey = `${tenant}|release|${idPart('idempotencyKey', input.idempotencyKey)}`;
    const previous = this.operations.get(operationKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
      return { operation: previous, isFinal: previous.state === 'completed' };
    }
    const reservation = this.reservations.get(reservationId);
    const seat = reservation ? this.seats.get(seatKey(reservation.showId, reservation.seatId)) : undefined;
    if (!reservation || reservation.tenant !== tenant || reservation.buyerId !== buyerId || reservation.state !== 'held') {
      const showId = reservation?.showId ?? 'unknown';
      const seatId = reservation?.seatId ?? 'unknown';
      const operation = this.finalOperation({
        durableId: `release-${++this.sequence}`,
        tenant,
        kind: 'release',
        fingerprint,
        idempotencyKey: input.idempotencyKey,
        result: freezeResult({ kind: 'declined', reason: 'reservation_not_held', showId, seatId }),
      });
      this.saveOperation(operationKey, operation);
      return { operation, isFinal: true };
    }
    const operation: DurableOperation = {
      durableId: `release-${++this.sequence}`,
      tenant,
      kind: 'release',
      fingerprint,
      idempotencyKey: input.idempotencyKey,
      reservationId,
      state: 'pending',
      attemptVersion: 0,
    };
    this.saveOperation(operationKey, operation);
    void seat;
    return { operation, isFinal: false };
  }

  async claimAttempt(durableId: string): Promise<{ isFinal: true; result: TicketResult } | { isFinal: false; attempt: OperationAttempt }> {
    const operation = this.operationsById.get(durableId);
    if (!operation) throw new Error('DURABLE_OPERATION_NOT_FOUND');
    if (operation.state === 'completed' && operation.result) return { isFinal: true, result: operation.result };
    operation.attemptVersion += 1;
    return { isFinal: false, attempt: { operation, version: operation.attemptVersion } };
  }

  async finalizeAttempt(attempt: OperationAttempt, result: TicketResult): Promise<{ isFinal: true; result: TicketResult; resultRef: string } | { isFinal: false }> {
    const operation = this.operationsById.get(attempt.operation.durableId);
    if (!operation || operation.state !== 'pending' || operation.attemptVersion !== attempt.version) return { isFinal: false };
    const reservation = operation.reservationId ? this.reservations.get(operation.reservationId) : undefined;
    const seat = reservation ? this.seats.get(seatKey(reservation.showId, reservation.seatId)) : undefined;
    if (operation.kind === 'reserve' && reservation && seat && (reservation.expiresAt <= Date.now() || seat.reservationId !== reservation.reservationId)) {
      this.releaseReservation(reservation, seat);
      result = freezeResult({ kind: 'declined', reason: 'reservation_expired', showId: reservation.showId, seatId: reservation.seatId });
    }
    if (operation.kind === 'confirm') {
      if (!reservation || !seat || reservation.state !== 'held' || seat.reservationId !== reservation.reservationId) {
        result = freezeResult({ kind: 'declined', reason: 'reservation_unavailable', showId: reservation?.showId ?? 'unknown', seatId: reservation?.seatId ?? 'unknown' });
      } else if (result.kind === 'confirmed') {
        reservation.state = 'confirmed';
        seat.state = 'confirmed';
        seat.expiresAt = undefined;
      } else {
        this.releaseReservation(reservation, seat);
      }
    }
    if (operation.kind === 'release' && reservation && seat) this.releaseReservation(reservation, seat);
    operation.state = 'completed';
    operation.result = freezeResult(result);
    operation.resultRef = `${operation.kind}:${operation.durableId}:${result.kind}`;
    return { isFinal: true, result: operation.result, resultRef: operation.resultRef };
  }

  readFinalOrPending(durableId: string): TicketResult | Readonly<{ kind: 'pending'; operationId: string }> {
    const operation = this.operationsById.get(durableId);
    if (operation?.state === 'completed' && operation.result) return operation.result;
    return { kind: 'pending', operationId: durableId };
  }

  readReservation(reservationId: string): Readonly<{ reservationId: string; state: ReservationRow['state']; showId: string; seatId: string; expiresAt: number }> | undefined {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return undefined;
    return Object.freeze({ reservationId, state: reservation.state, showId: reservation.showId, seatId: reservation.seatId, expiresAt: reservation.expiresAt });
  }

  readSeat(showId: string, seatId: string): Readonly<{ showId: string; seatId: string; state: SeatState; reservationId?: string }> {
    const seat = this.seats.get(seatKey(showId, seatId));
    if (!seat) throw new Error('SEAT_NOT_FOUND');
    this.expireSeat(seat, Date.now());
    return Object.freeze({ showId: seat.showId, seatId: seat.seatId, state: seat.state, reservationId: seat.reservationId });
  }

  private prepareFinalPayment(
    operationKey: string,
    metadata: { tenant: string; reservationId: string; fingerprint: string; input: ConfirmRequest },
    outcome: Readonly<{ kind: 'declined'; reason: string }>,
  ): PreparedOperation {
    const reservation = this.reservations.get(metadata.reservationId);
    const operation = this.finalOperation({
      durableId: `payment-${++this.sequence}`,
      tenant: metadata.tenant,
      kind: 'confirm',
      fingerprint: metadata.fingerprint,
      idempotencyKey: metadata.input.idempotencyKey,
      reservationId: metadata.reservationId,
      providerKey: paymentProviderKey(`payment-${this.sequence}`, 'fake-ticketing-provider'),
      result: freezeResult({ ...outcome, showId: reservation?.showId ?? 'unknown', seatId: reservation?.seatId ?? 'unknown' }),
    });
    this.saveOperation(operationKey, operation);
    return { operation, isFinal: true };
  }

  private finalOperation(input: Omit<DurableOperation, 'state' | 'attemptVersion' | 'resultRef'>): DurableOperation {
    return { ...input, state: 'completed', attemptVersion: 0, resultRef: `${input.kind}:${input.durableId}:final` };
  }

  private saveOperation(key: string, operation: DurableOperation): void {
    this.operations.set(key, operation);
    this.operationsById.set(operation.durableId, operation);
  }

  private expireSeat(seat: SeatRow, now: number): void {
    if (seat.state !== 'held' || !seat.expiresAt || seat.expiresAt > now) return;
    const reservation = seat.reservationId ? this.reservations.get(seat.reservationId) : undefined;
    if (reservation?.state === 'held') reservation.state = 'released';
    seat.state = 'available';
    seat.reservationId = undefined;
    seat.expiresAt = undefined;
  }

  private releaseReservation(reservation: ReservationRow, seat: SeatRow | undefined): void {
    reservation.state = 'released';
    if (seat?.reservationId === reservation.reservationId) {
      seat.state = 'available';
      seat.reservationId = undefined;
      seat.expiresAt = undefined;
    }
  }
}

/** Durable provider idempotency double. It records effects by stable key. */
export class FakeIdempotentPaymentProvider {
  private readonly outcomes = new Map<string, PaymentOutcome>();
  private requests = 0;
  private effects = 0;

  async lookup(idempotencyKey: string): Promise<PaymentOutcome | undefined> {
    return this.outcomes.get(idempotencyKey);
  }

  async execute(_request: ConfirmRequest, options: { idempotencyKey: string; signal?: AbortSignal }): Promise<PaymentOutcome> {
    this.requests += 1;
    const previous = this.outcomes.get(options.idempotencyKey);
    if (previous) return previous;
    if (options.signal?.aborted) return { kind: 'unknown' };
    const outcome: PaymentOutcome = Object.freeze({
      kind: 'approved',
      providerTransactionId: `fake-txn-${this.effects + 1}`,
    });
    this.effects += 1;
    this.outcomes.set(options.idempotencyKey, outcome);
    return outcome;
  }

  requestCount(): number { return this.requests; }
  effectCount(): number { return this.effects; }
  duplicateEffectCount(): number { return Math.max(0, this.requests - this.effects); }
}

export interface TicketingDependencies {
  readonly operations: OperationStore;
  readonly db: FakeDurableTicketDb;
  readonly provider: FakeIdempotentPaymentProvider;
}

export class TicketingService {
  constructor(private readonly deps: TicketingDependencies) {}

  async reserve(input: TicketRequest): Promise<TicketResult | Readonly<{ kind: 'pending'; operationId: string }>> {
    const prepared = await this.deps.db.prepareReservation(input);
    if (prepared.isFinal) return this.deps.db.readFinalOrPending(prepared.operation.durableId) as TicketResult;
    const claim = await this.deps.operations.begin(this.identity(prepared.operation));
    if (claim.kind === 'conflict') throw new Error('COORDINATION_CONFLICT');
    if (claim.kind === 'completed') return this.deps.db.readFinalOrPending(prepared.operation.durableId);
    if (claim.kind === 'in_progress') return { kind: 'pending', operationId: prepared.operation.durableId };
    const attempt = await this.deps.db.claimAttempt(prepared.operation.durableId);
    if (attempt.isFinal) return attempt.result;
    const result = await this.deps.db.finalizeAttempt(attempt.attempt, {
      kind: 'held',
      reservationId: prepared.operation.durableId,
      showId: input.showId,
      seatId: input.seatId,
      expiresAt: this.deps.db.readReservation(prepared.operation.durableId)?.expiresAt ?? Date.now(),
    });
    if (!result.isFinal) return { kind: 'pending', operationId: prepared.operation.durableId };
    await this.completeQuietly(claim, result.resultRef);
    return result.result;
  }

  async confirm(input: ConfirmRequest): Promise<TicketResult | Readonly<{ kind: 'pending'; operationId: string }>> {
    const prepared = await this.deps.db.prepareConfirm(input);
    if (prepared.isFinal) return this.deps.db.readFinalOrPending(prepared.operation.durableId) as TicketResult;
    const claim = await this.deps.operations.begin(this.identity(prepared.operation));
    if (claim.kind === 'conflict') throw new Error('COORDINATION_CONFLICT');
    if (claim.kind === 'completed') return this.deps.db.readFinalOrPending(prepared.operation.durableId);
    if (claim.kind === 'in_progress') return { kind: 'pending', operationId: prepared.operation.durableId };
    const attempt = await this.deps.db.claimAttempt(prepared.operation.durableId);
    if (attempt.isFinal) return attempt.result;
    const providerKey = prepared.operation.providerKey!;
    let outcome: PaymentOutcome | undefined = await this.deps.provider.lookup(providerKey);
    if (!outcome) {
      try {
        outcome = await this.deps.provider.execute(input, { idempotencyKey: providerKey });
      } catch {
        // A provider exception after dispatch is unknown. Keep the durable
        // operation pending and reconcile using the same provider key.
        return { kind: 'pending', operationId: prepared.operation.durableId };
      }
    }
    if (outcome.kind === 'unknown') return { kind: 'pending', operationId: prepared.operation.durableId };
    const result = outcome.kind === 'approved'
      ? { kind: 'confirmed' as const, reservationId: input.reservationId, showId: this.deps.db.readReservation(input.reservationId)?.showId ?? 'unknown', seatId: this.deps.db.readReservation(input.reservationId)?.seatId ?? 'unknown', providerTransactionId: outcome.providerTransactionId }
      : { kind: 'declined' as const, reason: outcome.reason, showId: this.deps.db.readReservation(input.reservationId)?.showId ?? 'unknown', seatId: this.deps.db.readReservation(input.reservationId)?.seatId ?? 'unknown' };
    const final = await this.deps.db.finalizeAttempt(attempt.attempt, result);
    if (!final.isFinal) return { kind: 'pending', operationId: prepared.operation.durableId };
    await this.completeQuietly(claim, final.resultRef);
    return final.result;
  }

  async release(input: ReleaseRequest): Promise<TicketResult | Readonly<{ kind: 'pending'; operationId: string }>> {
    const prepared = await this.deps.db.prepareRelease(input);
    if (prepared.isFinal) return this.deps.db.readFinalOrPending(prepared.operation.durableId) as TicketResult;
    const claim = await this.deps.operations.begin(this.identity(prepared.operation));
    if (claim.kind === 'conflict') throw new Error('COORDINATION_CONFLICT');
    if (claim.kind === 'completed') return this.deps.db.readFinalOrPending(prepared.operation.durableId);
    if (claim.kind === 'in_progress') return { kind: 'pending', operationId: prepared.operation.durableId };
    const reservation = this.deps.db.readReservation(input.reservationId);
    const result: TicketResult = {
      kind: 'released',
      reservationId: input.reservationId,
      showId: reservation?.showId ?? 'unknown',
      seatId: reservation?.seatId ?? 'unknown',
    };
    const attempt = await this.deps.db.claimAttempt(prepared.operation.durableId);
    if (attempt.isFinal) return attempt.result;
    const final = await this.deps.db.finalizeAttempt(attempt.attempt, result);
    if (!final.isFinal) return { kind: 'pending', operationId: prepared.operation.durableId };
    await this.completeQuietly(claim, final.resultRef);
    return final.result;
  }

  private identity(operation: DurableOperation): Identity {
    return Object.freeze({
      tenant: operation.tenant,
      operation: `ticket-${operation.kind}`,
      idempotencyKey: operation.idempotencyKey,
      fingerprint: operation.fingerprint,
      durableId: operation.durableId,
    });
  }

  private async completeQuietly(claim: Extract<BeginResult, { kind: 'acquired' }>, resultRef: string): Promise<void> {
    try {
      await this.deps.operations.complete(claim.lease, resultRef);
    } catch {
      // The DB result and outbox remain authoritative if Redis completion is
      // lost. Never execute the provider again because this repair failed.
    }
  }
}

export function createTicketingExample(): {
  readonly primary: FakePrimaryRedis;
  readonly db: FakeDurableTicketDb;
  readonly provider: FakeIdempotentPaymentProvider;
  readonly operations: RedisOperationStore;
  readonly service: TicketingService;
} {
  const primary = new FakePrimaryRedis();
  const transport = new RedisOperationTransport(primary as unknown as RedisOperationClient, {
    namespace: 'ticketing-demo',
    authorityId: 'in-memory-primary',
    allowUnknownClientOptions: true,
  });
  const operations = new RedisOperationStore(transport, {
    leaseMs: 250,
    retentionMs: 10_000,
    operationTimeoutMs: 1_000,
  });
  const db = new FakeDurableTicketDb();
  db.addSeat('movie-1', 'A1');
  db.addSeat('movie-1', 'A2');
  const provider = new FakeIdempotentPaymentProvider();
  const service = new TicketingService({ operations, db, provider });
  return { primary, db, provider, operations, service };
}

export async function runDemo(): Promise<void> {
  const example = createTicketingExample();
  const common = { tenant: 'acme', showId: 'movie-1', seatId: 'A1' } as const;
  const [first, second] = await Promise.all([
    example.service.reserve({ ...common, buyerId: 'alice', idempotencyKey: 'reserve-alice' }),
    example.service.reserve({ ...common, buyerId: 'bob', idempotencyKey: 'reserve-bob' }),
  ]);
  console.log('concurrent reserve:', first, second);
  if (first.kind !== 'held') throw new Error('demo expected a held seat');
  const retried = await example.service.reserve({ ...common, buyerId: 'alice', idempotencyKey: 'reserve-alice' });
  console.log('idempotent retry:', retried);
  const confirmed = await example.service.confirm({
    tenant: 'acme', reservationId: first.reservationId, buyerId: 'alice',
    currency: 'USD', amountMinor: '1200', idempotencyKey: 'pay-alice',
  });
  console.log('confirmed:', confirmed);
  const confirmedRetry = await example.service.confirm({
    tenant: 'acme', reservationId: first.reservationId, buyerId: 'alice',
    currency: 'USD', amountMinor: '1200', idempotencyKey: 'pay-alice',
  });
  console.log('payment retry:', confirmedRetry, 'provider effects:', example.provider.effectCount());
  await example.operations.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runDemo();
}
