#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import Redis from 'ioredis';

// The owning service runner creates a new capped project and removes it in
// finally. This harness refuses ambient services and validates the Docker
// labels before every pause, unpause, stop, or start.
const project = process.env.LAZY_AUDIT_PROJECT ?? '';
if (!/^lazy-layers-audit-[a-f0-9]{8}$/.test(project)) throw new Error('Run scripts/audit-services.mjs chaos with its disposable project');
const redisUrl = new URL(process.env.REDIS_URL ?? '');
if (redisUrl.protocol !== 'redis:' || !['127.0.0.1', 'localhost'].includes(redisUrl.hostname)
  || !redisUrl.port || redisUrl.username || redisUrl.password) throw new Error('Only the minted loopback Redis is authorized');
const modulePath = process.env.LAZY_LAYERS_AUDIT_ENTRY ?? process.env.LAZY_AUDIT_MODULE;
const moduleUrl = modulePath ? (modulePath.startsWith('file:') ? modulePath : pathToFileURL(path.resolve(modulePath)).href) : new URL('../dist/index.js', import.meta.url).href;
const label = process.env.LAZY_AUDIT_LABEL ?? 'current';
const output = process.env.LAZY_AUDIT_CHAOS_OUTPUT ?? `audit/raw/chaos-${label}.json`;
const prefix = `audit:chaos:${randomUUID().slice(0, 8)}:`;
const quiet = { enabled: false };
const totalController = new AbortController();
const children = new Set();
const rows = [];
const cases = [];
let containerId;
let backendPort = redisUrl.port;
let backendAvailable = false;
let proxy;
let clientUrl = redisUrl.href;
const proxySockets = new Set();
const endpointChanges = [];
let peakRssBytes = process.memoryUsage().rss;
let infrastructureError;
let cacheModule;
const began = performance.now();
const totalTimer = setTimeout(() => totalController.abort(new Error('90 s total chaos budget')), 90000);
const memoryTimer = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  if (peakRssBytes > 384 * 1024 * 1024) totalController.abort(new Error('384 MiB harness RSS budget'));
}, 100);
const interrupt = () => totalController.abort(new Error('Interrupted'));
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);

function command(args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = ''; let stderr = ''; let failure;
    const timer = setTimeout(() => { failure = new Error('Docker command deadline'); child.kill('SIGKILL'); }, timeoutMs);
    const receive = (target, data) => {
      if (target === 'out') stdout += data; else stderr += data;
      if (stdout.length + stderr.length > 1024 * 1024) { failure = new Error('Docker output budget'); child.kill('SIGKILL'); }
    };
    child.stdout.on('data', (data) => receive('out', data)); child.stderr.on('data', (data) => receive('err', data));
    child.once('error', (error) => { clearTimeout(timer); children.delete(child); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer); children.delete(child);
      if (failure || code !== 0) reject(failure ?? new Error(`Docker ${args[0]} failed: ${stderr.slice(-400)}`));
      else resolve(stdout.trim());
    });
  });
}

async function inspectOwned(requirePort = false, allowPortChange = false) {
  assert.match(containerId, /^[a-f0-9]{12,64}$/);
  const [state] = JSON.parse(await command(['inspect', containerId]));
  const labels = state.Config?.Labels ?? {};
  assert.equal(labels['com.docker.compose.project'], project, 'Docker project must match the owner');
  assert.equal(labels['com.docker.compose.service'], 'redis', 'Only the owned Redis is a fault target');
  assert.equal(labels['lazy-layers.audit'], 'disposable', 'Explicit disposable label is required');
  assert.ok(state.HostConfig.Memory > 0 && state.HostConfig.Memory <= 128 * 1024 * 1024, 'Redis must have a hard memory cap');
  const bindings = state.NetworkSettings?.Ports?.['6379/tcp'] ?? [];
  if (requirePort || bindings.length) {
    assert.equal(bindings.length, 1, 'Only one loopback Redis port may be published');
    const binding = bindings[0];
    assert.equal(binding.HostIp, '127.0.0.1', 'The actual container mapping must remain loopback-only');
    assert.ok(Number.isInteger(Number(binding.HostPort)) && Number(binding.HostPort) > 0 && Number(binding.HostPort) <= 65535);
    if (allowPortChange) {
      if (backendPort !== binding.HostPort) endpointChanges.push({ previous: backendPort, next: binding.HostPort, reason: 'authorized start of exact label-validated disposable container' });
      backendPort = binding.HostPort;
    } else assert.equal(binding.HostPort, backendPort, 'Minted loopback port must match the owned container');
  }
  return state;
}

