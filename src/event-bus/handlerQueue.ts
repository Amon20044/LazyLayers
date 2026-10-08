import type { InvalidationEvent } from '../types/event.types.js';
import { decodeInvalidationEvent, encodeInvalidationEvent } from './eventCodec.js';

export interface EventBusHandlerQueueOptions {
  concurrency?: number;
  maxSize?: number;
  maxBytes?: number;
  onError(error: unknown): void;
  onOverflow?(details: { bytes: number; maxBytes?: number; maxSize?: number }): void;
  /** Called when all accepted work has settled, including after failures. */
  onIdle?(): void;
}

interface PendingEvent { encoded: Uint8Array; decode: (raw: Uint8Array) => InvalidationEvent | null; bytes: number; settle?: (error?: unknown) => void }

export const DEFAULT_EVENT_BUS_HANDLER_QUEUE_MAX_SIZE = 10_000;
export const DEFAULT_EVENT_BUS_HANDLER_QUEUE_MAX_BYTES = 16 * 1024 * 1024;

export class EventBusHandlerQueue {
  private readonly pending = new Set<PendingEvent>();
  private pendingBytes = 0;
  private active = 0;
  private activeBytes = 0;
  private dropped = 0;
  private closed = false;

  constructor(
    private readonly handler: (event: InvalidationEvent) => void | Promise<void>,
    private readonly options: EventBusHandlerQueueOptions,
  ) {
    const limits = [options.concurrency ?? 1, options.maxSize ?? DEFAULT_EVENT_BUS_HANDLER_QUEUE_MAX_SIZE, options.maxBytes ?? DEFAULT_EVENT_BUS_HANDLER_QUEUE_MAX_BYTES];
    if (!limits.every(Number.isSafeInteger) || limits[0] <= 0 || limits[1] < 0 || limits[2] < 0) {
      throw new RangeError('Event handler concurrency must be positive; queue limits must be non-negative safe integers');
    }
  }

  get pendingCount(): number { return this.pending.size; }
  get activeCount(): number { return this.active; }
  get retainedBytes(): number { return this.activeBytes + this.pendingBytes; }
  get droppedCount(): number { return this.dropped; }

  /** Optional encoded bytes must be a matching encodeInvalidationEvent wire snapshot.
   * Use enqueueEncoded for a transport with its own trusted decoder. */
  enqueue(event: InvalidationEvent, encoded?: Uint8Array): boolean {
    if (this.closed) { this.dropped++; return false; }
    // Retain an owned wire snapshot, so a compressed size cannot disguise a
    // much larger mutable object graph held by the queue.
    try { return this.enqueueEncoded(encoded ?? encodeInvalidationEvent(event), decodeInvalidationEvent); }
    catch (error) { this.dropped++; this.reportError(error); return false; }
  }

  enqueueEncoded(encoded: Uint8Array, decode: (raw: Uint8Array) => InvalidationEvent | null, settle?: (error?: unknown) => void): boolean {
    return this.enqueueItem({ encoded, decode, bytes: encoded.byteLength, settle });
  }

  private enqueueItem(item: PendingEvent): boolean {
    const bytes = item.bytes;
    const maxSize = this.options.maxSize ?? DEFAULT_EVENT_BUS_HANDLER_QUEUE_MAX_SIZE;
    const maxBytes = this.options.maxBytes ?? DEFAULT_EVENT_BUS_HANDLER_QUEUE_MAX_BYTES;
    if (this.closed) { this.dropped++; return false; }
    if ((maxSize !== undefined && this.pending.size + this.active >= Math.max(0, maxSize))
      || (maxBytes !== undefined && this.retainedBytes + bytes > Math.max(0, maxBytes))) {
      this.dropped += 1;
      try { this.options.onOverflow?.({ bytes, maxBytes, maxSize }); } catch (error) { this.reportError(error); }
      return false;
    }
    // A small view must not retain an unaccounted larger network backing store.
    const owned = Buffer.allocUnsafeSlow(bytes);
    owned.set(item.encoded);
    item.encoded = owned;
    this.pending.add(item);
    this.pendingBytes += bytes;
    this.drain();
    return true;
  }

  private drain(): void {
    const concurrency = this.getConcurrency();

    while (this.active < concurrency) {
      const item = this.pending.values().next().value;

      if (!item) {
        return;
      }
      this.pending.delete(item);
      this.pendingBytes -= item.bytes;

      this.active += 1;
      this.activeBytes += item.bytes;

      void Promise.resolve()
        .then(() => {
          const event = item.decode(item.encoded);
          if (!event) throw new Error('invalid invalidation event');
          return this.handler(event);
        })
        .then(() => this.settle(item), (error) => { this.reportError(error); this.settle(item, error); })
        .finally(() => {
          this.active -= 1;
          this.activeBytes -= item.bytes;
          this.drain();
          if (!this.active && !this.pending.size && !this.closed) {
            try { this.options.onIdle?.(); } catch (error) { this.reportError(error); }
          }
        });
    }
  }

  close(error = new Error('event handler queue closed')): void {
    this.closed = true;
    const items = [...this.pending];
    this.pending.clear();
    this.pendingBytes = 0;
    for (const item of items) { this.reportError(error); this.settle(item, error); }
  }

  /** Drop queued deliveries after a transport gap. Active handlers finish normally. */
  discardPending(): void {
    const items = [...this.pending];
    this.pending.clear();
    this.pendingBytes = 0;
    for (const item of items) this.settle(item, new Error('event transport disconnected'));
  }

  private reportError(error: unknown): void {
    try { this.options.onError(error); } catch { /* observer failures cannot retain queue slots */ }
  }

  private settle(item: PendingEvent, error?: unknown): void {
    try { item.settle?.(error); } catch (settleError) { this.reportError(settleError); }
  }

  private getConcurrency(): number {
    return this.options.concurrency ?? 1;
  }
}
