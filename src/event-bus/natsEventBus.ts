import {
  AckPolicy,
  DeliverPolicy,
  jetstream as jetstreamClient,
  jetstreamManager,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
  type ConsumerMessages,
  type JetStreamManager,
} from '@nats-io/jetstream';
import {
  connect as connectNats,
  nanos,
  type NatsConnection,
  type NodeConnectionOptions,
  type Subscription,
} from '@nats-io/transport-node';

import type { InvalidationEvent } from '../types/event.types.js';
import { configureCacheLogger, type CacheLoggerOptions } from '../utils/debugLog.js';
import { debugLog, errorLog, infoLog, warnLog } from '../utils/debugLog.js';
import { decodeInvalidationEvent, encodeInvalidationEvent } from './eventCodec.js';
import type { EventBus, EventBusHealth } from './eventBus.interface.js';
import { EventBusRetryQueue, type EventBusRetryQueueOptions } from './retryQueue.js';

export type NatsEventBusMode = 'core' | 'jetstream';

const RESUBSCRIBE_INITIAL_DELAY_MS = 200;
const RESUBSCRIBE_MAX_DELAY_MS = 30_000;
/** A subscription that survived this long counts as healthy, so the backoff resets. */
const RESUBSCRIBE_STABLE_MS = 10_000;

export interface NatsJetStreamOptions {
  stream?: string;
  durableName?: string;
  storage?: 'file' | 'memory';
  maxAgeMs?: number;
  maxMsgs?: number;
  ackWaitMs?: number;
  maxDeliver?: number;
  ensureStream?: boolean;
  ensureConsumer?: boolean;
}

export interface NatsEventBusOptions {
  mode?: NatsEventBusMode;
  connection?: NatsConnection;
  connectionOptions?: NodeConnectionOptions;
  subject?: string;
  retryQueue?: EventBusRetryQueueOptions;
  jetstream?: NatsJetStreamOptions;
  logging?: CacheLoggerOptions;
}

export interface NatsEventBusHealth extends EventBusHealth {
  transport: 'nats';
  ok: boolean;
  mode: NatsEventBusMode;
  subject: string;
  server?: string;
  stream?: string;
  durableName?: string;
  error?: unknown;
}

export class NatsEventBus implements EventBus {
  private connection: NatsConnection | null = null;
  private readonly ownsConnection: boolean;
  private readonly retryQueue: EventBusRetryQueue;
  private subscription: Subscription | null = null;
  private consumerMessages: ConsumerMessages | null = null;
  private subscribing = false;
  private abortController: AbortController | null = null;
  private handler: ((event: InvalidationEvent) => void | Promise<void>) | null = null;
  private resubscribeTimer: NodeJS.Timeout | null = null;
  private resubscribeAttempt = 0;
  private subscribedAt = 0;
  private subscriptionLost = false;
  private closed = false;

  constructor(private readonly options: NatsEventBusOptions = {}) {
    configureCacheLogger(options.logging);
    this.connection = options.connection ?? null;
    this.ownsConnection = options.connection === undefined;
    this.retryQueue = new EventBusRetryQueue(options.retryQueue);
  }

  async connect(): Promise<void> {
    if (this.getMode() === 'jetstream') {
      this.getDurableName();
    }

    const connection = await this.getConnection();

    if (this.getMode() === 'jetstream') {
      const manager = await jetstreamManager(connection);
      await this.ensureJetStreamResources(manager);
    } else {
      await connection.flush();
    }

    debugLog('nats event bus connected', {
      subject: this.getSubject(),
      mode: this.getMode(),
      server: this.getServer(connection),
    });
  }