async function startProxy() {
  proxy = net.createServer((socket) => {
    if (!backendAvailable || proxySockets.size >= 64) { socket.destroy(); return; }
    // Forward only while an inspected owned mapping is current. Stopping the
    // container disables forwarding before its ephemeral host port is freed.
    const upstream = net.connect({ host: '127.0.0.1', port: Number(backendPort) });
    proxySockets.add(socket); proxySockets.add(upstream);
    const close = () => { socket.destroy(); upstream.destroy(); proxySockets.delete(socket); proxySockets.delete(upstream); };
    socket.on('error', close); upstream.on('error', close);
    socket.on('close', close); upstream.on('close', close);
    socket.pipe(upstream); upstream.pipe(socket);
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  clientUrl = `redis://127.0.0.1:${proxy.address().port}`;
  process.env.REDIS_URL = clientUrl;
  backendAvailable = true;
}

async function mutate(action) {
  assert.ok(['pause', 'unpause', 'stop', 'start'].includes(action));
  await inspectOwned();
  if (action === 'stop') { backendAvailable = false; for (const socket of proxySockets) socket.destroy(); }
  const args = action === 'stop' ? ['stop', '--time', '1', containerId] : [action, containerId];
  await command(args, action === 'stop' || action === 'start' ? 10000 : 5000);
  if (action === 'start') { await inspectOwned(true, true); backendAvailable = true; }
}

async function healRedis() {
  const state = await inspectOwned();
  if (state.State?.Paused) await mutate('unpause');
  if (!state.State?.Running) await mutate('start');
  await inspectOwned(true);
}

function add(name, priority, run, budgetMs = 6000) { cases.push({ name, priority, run, budgetMs }); }
function localBus() {
  let handler;
  return { published: [], async subscribe(fn) { handler = fn; }, async publish(event) { this.published.push(event); }, receive(event) { return handler(event); } };
}

function context(name, signal) {
  const caches = new Set(); const clients = new Set(); const cleanups = [];
  const measure = { instances: 1, payloadBytes: 'NOT MEASURED', concurrency: 1 };
  let serial = 0;
  return {
    signal, measure, caches, clients,
    own(cleanup) { cleanups.push(cleanup); },
    deferred() {
      let resolve; const promise = new Promise((yes) => { resolve = yes; });
      cleanups.push(() => resolve('cleanup')); return { promise, resolve };
    },
    async wait(ms) { signal.throwIfAborted(); await delay(ms, undefined, { signal }); },
    async redis(options = {}) {
      signal.throwIfAborted();
      const client = new Redis(clientUrl, { lazyConnect: true, connectTimeout: 1000, commandTimeout: 250, maxRetriesPerRequest: 1, enableOfflineQueue: false, autoResendUnfulfilledCommands: false, autoResubscribe: false, retryStrategy: (times) => times <= 30 ? Math.min(times * 20, 100) : null, ...options });
      client.on('error', () => {}); clients.add(client);
      await client.connect(); await client.ping(); return client;
    },
    store(client, suffix = String(++serial), options = {}) {
      return new cacheModule.RedisStore(client, { prefix: `${prefix}${name}:${suffix}:`, useIndex: false, keyLayout: 'v2', ...options });
    },
    cache(options = {}) {
      const cache = new cacheModule.HybridCache({ logging: quiet, failSafe: { enabled: false }, ttlMs: 2000, timeouts: { hardMs: 2000 }, distributedLock: { ttlMs: 1000, waitTimeoutMs: 1500, pollMs: 5 }, ...options });
      caches.add(cache); return cache;
    },
    async ping(client, limitMs = 3000) {
      const deadline = performance.now() + limitMs;
      while (performance.now() < deadline) {
        signal.throwIfAborted();
        if (client.status === 'end' || client.status === 'wait') await client.connect().catch(() => {});
        try { if (await client.ping() === 'PONG') return; } catch {}
        await delay(25, undefined, { signal });
      }
      throw new Error('Redis recovery ping deadline');
    },
    async cleanup() {
      for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch {} }
      await Promise.allSettled([...caches].map((cache) => cache.close()));
      for (const client of clients) client.disconnect();
    },
  };
}

// An actual independently scheduled worker lets SIGSTOP stall its event loop
// beyond the Redis lease, and SIGKILL removes a leader mid-refresh.
function worker(ctx, storePrefix, ttlMs) {
  const source = `
    import Redis from 'ioredis';
    const { HybridCache, RedisStore } = await import(process.env.LAZY_AUDIT_WORKER_MODULE);
    const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, autoResendUnfulfilledCommands: false, commandTimeout: 300, connectTimeout: 1000 });
    redis.on('error', () => {});
    const store = new RedisStore(redis, { prefix: process.env.LAZY_AUDIT_WORKER_PREFIX, keyLayout: 'v2', useIndex: false });
    const cache = new HybridCache({ l2: store, logging: {enabled:false}, failSafe: {enabled:false}, timeouts: {hardMs:2000}, distributedLock: {ttlMs:Number(process.env.LAZY_AUDIT_WORKER_TTL),waitTimeoutMs:1000,pollMs:5} });
    let finish; const completion = new Promise(resolve => {finish=resolve});
    process.on('message', message => {if(message?.finish) finish('obsolete')});
    try { const value=await cache.getOrSet('row',async()=>{process.send({stage:'loading'});return completion});process.send({stage:'done',value}); }
    catch(error){process.send({stage:'done',error:error.name});}
    finally{await cache.close();redis.disconnect();process.disconnect();}
  `;
  const child = spawn(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', source], { env: { ...process.env, LAZY_AUDIT_WORKER_MODULE: moduleUrl, LAZY_AUDIT_WORKER_PREFIX: storePrefix, LAZY_AUDIT_WORKER_TTL: String(ttlMs) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.add(child);
  let stderr = ''; child.stderr.on('data', (data) => { stderr += data; if (stderr.length > 64 * 1024) child.kill('SIGKILL'); });
  const received = new Map(); const pending = new Map();
  child.on('message', (message) => { received.set(message.stage, message); pending.get(message.stage)?.resolve(message); });
  child.once('exit', (code) => { children.delete(child); for (const [stage, waiter] of pending) if (!received.has(stage)) waiter.reject(new Error(`Owned worker exited ${code}: ${stderr.slice(-300)}`)); });
  ctx.own(() => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGCONT'); child.kill('SIGKILL'); } });
  return {
    child,
    async stage(stage) {
      if (received.has(stage)) return received.get(stage);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(stage); reject(new Error(`Worker ${stage} deadline`)); }, 4000);
        pending.set(stage, { resolve: (value) => { clearTimeout(timer); pending.delete(stage); resolve(value); }, reject: (error) => { clearTimeout(timer); pending.delete(stage); reject(error); } });
      });
    },
  };
}

