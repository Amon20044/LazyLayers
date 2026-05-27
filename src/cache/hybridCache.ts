import type { EventBus } from '../event-bus/index.js';
import { encodeInvalidationEvent } from '../event-bus/eventCodec.js';
import type { DeleteEvent, SetEvent } from '../types/event.types.js';
import type {
  CacheKey,
  CacheLevel,
  CacheLoader,
  CacheOptions,
  CacheStore,
  InflightEntry,
  InflightStore,
} from '../types/index.js';
import { configureCacheLogger, type CacheLoggerOptions } from '../utils/debugLog.js';
import { debugLog, errorLog } from '../utils/debugLog.js';
import { CircuitBreaker, type CircuitBreakerOptions } from './circuitBreaker.js';
import { DEFAULT_INFLIGHT_TTL_MS } from './defaults.js';
import {
  supportsDistributedLock,
  type DistributedLockOptions,
} from './distributedLock.js';
import type { CacheEvent, CacheEventHandler } from './events.js';
import { MemoryStore } from './memoryStore.js';
import { matchesPattern } from './pattern.js';

interface StaleEntry<V> {
  value: V;
  expiresAt: number;
}

interface NegativeEntry {
  expiresAt: number;
}

export interface HybridCacheResilienceOptions {
  l2CircuitBreaker?: CircuitBreakerOptions;
  eventBusCircuitBreaker?: CircuitBreakerOptions;
}

export type CacheLayer<K extends CacheKey = string, V = unknown> = CacheStore<K, V> | false;

export interface HybridCacheOptions<K extends CacheKey = string, V = unknown> extends CacheOptions {
  l1?: CacheLayer<K, V>;
  l2?: CacheLayer<K, V>;
  eventBus?: EventBus;
  source?: string;
  subscribeToEvents?: boolean;
  resilience?: HybridCacheResilienceOptions;
  distributedLock?: DistributedLockOptions;
  events?: CacheEventHandler[];
  eventDedupeMaxEntries?: number;
  eventDedupeTtlMs?: number;
  logging?: CacheLoggerOptions;
  broadcastSet?: boolean;
  broadcastSetMaxBytes?: number;
}

export class HybridCache<K extends CacheKey = string, V = unknown> implements CacheStore<K, V> {
  private readonly l1?: CacheStore<K, V>;
  private readonly l2?: CacheStore<K, V>;
  private readonly inflight: InflightStore<K, V> = new Map();
  private readonly source: string;
  private readonly l2CircuitBreaker: CircuitBreaker;
  private readonly eventBusCircuitBreaker: CircuitBreaker;
  private readonly stale = new Map<K, StaleEntry<V>>();
  private readonly negative = new Map<K, NegativeEntry>();
  private readonly generations = new Map<string, number>();
  private readonly seenEvents = new Map<string, number>();
  private readonly eventHandlers = new Set<CacheEventHandler>();

  constructor(private readonly options: HybridCacheOptions<K, V> = {}) {
    configureCacheLogger(options.logging);
    this.l1 = options.l1 === false ? undefined : options.l1 ?? new MemoryStore<K, V>(options);
    this.l2 = options.l2 === false ? undefined : options.l2;
    this.source = options.source ?? createSourceId();
    this.l2CircuitBreaker = new CircuitBreaker(options.resilience?.l2CircuitBreaker);
    this.eventBusCircuitBreaker = new CircuitBreaker(options.resilience?.eventBusCircuitBreaker);
    options.events?.forEach((handler) => this.eventHandlers.add(handler));

    if (options.eventBus && options.subscribeToEvents !== false) {
      void options.eventBus
        .subscribe(async (event) => {
          const eventId = event.id ?? this.getLegacyEventId(event);

          if (this.hasSeenEvent(eventId)) {
            this.emit({ type: 'invalidation:duplicate', eventId });
            return;
          }

          this.markEventSeen(eventId);

          if (event.source === this.source) {
            return;
          }

          this.emit({ type: 'invalidation:received', eventId, eventType: event.type });
          debugLog('event-bus invalidation received', event);

          if (event.type === 'del') {
            await this.applyRemoteDelete(event, eventId);
            return;
          }

          if (event.type === 'set') {
            await this.applyRemoteSet(event, eventId);
            return;
          }

          await this.deleteByPatternLocal(event.pattern);
        })
        .catch((error) => {
          errorLog('event-bus subscription failed', { error });
        });
    }
  }

