import assert from 'node:assert/strict';
import { test } from 'node:test';

const { L2OperationGate, L2OperationOverloadError, L2OperationTimeoutError,
  CircuitBreaker, RedisPipelineCommandError, validateRedisPipeline,
  OriginLoadGate, OriginLoadClosedError } = await import('../dist/index.js');

test('pipeline validator preserves cause and redacts key context', () => {
  const cause = new Error('ERR simulated');
  assert.throws(() => validateRedisPipeline([[cause, undefined]], [{ command: 'SET', key: 'secret-value' }]), (error) => {
    assert.ok(error instanceof RedisPipelineCommandError);
    assert.equal(error.command, 'SET');
    assert.equal(error.index, 0);
    assert.equal(error.partialSuccess, true);
    assert.equal(error.cause, cause);
    assert.ok(error.keyDigest && !error.message.includes('secret-value'));
    return true;
  });
});

test('L2 gate bounds queued count and retained bytes', async () => {
  const gate = new L2OperationGate({ maxConcurrent: 1, maxQueued: 2, maxQueuedBytes: 3, queueTimeoutMs: 10_000, operationTimeoutMs: 1_000 });
  let release;
  const first = gate.run('first', () => new Promise((resolve) => { release = resolve; }));
  const queued = gate.run('second', () => Promise.resolve('ok'), 3);
  await assert.rejects(gate.run('third', () => Promise.resolve('no'), 1), L2OperationOverloadError);
  assert.equal(gate.stats().active, 1);
  release('done');
  await first;
  assert.equal(await queued, 'ok');
  assert.equal(gate.stats().active, 0);
  gate.close();
});

test('L2 timeout does not release active slot before underlying settles', async () => {
  const gate = new L2OperationGate({ maxConcurrent: 1, maxQueued: 0, queueTimeoutMs: 1, operationTimeoutMs: 5 });
  let release;
  const work = gate.run('slow', () => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(work, L2OperationTimeoutError);
  assert.equal(gate.stats().active, 1);
  release('done');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.stats().active, 0);
  gate.close();
});

test('half-open breaker admits one probe', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 0 });
  breaker.recordFailure();
  assert.equal(breaker.canCall(), true);
  assert.equal(breaker.canCall(), false);
  const epoch = breaker.currentEpoch;
  breaker.recordFailure(epoch);
  assert.equal(breaker.currentState, 'open');
  breaker.recordSuccess(epoch);
  assert.equal(breaker.currentState, 'open');
});

test('origin gate retains duplicate queued callers and releases permits idempotently', async () => {
  const gate = new OriginLoadGate({ maxConcurrent: 1, maxQueued: 2, queueTimeoutMs: 100 });
  const first = await gate.acquire('first');
  const second = gate.acquire('same');
  const third = gate.acquire('same');
  assert.equal(gate.stats().queued, 2);
  first(); first();
  (await second)();
  (await third)();
  assert.equal(gate.stats().active, 0);
  gate.close();
  await assert.rejects(gate.acquire('closed'), OriginLoadClosedError);
});