add('real-lease-expiry-stale-publication', 'control', async (ctx) => {
  const store = ctx.store(await ctx.redis());
  assert.equal(await store.acquireLock('row', 'A', 60), true);
  await ctx.wait(110);
  assert.equal(await store.acquireLock('row', 'B', 1000), true, 'The lease must actually expire');
  assert.equal(await store.publishIfOwner('row', 'B', cacheModule.serialize('winner'), 1000), 'published');
  ctx.measure.oldPublication = await store.publishIfOwner('row', 'A', cacheModule.serialize('obsolete'), 1000);
  assert.equal(ctx.measure.oldPublication, 'not-owner');
  assert.equal(await store.get('row'), 'winner');
  Object.assign(ctx.measure, { instances: 2, leaseTtlMs: 60, originLoads: 0 });
});

add('frozen-process-past-lease-expiry', 'control', async (ctx) => {
  const storePrefix = `${prefix}frozen-worker:`;
  const store = ctx.store(await ctx.redis(), 'worker', { prefix: storePrefix });
  const leader = worker(ctx, storePrefix, 120);
  await leader.stage('loading');
  assert.equal(leader.child.kill('SIGSTOP'), true);
  const frozenAt = performance.now();
  await ctx.wait(220);
  assert.equal(await store.acquireLock('row', 'replacement', 1000), true);
  assert.equal(await store.publishIfOwner('row', 'replacement', cacheModule.serialize('winner'), 1000), 'published');
  leader.child.kill('SIGCONT'); leader.child.send({ finish: true });
  ctx.measure.oldOutcome = await leader.stage('done');
  ctx.measure.frozenMs = performance.now() - frozenAt;
  assert.equal(await store.get('row'), 'winner');
  Object.assign(ctx.measure, { instances: 2, independentProcesses: 2, leaseTtlMs: 120 });
}, 8000);