  async set(key: K, value: V, options: CacheOptions = {}): Promise<void> {
    const storageKey = this.toStorageKey(key);

    await this.l1?.set(storageKey, value, options);
    await this.runL2('set', storageKey, () => this.l2?.set(storageKey, value, options) ?? Promise.resolve());
    this.rememberStale(key, value, options);
    this.negative.delete(key);

    this.emit({ type: 'set', key, levels: this.getActiveLevels() });
    debugLog('cache set', { key, levels: this.getActiveLevels() });
  }

  async get(key: K): Promise<V | undefined> {
    if (this.hasNegative(key)) {
      this.emit({ type: 'miss', key, level: 'negative' });
      return undefined;
    }

    const storageKey = this.toStorageKey(key);

    if (this.l1) {
      const l1Value = await this.l1.get(storageKey);

      if (l1Value !== undefined) {
        this.rememberStale(key, l1Value, this.options);
        this.emit({ type: 'hit', key, level: 'L1' });
        debugLog('cache hit', { key, level: 'L1' });
        return l1Value;
      }

      this.emit({ type: 'miss', key, level: 'L1' });
      debugLog('cache miss', { key, level: 'L1' });
    }

    const l2Value = await this.runL2(
      'get',
      storageKey,
      () => this.l2?.get(storageKey) ?? Promise.resolve(undefined),
      undefined,
    );

    if (l2Value !== undefined) {
      await this.l1?.set(storageKey, l2Value, this.options);
      this.rememberStale(key, l2Value, this.options);
      this.emit({ type: 'hit', key, level: 'L2' });
      debugLog('cache hit', { key, level: 'L2', promotedTo: this.l1 ? 'L1' : undefined });
      return l2Value;
    }

    if (this.l2) {
      this.emit({ type: 'miss', key, level: 'L2' });
      debugLog('cache miss', { key, level: 'L2' });
    }

    return undefined;
  }

  async getOrSet(key: K, loader: CacheLoader<V>, options: CacheOptions = {}): Promise<V | undefined> {
    const cached = await this.get(key);

    if (cached !== undefined) {
      return cached;
    }

    if (this.hasNegative(key)) {
      return undefined;
    }

    if (this.inflightDisabled(options)) {
      debugLog('cache lazy load', { key, inflight: false });
      return this.loadWithDistributedLock(key, loader, options);
    }

    this.pruneInflight();

    const existing = this.inflight.get(key);

    if (existing && !this.isInflightExpired(existing)) {
      this.emit({ type: 'inflight:reuse', key });
      debugLog('cache inflight reuse', { key });
      return existing.promise;
    }

    debugLog('cache inflight start', { key });

    if (!this.canTrackNewInflight()) {
      this.emit({ type: 'inflight:bypass', key, reason: 'maxEntries' });
      debugLog('cache inflight bypassed', { key, reason: 'maxEntries' });
      return this.loadWithDistributedLock(key, loader, options);
    }

    const promise = this.loadWithDistributedLock(key, loader, options).finally(() => {
      this.inflight.delete(key);
      debugLog('cache inflight complete', { key });
    });

    this.inflight.set(key, {
      key,
      promise,
      startedAt: Date.now(),
      expiresAt: this.getInflightExpiresAt(options),
    });

    return promise;
  }

  async has(key: K): Promise<boolean> {
    if (this.hasNegative(key)) {
      return false;
    }

    const storageKey = this.toStorageKey(key);

    if (this.l1 && await this.l1.has(storageKey)) {
      return true;
    }

    return this.runL2('has', storageKey, () => this.l2?.has(storageKey) ?? Promise.resolve(false), false);
  }

  async delete(key: K): Promise<void> {
    await this.deleteLocal(key);
    debugLog('cache delete', { key });

    await this.publishInvalidation({
      id: createEventId(),
      type: 'del',
      keys: [String(key)],
      source: this.source,
      ts: Date.now(),
      generation: this.getGeneration(String(key)),
    });
  }

  async deleteByPattern(pattern: string): Promise<void> {
    await this.deleteByPatternLocal(pattern);
    debugLog('cache delete pattern', { pattern });

    await this.publishInvalidation({
      id: createEventId(),
      type: 'pattern',
      pattern,
      source: this.source,
      ts: Date.now(),
    });
  }

