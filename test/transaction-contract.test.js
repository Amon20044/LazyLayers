import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const tx = await import('../dist/transactions/index.js');

function identity(overrides = {}) {
  return {
    tenant: 'acme',
    operation: 'ticket-reserve',
    idempotencyKey: 'request-1',
    fingerprint: 'a'.repeat(64),
    durableId: 'reservation-1',
    ...overrides,
  };
}

class ScriptTransport {
  namespace = 'contract';
  calls = [];
  ready = true;
  result = null;

  canDispatch() { return this.ready; }

  async execute(key, args) {
    this.calls.push({ key, args });
    if (this.result) return this.result(args);
    const [command, , durableId, owner] = args;
    if (command === 'begin') return ['acquired', owner, '500', 'reconcile'];
    if (command === 'renew') return ['renewed', '500'];
    if (command === 'complete') return ['completed', args[6]];
    if (command === 'read') return ['missing'];
    throw new Error(`unexpected command ${command} for ${durableId}`);
  }
}

test('transaction source graph contains no L1/cache dependency', async () => {
  const root = new URL('../src/transactions/', import.meta.url);
  const files = [];
  async function visit(url) {
    for (const entry of await readdir(url, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, url);
      if (entry.isDirectory()) await visit(child);
      else if (entry.name.endsWith('.ts')) files.push(child);
    }
  }
  await visit(root);
  const source = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  const joined = source.join('\n');
  assert.doesNotMatch(joined, /(?:\.\/|\.\.\/).*cache|HybridCache|MemoryStore|CacheStore|getOrSet|staleFallback|eventBus/i);
});

test('store exposes explicit outcomes and does not require a local result cache', async () => {
  const transport = new ScriptTransport();
  const store = new tx.RedisOperationStore(transport, {
    namespace: 'contract',
    leaseMs: 500,
    retentionMs: 2_000,
    operationTimeoutMs: 250,
  });
  const id = identity();
  const acquired = await store.begin(id);
  assert.equal(acquired.kind, 'acquired');
  assert.equal(acquired.mustReconcile, true);
  assert.equal(acquired.lease.identity.durableId, id.durableId);
  assert.equal(transport.calls.length, 1);
  const completed = await store.complete(acquired.lease, 'reservation:reservation-1:held');
  assert.deepEqual(completed, { kind: 'completed', resultRef: 'reservation:reservation-1:held' });
  const status = await store.readStatus(id);
  assert.deepEqual(status, { kind: 'missing' });
  await store.close();
});

test('transport failure after dispatch is unknown, while an unready primary is unavailable', async () => {
  const transport = new ScriptTransport();
  transport.result = () => { throw new Error('ECONNRESET'); };
  const store = new tx.RedisOperationStore(transport, {
    namespace: 'contract',
    leaseMs: 100,
    retentionMs: 500,
    operationTimeoutMs: 250,
  });
  await assert.rejects(store.begin(identity()), (error) => error.code === 'OPERATION_UNKNOWN');
  assert.equal(transport.calls.length, 1);
  transport.ready = false;
  await assert.rejects(store.begin(identity({ idempotencyKey: 'request-2', durableId: 'reservation-2' })), (error) => error.code === 'OPERATION_UNAVAILABLE');
  assert.equal(transport.calls.length, 1, 'an unready primary must not dispatch');
  await store.close();
});

test('a command timeout after dispatch is unknown and does not free the gate early', async () => {
  const transport = new ScriptTransport();
  transport.execute = async (...args) => {
    transport.calls.push({ key: args[0], args: args[1] });
    return new Promise(() => undefined);
  };
  const store = new tx.RedisOperationStore(transport, {
    namespace: 'contract', leaseMs: 100, retentionMs: 500, operationTimeoutMs: 5,
    maxConcurrent: 1, maxQueued: 0,
  });
  await assert.rejects(store.begin(identity({ idempotencyKey: 'timeout-1' })), (error) => error.code === 'OPERATION_UNKNOWN');
  assert.equal(store.stats().active, 1, 'the underlying command still owns the active slot');
  await store.close();
});

test('canonical operation keys share a Redis Cluster hash tag per operation', () => {
  const first = tx.operationKey('contract', identity());
  const second = tx.operationKey('contract', identity({ operation: 'ticket-confirm' }));
  assert.match(first, /^lltx:v1:[0-9a-f]{64}:\{[0-9a-f]{64}\}:record$/);
  assert.notEqual(first, second);
  assert.equal(first.match(/\{([^}]+)\}/u)?.[1]?.length, 64);
});