add('leader-process-killed-mid-refresh', 'control', async (ctx) => {
  const storePrefix = `${prefix}killed-worker:`;
  const store = ctx.store(await ctx.redis(), 'worker', { prefix: storePrefix });
  const leader = worker(ctx, storePrefix, 120);
  await leader.stage('loading');
  const killedAt = performance.now();
  assert.equal(leader.child.kill('SIGKILL'), true);
  await ctx.wait(180);
  const replacement = ctx.cache({ l2: store });
  assert.equal(await replacement.getOrSet('row', async () => 'replacement'), 'replacement');
  assert.equal(await store.get('row'), 'replacement');
  Object.assign(ctx.measure, { instances: 2, independentProcesses: 2, faultRecoveryMs: performance.now() - killedAt, leaseTtlMs: 120, originLoads: 1 });
}, 8000);

add('lease-only-pattern-invalidation', 'P0', async (ctx) => {
  const store = ctx.store(await ctx.redis());
  assert.equal(await store.acquireLock('cold:row', 'old-fill', 1000), true);
  await store.deleteByPattern('cold:*');
  ctx.measure.oldPublication = await store.publishIfOwner('cold:row', 'old-fill', cacheModule.serialize('obsolete'), 1000);
  assert.equal(ctx.measure.oldPublication, 'not-owner');
  assert.equal(await store.get('cold:row'), undefined);
});

add('redis-stopped-during-acquisition-safe-fallback', 'P0', async (ctx) => {
  Object.assign(ctx.measure, { instances: 2, originLoads: 2, networkFault: 'owned Redis stop before lock dispatch' });
  const client = await ctx.redis();
  const store = ctx.store(client);
  const nativeAcquire = store.acquireLock.bind(store);
  const started = ctx.deferred(); const finish = ctx.deferred(); const events = localBus();
  const oldCache = ctx.cache({ l2: store, eventBus: events, resilience: { l2CircuitBreaker: { cooldownMs: 100 } } }); await oldCache.ready();
  ctx.measure.configuredL2BreakerCooldownMs = 100;
  store.acquireLock = async (...args) => { await mutate('stop'); return nativeAcquire(...args); };
  const old = oldCache.getOrSet('row', async () => { started.resolve(); return finish.promise; }).then((value) => ({ value }), (error) => ({ error: error.name }));
  await started.promise;
  const recoveryAt = performance.now(); await mutate('start'); await ctx.ping(client);
  ctx.measure.faultRecoveryMs = performance.now() - recoveryAt;
  const winnerStore = ctx.store(await ctx.redis(), 'winner', { prefix: store.prefix });
  const winner = ctx.cache({ l2: winnerStore });
  assert.equal(await winner.getOrSet('row', async () => 'winner'), 'winner');
  finish.resolve('obsolete'); ctx.measure.oldOutcome = await old;
  assert.equal(ctx.measure.oldOutcome.value, 'obsolete', 'Fail-open keeps the existing caller value');
  assert.equal(await store.get('row'), 'winner', 'Unleased fallback cannot overwrite protected state');
  const cacheRecoveryAt = performance.now(); let recovered;
  while (performance.now() - cacheRecoveryAt < 800) {
    recovered = await oldCache.get('row');
    if (recovered !== undefined) break;
    await ctx.wait(20);
  }
  ctx.measure.cacheReadRecoveryMs = performance.now() - cacheRecoveryAt;
  assert.equal(recovered, 'winner', 'A bounded half-open probe must recover reads from protected L2');
  assert.equal(events.published.filter((event) => event.type === 'set').length, 0);
}, 12000);