  async clear(): Promise<void> {
    await this.deleteByPattern('*');
  }

  async size(): Promise<number> {
    if (this.l1) {
      return this.l1.size();
    }

    return this.runL2('size', '*', () => this.l2?.size() ?? Promise.resolve(0), 0);
  }

  on(handler: CacheEventHandler): () => void {
    this.eventHandlers.add(handler);

    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  private async loadAndStore(key: K, loader: CacheLoader<V>, options: CacheOptions): Promise<V | undefined> {
    const startedAt = Date.now();
    const controller = new AbortController();
    let value: V | undefined;

    try {
      this.emit({ type: 'loader:start', key });
      value = await this.runLoaderWithTimeouts(key, loader, controller, options);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const stale = this.getStale(key);

      this.emit({ type: 'loader:error', key, durationMs, error });
      errorLog('cache loader failed', { key, error });

      if (stale !== undefined && this.failSafeEnabled(options)) {
        this.emit({ type: 'stale:hit', key, reason: error instanceof LoaderTimeoutError ? error.reason : 'loader-error' });
        return stale;
      }

      throw error;
    }

    this.emit({ type: 'loader:success', key, durationMs: Date.now() - startedAt });

    if (value === undefined) {
      this.setNegative(key, options);
      const stale = this.getStale(key);

      if (stale !== undefined && this.failSafeEnabled(options)) {
        return stale;
      }

      return undefined;
    }

    await this.set(key, value, options);

    if (this.shouldBroadcastSet()) {
      const event: SetEvent = {
        id: createEventId(),
        type: 'set',
        keys: [String(key)],
        value,
        ttlMs: options.ttlMs ?? this.options.ttlMs,
        source: this.source,
        ts: Date.now(),
        generation: this.getGeneration(String(key)),
      };

      const encodedBytes = encodeInvalidationEvent(event).byteLength;
      const maxBytes = this.options.broadcastSetMaxBytes;

      if (maxBytes !== undefined && encodedBytes > maxBytes) {
        this.emit({
          type: 'set:broadcast-skipped',
          key,
          reason: 'max-bytes',
          bytes: encodedBytes,
          maxBytes,
        });
        debugLog('cache set broadcast skipped because payload is too large', {
          key,
          bytes: encodedBytes,
          maxBytes,
        });
      } else {
        this.emit({ type: 'set:broadcast', key });
        await this.publishInvalidation(event);
      }
    }

    return value;
  }

  private async loadWithDistributedLock(key: K, loader: CacheLoader<V>, options: CacheOptions): Promise<V | undefined> {
    if (!this.distributedLockEnabled(options) || !supportsDistributedLock(this.l2)) {
      return this.loadAndStore(key, loader, options);
    }

    const lockTtlMs = options.distributedLock?.ttlMs ?? this.options.distributedLock?.ttlMs ?? 10_000;
    const waitTimeoutMs = options.distributedLock?.waitTimeoutMs ?? this.options.distributedLock?.waitTimeoutMs ?? 2_000;
    const pollMs = options.distributedLock?.pollMs ?? this.options.distributedLock?.pollMs ?? 50;
    const token = createEventId();
    const acquired = await this.runL2(
      'acquireLock',
      key,
      () => this.l2 && supportsDistributedLock(this.l2)
        ? this.l2.acquireLock(key, token, lockTtlMs)
        : Promise.resolve(false),
      false,
    );

    if (acquired) {
      try {
        return await this.loadAndStore(key, loader, options);
      } finally {
        await this.runL2(
          'releaseLock',
          key,
          () => this.l2 && supportsDistributedLock(this.l2)
            ? this.l2.releaseLock(key, token)
            : Promise.resolve(),
        );
      }
    }

    const waitUntil = Date.now() + waitTimeoutMs;

    while (Date.now() < waitUntil) {
      await sleep(pollMs);

      const cached = await this.get(key);

      if (cached !== undefined) {
        return cached;
      }
    }

    return this.loadAndStore(key, loader, options);
  }

  private async deleteLocal(key: K, generation?: number): Promise<void> {
    this.inflight.delete(key);
    this.negative.delete(key);
    this.stale.delete(key);
    const storageKey = this.toStorageKey(key);
    this.advanceGenerationAfterDelete(String(key), generation);

    await this.l1?.delete(storageKey);
    await this.runL2('delete', storageKey, () => this.l2?.delete(storageKey) ?? Promise.resolve());
    this.emit({ type: 'delete', key });
  }

  private async deleteByPatternLocal(pattern: string): Promise<void> {
    for (const key of this.inflight.keys()) {
      if (matchesPattern(String(key), pattern)) {
        this.inflight.delete(key);
      }
    }

    for (const key of this.negative.keys()) {
      if (matchesPattern(String(key), pattern)) {
        this.negative.delete(key);
      }
    }

    for (const key of this.stale.keys()) {
      if (matchesPattern(String(key), pattern)) {
        this.stale.delete(key);
      }
    }

    await this.l1?.deleteByPattern(pattern);
    await this.runL2('deleteByPattern', pattern, () => this.l2?.deleteByPattern(pattern) ?? Promise.resolve());
    this.emit({ type: 'delete-pattern', pattern });
  }

  private async publishInvalidation(event: Parameters<EventBus['publish']>[0]): Promise<void> {
    if (!this.options.eventBus) {
      return;
    }

    if (!this.eventBusCircuitBreaker.canCall()) {
      debugLog('event-bus publish skipped because circuit is open', {
        type: event.type,
        state: this.eventBusCircuitBreaker.currentState,
      });
      this.emit({
        type: 'event-bus:publish-skipped',
        eventType: event.type,
        state: this.eventBusCircuitBreaker.currentState,
      });
      return;
    }

    try {
      await this.options.eventBus.publish(event);
      this.eventBusCircuitBreaker.recordSuccess();
    } catch (error) {
      const state = this.eventBusCircuitBreaker.recordFailure();
      this.emit({ type: 'event-bus:publish-error', eventType: event.type, state, error });
      errorLog('event-bus publish failed open', { type: event.type, state, error });
    }
  }

  private async runL2<T>(
    operation: string,
    keyOrPattern: CacheKey | string,
    call: () => Promise<T>,
    fallback: T,
  ): Promise<T>;
  private async runL2(
    operation: string,
    keyOrPattern: CacheKey | string,
    call: () => Promise<void>,
  ): Promise<void>;
  private async runL2<T>(
    operation: string,
    keyOrPattern: CacheKey | string,
    call: () => Promise<T>,
    fallback?: T,
  ): Promise<T | void> {
    if (!this.l2) {
      return fallback;
    }

    if (!this.l2CircuitBreaker.canCall()) {
      debugLog('l2 cache operation skipped because circuit is open', {
        operation,
        key: keyOrPattern,
        state: this.l2CircuitBreaker.currentState,
      });
      this.emit({
        type: 'l2:skipped',
        operation,
        key: keyOrPattern,
        state: this.l2CircuitBreaker.currentState,
      });
      return fallback;
    }

    try {
      const result = await call();
      this.l2CircuitBreaker.recordSuccess();
      return result;
    } catch (error) {
      const state = this.l2CircuitBreaker.recordFailure();
      this.emit({ type: 'l2:error', operation, key: keyOrPattern, state, error });
      errorLog('l2 cache operation failed open', { operation, key: keyOrPattern, state, error });
      return fallback;
    }
  }

  private inflightDisabled(options: CacheOptions): boolean {
    return options.inflight?.enabled === false || this.options.inflight?.enabled === false;
  }

  private distributedLockEnabled(options: CacheOptions): boolean {
    return options.distributedLock?.enabled === true || this.options.distributedLock?.enabled === true;
  }

  private canTrackNewInflight(): boolean {
    const maxEntries = this.options.inflight?.maxEntries;

    return maxEntries === undefined || maxEntries > 0 && this.inflight.size < maxEntries;
  }

  private getInflightTtlMs(options: CacheOptions): number | undefined {
    return options.inflight?.ttlMs ?? this.options.inflight?.ttlMs ?? DEFAULT_INFLIGHT_TTL_MS;
  }

  private getInflightExpiresAt(options: CacheOptions): number | undefined {
    const ttlMs = this.getInflightTtlMs(options);

    return ttlMs === undefined ? undefined : Date.now() + ttlMs;
  }

  private isInflightExpired(entry: InflightEntry<K, V>): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= Date.now();
  }

