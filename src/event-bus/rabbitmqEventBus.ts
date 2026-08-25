import amqp, { type Channel, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';

import type { EventBus, EventBusHealth } from './eventBus.interface.js';
import type { InvalidationEvent } from '../types/event.types.js';
import { configureCacheLogger, type CacheLoggerOptions } from '../utils/debugLog.js';
import { debugLog, errorLog, infoLog, warnLog } from '../utils/debugLog.js';
import { decodeInvalidationEvent, encodeInvalidationEvent } from './eventCodec.js';
import { EventBusRetryQueue, type EventBusRetryQueueOptions } from './retryQueue.js';

/**
 * Unacked messages a consumer may hold at once. The handler is acked only after
 * it resolves, so this doubles as the handler concurrency cap. Without a default
 * the broker pushes the whole queue at once and every invalidation runs in
 * parallel, which destroys ordering and unbounds memory.
 */
export const DEFAULT_RABBITMQ_PREFETCH = 32;

const RECONNECT_INITIAL_DELAY_MS = 200;
const RECONNECT_MAX_DELAY_MS = 30_000;

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
  consuming?: boolean;
}

export class RabbitMQEventBus implements EventBus {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private publishChannel: ConfirmChannel | null = null;
  private consumerTag: string | null = null;
  private queueName: string | null = null;
  private handler: ((event: InvalidationEvent) => void | Promise<void>) | null = null;
  private connectionUrl: string | null = null;
  private initPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private closed = false;
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

      // A registered handler with no consumer tag means the consumer died with
      // the connection and has not come back yet. Reporting ok here is how a
      // server ends up silently missing every invalidation.
      const consuming = this.handler === null || this.consumerTag !== null;

