import http from 'node:http';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'production';
const role = process.env.LAZY_AUDIT_ROLE;
process.on('disconnect', () => process.exit(1));
const moduleUrl = process.env.LAZY_AUDIT_MODULE ?? new URL('../dist/index.js', import.meta.url).href;
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? null;
};
const quantiles = (values) => ({ p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99), p999: percentile(values, .999) });
const cpuMs = (start) => { const cpu = process.cpuUsage(start); return (cpu.user + cpu.system) / 1000; };
const pauses = [];
const observer = new PerformanceObserver((list) => { for (const item of list.getEntries()) pauses.push(item.duration); });
observer.observe({ entryTypes: ['gc'] });
let snapshotCpu = process.cpuUsage();
let peakRss = process.memoryUsage().rss;
const memoryTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
memoryTimer.unref();
function resetRuntime() { snapshotCpu = process.cpuUsage(); peakRss = process.memoryUsage().rss; pauses.length = 0; }
function runtime() { return { cpuMs: cpuMs(snapshotCpu), peakSampledRssBytes: peakRss, processLifetimeMaxRssBytes: process.resourceUsage().maxRSS * 1024, memory: process.memoryUsage(), gc: { count: pauses.length, totalMs: pauses.reduce((sum, value) => sum + value, 0), maxMs: Math.max(0, ...pauses) } }; }
function reply(res, status, value) { const body = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }); res.end(body); }
function controlled(methods) {
  process.on('message', async (message) => {
    if (!message?.id) return;
    try { const value = await methods[message.method](message.args); process.send?.({ id: message.id, value }); }
    catch (error) { process.send?.({ id: message.id, error: { name: error.name, message: `${error.message}${error.cause ? ` (${error.cause.code ?? ''}: ${error.cause.message})` : ''}` } }); }
  });
}
async function listen(server) {
  // Node 24's agent subtracts a 1-second safety margin from the advertised
  // timeout. Advertising only one second disables reuse and churns TCP ports.
  server.requestTimeout = 2000; server.headersTimeout = 2000; server.keepAliveTimeout = 5000;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.send?.({ ready: true, port: server.address().port });
}
async function closeServer(server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }

if (role === 'origin') {
  let config = { latencyMs: 5, maxConcurrent: 64, fail: false, version: 1, payloadBytes: 1024 };
  let stats = { requests: 0, accepted: 0, rejected: 0, completed: 0, active: 0, maxActive: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const key = url.searchParams.get('key') ?? '';
    stats.requests++;
    if (config.fail || stats.active >= config.maxConcurrent) { stats.rejected++; reply(res, 503, { error: 'controlled origin saturation' }); return; }
    stats.accepted++; stats.active++; stats.maxActive = Math.max(stats.maxActive, stats.active);
    const selected = { ...config };
    try { await tick(selected.latencyMs); if (!res.destroyed) { stats.completed++; reply(res, 200, { key, version: selected.version, payload: '0123456789abcdef'.repeat(Math.ceil(selected.payloadBytes / 16)).slice(0, selected.payloadBytes) }); } }
    finally { stats.active--; }
  });
  controlled({
    configure(value) { if (stats.active) throw new Error('origin still active'); config = { ...config, ...value }; return config; },
    reset() { if (stats.active) throw new Error('origin still active'); stats = { requests: 0, accepted: 0, rejected: 0, completed: 0, active: 0, maxActive: 0 }; resetRuntime(); return true; },
    stats() { return { ...stats, runtime: runtime(), config }; },
    async close() { await closeServer(server); observer.disconnect(); clearInterval(memoryTimer); setImmediate(() => process.exit(0)); return true; },
  });
  await listen(server);
} else if (role === 'worker') {
  const mod = await import(moduleUrl.startsWith('file:') ? moduleUrl : pathToFileURL(moduleUrl).href);
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 1000, commandTimeout: 1000, retryStrategy: () => null });
  redis.on('error', () => {}); await redis.connect();
  let commands = 0;
  const send = redis.sendCommand.bind(redis);
  redis.sendCommand = (...args) => { commands++; return send(...args); };
  let cache; let store; let configuration;
  let events = {}; let requests = 0; let errors = 0; let maxActive = 0; let maxQueued = 0; let maxQueuedBytes = 0; let maxWaiters = 0;
  const queueTimer = setInterval(() => {
    if (!cache) return;
    const origin = cache.getOriginLoadStats(); const l2 = cache.getL2OperationStats?.();
    maxActive = Math.max(maxActive, origin.active); maxQueued = Math.max(maxQueued, origin.queued);
    maxQueuedBytes = Math.max(maxQueuedBytes, l2?.queuedBytes ?? 0);
    maxWaiters = Math.max(maxWaiters, cache.getCoordinationStats?.().inflightEntries ?? 0);
  }, 10); queueTimer.unref();
  const originAgent = new http.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 16 });
  function loader(key, context) {
    return new Promise((resolve, reject) => {
      const req = http.get(`${process.env.LAZY_AUDIT_ORIGIN}/value?key=${encodeURIComponent(key)}`, { agent: originAgent, signal: context?.signal }, (res) => {
        const chunks = []; let bytes = 0;
        res.on('data', (chunk) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) req.destroy(new Error('origin response byte budget')); else chunks.push(chunk); });
        res.on('end', () => { if (res.statusCode !== 200) { reject(new Error(`Origin HTTP ${res.statusCode}`)); return; } try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); } });
        res.on('error', reject);
      });
      req.setTimeout(1000, () => req.destroy(new Error('origin request deadline')));
      req.on('error', reject);
    });
  }
  async function configure(value) {
    if (cache) { await cache.close(); await store.clear(); }
    configuration = value;
    const common = { ttlMs: value.ttlMs ?? 60_000, levels: { L1: { maxEntries: 4096, admission: { enabled: false }, codec: { compression: value.compression ?? 'none' } }, L2: { codec: { compression: value.compression ?? 'none' } } }, failSafe: { enabled: value.stale ?? false, staleTtlMs: 5000 }, logging: { enabled: false } };
    store = new mod.RedisStore(redis, { ...common, prefix: value.prefix, keyLayout: 'v2' });
    cache = new mod.HybridCache({ ...common, source: process.env.LAZY_AUDIT_WORKER_ID, l1: value.l1 === false ? false : undefined, l2: store, memoryBudget: new mod.MemoryBudget({ maxMemory: '64MiB', sampleIntervalMs: 0 }), inflight: { enabled: value.singleflight !== false }, originLoad: { maxConcurrent: value.originConcurrent ?? 8, maxQueued: value.originQueued ?? 32, queueTimeoutMs: 150 }, timeouts: { hardMs: 750 }, distributedLock: { enabled: value.lease !== false, redis, ttlMs: 1200, waitTimeoutMs: 1600, pollMs: 10 } });
    cache.on((event) => { const label = event.level ? `${event.type}:${event.level}` : event.type; events[label] = (events[label] ?? 0) + 1; });
    await cache.ready();
    return true;
  }
  function reset() { commands = 0; events = {}; requests = 0; errors = 0; maxActive = 0; maxQueued = 0; maxQueuedBytes = 0; maxWaiters = 0; resetRuntime(); return true; }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'); const key = url.searchParams.get('key') ?? '';
    requests++;
    if (url.pathname === '/noop') { reply(res, 200, { key, version: 1, payload: 'x'.repeat(1024) }); return; }
    try { const value = await cache.getOrSet(key, (context) => loader(key, context)); reply(res, 200, value); }
    catch (error) { errors++; reply(res, 503, { error: error.name, code: error.code }); }
  });
  controlled({ configure, reset,
    async warm({ keys }) { for (const key of keys) await cache.getOrSet(key, (context) => loader(key, context)); return true; },
    stats() { return { worker: process.env.LAZY_AUDIT_WORKER_ID, requests, errors, redisCommands: commands, events, origin: cache?.getOriginLoadStats(), l2: cache?.getL2OperationStats?.(), memoryLedger: cache?.getMemoryStats(), coordination: cache?.getCoordinationStats?.(), maxActiveRefreshes: maxActive, maxQueuedOrigin: maxQueued, maxQueuedL2Bytes: maxQueuedBytes, maxInflightKeys: maxWaiters, runtime: runtime(), configuration }; },
    async close() { clearInterval(queueTimer); await closeServer(server); if (cache) { await cache.close(); await store.clear(); } originAgent.destroy(); redis.disconnect(); observer.disconnect(); clearInterval(memoryTimer); setImmediate(() => process.exit(0)); return true; },
  });
  await listen(server);
} else if (role === 'load') {
  const config = JSON.parse(process.env.LAZY_AUDIT_LOAD_CONFIG);
  const urls = config.urls;
  if (urls.some((value) => new URL(value).hostname !== '127.0.0.1')) throw new Error('Only isolated loopback workers are permitted');
  // Equal active/free pool caps prevent socket churn when bursts complete.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 64 });
  let connectionsCreated = 0;
  const createConnection = agent.createConnection.bind(agent);
  agent.createConnection = (...args) => { connectionsCreated++; return createConnection(...args); };
  const total = config.burst ?? Math.ceil(config.rps * config.durationMs / 1000);
  if (total > 100_000 || !Number.isSafeInteger(total) || total < 1) throw new Error('Invalid load resource budget');
  let next = 0; let active = 0; let maxActive = 0; let completed = 0; let successful = 0; let errors = 0; let timeouts = 0; let clientDropped = 0; let violations = 0; let bodyBytes = 0;
  const arrivals = []; const service = []; const lag = []; const statuses = {}; const errorCodes = {}; const byWorker = Array(urls.length).fill(0); const requests = new Set();
  let seed = 0x51a71;
  const keyFor = (i) => {
    if (config.distribution === 'one-key') return 'tenant:storm:one';
    if (config.distribution === 'scan') return `tenant:user:${i}`;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const selected = config.distribution === 'zipf-like' ? Math.floor((seed / 2 ** 32) ** 3 * 64) : i % 64;
    return `tenant:user:${selected}`;
  };
  const start = performance.now(); resetRuntime();
  const maxOutstanding = config.burst ? Math.min(config.burst, 1500) : 1024;
  const deadline = setTimeout(() => { for (const req of requests) req.destroy(new Error('load wall deadline')); }, Math.max(4000, config.durationMs + 3500));
  function dispatch(i, planned) {
    if (active >= maxOutstanding) { clientDropped++; return; }
    const key = keyFor(i); const worker = i % urls.length; const dispatched = performance.now();
    lag.push(dispatched - planned); active++; maxActive = Math.max(maxActive, active); byWorker[worker]++;
    let settled = false; let timedOut = false;
    const finish = (ok, status = 'transport') => {
      if (settled) return; settled = true; requests.delete(req); active--; completed++;
      const ended = performance.now(); arrivals.push(ended - planned); service.push(ended - dispatched);
      statuses[status] = (statuses[status] ?? 0) + 1; if (ok) successful++; else errors++;
      if (timedOut) timeouts++;
    };
    const req = http.get(`${urls[worker]}/${config.noop ? 'noop' : 'get'}?key=${encodeURIComponent(key)}`, { agent }, (res) => {
      let bytes = 0; const chunks = [];
      res.on('data', (chunk) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) req.destroy(new Error('response byte budget')); else chunks.push(chunk); });
      res.on('end', () => {
        bodyBytes += bytes; let valid = false;
        if (res.statusCode === 200) {
          try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); valid = value.key === key && value.version === (config.expectedVersion ?? 1); if (!valid) violations++; }
          catch { violations++; }
        }
        finish(valid, res.statusCode);
      });
      res.on('error', () => finish(false));
    });
    requests.add(req); req.setTimeout(2000, () => { timedOut = true; req.destroy(new Error('request deadline')); });
    req.on('error', (error) => { errorCodes[error.code ?? error.message] = (errorCodes[error.code ?? error.message] ?? 0) + 1; finish(false); });
  }
  while (next < total) {
    const now = performance.now(); const due = config.burst ? total : Math.min(total, Math.floor((now - start) * config.rps / 1000) + 1);
    while (next < due) { const i = next++; dispatch(i, config.burst ? start : start + i * 1000 / config.rps); }
    if (next < total) await tick(1);
  }
  while (active) await tick(2);
  const elapsedMs = performance.now() - start;
  clearTimeout(deadline); agent.destroy(); observer.disconnect(); clearInterval(memoryTimer);
  console.log(JSON.stringify({ errorCodes, connectionsCreated, config, offered: total, sent: total - clientDropped, completed, successful, errors, timeouts, clientDropped, freshnessViolations: violations, elapsedMs, offeredRps: config.burst ? null : total / (config.durationMs / 1000), completedRps: completed * 1000 / elapsedMs, successfulRps: successful * 1000 / elapsedMs, errorRate: (errors + clientDropped) / total, bytesReceived: bodyBytes, maxOutstanding: maxActive, byWorker, statuses, arrivalToCompletionMs: quantiles(arrivals), dispatchedToCompletionMs: quantiles(service), dispatchLagMs: quantiles(lag), runtime: runtime(), coordinatedOmission: 'Open-loop scheduled arrivals; latency includes dispatch delay. Unsent arrivals are explicit clientDropped errors, excluded from latency quantiles.' }));
} else throw new Error('Unknown isolated E2E child role');