  private pruneInflight(): void {
    for (const [key, entry] of this.inflight) {
      if (this.isInflightExpired(entry)) {
        this.inflight.delete(key);
      }
    }
  }

  private async runLoaderWithTimeouts(
    key: K,
    loader: CacheLoader<V>,
    controller: AbortController,
    options: CacheOptions,
  ): Promise<V | undefined> {
    const softMs = options.timeouts?.softMs ?? this.options.timeouts?.softMs;
    const hardMs = options.timeouts?.hardMs ?? this.options.timeouts?.hardMs;
    const loaderPromise = loader({ signal: controller.signal });
    const stale = this.getStale(key);

    if (softMs !== undefined && stale !== undefined && this.failSafeEnabled(options)) {
      const result = await raceWithTimeout(loaderPromise, softMs, 'soft-timeout');

      if (result.timedOut) {
        controller.abort();
        this.emit({ type: 'loader:timeout', key, timeoutMs: softMs });
        throw new LoaderTimeoutError('soft-timeout');
      }

      return result.value;
    }

    if (hardMs !== undefined) {
      const result = await raceWithTimeout(loaderPromise, hardMs, 'hard-timeout');

      if (result.timedOut) {
        controller.abort();
        this.emit({ type: 'loader:timeout', key, timeoutMs: hardMs });
        throw new LoaderTimeoutError('hard-timeout');
      }

      return result.value;
    }

    return loaderPromise;
  }

