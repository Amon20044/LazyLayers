import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const configuredModule = process.env.LAZY_AUDIT_MODULE;
const moduleUrl = configuredModule
  ? configuredModule.startsWith('file:') ? configuredModule : pathToFileURL(configuredModule).href
  : new URL('../dist/index.js', import.meta.url).href;
const { ObservabilityCollector, createObservabilityHandler, resolveObservabilityOptions } = await import(moduleUrl);

function request() {
  const req = new EventEmitter();
  Object.assign(req, { method: 'GET', url: '/__lazylayers/stream', headers: {} });
  return req;
}

function response(backedUp = false) {
  const res = new EventEmitter();
  Object.assign(res, {
    writable: true,
    writableEnded: false,
    writableNeedDrain: false,
    destroyed: false,
    headersSent: false,
    statusCode: 0,
    writes: [],
    body: '',
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    write(chunk) {
      assert.ok(this.writes.length < 100, 'test response must remain bounded');
      this.writes.push(String(chunk));
      if (backedUp) { this.writableNeedDrain = true; return false; }
      return true;
    },
    end(body = '') { this.body = String(body); this.writableEnded = true; },
  });
  return res;
}

function handlerFor(collector, limits = {}) {
  return createObservabilityHandler({
    collector,
    inspector: {},
    options: resolveObservabilityOptions({ enabled: true, server: false, auth: { disabled: true }, ...limits }),
  });
}

test('SSE stops replay, live and heartbeat writes at backpressure and resumes on drain', { timeout: 2000 }, () => {
  const collector = new ObservabilityCollector(20);
  for (let i = 0; i < 20; i++) collector.handle({ type: 'hit', key: `before-${i}`, level: 'L1' });
  const req = request();
  const res = response(true);
  const originalSetInterval = globalThis.setInterval;
  let beat;
  globalThis.setInterval = (callback, delay, ...args) => {
    if (delay === 25_000) beat = callback;
    return originalSetInterval(callback, delay, ...args);
  };
  try {
    handlerFor(collector)(req, res);
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
  try {
    for (let i = 0; i < 20; i++) collector.handle({ type: 'hit', key: `blocked-${i}`, level: 'L1' });
    beat?.();
    assert.equal(res.writes.length, 1, 'one false write must stop all further writes until drain');
    res.writableNeedDrain = false;
    res.emit('drain');
    collector.handle({ type: 'hit', key: 'resumed', level: 'L1' });
    assert.equal(res.writes.length, 2);
    assert.match(res.writes[1], /resumed/);
  } finally {
    res.emit('close');
    req.emit('close');
  }
  const count = res.writes.length;
  collector.handle({ type: 'hit', key: 'after-close', level: 'L1' });
  beat?.();
  assert.equal(res.writes.length, count);
  assert.equal(res.listenerCount('drain'), 0);
  assert.equal(res.listenerCount('close'), 0);
  assert.equal(req.listenerCount('close'), 0);
});

test('SSE has a finite client budget and releases it exactly once on close', { timeout: 2000 }, () => {
  const collector = new ObservabilityCollector(4);
  const handler = handlerFor(collector, { maxStreamClients: 2 });
  const first = response();
  const second = response();
  const rejected = response();
  const next = response();
  const req1 = request();
  try {
    handler(req1, first);
    handler(request(), second);
    handler(request(), rejected);
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(rejected.statusCode, 503);
    assert.equal(rejected.writes.length, 0);
    first.emit('close');
    req1.emit('close');
    handler(request(), next);
    assert.equal(next.statusCode, 200, 'closed stream frees one slot');
    const fourth = response();
    try {
      handler(request(), fourth);
      assert.equal(fourth.statusCode, 503, 'duplicate cleanup must not free a second slot');
    } finally { fourth.emit('close'); }
  } finally {
    first.emit('close'); second.emit('close'); rejected.emit('close'); next.emit('close');
  }
});

test('collector bounds retained oversized keys and error messages while preserving counters', { timeout: 2000 }, () => {
  const collector = new ObservabilityCollector(4);
  const huge = 'x'.repeat(128 * 1024);
  collector.handle({ type: 'hit', key: huge, level: 'L1' });
  collector.handle({ type: 'loader:error', key: 'a', durationMs: 1, error: new Error(huge) });
  const events = collector.recentEvents();
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.ok(Buffer.byteLength(JSON.stringify(event)) <= 64 * 1024);
    assert.equal(event.data.truncated, true, 'metadata shedding must be visible');
    assert.ok(!JSON.stringify(event).includes(huge));
  }
  assert.equal(collector.overview().counters.hitsL1, 1);
  assert.equal(collector.overview().counters.loaderError, 1);
  assert.equal(collector.overview().totalEvents, 2);
});

test('SSE bounds each frame before serializing an oversized metadata string', { timeout: 2000 }, () => {
  const collector = new ObservabilityCollector(4);
  const handler = handlerFor(collector, { maxStreamEventBytes: 256 });
  const req = request();
  const res = response();
  const giant = 'z'.repeat(4096);
  collector.handle({ type: 'hit', key: giant, level: 'L1' });
  const originalStringify = JSON.stringify;
  let oversizedAttempts = 0;
  JSON.stringify = (value, ...args) => {
    if (value?.data?.key === giant) oversizedAttempts += 1;
    return originalStringify(value, ...args);
  };
  try {
    handler(req, res);
    assert.equal(oversizedAttempts, 0, 'oversized replay must be rejected before JSON allocation');
    collector.handle({ type: 'hit', key: 'small', level: 'L1' });
    assert.ok(res.writes.every((frame) => Buffer.byteLength(frame) <= 256));
    assert.match(res.writes.at(-1), /small/);
  } finally {
    JSON.stringify = originalStringify;
    res.emit('close'); req.emit('close');
  }
});

test('normal captured metadata is detached from mutable source references', { timeout: 2000 }, () => {
  const collector = new ObservabilityCollector(4);
  const levels = ['L1'];
  collector.handle({ type: 'set', key: 'small', levels });
  levels.push('L2');
  assert.deepEqual(collector.recentEvents()[0].data, { key: 'small', levels: ['L1'] });
});

test('new stream limits reject non-finite or non-positive settings', { timeout: 2000 }, () => {
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    for (const name of ['maxStreamClients', 'maxStreamEventBytes']) {
      assert.throws(() => resolveObservabilityOptions({ [name]: value }), RangeError);
    }
  }
  const defaults = resolveObservabilityOptions(true);
  assert.equal(defaults.maxStreamClients, 64);
  assert.equal(defaults.maxStreamEventBytes, 64 * 1024);
});