  async healthCheck(): Promise<NatsEventBusHealth> {
    try {
      await this.connect();

      const connection = await this.getConnection();

      return {
        // A lost subscription is not visible from the connection: publishing
        // keeps working while this instance receives nothing at all.
        ok: !this.subscriptionLost,
        transport: 'nats',
        mode: this.getMode(),
        subject: this.getSubject(),
        server: this.getServer(connection),
        stream: this.getMode() === 'jetstream' ? this.getStreamName() : undefined,
        durableName: this.getMode() === 'jetstream' ? this.getDurableName() : undefined,
        error: this.subscriptionLost
          ? new Error('NatsEventBus lost its subscription and is retrying. This instance is not receiving invalidations.')
          : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        transport: 'nats',
        mode: this.getMode(),
        subject: this.getSubject(),
        stream: this.getMode() === 'jetstream' ? this.getStreamName() : undefined,
        durableName: this.getMode() === 'jetstream' ? this.options.jetstream?.durableName : undefined,
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
      errorLog('nats event bus publish failed', { subject: this.getSubject(), error });
      throw error;
    }
  }

  async subscribe(handler: (event: InvalidationEvent) => void | Promise<void>): Promise<void> {
    if (this.subscription || this.consumerMessages || this.subscribing) {
      return;
    }

    this.subscribing = true;
    // Remembered so the subscription can be rebuilt if the iterator ends.
    this.handler = handler;
    this.closed = false;

    try {
      if (this.getMode() === 'jetstream') {
        await this.subscribeJetStream(handler);
      } else {
        await this.subscribeCore(handler);
      }

      this.subscribedAt = Date.now();
      this.subscriptionLost = false;
    } finally {
      this.subscribing = false;
    }
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.handler = null;
    this.subscriptionLost = false;

    if (this.resubscribeTimer) {
      clearTimeout(this.resubscribeTimer);
      this.resubscribeTimer = null;
    }

    this.resubscribeAttempt = 0;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    const messages = this.consumerMessages;
    const subscription = this.subscription;
    const connection = this.connection;

    // Cleared up front so a throwing close leaves the bus consistent and a
    // second disconnect() is a no-op.
    this.consumerMessages = null;
    this.subscription = null;

    if (messages) {
      await this.closeQuietly('close consumer', () => messages.close());
    }

    if (subscription) {
      await this.closeQuietly('drain subscription', () => subscription.drain());
    }

    if (connection && this.ownsConnection) {
      this.connection = null;
      await this.closeQuietly('drain connection', () => connection.drain());
    }
  }

  private async closeQuietly(step: string, close: () => Promise<unknown>): Promise<void> {
    try {
      await close();
    } catch (error) {
      // Teardown must never throw: a connection that is already gone rejects
      // every close, and one rejection would skip the remaining steps.
      warnLog('nats event bus teardown step failed', { subject: this.getSubject(), step, error });
    }
  }

  /**
   * The message iterator only ends when the subscription or the whole connection
   * is gone. NATS reconnects and re-sends SUB on its own, and JetStream's
   * consume() resets itself on reconnect, so this fires when recovery has given
   * up (maxReconnectAttempts, default 10). Left alone the process would stay up
   * publishing happily while receiving nothing, forever.
   */
  private handleSubscriptionEnded(
    subscription: Subscription | null,
    messages: ConsumerMessages | null,
  ): void {
    if (subscription && this.subscription !== subscription) {
      return;
    }

    if (messages && this.consumerMessages !== messages) {
      return;
    }

    this.subscription = null;
    this.consumerMessages = null;

    if (this.closed) {
      return;
    }

    if (Date.now() - this.subscribedAt >= RESUBSCRIBE_STABLE_MS) {
      this.resubscribeAttempt = 0;
    }

    this.subscriptionLost = true;
    errorLog('nats event bus subscription ended unexpectedly', {
      subject: this.getSubject(),
      mode: this.getMode(),
    });
    this.scheduleResubscribe();
  }

  private scheduleResubscribe(): void {
    if (this.closed || this.resubscribeTimer || !this.handler) {
      return;
    }

    this.resubscribeAttempt += 1;

    const delay = Math.min(
      RESUBSCRIBE_MAX_DELAY_MS,
      RESUBSCRIBE_INITIAL_DELAY_MS * 2 ** (this.resubscribeAttempt - 1),
    );

    warnLog('nats event bus scheduling resubscribe', {
      subject: this.getSubject(),
      attempt: this.resubscribeAttempt,
      delay,
    });

    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = null;

      const handler = this.handler;

      if (this.closed || !handler) {
        return;
      }

      void this.subscribe(handler)
        .then(() => {
          infoLog('nats event bus resubscribed', { subject: this.getSubject(), mode: this.getMode() });
        })
        .catch((error) => {
          errorLog('nats event bus resubscribe failed', { subject: this.getSubject(), error });
          this.scheduleResubscribe();
        });
    }, delay);
    // A dead server must not keep the process alive on its own.
    this.resubscribeTimer.unref?.();
  }

  private async publishNow(event: InvalidationEvent): Promise<void> {
    const connection = await this.getConnection();
    const subject = this.getSubject();
    const payload = encodeInvalidationEvent(event);

    if (this.getMode() === 'jetstream') {
      const js = jetstreamClient(connection);
      await js.publish(subject, payload);
    } else {
      connection.publish(subject, payload);
      await connection.flush();
    }

    debugLog('nats event bus published', { subject, type: event.type, mode: this.getMode() });
  }

  private async subscribeCore(handler: (event: InvalidationEvent) => void | Promise<void>): Promise<void> {
    const connection = await this.getConnection();
    const subject = this.getSubject();
    const subscription = connection.subscribe(subject);

    this.subscription = subscription;
    debugLog('nats event bus subscribed', { subject, mode: 'core' });

    void (async () => {
      for await (const message of subscription) {
        const event = decodeInvalidationEvent(message.data);

        if (!event) {
          warnLog('nats event bus ignored invalid message', { subject });
          continue;
        }

        try {
          await handler(event);
        } catch (error) {
          errorLog('nats event bus handler failed', { subject, error });
        }
      }
    })().catch((error) => {
      errorLog('nats event bus subscription failed', { subject, error });
    });
  }

  private async subscribeJetStream(handler: (event: InvalidationEvent) => void | Promise<void>): Promise<void> {
    const subject = this.getSubject();
    const stream = this.getStreamName();
    const durableName = this.getDurableName();
    const connection = await this.getConnection();
    const manager = await jetstreamManager(connection);

    await this.ensureJetStreamResources(manager);

    const js = jetstreamClient(connection);
    const consumer = await js.consumers.get(stream, durableName);
    const messages = await consumer.consume();

    this.consumerMessages = messages;
    this.abortController = new AbortController();
    debugLog('nats event bus subscribed', { subject, stream, durableName, mode: 'jetstream' });

    const abortSignal = this.abortController.signal;

    void (async () => {
      for await (const message of messages) {
        if (abortSignal.aborted) {
          break;
        }

        const event = decodeInvalidationEvent(message.data);

        if (!event) {
          warnLog('nats event bus ignored invalid message', { subject, stream });
          message.term();
          continue;
        }

        try {
          await handler(event);
          message.ack();
        } catch (error) {
          errorLog('nats event bus handler failed', { subject, stream, error });
          message.nak();
        }
      }
    })().catch((error) => {
      if (!abortSignal.aborted) {
        errorLog('nats event bus subscription failed', { subject, stream, error });
      }
    });
  }

  private async ensureJetStreamResources(manager: JetStreamManager): Promise<void> {
    const stream = this.getStreamName();
    const durableName = this.getDurableName();

    if (this.options.jetstream?.ensureStream !== false) {
      await this.ensureStream(manager, stream);
    }

    if (this.options.jetstream?.ensureConsumer !== false) {
      await this.ensureConsumer(manager, stream, durableName);
    }
  }

  private async ensureStream(manager: JetStreamManager, stream: string): Promise<void> {
    try {
      await manager.streams.info(stream);
      return;
    } catch {
      // Stream does not exist or is not visible to this client. Try creating it.
    }

    await manager.streams.add({
      name: stream,
      subjects: [this.getSubject()],
      retention: RetentionPolicy.Limits,
      storage: this.options.jetstream?.storage === 'memory' ? StorageType.Memory : StorageType.File,
      max_age: this.options.jetstream?.maxAgeMs === undefined
        ? undefined
        : nanos(this.options.jetstream.maxAgeMs),
      max_msgs: this.options.jetstream?.maxMsgs ?? -1,
    });
  }

  private async ensureConsumer(manager: JetStreamManager, stream: string, durableName: string): Promise<void> {
    try {
      await manager.consumers.info(stream, durableName);
      return;
    } catch {
      // Consumer does not exist or is not visible to this client. Try creating it.
    }

    await manager.consumers.add(stream, {
      durable_name: durableName,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      replay_policy: ReplayPolicy.Instant,
      filter_subject: this.getSubject(),
      ack_wait: nanos(this.options.jetstream?.ackWaitMs ?? 30_000),
      max_deliver: this.options.jetstream?.maxDeliver ?? 10,
    });
  }

  private async getConnection(): Promise<NatsConnection> {
    if (this.connection && !this.connection.isClosed()) {
      return this.connection;
    }

    this.connection = await connectNats(this.options.connectionOptions);

    return this.connection;
  }

  private getServer(connection: NatsConnection): string | undefined {
    try {
      return connection.getServer();
    } catch {
      return undefined;
    }
  }

  private getMode(): NatsEventBusMode {
    return this.options.mode ?? 'core';
  }

  private getSubject(): string {
    return this.options.subject ?? 'cache.invalidations';
  }

  private getStreamName(): string {
    return this.options.jetstream?.stream ?? 'CACHE_INVALIDATIONS';
  }

  private getDurableName(): string {
    const durableName = this.options.jetstream?.durableName;

    if (!durableName) {
      throw new Error('NatsEventBus JetStream mode requires jetstream.durableName for persistent per-instance delivery.');
    }

    return durableName;
  }
}
