import type { InvalidationEvent } from '../types/event.types.js';
import { debugLog, warnLog } from '../utils/debugLog.js';

export interface EventBusRetryQueueOptions {
  enabled?: boolean;
  maxSize?: number;
}

export const DEFAULT_EVENT_BUS_RETRY_QUEUE_MAX_SIZE = 10_000;

export class EventBusRetryQueue {
  private readonly events: InvalidationEvent[] = [];

  constructor(private readonly options: EventBusRetryQueueOptions = {}) {}

  get enabled(): boolean {
    return this.options.enabled !== false;
  }

  enqueue(event: InvalidationEvent): void {
    if (!this.enabled) {
      return;
    }

    const maxSize = this.options.maxSize ?? DEFAULT_EVENT_BUS_RETRY_QUEUE_MAX_SIZE;

    if (maxSize <= 0) {
      warnLog('event bus retry queue dropped event because maxSize is non-positive', { maxSize });
      return;
    }

    if (this.events.length >= maxSize) {
      this.events.shift();
      warnLog('event bus retry queue dropped oldest event', { maxSize });
    }

    this.events.push(event);
    debugLog('event bus retry queued event', { size: this.events.length, type: event.type });
  }

  async flush(publish: (event: InvalidationEvent) => Promise<void>): Promise<void> {
    while (this.events.length > 0) {
      const event = this.events[0];

      await publish(event);
      this.events.shift();
    }
  }
}
