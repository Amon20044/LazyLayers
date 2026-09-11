import type { InvalidationEvent } from '../types/event.types.js';
import { encodeInvalidationEvent } from './eventCodec.js';

export interface EventBusHandlerQueueOptions {
  concurrency?: number;
  maxSize?: number;
  maxBytes?: number;
  onError(error: unknown): void;
  onOverflow?(details: { bytes: number; maxBytes?: number; maxSize?: number }): void;
}

interface PendingEvent { event?: InvalidationEvent; encoded?: Uint8Array; decode?: (raw: Uint8Array) => InvalidationEvent | null; bytes: number }

export const DEFAULT_EVENT_BUS_HANDLER_QUEUE_MAX_SIZE = 10_000;
export const DEFAULT_EVENT_BUS_HANDLER_QUEUE_MAX_BYTES = 16 * 1024 * 1024;

export class EventBusHandlerQueue {
  private readonly pending: PendingEvent[] = [];
  private active = 0;
  private activeBytes = 0;
  private dropped = 0;

  constructor(
    private readonly handler: (event: InvalidationEvent) => void | Promise<void>,
    private readonly options: EventBusHandlerQueueOptions,
  ) {}

  get pendingCount(): number { return this.pending.length; }
  get activeCount(): number { return this.active; }
  get retainedBytes(): number { return this.activeBytes + this.pending.reduce((n, item) => n + item.bytes, 0); }
  get droppedCount(): number { return this.dropped; }

  enqueue(event: InvalidationEvent, encoded?: Uint8Array): boolean {
    return this.enqueueItem({ event, encoded, bytes: encoded?.byteLength ?? this.encodedSize(event) });
  }

  enqueueEncoded(encoded: Uint8Array, decode: (raw: Uint8Array) => InvalidationEvent | null): boolean {
    return this.enqueueItem({ encoded, decode, bytes: encoded.byteLength });
  }

  private enqueueItem(item: PendingEvent): boolean {
    const bytes = item.bytes;
    const maxSize = this.options.maxSize ?? DEFAULT_EVENT_BUS_HANDLER_QUEUE_MAX_SIZE;
    const maxBytes = this.options.maxBytes ?? DEFAULT_EVENT_BUS_HANDLER_QUEUE_MAX_BYTES;
    if ((maxSize !== undefined && this.pending.length + this.active >= Math.max(0, maxSize))
      || (maxBytes !== undefined && this.retainedBytes + bytes > Math.max(0, maxBytes))) {
      this.dropped += 1;
      this.options.onOverflow?.({ bytes, maxBytes, maxSize });
      return false;
    }
    this.pending.push(item);
    this.drain();
    return true;
  }

  private drain(): void {
    const concurrency = this.getConcurrency();

    while (this.active < concurrency) {
      const item = this.pending.shift();

      if (!item) {
        return;
      }

      this.active += 1;
      this.activeBytes += item.bytes;

      void Promise.resolve()
        .then(() => {
          const event = item.event ?? item.decode?.(item.encoded!);
          if (event) return this.handler(event);
        })
        .catch((error) => {
          this.options.onError(error);
        })
        .finally(() => {
          this.active -= 1;
          this.activeBytes -= item.bytes;
          this.drain();
        });
    }
  }

  private encodedSize(event: InvalidationEvent): number {
    try { return encodeInvalidationEvent(event).byteLength; } catch { return 0; }
  }

  close(error = new Error('event handler queue closed')): void {
    while (this.pending.length) {
      const item = this.pending.shift()!;
      this.options.onError(error);
      this.activeBytes -= 0;
      void item;
    }
  }

  /** Drop queued deliveries after a transport gap. Active handlers finish normally. */
  discardPending(): void {
    this.pending.length = 0;
  }

  private getConcurrency(): number {
    const concurrency = this.options.concurrency ?? 1;

    if (!Number.isFinite(concurrency) || concurrency <= 0) {
      return 1;
    }

    return Math.floor(concurrency);
  }
}
