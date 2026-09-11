import type { InvalidationEvent } from '../types/event.types.js';

export interface EventBusHealth {
  ok: boolean;
  transport: string;
  error?: unknown;
}

export type EventBusStatus = 'connecting' | 'ready' | 'subscribed' | 'disconnected' | 'error';

export interface EventBus {
  connect?(): Promise<void>;

  healthCheck?(): Promise<EventBusHealth>;

  publish(event: InvalidationEvent): Promise<void>;

  subscribe(handler: (event: InvalidationEvent) => void | Promise<void>): Promise<void>;

  /** Observe transport/subscription loss. Optional for custom buses. */
  onStatus?(listener: (status: EventBusStatus) => void): () => void;

  disconnect?(): Promise<void>;
}