add('redis-paused-during-publication-unknown-outcome', 'control', async (ctx) => {
  const store = ctx.store(await ctx.redis()); const events = localBus();
  const nativePublish = store.publishIfOwner.bind(store); let publications = 0;
  store.publishIfOwner = async (...args) => {
    publications++; await mutate('pause');
    try { return await nativePublish(...args); }
    finally { await mutate('unpause'); }
  };
  const cache = ctx.cache({ l2: store, eventBus: events }); await cache.ready();
  ctx.measure.callerOutcome = await cache.getOrSet('row', async () => 'uncertain').then((value) => ({ value }), (error) => ({ error: error.name }));
  assert.equal(publications, 1, 'A timed-out publication must not be blindly replayed');
  assert.equal(events.published.filter((event) => event.type === 'set').length, 0);
  assert.equal(await cache.l1.get('row'), undefined, 'An uncertain commit must not prime L1');
  await store.set('row', 'winner');
  assert.equal(await cache.get('row'), 'winner');
  Object.assign(ctx.measure, { publicationAttempts: publications, commandDeadlineMs: 250, networkFault: 'paused owned Redis while command is dispatched; commit outcome deliberately unknown' });
}, 12000);

add('redis-restart-rejects-previous-lease', 'control', async (ctx) => {
  const client = await ctx.redis(); const store = ctx.store(client);
  assert.equal(await store.acquireLock('row', 'pre-restart', 1000), true);
  await mutate('stop'); const recoveryAt = performance.now(); await mutate('start'); await ctx.ping(client);
  ctx.measure.faultRecoveryMs = performance.now() - recoveryAt;
  assert.equal(await store.publishIfOwner('row', 'pre-restart', cacheModule.serialize('obsolete'), 1000), 'not-owner');
  assert.equal(await store.acquireLock('row', 'post-restart', 1000), true);
  assert.equal(await store.publishIfOwner('row', 'post-restart', cacheModule.serialize('winner'), 1000), 'published');
  assert.equal(await store.get('row'), 'winner');
  ctx.measure.persistence = 'isolated Redis has RDB and AOF disabled; restart is not failover';
}, 10000);

add('redis-nested-and-literal-prefix-isolation', 'P0', async (ctx) => {
  ctx.measure.instances = 3;
  const client = await ctx.redis();
  const parent = ctx.store(client, 'parent', { prefix: `${prefix}tenant[?]:` });
  const nested = ctx.store(client, 'nested', { prefix: `${prefix}tenant[?]:child:` });
  const other = ctx.store(client, 'other', { prefix: `${prefix}tenantX:child:` });
  await parent.set('child:row', 'parent'); await nested.set('row', 'nested'); await other.set('row', 'other');
  await parent.clear();
  const literal = {
    nestedPreserved: (await nested.get('row')) === 'nested',
    foreignPreserved: (await other.get('row')) === 'other',
    ownRemoved: (await parent.get('child:row')) === undefined,
  };
  const plainParent = ctx.store(client, 'plain-parent', { prefix: `${prefix}plain:` });
  const plainNested = ctx.store(client, 'plain-nested', { prefix: `${prefix}plain:child:` });
  await plainParent.set('child:row', 'parent'); await plainNested.set('row', 'nested');
  await plainParent.clear();
  const plain = { nestedPreserved: (await plainNested.get('row')) === 'nested', ownRemoved: (await plainParent.get('child:row')) === undefined };
  Object.assign(ctx.measure, { literalPrefix: literal, plainPrefix: plain, topology: 'one process/client; three namespace stores in literal-prefix subcase, two in plain-prefix subcase' });
  assert.equal(plain.nestedPreserved, true, 'Parent clear must preserve a nested tenant namespace');
  assert.equal(plain.ownRemoved, true);
  assert.equal(literal.nestedPreserved, true); assert.equal(literal.foreignPreserved, true); assert.equal(literal.ownRemoved, true);
  ctx.measure.instances = 3;
});

