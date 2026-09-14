import type { InvalidationEvent } from '../types/event.types.js';
import { debugLog, warnLog } from '../utils/debugLog.js';
import { decodeInvalidationEvent, encodeInvalidationEvent } from './eventCodec.js';

export interface EventBusRetryQueueOptions {
  enabled?: boolean;
  maxSize?: number;
  maxBytes?: number;
  onOverflow?(details: { reason: 'count' | 'bytes' | 'disabled'; bytes: number; maxSize?: number; maxBytes?: number }): void;
}

export const DEFAULT_EVENT_BUS_RETRY_QUEUE_MAX_SIZE = 10_000;
export const DEFAULT_EVENT_BUS_RETRY_QUEUE_MAX_BYTES = 16 * 1024 * 1024;

interface RetryEntry { encoded: Buffer; }

export class EventBusRetryQueue {
  private readonly events: RetryEntry[] = [];
  private bytes = 0;
  private dropped = 0;
  private flushing: Promise<void> | null = null;
  private flushingEntry: RetryEntry | null = null;

  constructor(private readonly options: EventBusRetryQueueOptions = {}) {}

  get enabled(): boolean {
    return this.options.enabled !== false;
  }

  get size(): number { return this.events.length; }
  get retainedBytes(): number { return this.bytes; }
  get droppedCount(): number { return this.dropped; }

  enqueue(event: InvalidationEvent): boolean {
    if (!this.enabled) {
      this.dropped += 1;
      this.options.onOverflow?.({ reason: 'disabled', bytes: 0 });
      return false;
    }

    const maxSize = this.options.maxSize ?? DEFAULT_EVENT_BUS_RETRY_QUEUE_MAX_SIZE;

    if (maxSize <= 0) {
      warnLog('event bus retry queue dropped event because maxSize is non-positive', { maxSize });
      this.dropped += 1;
      this.options.onOverflow?.({ reason: 'count', bytes: 0, maxSize });
      return false;
    }

    let encoded: Buffer;
    try { encoded = encodeInvalidationEvent(event); } catch (error) {
      this.dropped += 1;
      warnLog('event bus retry queue dropped unencodable event', { error });
      this.options.onOverflow?.({ reason: 'bytes', bytes: 0, maxSize, maxBytes: this.options.maxBytes });
      return false;
    }
    const maxBytes = this.options.maxBytes ?? DEFAULT_EVENT_BUS_RETRY_QUEUE_MAX_BYTES;
    if (maxBytes <= 0 || encoded.byteLength > maxBytes) {
      this.dropped += 1;
      warnLog('event bus retry queue dropped event because maxBytes is too small', { maxBytes, bytes: encoded.byteLength });
      this.options.onOverflow?.({ reason: 'bytes', bytes: encoded.byteLength, maxSize, maxBytes });
      return false;
    }

    if (this.waitingSize() >= maxSize) {
      const removed = this.removeOldestWaiting();
      if (removed) this.bytes -= removed.encoded.byteLength;
      this.dropped += 1;
      warnLog('event bus retry queue dropped oldest event', { maxSize });
      this.options.onOverflow?.({ reason: 'count', bytes: removed?.encoded.byteLength ?? 0, maxSize, maxBytes });
    }

    while (this.waitingSize() > 0 && this.bytes + encoded.byteLength > maxBytes) {
      const removed = this.removeOldestWaiting();
      if (removed) this.bytes -= removed.encoded.byteLength;
      this.dropped += 1;
      this.options.onOverflow?.({ reason: 'bytes', bytes: removed?.encoded.byteLength ?? 0, maxSize, maxBytes });
    }
    this.events.push({ encoded });
    this.bytes += encoded.byteLength;
    debugLog('event bus retry queued event', { size: this.events.length, type: event.type });
    return true;
  }

  async flush(publish: (event: InvalidationEvent) => Promise<void>): Promise<void> {
    // Concurrent publish() calls would otherwise each read events[0] and send
    // the same backlog entry, so every peer gets duplicates of it.
    if (this.flushing) {
      return this.flushing;
    }

    this.flushing = this.drain(publish).finally(() => {
      this.flushing = null;
    });

    return this.flushing;
  }

  private async drain(publish: (event: InvalidationEvent) => Promise<void>): Promise<void> {
    while (this.events.length > 0) {
      const entry = this.events[0];
      this.flushingEntry = entry;
      try {
        const event = decodeInvalidationEvent(entry.encoded);
        if (event) await publish(event);
        if (this.events[0] === entry) {
          this.events.shift();
          this.bytes -= entry.encoded.byteLength;
        }
      } finally {
        this.flushingEntry = null;
      }
    }
  }

  private waitingSize(): number {
    return this.events.length - (this.flushingEntry ? 1 : 0);
  }

  private removeOldestWaiting(): RetryEntry | undefined {
    const index = this.flushingEntry && this.events[0] === this.flushingEntry ? 1 : 0;
    return this.events.splice(index, 1)[0];
  }
}
