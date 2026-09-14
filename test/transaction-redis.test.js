import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const tx = await import('../dist/transactions/index.js');

test('Redis v1 state machine serializes ownership and preserves terminal results', { skip: !process.env.REDIS_URL }, async (t) => {
  const { default: Redis } = await import('ioredis');
  const client = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
  });
  if (client.status !== 'ready') await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
  });
  const transport = new tx.RedisOperationTransport(client, {
    namespace: `tx-test-${randomUUID()}`,
    authorityId: 'redis-test-primary',
  });
  const store = new tx.RedisOperationStore(transport, { leaseMs: 100, retentionMs: 2_000 });
  const id = {
    tenant: 'acme', operation: 'ticket-reserve', idempotencyKey: randomUUID(),
    fingerprint: 'b'.repeat(64), durableId: `reservation-${randomUUID()}`,
  };
  t.after(async () => { await store.close(); client.disconnect(); });

  const first = await store.begin(id);
  assert.equal(first.kind, 'acquired');
  assert.equal(first.mustReconcile, true);
  const second = await store.begin(id);
  assert.equal(second.kind, 'in_progress');
  assert.ok(second.remainingMs > 0);

  assert.deepEqual(await store.complete(first.lease, 'reservation:result-1'), {
    kind: 'completed', resultRef: 'reservation:result-1',
  });
  assert.deepEqual(await store.readStatus(id), { kind: 'completed', resultRef: 'reservation:result-1' });
  assert.deepEqual(await store.complete(first.lease, 'reservation:result-1'), {
    kind: 'completed', resultRef: 'reservation:result-1',
  });
  assert.deepEqual(await store.complete(first.lease, 'reservation:other'), { kind: 'conflict' });

  // ioredis recovers the EVALSHA cache only for this definite no-execution
  // response; a lost connection is intentionally never replayed by us.
  await client.script('flush');
  assert.deepEqual(await store.readStatus(id), { kind: 'completed', resultRef: 'reservation:result-1' });
});

test('an expired Redis lease can be taken over, but the former owner cannot renew or complete', { skip: !process.env.REDIS_URL }, async (t) => {
  const { default: Redis } = await import('ioredis');
  const client = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
  });
  if (client.status !== 'ready') await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
  });
  const transport = new tx.RedisOperationTransport(client, {
    namespace: `tx-race-${randomUUID()}`,
    authorityId: 'redis-test-primary',
  });
  const store = new tx.RedisOperationStore(transport, { leaseMs: 30, retentionMs: 2_000 });
  const id = {
    tenant: 'acme', operation: 'ticket-reserve', idempotencyKey: randomUUID(),
    fingerprint: 'c'.repeat(64), durableId: `reservation-${randomUUID()}`,
  };
  t.after(async () => { await store.close(); client.disconnect(); });

  const former = await store.begin(id);
  assert.equal(former.kind, 'acquired');
  await sleep(60);
  const replacement = await store.begin(id);
  assert.equal(replacement.kind, 'acquired');
  assert.notEqual(replacement.lease.owner, former.lease.owner);
  assert.deepEqual(await store.renew(former.lease), { kind: 'lost' });
  assert.deepEqual(await store.complete(former.lease, 'old-result'), { kind: 'lost' });
  assert.deepEqual(await store.complete(replacement.lease, 'new-result'), {
    kind: 'completed', resultRef: 'new-result',
  });
});
