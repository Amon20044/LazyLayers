import type { InvalidationEvent } from '../types/event.types.js';

export interface EventBusHandlerQueueOptions {
  concurrency?: number;
  onError(error: unknown): void;
}

export class EventBusHandlerQueue {
  private readonly pending: InvalidationEvent[] = [];
  private active = 0;

  constructor(
    private readonly handler: (event: InvalidationEvent) => void | Promise<void>,
    private readonly options: EventBusHandlerQueueOptions,
  ) {}

  enqueue(event: InvalidationEvent): void {
    this.pending.push(event);
    this.drain();
  }

  private drain(): void {
    const concurrency = this.getConcurrency();

    while (this.active < concurrency) {
      const event = this.pending.shift();

      if (!event) {
        return;
      }

      this.active += 1;

      void Promise.resolve()
        .then(() => this.handler(event))
        .catch((error) => {
          this.options.onError(error);
        })
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }

  private getConcurrency(): number {
    const concurrency = this.options.concurrency ?? 1;

    if (!Number.isFinite(concurrency) || concurrency <= 0) {
      return 1;
    }

    return Math.floor(concurrency);
  }
}
