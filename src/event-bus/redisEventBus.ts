import type { Redis as RedisClient } from 'ioredis';

import type { EventBus, EventBusHealth, EventBusStatus } from './eventBus.interface.js';
import type { InvalidationEvent } from '../types/event.types.js';
import { configureCacheLogger, type CacheLoggerOptions } from '../utils/debugLog.js';
import { debugLog, errorLog, warnLog } from '../utils/debugLog.js';
import { decodeInvalidationEvent, encodeInvalidationEvent } from './eventCodec.js';
import { EventBusHandlerQueue } from './handlerQueue.js';
import { EventBusRetryQueue, type EventBusRetryQueueOptions } from './retryQueue.js';

export interface RedisEventBusOptions {
  retryQueue?: EventBusRetryQueueOptions;
  handlerConcurrency?: number;
  logging?: CacheLoggerOptions;
  handlerMaxSize?: number;
  handlerMaxBytes?: number;
}

export interface RedisEventBusHealth extends EventBusHealth {
  transport: 'redis';
  channel: string;
  publisherStatus?: string;
  subscriberStatus?: string;
}

export class RedisEventBus implements EventBus {
  private readonly pub: RedisClient;
  private readonly sub: RedisClient;
  private readonly channel: string;
  private readonly retryQueue: EventBusRetryQueue;
  private subscribed = false;
  private messageListener: ((channel: Buffer, message: Buffer) => void) | null = null;
  private handlerQueue: EventBusHandlerQueue | null = null;
  private handler: ((event: InvalidationEvent) => void | Promise<void>) | null = null;
  private resubscribing = false;
  private readonly statusListeners = new Set<(status: EventBusStatus) => void>();

  constructor(redis: RedisClient, channel: string, private readonly options: RedisEventBusOptions = {}) {
    configureCacheLogger(options.logging);
    this.pub = redis;
    this.sub = redis.duplicate({ autoResubscribe: false });
    this.channel = channel;
    this.retryQueue = new EventBusRetryQueue(options.retryQueue);
    for (const status of ['close', 'end', 'reconnecting'] as const) {
      this.sub.on(status, () => this.emitStatus('disconnected'));
    }
    this.sub.on('error', () => this.emitStatus('error'));
    this.sub.on('ready', () => { this.emitStatus('ready'); void this.resubscribe(); });
  }

  async connect(): Promise<void> {
    await Promise.all([
      this.pub.ping(),
      this.sub.ping(),
    ]);

    debugLog('redis event bus connected', {
      channel: this.channel,
      publisherStatus: this.pub.status,
      subscriberStatus: this.sub.status,
    });
  }

  async healthCheck(): Promise<RedisEventBusHealth> {
    try {
      await this.connect();

      return {
        ok: true,
        transport: 'redis',
        channel: this.channel,
        publisherStatus: this.pub.status,
        subscriberStatus: this.sub.status,
      };
    } catch (error) {
      return {
        ok: false,
        transport: 'redis',
        channel: this.channel,
        publisherStatus: this.pub.status,
        subscriberStatus: this.sub.status,
        error,
      };
    }
  }

  async publish(event: InvalidationEvent): Promise<void> {
    try {
      await this.retryQueue.flush((queuedEvent) => this.publishNow(queuedEvent));
      await this.publishNow(event);
    } catch (error) {
      this.retryQueue.enqueue(event);
      errorLog('redis event bus publish failed', { channel: this.channel, error });
      throw error;
    }
  }

  async subscribe(handler: (event: InvalidationEvent) => void | Promise<void>): Promise<void> {
    if (this.subscribed) {
      return;
    }

    this.handler = handler;
    const handlerQueue = new EventBusHandlerQueue(handler, {
      concurrency: this.options.handlerConcurrency,
      maxSize: this.options.handlerMaxSize,
      maxBytes: this.options.handlerMaxBytes,
      onError: (error) => {
        errorLog('redis event bus handler failed', { channel: this.channel, error });
        this.emitStatus('error');
      },
      onOverflow: (details) => {
        warnLog('redis event bus handler queue overflow', { channel: this.channel, ...details });
        this.emitStatus('error');
      },
    });

    const messageListener = (channel: Buffer, message: Buffer): void => {
      if (channel.toString('utf8') !== this.channel) {
        return;
      }

      handlerQueue.enqueueEncoded(message, (raw) => decodeInvalidationEvent(raw));
    };

    // Attach before SUBSCRIBE so a message delivered between the command
    // completing and the listener landing is not dropped. Keeping the reference
    // also lets disconnect() detach it instead of leaking a listener per
    // subscribe/disconnect cycle.
    this.sub.on('messageBuffer', messageListener);
    this.messageListener = messageListener;

    try {
      await this.sub.subscribe(this.channel);
    } catch (error) {
      this.sub.off('messageBuffer', messageListener);
      this.messageListener = null;
      throw error;
    }

    this.handlerQueue = handlerQueue;
    this.subscribed = true;
    this.emitStatus('subscribed');
    // ioredis re-issues SUBSCRIBE for every channel of a subscriber connection
    // after a reconnect (autoResubscribe defaults to true), so this bus does not
    // need its own resubscribe loop.
    debugLog('redis event bus subscribed', { channel: this.channel });
  }

  async disconnect(): Promise<void> {
    this.handlerQueue?.close();
    this.handlerQueue = null;
    this.handler = null;
    if (this.messageListener) {
      this.sub.off('messageBuffer', this.messageListener);
      this.messageListener = null;
    }

    if (this.subscribed) {
      this.subscribed = false;

      try {
        await this.sub.unsubscribe(this.channel);
      } catch (error) {
        // A connection that is already gone took the server side subscription
        // with it. Surface it, but never let it block the rest of teardown.
        warnLog('redis event bus unsubscribe failed during disconnect', {
          channel: this.channel,
          error,
        });
      }
    }

    // Only the subscriber belongs to this bus: it was created here with
    // duplicate(). The publisher was handed in by the caller and is usually the
    // very same client backing the L2 RedisStore, so disconnecting it here would
    // take L2 down along with the bus.
    this.sub.disconnect();
    this.emitStatus('disconnected');
  }

  onStatus(listener: (status: EventBusStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private emitStatus(status: EventBusStatus): void {
    for (const listener of this.statusListeners) {
      try { listener(status); } catch { /* observers must not affect transport */ }
    }
  }

  private async resubscribe(): Promise<void> {
    if (!this.handler || this.resubscribing || this.subscribed) return;
    this.resubscribing = true;
    try {
      await this.sub.subscribe(this.channel);
      this.subscribed = true;
      this.emitStatus('subscribed');
    } catch (error) {
      this.emitStatus('error');
      errorLog('redis event bus resubscribe failed', { channel: this.channel, error });
    } finally {
      this.resubscribing = false;
    }
  }

  private async publishNow(event: InvalidationEvent): Promise<void> {
    await this.pub.publish(this.channel, encodeInvalidationEvent(event));
    debugLog('redis event bus published', { channel: this.channel, type: event.type });
  }
}
