#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';

const files = process.argv.slice(2).filter((value) => !value.startsWith('--'));
if (!files.length) throw new Error('Usage: audit-export-metrics.mjs audit/raw/e2e-before.json audit/raw/e2e-after.json [--serve]');
const lines = ['# Audit summary gauges; quantiles are not histogram buckets.'];
const quote = (value) => JSON.stringify(String(value));
const metric = (name, labels, value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  lines.push(`lazy_layers_audit_${name}{${Object.entries(labels).map(([key, item]) => `${key}=${quote(item)}`).join(',')}} ${value}`);
};
for (const file of files) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  const version = /before/.test(file) ? 'before' : /after/.test(file) ? 'after' : 'current';
  for (const row of data.rows ?? []) {
    const labels = { version, scenario: row.name, repetition: row.repetition };
    metric('offered_rps', labels, row.result.offeredRps);
    metric('successful_rps', labels, row.result.successfulRps);
    metric('completed_rps', labels, row.result.completedRps);
    metric('error_ratio', labels, row.result.errorRate);
    metric('client_dropped_requests', labels, row.result.clientDropped);
    metric('freshness_violations', labels, row.result.freshnessViolations);
    metric('worker_peak_rss_bytes', labels, row.aggregateWorkerPeakSampledRssBytes);
    metric('worker_cpu_ms_per_million', labels, row.cpuMsPerMillion);
    metric('redis_operations_per_request', labels, row.redisOpsPerSentRequest);
    metric('origin_requests', labels, row.origin.requests);
    metric('origin_amplification', labels, row.originAmplification);
    metric('cache_hit_events_per_request', labels, row.cacheHitEventsPerSentRequest);
    for (const [quantile, value] of Object.entries(row.result.arrivalToCompletionMs)) metric('arrival_latency_ms', { ...labels, quantile }, value);
    for (const worker of row.workers) {
      const workerLabels = { ...labels, worker: worker.worker };
      metric('active_refreshes_peak', workerLabels, worker.maxActiveRefreshes);
      metric('queued_origin_peak', workerLabels, worker.maxQueuedOrigin);
      metric('gc_duration_ms', workerLabels, worker.runtime.gc.totalMs);
      metric('stale_responses', workerLabels, worker.events['stale:hit'] ?? 0);
    }
  }
}
const text = lines.join('\n') + '\n';
await writeFile('audit/raw/e2e-metrics.prom', text);
console.log('Metrics: audit/raw/e2e-metrics.prom');
if (process.argv.includes('--serve')) {
  const server = http.createServer((req, res) => { if (req.url !== '/metrics') { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); res.end(text); });
  server.listen(9098, '127.0.0.1', () => console.log('Private metrics snapshot at http://127.0.0.1:9098/metrics; Ctrl-C stops.'));
  const close = () => { server.closeAllConnections(); server.close(); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
