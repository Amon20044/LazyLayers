import assert from 'node:assert/strict';
import test from 'node:test';
import { HybridCache, OriginLoadClosedError, OriginLoadOverloadError } from '../dist/index.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('origin gate bounds distinct misses when inflight tracking is disabled', async () => {
  const cache = new HybridCache({ l1: false, originLoad: { maxConcurrent: 2, maxQueued: 8, queueTimeoutMs: 500 }, inflight: { enabled: false } });
  let active = 0;
  let max = 0;
  const values = await Promise.all(Array.from({ length: 8 }, (_, i) => cache.getOrSet(`key-${i}`, async () => {
    active += 1; max = Math.max(max, active);
    await pause(10);
    active -= 1;
    return i;
  })));
  assert.deepEqual(values, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(max, 2);
  await cache.close();
});

test('queue timeout rejects with a typed overload and does not start a loader', async () => {
  const cache = new HybridCache({ l1: false, originLoad: { maxConcurrent: 1, maxQueued: 0, queueTimeoutMs: 5 }, inflight: { enabled: false } });
  let release;
  const first = cache.getOrSet('first', () => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(cache.getOrSet('second', async () => 'bad'), (error) => error instanceof OriginLoadOverloadError);
  release('ok');
  assert.equal(await first, 'ok');
  await cache.close();
});

test('close rejects queued origin work', async () => {
  const cache = new HybridCache({ l1: false, originLoad: { maxConcurrent: 1, maxQueued: 2, queueTimeoutMs: 1_000 }, inflight: { enabled: false } });
  const first = cache.getOrSet('first', () => new Promise((resolve) => setTimeout(() => resolve('first'), 20)));
  await pause(5);
  const queued = cache.getOrSet('second', () => Promise.resolve('bad'));
  await cache.close();
  await assert.rejects(queued, (error) => error instanceof OriginLoadClosedError);
  assert.equal(await first, 'first');
});

test('timed out caller still occupies the origin slot until ignored loader settles', async () => {
  const cache = new HybridCache({ l1: false, originLoad: { maxConcurrent: 1, maxQueued: 2, queueTimeoutMs: 100 }, timeouts: { hardMs: 5 }, inflight: { enabled: false } });
  let finish;
  const first = cache.getOrSet('first', () => new Promise((resolve) => { finish = resolve; }));
  await assert.rejects(first, /hard-timeout/);
  const second = cache.getOrSet('second', () => Promise.resolve('second'));
  await pause(25);
  assert.equal(await Promise.race([second, pause(5).then(() => 'still-waiting')]), 'still-waiting');
  finish('late');
  assert.equal(await second, 'second');
  await cache.close();
});