      return {
        ok: consuming,
        transport: 'rabbitmq',
        exchange: this.exchange,
        queueName: this.queueName,
        durable: this.isDurable(),
        initialized: this.isInitialized(),
        consuming,
        error: consuming
          ? undefined
          : new Error('RabbitMQEventBus is connected but not consuming. This instance is not receiving invalidations.'),
      };
    } catch (error) {
      return {
        ok: false,
        transport: 'rabbitmq',
        exchange: this.exchange,
        queueName: this.queueName,
        durable: this.isDurable(),
        initialized: this.isInitialized(),
        consuming: false,
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

    // Single flight. connect(), healthCheck() and the reconnect timer can all
    // land here at once, and each one would otherwise open its own connection.
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.openConnection(url).finally(() => {
      this.initPromise = null;
    });

    return this.initPromise;
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

    // Remembered so the consumer can be rebuilt after a connection loss.
    this.handler = handler;

    if (this.consumerTag) {
      return;
    }

    // Bind to the channel this consumer was created on. Acking on whatever
    // this.channel happens to be later would target a delivery tag the new
    // channel never issued.
    const channel = this.channel;

    const queue = await channel.assertQueue(this.options.queueName ?? '', {
      exclusive: this.options.exclusiveQueue ?? !this.isDurableInvalidationMode(),
      durable: this.options.queueName ? this.isDurable() : false,
      autoDelete: this.options.autoDeleteQueue ?? !this.isDurableInvalidationMode(),
    });
    this.queueName = queue.queue;

    await channel.bindQueue(queue.queue, this.exchange, this.options.routingKey ?? '');

    const consumeResult = await channel.consume(queue.queue, (message) => {
      if (!message) {
        // A null delivery is the broker cancelling this consumer (queue deleted,
        // node failover). The connection is still up, so nothing else would
        // notice that this instance stopped receiving invalidations.
        this.consumerTag = null;
        errorLog('rabbitmq event bus consumer cancelled by broker', {
          exchange: this.exchange,
          queue: this.queueName,
        });
        this.scheduleReconnect();
        return;
      }

      const event = decodeInvalidationEvent(message.content);

      if (!event) {
        warnLog('rabbitmq event bus ignored invalid message', { exchange: this.exchange });
        this.settle(channel, message, undefined);
        return;
      }

      // Promise.resolve().then(...) rather than Promise.resolve(handler(event)):
      // a handler that throws synchronously would otherwise escape into
      // amqplib's delivery callback and take the process down. The ack happens
      // only after the handler resolves, so a crash mid-handler leaves the
      // message unacked and the broker redelivers it.
      void Promise.resolve()
        .then(() => handler(event))
        .then(
          () => this.settle(channel, message, undefined),
          (error: unknown) => this.settle(channel, message, error ?? new Error('rabbitmq handler rejected')),
        );
    });
    this.consumerTag = consumeResult.consumerTag;
    debugLog('rabbitmq event bus subscribed', { exchange: this.exchange, queue: queue.queue });
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.handler = null;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.reconnectAttempt = 0;

    const channel = this.channel;
    const publishChannel = this.publishChannel;
    const connection = this.connection;
    const consumerTag = this.consumerTag;

    // Cleared up front so a throwing close still leaves the bus in a consistent
    // state and a second disconnect() is a no-op.
    this.channel = null;
    this.publishChannel = null;
    this.connection = null;
    this.consumerTag = null;
    this.queueName = null;

    if (channel && consumerTag) {
      await this.closeQuietly('cancel consumer', () => channel.cancel(consumerTag));
    }

    if (channel) {
      await this.closeQuietly('close channel', () => channel.close());
    }

    if (publishChannel) {
      await this.closeQuietly('close publish channel', () => publishChannel.close());
    }

    if (connection) {
      await this.closeQuietly('close connection', () => connection.close());
    }
  }

  private async openConnection(url: string): Promise<void> {
    const connection = await amqp.connect(url);

    try {
      const channel = await connection.createChannel();
      const publishChannel = await connection.createConfirmChannel();

      await Promise.all([
        channel.assertExchange(this.exchange, this.options.exchangeType ?? 'fanout', {
          durable: this.isDurable(),
        }),
        publishChannel.assertExchange(this.exchange, this.options.exchangeType ?? 'fanout', {
          durable: this.isDurable(),
        }),
      ]);

      await channel.prefetch(this.options.prefetch ?? DEFAULT_RABBITMQ_PREFETCH);

      this.connection = connection;
      this.channel = channel;
      this.publishChannel = publishChannel;
      this.connectionUrl = url;
      this.closed = false;
      this.watchConnection(connection, channel, publishChannel);
    } catch (error) {
      // A half opened connection leaks a socket and a heartbeat timer, and the
      // next init() would open a second one on top of it.
      await this.closeQuietly('close half opened connection', () => connection.close());
      throw error;
    }

    debugLog('rabbitmq event bus initialized', {
      exchange: this.exchange,
      durable: this.isDurable(),
      prefetch: this.options.prefetch ?? DEFAULT_RABBITMQ_PREFETCH,
    });
  }

  /**
   * amqplib re-emits connection failures as 'error' on the ChannelModel and on
   * every channel. An EventEmitter 'error' with no listener is rethrown and
   * crashes the process, so each emitter this bus owns gets one. The 'close'
   * listener is what actually rebuilds the consumer: amqplib 2.x only recovers
   * connections when they are opened with an explicit `recovery` option, and it
   * never re-creates the channels or consumers that were open before the drop.
   */
  private watchConnection(connection: ChannelModel, channel: Channel, publishChannel: ConfirmChannel): void {
    connection.on('error', (error) => {
      errorLog('rabbitmq event bus connection error', { exchange: this.exchange, error });
    });

    channel.on('error', (error) => {
      errorLog('rabbitmq event bus channel error', { exchange: this.exchange, error });
    });

    publishChannel.on('error', (error) => {
      errorLog('rabbitmq event bus publish channel error', { exchange: this.exchange, error });
    });

    connection.on('close', (error) => {
      if (this.connection !== connection) {
        return;
      }

      this.connection = null;
      this.channel = null;
      this.publishChannel = null;
      this.consumerTag = null;

      if (this.closed) {
        return;
      }

      errorLog('rabbitmq event bus connection closed unexpectedly', { exchange: this.exchange, error });
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || !(this.connectionUrl ?? this.options.url)) {
      return;
    }

    this.reconnectAttempt += 1;

    const delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_INITIAL_DELAY_MS * 2 ** (this.reconnectAttempt - 1),
    );

    warnLog('rabbitmq event bus scheduling reconnect', {
      exchange: this.exchange,
      attempt: this.reconnectAttempt,
      delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
    // A dead broker must not keep the process alive on its own.
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.closed) {
      return;
    }

    const handler = this.handler;

    try {
      await this.init(this.connectionUrl ?? this.options.url);

      if (handler) {
        await this.subscribe(handler);
      }

      this.reconnectAttempt = 0;
      infoLog('rabbitmq event bus reconnected', { exchange: this.exchange, queue: this.queueName });
    } catch (error) {
      errorLog('rabbitmq event bus reconnect failed', { exchange: this.exchange, error });
      this.scheduleReconnect();
    }
  }

  /**
   * Ack on success, nack without requeue on failure. Either call throws when the
   * channel died while the handler was running, and an unhandled rejection there
   * would take the process down for a message the broker will redeliver anyway.
   */
  private settle(channel: Channel, message: ConsumeMessage, error: unknown): void {
    if (error !== undefined) {
      errorLog('rabbitmq event bus handler failed', { exchange: this.exchange, error });
    }

    try {
      if (error !== undefined) {
        channel.nack(message, false, false);
      } else {
        channel.ack(message);
      }
    } catch (settleError) {
      warnLog('rabbitmq event bus could not settle message', {
        exchange: this.exchange,
        error: settleError,
      });
    }
  }

  private async closeQuietly(step: string, close: () => Promise<unknown>): Promise<void> {
    try {
      await close();
    } catch (error) {
      // Teardown must never throw: a broker that already dropped the connection
      // rejects every close, and one rejection would skip the remaining steps.
      warnLog('rabbitmq event bus teardown step failed', { exchange: this.exchange, step, error });
    }
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
