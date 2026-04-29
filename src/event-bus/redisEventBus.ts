import Redis, { type Redis as RedisClient } from 'ioredis';

import type { EventBus, EventBusHealth } from './eventBus.interface.js';
import type { InvalidationEvent } from '../types/event.types.js';
import { configureCacheLogger, type CacheLoggerOptions } from '../utils/debugLog.js';
import { debugLog, errorLog, warnLog } from '../utils/debugLog.js';
import { decodeInvalidationEvent, encodeInvalidationEvent } from './eventCodec.js';
import { EventBusRetryQueue, type EventBusRetryQueueOptions } from './retryQueue.js';

export interface RedisEventBusOptions {
  retryQueue?: EventBusRetryQueueOptions;
  logging?: CacheLoggerOptions;
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

  constructor(redis: RedisClient, channel: string, options: RedisEventBusOptions = {}) {
    configureCacheLogger(options.logging);
    this.pub = redis;
    this.sub = redis.duplicate();
    this.channel = channel;
    this.retryQueue = new EventBusRetryQueue(options.retryQueue);
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

    await this.sub.subscribe(this.channel);
    this.subscribed = true;
    debugLog('redis event bus subscribed', { channel: this.channel });

    this.sub.on('messageBuffer', (channel: Buffer, message: Buffer) => {
      if (channel.toString('utf8') !== this.channel) {
        return;
      }

      const event = decodeInvalidationEvent(message);

      if (event) {
        void Promise.resolve(handler(event)).catch((error) => {
          errorLog('redis event bus handler failed', { channel: this.channel, error });
        });
      } else {
        warnLog('redis event bus ignored invalid message', { channel: this.channel });
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.subscribed) {
      await this.sub.unsubscribe(this.channel);
      this.subscribed = false;
    }

    this.sub.disconnect();
    this.pub.disconnect();
  }

  private async publishNow(event: InvalidationEvent): Promise<void> {
    await this.pub.publish(this.channel, encodeInvalidationEvent(event));
    debugLog('redis event bus published', { channel: this.channel, type: event.type });
  }
}
