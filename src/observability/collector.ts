import type { CacheEvent } from '../cache/events.js';
import type {
  ObservabilityCounters,
  OverviewSnapshot,
  RecordedEvent,
} from './types.js';

type EventListener = (event: RecordedEvent) => void;

function emptyCounters(): ObservabilityCounters {
  return {
    hitsL1: 0,
    hitsL2: 0,
    missesL1: 0,
    missesL2: 0,
    missesNegative: 0,
    sets: 0,
    deletes: 0,
    deletePatterns: 0,
    loaderStart: 0,
    loaderSuccess: 0,
    loaderError: 0,
    loaderTimeout: 0,
    inflightReuse: 0,
    inflightBypass: 0,
    staleHit: 0,
    negativeSet: 0,
    l2Error: 0,
    l2Skipped: 0,
    eventBusPublishError: 0,
    eventBusPublishSkipped: 0,
    invalidationReceived: 0,
    invalidationDuplicate: 0,
    invalidationStale: 0,
    setReceived: 0,
    setBroadcast: 0,
    setBroadcastSkipped: 0,
  };
}

/**
 * Captures the cache's live `CacheEvent` stream for the observability dashboard.
 *
 * Design constraints (see plan):
 *   - O(1) per event: bump a counter + write one ring-buffer slot + fan out.
 *   - Bounded memory: a fixed-size circular buffer, overwriting the oldest event.
 *     Nothing is ever persisted to Redis/disk — the feed is in-memory only.
 *   - Backpressure-safe fan-out: a throwing/slow SSE listener can't stall the
 *     hot path (errors are swallowed; listeners are expected to drop, not block).
 */
export class ObservabilityCollector {
  private readonly buffer: Array<RecordedEvent | undefined>;
  private readonly maxEvents: number;
  private writeIndex = 0;
  private buffered = 0;
  private seq = 0;
  private readonly counters = emptyCounters();
  private readonly listeners = new Set<EventListener>();
  private readonly startedAt = Date.now();

  constructor(maxEvents: number) {
    this.maxEvents = Math.max(1, maxEvents);
    this.buffer = new Array<RecordedEvent | undefined>(this.maxEvents);
  }

  /** Bound handler — register via `cache.on(collector.handle)`. */
  readonly handle = (event: CacheEvent): void => {
    this.count(event);

    const recorded: RecordedEvent = {
      seq: ++this.seq,
      ts: Date.now(),
      type: event.type,
      data: sanitize(event),
    };

    this.buffer[this.writeIndex] = recorded;
    this.writeIndex = (this.writeIndex + 1) % this.maxEvents;
    if (this.buffered < this.maxEvents) {
      this.buffered += 1;
    }

    if (this.listeners.size > 0) {
      for (const listener of this.listeners) {
        try {
          listener(recorded);
        } catch {
          // A failing SSE writer must never affect the cache hot path.
        }
      }
    }
  };

  /** Register a live listener (SSE). Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot of buffered events in chronological (oldest-first) order. */
  recentEvents(): RecordedEvent[] {
    const events: RecordedEvent[] = [];
    const start = this.buffered < this.maxEvents ? 0 : this.writeIndex;

    for (let i = 0; i < this.buffered; i += 1) {
      const event = this.buffer[(start + i) % this.maxEvents];
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  overview(): OverviewSnapshot {
    const hits = this.counters.hitsL1 + this.counters.hitsL2;
    const misses = this.counters.missesL1 + this.counters.missesL2 + this.counters.missesNegative;
    const lookups = hits + misses;

    return {
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      totalEvents: this.seq,
      bufferedEvents: this.buffered,
      maxEvents: this.maxEvents,
      hits,
      misses,
      hitRatio: lookups === 0 ? 0 : hits / lookups,
      counters: { ...this.counters },
    };
  }

  private count(event: CacheEvent): void {
    const c = this.counters;

    switch (event.type) {
      case 'hit':
        if (event.level === 'L1') c.hitsL1 += 1;
        else c.hitsL2 += 1;
        break;
      case 'miss':
        if (event.level === 'L1') c.missesL1 += 1;
        else if (event.level === 'L2') c.missesL2 += 1;
        else c.missesNegative += 1;
        break;
      case 'set':
        c.sets += 1;
        break;
      case 'delete':
        c.deletes += 1;
        break;
      case 'delete-pattern':
        c.deletePatterns += 1;
        break;
      case 'loader:start':
        c.loaderStart += 1;
        break;
      case 'loader:success':
        c.loaderSuccess += 1;
        break;
      case 'loader:error':
        c.loaderError += 1;
        break;
      case 'loader:timeout':
        c.loaderTimeout += 1;
        break;
      case 'inflight:reuse':
        c.inflightReuse += 1;
        break;
      case 'inflight:bypass':
        c.inflightBypass += 1;
        break;
      case 'stale:hit':
        c.staleHit += 1;
        break;
      case 'negative:set':
        c.negativeSet += 1;
        break;
      case 'l2:error':
        c.l2Error += 1;
        break;
      case 'l2:skipped':
        c.l2Skipped += 1;
        break;
      case 'event-bus:publish-error':
        c.eventBusPublishError += 1;
        break;
      case 'event-bus:publish-skipped':
        c.eventBusPublishSkipped += 1;
        break;
      case 'invalidation:received':
        c.invalidationReceived += 1;
        break;
      case 'invalidation:duplicate':
        c.invalidationDuplicate += 1;
        break;
      case 'invalidation:stale':
        c.invalidationStale += 1;
        break;
      case 'set:received':
        c.setReceived += 1;
        break;
      case 'set:broadcast':
        c.setBroadcast += 1;
        break;
      case 'set:broadcast-skipped':
        c.setBroadcastSkipped += 1;
        break;
    }
  }
}

/** Flatten an event to a plain, JSON-safe record (errors → messages). */
function sanitize(event: CacheEvent): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(event)) {
    if (key === 'type') continue;

    if (key === 'error') {
      data.error = value instanceof Error ? value.message : String(value);
    } else if (typeof value === 'bigint') {
      data[key] = value.toString();
    } else {
      data[key] = value;
    }
  }

  return data;
}