add('redis-malformed-unicode-key-identity', 'P1', async (ctx) => {
  const store = ctx.store(await ctx.redis());
  await store.set('\ud800', 'first'); await store.set('\ud801', 'second');
  assert.equal(await store.get('\ud800'), 'first'); assert.equal(await store.get('\ud801'), 'second');
  await store.set('☃:valid', 'valid'); assert.equal(await store.get('☃:valid'), 'valid');
});

add('shared-pubsub-channel-tenant-isolation', 'P0', async (ctx) => {
  ctx.measure.instances = 2;
  const aClient = await ctx.redis(); const bClient = await ctx.redis();
  const channel = `${prefix}shared-channel`;
  const aBus = new cacheModule.RedisEventBus(aClient, channel, { logging: quiet });
  const bBus = new cacheModule.RedisEventBus(bClient, channel, { logging: quiet });
  ctx.own(() => aBus.disconnect()); ctx.own(() => bBus.disconnect());
  await Promise.all([aBus.connect(), bBus.connect()]);
  const a = ctx.cache({ l2: ctx.store(aClient, 'tenant-a'), eventBus: aBus, eventNamespace: 'tenant-a' });
  const b = ctx.cache({ l2: ctx.store(bClient, 'tenant-b'), eventBus: bBus, eventNamespace: 'tenant-b' });
  await Promise.all([a.ready(), b.ready()]);
  assert.equal(await a.getOrSet('row', async () => 'tenant-a-value'), 'tenant-a-value');
  await ctx.wait(75);
  assert.equal(await b.get('row'), undefined, 'Shared transport must not expose another scope payload');
  ctx.measure.instances = 2;
});

add('pubsub-disconnect-missed-event-reconciliation', 'control', async (ctx) => {
  const aClient = await ctx.redis(); const bClient = await ctx.redis(); const channel = `${prefix}gap-channel`;
  const aBus = new cacheModule.RedisEventBus(aClient, channel, { logging: quiet });
  const bBus = new cacheModule.RedisEventBus(bClient, channel, { logging: quiet });
  ctx.own(() => aBus.disconnect()); ctx.own(() => bBus.disconnect());
  await Promise.all([aBus.connect(), bBus.connect()]);
  const storePrefix = `${prefix}gap-data:`;
  const a = ctx.cache({ l2: ctx.store(aClient, 'a', { prefix: storePrefix }), eventBus: aBus, eventNamespace: 'gap' });
  const b = ctx.cache({ l2: ctx.store(bClient, 'b', { prefix: storePrefix }), eventBus: bBus, eventNamespace: 'gap' });
  await Promise.all([a.ready(), b.ready()]); await a.set('row', 'before-gap');
  assert.equal(await b.get('row'), 'before-gap');
  bBus.sub.disconnect(); await ctx.wait(25);
  await a.set('row', 'during-gap');
  assert.equal(await b.get('row'), 'during-gap', 'Untrusted local state must not hide current L2');
  const recoveryAt = performance.now(); await bBus.sub.connect();
  const deadline = performance.now() + 1500;
  const trusted = () => typeof b.isInvalidationTrusted === 'function' ? b.isInvalidationTrusted() : b.invalidationTrusted;
  while (!trusted() && performance.now() < deadline) await ctx.wait(10);
  ctx.measure.trustRecovered = trusted();
  assert.equal(ctx.measure.trustRecovered, true, 'Reconciliation must restore trust, not permanently bypass L1');
  await a.set('row', 'after-gap'); await ctx.wait(50);
  assert.equal(await b.get('row'), 'after-gap');
  Object.assign(ctx.measure, { instances: 2, faultRecoveryMs: performance.now() - recoveryAt, missedEvents: 1, delivery: 'ordinary non-durable Redis Pub/Sub' });
});