  private rememberStale(key: K, value: V, options: CacheOptions): void {
    if (!this.failSafeEnabled(options)) {
      return;
    }

    const staleTtlMs = options.failSafe?.staleTtlMs ?? this.options.failSafe?.staleTtlMs;

    if (staleTtlMs === undefined || staleTtlMs <= 0) {
      return;
    }

    this.stale.set(key, { value, expiresAt: Date.now() + staleTtlMs });
  }

  private getStale(key: K): V | undefined {
    const entry = this.stale.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.stale.delete(key);
      return undefined;
    }

    return entry.value;
  }

  private failSafeEnabled(options: CacheOptions): boolean {
    return options.failSafe?.enabled === true || this.options.failSafe?.enabled === true;
  }

  private hasNegative(key: K): boolean {
    const entry = this.negative.get(key);

    if (!entry) {
      return false;
    }

    if (entry.expiresAt <= Date.now()) {
      this.negative.delete(key);
      return false;
    }

    return true;
  }

  private setNegative(key: K, options: CacheOptions): void {
    if (options.negativeCache?.enabled === false || this.options.negativeCache?.enabled === false) {
      return;
    }

    const ttlMs = options.negativeCache?.ttlMs ?? this.options.negativeCache?.ttlMs;

    if (ttlMs === undefined || ttlMs <= 0) {
      return;
    }

    const maxEntries = options.negativeCache?.maxEntries ?? this.options.negativeCache?.maxEntries;

    while (maxEntries !== undefined && this.negative.size >= maxEntries) {
      const oldestKey = this.negative.keys().next().value;

      if (oldestKey === undefined) {
        break;
      }

      this.negative.delete(oldestKey);
    }

    this.negative.set(key, { expiresAt: Date.now() + ttlMs });
    this.emit({ type: 'negative:set', key, ttlMs });
  }

  private toStorageKey(key: K): K {
    if (this.options.versioning?.enabled !== true) {
      return key;
    }

    return `${String(key)}::v${this.getGeneration(String(key))}` as K;
  }

  private getGeneration(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  private advanceGenerationAfterDelete(key: string, generation?: number): void {
    const currentGeneration = this.getGeneration(key);

    if (generation !== undefined) {
      this.generations.set(key, Math.max(currentGeneration, generation));
      return;
    }

    this.generations.set(key, currentGeneration + 1);
  }

  private advanceGenerationAfterRemoteSet(key: string, generation?: number): void {
    if (generation === undefined) {
      return;
    }

    this.generations.set(key, Math.max(this.getGeneration(key), generation));
  }

  private emit(event: CacheEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        errorLog('cache event handler failed', { event: event.type, error });
      }
    }
  }

  private hasSeenEvent(eventId: string): boolean {
    const seenAt = this.seenEvents.get(eventId);

    if (seenAt === undefined) {
      return false;
    }

    if (Date.now() - seenAt > this.getEventDedupeTtlMs()) {
      this.seenEvents.delete(eventId);
      return false;
    }

    return true;
  }

  private markEventSeen(eventId: string): void {
    this.seenEvents.set(eventId, Date.now());

    while (this.seenEvents.size > this.getEventDedupeMaxEntries()) {
      const oldestId = this.seenEvents.keys().next().value;

      if (oldestId === undefined) {
        return;
      }

      this.seenEvents.delete(oldestId);
    }
  }

  private getEventDedupeMaxEntries(): number {
    return this.options.eventDedupeMaxEntries ?? 10_000;
  }

  private getEventDedupeTtlMs(): number {
    return this.options.eventDedupeTtlMs ?? 5 * 60_000;
  }

  private getActiveLevels(): CacheLevel[] {
    const levels: CacheLevel[] = [];

    if (this.l1) {
      levels.push('L1');
    }

    if (this.l2) {
      levels.push('L2');
    }

    return levels;
  }

  private getLegacyEventId(event: Parameters<EventBus['publish']>[0]): string {
    const suffix =
      event.type === 'del' || event.type === 'set'
        ? event.keys.join(',')
        : event.pattern;

    return `${event.source}:${event.ts}:${event.type}:${suffix}`;
  }

  private isStaleGeneration(key: string, generation?: number): boolean {
    return generation !== undefined && generation < this.getGeneration(key);
  }

  private emitStaleInvalidation(
    event: DeleteEvent | SetEvent,
    eventId: string,
    key: K,
  ): void {
    const localGeneration = this.getGeneration(String(key));

    this.emit({
      type: 'invalidation:stale',
      eventId,
      eventType: event.type,
      key,
      generation: event.generation,
      localGeneration,
    });
    debugLog('event-bus invalidation ignored because generation is stale', {
      eventId,
      eventType: event.type,
      key,
      generation: event.generation,
      localGeneration,
    });
  }

  private async applyRemoteDelete(event: DeleteEvent, eventId: string): Promise<void> {
    await Promise.all(event.keys.map(async (rawKey) => {
      const key = rawKey as K;

      if (this.isStaleGeneration(rawKey, event.generation)) {
        this.emitStaleInvalidation(event, eventId, key);
        return;
      }

      await this.deleteLocal(key, event.generation);
    }));
  }

  private async applyRemoteSet(event: SetEvent, eventId: string): Promise<void> {
    const localOptions: CacheOptions =
      event.ttlMs !== undefined ? { ...this.options, ttlMs: event.ttlMs } : this.options;

    for (const rawKey of event.keys) {
      const key = rawKey as K;

      if (this.isStaleGeneration(rawKey, event.generation)) {
        this.emitStaleInvalidation(event, eventId, key);
        continue;
      }

      this.advanceGenerationAfterRemoteSet(rawKey, event.generation);

      const storageKey = this.toStorageKey(key);

      await this.l1?.set(storageKey, event.value as V, localOptions);
      this.rememberStale(key, event.value as V, localOptions);
      this.negative.delete(key);
      this.inflight.delete(key);
      this.emit({ type: 'set:received', key, level: 'L1' });
      debugLog('cache set:received', { key, level: 'L1' });
    }
  }

  private shouldBroadcastSet(): boolean {
    if (!this.options.eventBus) {
      return false;
    }

    return this.options.broadcastSet !== false;
  }
}

export type LazyLayersCacheOptions<K extends CacheKey = string, V = unknown> = HybridCacheOptions<K, V>;

export class LazyLayersCache<K extends CacheKey = string, V = unknown> extends HybridCache<K, V> {
  constructor(options: LazyLayersCacheOptions<K, V> = {}) {
    super(options);
  }
}

function createSourceId(): string {
  return `cache-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createEventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function raceWithTimeout<V>(
  promise: Promise<V | undefined>,
  timeoutMs: number,
  reason: LoaderTimeoutReason,
): Promise<{ timedOut: false; value: V | undefined } | { timedOut: true; reason: LoaderTimeoutReason }> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true; reason: LoaderTimeoutReason }>((resolve) => {
        timeout = setTimeout(() => resolve({ timedOut: true, reason }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

type LoaderTimeoutReason = 'soft-timeout' | 'hard-timeout';

class LoaderTimeoutError extends Error {
  constructor(readonly reason: LoaderTimeoutReason) {
    super(reason);
  }
}
