import type { InvalidationEvent } from '../types/event.types.js';

export interface EventBusHealth {
  ok: boolean;
  transport: string;
  error?: unknown;
}

export interface EventBus {
  connect?(): Promise<void>;

  healthCheck?(): Promise<EventBusHealth>;

  publish(event: InvalidationEvent): Promise<void>;

  subscribe(handler: (event: InvalidationEvent) => void | Promise<void>): Promise<void>;

  disconnect?(): Promise<void>;
}
