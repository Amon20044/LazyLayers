import type { ObservabilityCollector } from './collector.js';

/** Optional live gauges resolved per scrape (layer sizes). */
export interface PrometheusGauges {
  l1Size?: number;
  l2Size?: number;
}

/**
 * Render the collector's counters + gauges in Prometheus text exposition format
 * (v0.0.4) with zero dependencies.
 *
 * Cardinality note: unlike some cache exporters we deliberately do NOT label by
 * cache key — that explodes series count and melts Prometheus in production. We
 * label by `level`/`kind`/`result` only, which stays bounded forever.
 */
export function renderPrometheus(
  collector: ObservabilityCollector,
  prefix: string,
  gauges: PrometheusGauges = {},
): string {
  const o = collector.overview();
  const c = o.counters;
  const lines: string[] = [];

  const counter = (
    name: string,
    help: string,
    series: Array<{ labels?: Record<string, string>; value: number }>,
  ): void => {
    lines.push(`# HELP ${prefix}_${name} ${help}`);
    lines.push(`# TYPE ${prefix}_${name} counter`);
    for (const s of series) {
      lines.push(`${prefix}_${name}${formatLabels(s.labels)} ${s.value}`);
    }
  };

  const gauge = (name: string, help: string, value: number): void => {
    lines.push(`# HELP ${prefix}_${name} ${help}`);
    lines.push(`# TYPE ${prefix}_${name} gauge`);
    lines.push(`${prefix}_${name} ${value}`);
  };

  counter('hits_total', 'Cache hits by level', [
    { labels: { level: 'l1' }, value: c.hitsL1 },
    { labels: { level: 'l2' }, value: c.hitsL2 },
  ]);
  counter('misses_total', 'Cache misses by level', [
    { labels: { level: 'l1' }, value: c.missesL1 },
    { labels: { level: 'l2' }, value: c.missesL2 },
    { labels: { level: 'negative' }, value: c.missesNegative },
  ]);
  counter('writes_total', 'Set operations', [{ value: c.sets }]);
  counter('deletes_total', 'Delete operations by kind', [
    { labels: { kind: 'key' }, value: c.deletes },
    { labels: { kind: 'pattern' }, value: c.deletePatterns },
  ]);
  counter('loader_total', 'Loader outcomes', [
    { labels: { result: 'success' }, value: c.loaderSuccess },
    { labels: { result: 'error' }, value: c.loaderError },
    { labels: { result: 'timeout' }, value: c.loaderTimeout },
  ]);
  counter('inflight_total', 'Inflight dedupe outcomes', [
    { labels: { kind: 'reuse' }, value: c.inflightReuse },
    { labels: { kind: 'bypass' }, value: c.inflightBypass },
  ]);
  counter('stale_hits_total', 'Stale values served (fail-safe)', [{ value: c.staleHit }]);
  counter('negative_cached_total', 'Negative entries stored', [{ value: c.negativeSet }]);
  counter('l2_total', 'L2 resilience events', [
    { labels: { kind: 'error' }, value: c.l2Error },
    { labels: { kind: 'skipped' }, value: c.l2Skipped },
  ]);
  counter('eventbus_total', 'Event-bus outcomes', [
    { labels: { kind: 'publish_error' }, value: c.eventBusPublishError },
    { labels: { kind: 'publish_skipped' }, value: c.eventBusPublishSkipped },
    { labels: { kind: 'received' }, value: c.invalidationReceived },
    { labels: { kind: 'duplicate' }, value: c.invalidationDuplicate },
    { labels: { kind: 'stale' }, value: c.invalidationStale },
  ]);
  counter('set_broadcast_total', 'Cross-instance L1 priming', [
    { labels: { kind: 'sent' }, value: c.setBroadcast },
    { labels: { kind: 'skipped' }, value: c.setBroadcastSkipped },
    { labels: { kind: 'received' }, value: c.setReceived },
  ]);
  counter('events_total', 'Total cache events observed', [{ value: o.totalEvents }]);

  gauge('hit_ratio', 'Hit ratio in [0,1]', round(o.hitRatio));
  gauge('uptime_seconds', 'Collector uptime in seconds', Math.round(o.uptimeMs / 1000));
  gauge('events_buffered', 'Events currently held in the in-memory ring buffer', o.bufferedEvents);

  if (gauges.l1Size !== undefined) {
    gauge('l1_entries', 'Approximate L1 entry count', gauges.l1Size);
  }
  if (gauges.l2Size !== undefined) {
    gauge('l2_entries', 'Approximate L2 entry count', gauges.l2Size);
  }

  return `${lines.join('\n')}\n`;
}

function formatLabels(labels?: Record<string, string>): string {
  if (!labels) return '';
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
