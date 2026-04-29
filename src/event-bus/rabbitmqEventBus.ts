import amqp, { type Channel, type ChannelModel, type ConfirmChannel } from 'amqplib';

import type { EventBus, EventBusHealth } from './eventBus.interface.js';
import type { InvalidationEvent } from '../types/event.types.js';
import { configureCacheLogger, type CacheLoggerOptions } from '../utils/debugLog.js';
import { debugLog, errorLog, warnLog } from '../utils/debugLog.js';
import { decodeInvalidationEvent, encodeInvalidationEvent } from './eventCodec.js';
import { EventBusRetryQueue, type EventBusRetryQueueOptions } from './retryQueue.js';

export interface RabbitMQEventBusOptions {
  url?: string;
  exchangeType?: 'fanout' | 'topic' | 'direct';
  durable?: boolean;
  persistent?: boolean;
  durableInvalidationMode?: boolean;
  prefetch?: number;
  routingKey?: string;
  queueName?: string;
  exclusiveQueue?: boolean;
  autoDeleteQueue?: boolean;
  retryQueue?: EventBusRetryQueueOptions;
  logging?: CacheLoggerOptions;
}

export interface RabbitMQEventBusHealth extends EventBusHealth {
  transport: 'rabbitmq';
  exchange: string;
  queueName?: string | null;
  durable: boolean;
  initialized: boolean;
}

export class RabbitMQEventBus implements EventBus {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private publishChannel: ConfirmChannel | null = null;
  private consumerTag: string | null = null;
  private queueName: string | null = null;
  private readonly retryQueue: EventBusRetryQueue;

  constructor(
    private readonly exchange: string,
    private readonly options: RabbitMQEventBusOptions = {},
  ) {
    configureCacheLogger(options.logging);
    this.retryQueue = new EventBusRetryQueue(options.retryQueue);
  }

  async connect(): Promise<void> {
    await this.init();
  }

  async healthCheck(): Promise<RabbitMQEventBusHealth> {
    try {
      await this.connect();

      return {
        ok: true,
        transport: 'rabbitmq',
        exchange: this.exchange,
        queueName: this.queueName,
        durable: this.isDurable(),
        initialized: this.isInitialized(),
      };
    } catch (error) {
      return {
        ok: false,
        transport: 'rabbitmq',
        exchange: this.exchange,
        queueName: this.queueName,
        durable: this.isDurable(),
        initialized: this.isInitialized(),
        error,
      };
    }
  }

  async init(url = this.options.url): Promise<void> {
    if (!url) {
      throw new Error('RabbitMQEventBus requires a URL. Pass options.url or call init(url).');
    }

    if (this.isInitialized()) {
      return;
    }

    this.connection = await amqp.connect(url);
    this.channel = await this.connection.createChannel();
    this.publishChannel = await this.connection.createConfirmChannel();

    await Promise.all([
      this.channel.assertExchange(this.exchange, this.options.exchangeType ?? 'fanout', {
        durable: this.isDurable(),
      }),
      this.publishChannel.assertExchange(this.exchange, this.options.exchangeType ?? 'fanout', {
        durable: this.isDurable(),
      }),
    ]);

    if (this.options.prefetch !== undefined) {
      await this.channel.prefetch(this.options.prefetch);
    }

    debugLog('rabbitmq event bus initialized', {
      exchange: this.exchange,
      durable: this.isDurable(),
    });
  }

  async publish(event: InvalidationEvent): Promise<void> {
    if (!this.publishChannel) {
      throw new Error('RabbitMQEventBus must be initialized before publishing.');
    }

    try {
      await this.retryQueue.flush((queuedEvent) => this.publishNow(queuedEvent));
      await this.publishNow(event);
    } catch (error) {
      this.retryQueue.enqueue(event);
      errorLog('rabbitmq event bus publish failed', { exchange: this.exchange, error });
      throw error;
    }
  }

  async subscribe(handler: (event: InvalidationEvent) => void | Promise<void>): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQEventBus must be initialized before subscribing.');
    }

    if (this.consumerTag) {
      return;
    }

    const queue = await this.channel.assertQueue(this.options.queueName ?? '', {
      exclusive: this.options.exclusiveQueue ?? !this.isDurableInvalidationMode(),
      durable: this.options.queueName ? this.isDurable() : false,
      autoDelete: this.options.autoDeleteQueue ?? !this.isDurableInvalidationMode(),
    });
    this.queueName = queue.queue;

    await this.channel.bindQueue(queue.queue, this.exchange, this.options.routingKey ?? '');

    const consumeResult = await this.channel.consume(queue.queue, (message) => {
      if (!message || !this.channel) {
        return;
      }

      const event = decodeInvalidationEvent(message.content);

      if (event) {
        void Promise.resolve(handler(event))
          .then(() => {
            this.channel?.ack(message);
          })
          .catch((error) => {
            errorLog('rabbitmq event bus handler failed', { exchange: this.exchange, error });
            this.channel?.nack(message, false, false);
          });
      } else {
        warnLog('rabbitmq event bus ignored invalid message', { exchange: this.exchange });
        this.channel.ack(message);
      }
    });
    this.consumerTag = consumeResult.consumerTag;
    debugLog('rabbitmq event bus subscribed', { exchange: this.exchange, queue: queue.queue });
  }

  async disconnect(): Promise<void> {
    if (this.channel && this.consumerTag) {
      await this.channel.cancel(this.consumerTag);
      this.consumerTag = null;
    }

    await this.channel?.close();
    await this.publishChannel?.close();
    await this.connection?.close();

    this.channel = null;
    this.publishChannel = null;
    this.connection = null;
    this.queueName = null;
  }

  private async publishNow(event: InvalidationEvent): Promise<void> {
    if (!this.publishChannel) {
      throw new Error('RabbitMQEventBus must be initialized before publishing.');
    }

    this.publishChannel.publish(this.exchange, this.options.routingKey ?? '', encodeInvalidationEvent(event), {
      persistent: this.options.persistent ?? this.isDurable(),
      contentType: 'application/msgpack',
    });
    await this.publishChannel.waitForConfirms();
    debugLog('rabbitmq event bus published', { exchange: this.exchange, type: event.type });
  }

  private isDurableInvalidationMode(): boolean {
    return this.options.durableInvalidationMode === true;
  }

  private isDurable(): boolean {
    return this.options.durable ?? this.isDurableInvalidationMode();
  }

  private isInitialized(): boolean {
    return this.connection !== null && this.channel !== null && this.publishChannel !== null;
  }
}