add('bounded-origin-overload-and-recovery', 'control', async (ctx) => {
  const cache = ctx.cache({ originLoad: { maxConcurrent: 2, maxQueued: 4, queueTimeoutMs: 1000 } });
  const finish = ctx.deferred(); let originLoads = 0; let active = 0; let peak = 0;
  const requests = Array.from({ length: 32 }, (_, key) => cache.getOrSet(`key:${key}`, async () => {
    originLoads++; peak = Math.max(peak, ++active); await finish.promise; active--; return `value:${key}`;
  }).then((value) => ({ value }), (error) => ({ error: error.name })));
  await ctx.wait(25);
  const saturated = cache.getOriginLoadStats(); assert.ok(saturated.active <= 2 && saturated.queued <= 4);
  const recoveryAt = performance.now(); finish.resolve(); const outcomes = await Promise.all(requests);
  assert.ok(peak <= 2); assert.equal(originLoads, 6); assert.equal(outcomes.filter((outcome) => outcome.error).length, 26);
  assert.equal(await cache.getOrSet('recovery', async () => 'healthy'), 'healthy');
  assert.equal(cache.getOriginLoadStats().active, 0); assert.equal(cache.getOriginLoadStats().queued, 0);
  Object.assign(ctx.measure, { concurrency: 32, originLoads, originPeakConcurrent: peak, rejected: 26, saturated, faultRecoveryMs: performance.now() - recoveryAt, origin: 'controlled in-process read-only mock, no external database' });
});

add('shutdown-suppresses-late-fill', 'P1', async (ctx) => {
  const store = ctx.store(await ctx.redis()); const cache = ctx.cache({ l2: store });
  const finish = ctx.deferred(); const started = ctx.deferred(); let signal;
  const value = cache.getOrSet('row', async (context) => { signal = context.signal; started.resolve(); return finish.promise; });
  await started.promise; await cache.close(); finish.resolve('late');
  assert.equal(await value, 'late', 'An already active ignoring-abort loader keeps its caller result');
  ctx.measure.signalAborted = signal.aborted;
  const latePublished = await store.get('row');
  ctx.measure.latePublishedValue = latePublished === undefined ? 'ABSENT' : latePublished;
  assert.equal(signal.aborted, true); assert.equal(latePublished, undefined);
});

add('corrupt-record-and-pretransfer-size-limits', 'P1', async (ctx) => {
  const client = await ctx.redis(); const store = ctx.store(client, 'limited', { decodeLimits: { maxEncodedBytes: 1024, maxDecodedBytes: 1024 } });
  await store.setEncoded('corrupt', Buffer.from('HC1!not-a-record'));
  const corrupt = await store.get('corrupt');
  ctx.measure.corruptRecordOutcome = corrupt === undefined ? 'MISS' : corrupt === null ? 'NULL_HIT' : 'OTHER_HIT';
  const oversized = cacheModule.serialize('x'.repeat(8192), { compression: 'none' });
  await store.setEncoded('large', oversized);
  const stream = client.connector?.stream;
  const receivedBefore = stream?.bytesRead;
  ctx.measure.largeRecordMiss = (await store.getEncoded('large')) === undefined;
  ctx.measure.receivedBytes = typeof receivedBefore === 'number' ? stream.bytesRead - receivedBefore : 'NOT MEASURED';
  ctx.measure.payloadBytes = oversized.byteLength;
  const page = await store.inspect({ includeValues: true, maxValueBytes: 512, limit: 8 });
  ctx.measure.previewValuesOmitted = page.keys.every((entry) => entry.value === undefined);
  assert.equal(corrupt, undefined);
  assert.equal(ctx.measure.largeRecordMiss, true, 'Oversized values must be rejected before transferring their full body');
  assert.equal(ctx.measure.previewValuesOmitted, true);
});

add('distributed-coalescing-simulated-instance-matrix', 'control', async (ctx) => {
  const client = await ctx.redis(); const matrix = [];
  for (const instances of [2, 10, 50, 100]) {
    ctx.signal.throwIfAborted();
    const storePrefix = `${prefix}matrix:${instances}:`;
    const caches = Array.from({ length: instances }, () => ctx.cache({ l1: false, l2: ctx.store(client, 'matrix', { prefix: storePrefix }) }));
    let originLoads = 0;
    const result = await Promise.all(caches.flatMap((cache) => Array.from({ length: 2 }, () => cache.getOrSet('row', async () => { originLoads++; await ctx.wait(25); return 'shared'; }))));
    assert.equal(originLoads, 1); assert.ok(result.every((value) => value === 'shared'));
    matrix.push({ instances, concurrentRequests: instances * 2, originLoads, originAmplification: originLoads, idealMissEpisodes: 1 });
    await Promise.all(caches.map((cache) => cache.close()));
  }
  Object.assign(ctx.measure, { instances: 100, concurrency: 200, matrix, topology: 'independent HybridCache objects in one process sharing a Redis connection; simulated instance counts, not 100 physical workers' });
}, 10000);

