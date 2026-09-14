import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const tx = await import('../dist/transactions/index.js');

class SharedStateTransport {
  constructor(state) {
    this.namespace = 'recovery';
    this.state = state;
    this.closed = false;
  }

  canDispatch() { return !this.closed; }

  async execute(key, args) {
    const [command, fingerprint, durableId, owner, leaseText, retentionText, resultRef] = args;
    const now = Date.now();
    let record = this.state.records.get(key);
    const leaseMs = Number(leaseText);
    const retentionMs = Number(retentionText);
    if (record && record.retainUntil <= now) {
      this.state.records.delete(key);
      record = undefined;
    }
    if (record && (record.fingerprint !== fingerprint || record.durableId !== durableId)) return ['conflict'];
    if (command === 'read') {
      if (!record) return ['missing'];
      if (record.state === 'completed') return ['completed', record.resultRef];
      const remaining = Math.max(0, record.leaseUntil - now);
      return remaining === 0 ? ['recovery_required'] : ['in_progress', String(remaining)];
    }
    if (record?.state === 'completed') {
      if (command === 'renew') return ['lost'];
      if (command === 'complete' && record.resultRef !== resultRef) return ['conflict'];
      return ['completed', record.resultRef];
    }
    if (command === 'begin') {
      if (record && record.leaseUntil > now) return ['in_progress', String(record.leaseUntil - now)];
      record = {
        fingerprint, durableId, owner, state: 'pending', leaseUntil: now + leaseMs,
        retainUntil: Math.max(record?.retainUntil ?? 0, now + retentionMs), resultRef: '',
      };
      this.state.records.set(key, record);
      return ['acquired', owner, String(leaseMs), 'reconcile'];
    }
    if (!record || record.owner !== owner || record.leaseUntil <= now) return ['lost'];
    if (command === 'renew') {
      record.leaseUntil = now + leaseMs;
      record.retainUntil = Math.max(record.retainUntil, now + retentionMs);
      return ['renewed', String(leaseMs)];
    }
    record.state = 'completed';
    record.resultRef = resultRef;
    record.leaseUntil = 0;
    record.retainUntil = Math.max(record.retainUntil, now + retentionMs);
    return ['completed', resultRef];
  }

  close() { this.closed = true; }
}

function makeIdentity() {
  return {
    tenant: 'acme', operation: 'ticket-confirm', idempotencyKey: 'pay-1',
    fingerprint: 'd'.repeat(64), durableId: 'payment-1',
  };
}

test('recovery after a provider effect reuses the durable provider identity', async () => {
  const redisState = { records: new Map() };
  const provider = new Map();
  let providerEffects = 0;
  const executeProvider = async (providerKey) => {
    const previous = provider.get(providerKey);
    if (previous) return previous;
    providerEffects += 1;
    const outcome = { kind: 'approved', providerTransactionId: 'provider-txn-1' };
    provider.set(providerKey, outcome);
    return outcome;
  };
  const durable = { state: 'pending', attempt: 0, result: undefined };
  const id = makeIdentity();
  const firstStore = new tx.RedisOperationStore(new SharedStateTransport(redisState), {
    namespace: 'recovery', leaseMs: 20, retentionMs: 1_000, operationTimeoutMs: 250,
  });
  const first = await firstStore.begin(id);
  assert.equal(first.kind, 'acquired');
  durable.attempt += 1;
  const providerKey = tx.paymentProviderKey(id.durableId, 'fake-ticketing-provider');
  await executeProvider(providerKey);
  // Crash after provider execution, before the DB finalization transaction.
  await firstStore.close();
  await sleep(35);

  const secondStore = new tx.RedisOperationStore(new SharedStateTransport(redisState), {
    namespace: 'recovery', leaseMs: 20, retentionMs: 1_000, operationTimeoutMs: 250,
  });
  const takeover = await secondStore.begin(id);
  assert.equal(takeover.kind, 'acquired');
  durable.attempt += 1;
  const reconciled = await executeProvider(providerKey);
  durable.state = 'completed';
  durable.result = reconciled;
  assert.equal(providerEffects, 1, 'same provider idempotency key must produce one effect');
  assert.deepEqual(await secondStore.complete(takeover.lease, 'payment:payment-1:confirmed'), {
    kind: 'completed', resultRef: 'payment:payment-1:confirmed',
  });
  assert.deepEqual(await secondStore.readStatus(id), {
    kind: 'completed', resultRef: 'payment:payment-1:confirmed',
  });
  assert.equal(durable.attempt, 2);
  await secondStore.close();
});

test('ticket resource locking is independent of request idempotency', async () => {
  const { tsImport } = await import('tsx/esm/api');
  const example = await tsImport('../examples/transaction-coordination/index.ts', { parentURL: import.meta.url });
  const fixture = example.createTicketingExample();
  const [alice, bob] = await Promise.all([
    fixture.service.reserve({ tenant: 'acme', showId: 'movie-1', seatId: 'A1', buyerId: 'alice', idempotencyKey: 'reserve-a' }),
    fixture.service.reserve({ tenant: 'acme', showId: 'movie-1', seatId: 'A1', buyerId: 'bob', idempotencyKey: 'reserve-b' }),
  ]);
  assert.equal([alice, bob].filter((result) => result.kind === 'held').length, 1);
  assert.equal([alice, bob].filter((result) => result.kind === 'declined').length, 1);
  const held = alice.kind === 'held' ? alice : bob;
  assert.deepEqual(await fixture.service.reserve({
    tenant: 'acme', showId: 'movie-1', seatId: 'A1', buyerId: held.kind === 'held' ? 'alice' : 'bob',
    idempotencyKey: held.kind === 'held' ? 'reserve-a' : 'reserve-b',
  }), held);
  const confirmed = await fixture.service.confirm({
    tenant: 'acme', reservationId: held.reservationId,
    buyerId: held.kind === 'held' ? 'alice' : 'bob', currency: 'USD', amountMinor: '1200', idempotencyKey: 'pay-a',
  });
  assert.equal(confirmed.kind, 'confirmed');
  const retry = await fixture.service.confirm({
    tenant: 'acme', reservationId: held.reservationId,
    buyerId: held.kind === 'held' ? 'alice' : 'bob', currency: 'USD', amountMinor: '1200', idempotencyKey: 'pay-a',
  });
  assert.deepEqual(retry, confirmed);
  assert.equal(fixture.provider.effectCount(), 1);

  const shortHold = await fixture.service.reserve({ tenant: 'acme', showId: 'movie-1', seatId: 'A2', buyerId: 'charlie', idempotencyKey: 'reserve-c', holdMs: 15 });
  assert.equal(shortHold.kind, 'held');
  await sleep(30);
  const replacement = await fixture.service.reserve({ tenant: 'acme', showId: 'movie-1', seatId: 'A2', buyerId: 'dave', idempotencyKey: 'reserve-d' });
  assert.equal(replacement.kind, 'held');
  assert.notEqual(replacement.reservationId, shortHold.reservationId);
  assert.equal(fixture.db.readReservation(shortHold.reservationId).state, 'released');
  assert.equal(fixture.db.readSeat('movie-1', 'A2').reservationId, replacement.reservationId);
  await fixture.operations.close();
});