try {
  containerId = await command(['compose', '--project-name', project, '--file', 'audit/compose.yml', 'ps', '--all', '--quiet', 'redis']);
  await inspectOwned(true);
  await startProxy();
  cacheModule = await import(moduleUrl);
  for (const entry of cases) {
    if (totalController.signal.aborted) {
      rows.push({ name: entry.name, priority: entry.priority, status: 'NOT MEASURED', reason: totalController.signal.reason.message }); continue;
    }
    const controller = new AbortController();
    const abort = () => controller.abort(totalController.signal.reason);
    totalController.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`${entry.budgetMs} ms case deadline`)), entry.budgetMs);
    const ctx = context(entry.name, controller.signal); const startedAt = performance.now();
    let status = 'PASS'; let error;
    let abortListener;
    const timedOut = new Promise((_, reject) => {
      abortListener = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    try { await Promise.race([entry.run(ctx), timedOut]); }
    catch (failure) { status = 'FAIL'; error = { name: failure.name, message: failure.message }; }
    finally {
      clearTimeout(timer); totalController.signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', abortListener);
      await ctx.cleanup();
      try { await healRedis(); } catch (failure) { status = 'FAIL'; error = { name: failure.name, message: `Automatic fault cleanup: ${failure.message}` }; totalController.abort(failure); }
    }
    rows.push({ name: entry.name, priority: entry.priority, status, elapsedMs: performance.now() - startedAt, budgetMs: entry.budgetMs, ...ctx.measure, ...(error ? { error } : {}) });
    console.log(`${status} ${entry.name} (${rows.at(-1).elapsedMs.toFixed(1)} ms)`);
    if (controller.signal.aborted) totalController.abort(controller.signal.reason);
  }
} catch (error) {
  infrastructureError = { name: error.name, message: error.message };
} finally {
  clearTimeout(totalTimer); clearInterval(memoryTimer);
  for (const child of children) { child.kill('SIGCONT'); child.kill('SIGKILL'); }
  if (containerId) { try { await healRedis(); } catch (error) { infrastructureError ??= { name: error.name, message: `Final Redis cleanup: ${error.message}` }; } }
  for (const socket of proxySockets) socket.destroy();
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  const failed = rows.filter((row) => row.status === 'FAIL').length;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ metadata: { generatedAt: new Date().toISOString(), label, module: moduleUrl, project, redisContainer: containerId, initialDockerRedisEndpoint: redisUrl.host, stableOwnedProxyEndpoint: new URL(clientUrl).host, endpointChanges, node: process.version, os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, elapsedMs: performance.now() - began, peakSampledHarnessRssBytes: peakRssBytes, budgets: { totalMs: 90000, perCaseMs: '6000–12000', harnessRssMiB: 384, childHeapMiB: 64, ownedRedisMemoryMiB: 96, redisCommandDeadlineMs: 250, maximumConcurrentRequests: 200, maximumProxySockets: 64 }, faultTarget: 'label-validated disposable Redis through an owned bounded loopback proxy; owned child processes only', latencyMeasurement: 'fault recovery from planned fault/release to verified ping or cache response; no throughput claim, no production traffic' }, rows, failed, infrastructureError: infrastructureError ?? null, notMeasured: ['Redis replication failover or Cluster resharding', 'packet loss, DNS failures, CPU throttling, database pool exhaustion', 'physical 10/50/100-worker clusters; matrix counts are simulated', 'long-duration leak/fault endurance and external database fencing'] }, null, 2) + '\n');
  console.log(`Chaos raw results: ${output}; ${failed} failed cases.`);
  if (failed || infrastructureError || rows.some((row) => row.status === 'NOT MEASURED')) process.exitCode = 1;
}
