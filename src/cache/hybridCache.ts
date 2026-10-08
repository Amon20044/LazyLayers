import type { EventBus, EventBusStatus } from '../event-bus/index.js';
import { randomUUID } from 'node:crypto';
import { decodeInvalidationEvent, encodeInvalidationEvent } from '../event-bus/eventCodec.js';
import type { DeleteEvent, SetEvent } from '../types/event.types.js';
import type {
  AtomicPublishStore,
  AtomicPublicationResult,
  CacheCodecOptions,
  CacheKey,
  CacheLevel,
  CacheLoader,
  CacheOptions,
  CacheStore,
  EncodedCacheStore,
  InflightEntry,
} from '../types/index.js';
import { decodeCacheRecord, serializeWithStats } from '../utils/serializer.js';
import { configureCacheLogger, type CacheLoggerOptions } from '../utils/debugLog.js';
import { debugLog, errorLog } from '../utils/debugLog.js';
import { CircuitBreaker, type CircuitBreakerOptions } from './circuitBreaker.js';
import {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_INFLIGHT_TTL_MS,
  DEFAULT_INFLIGHT_MAX_ENTRIES,
  DEFAULT_L1_MAX_ENTRIES,
  DEFAULT_LOADER_HARD_TIMEOUT_MS,
  DEFAULT_LOCK_TTL_MS,
  DEFAULT_LOCK_POLL_MS,
  DEFAULT_NEGATIVE_MAX_ENTRIES,
  DEFAULT_NEGATIVE_TTL_MS,
  DEFAULT_STALE_TTL_MS,
} from './defaults.js';
import {
  DEFAULT_ORIGIN_MAX_CONCURRENT,
  DEFAULT_ORIGIN_MAX_QUEUED,
  OriginLoadGate,
  OriginLoadClosedError,
  OriginLoadOverloadError,
} from './originLoadGate.js';
import { L2OperationGate, L2OperationOverloadError, defaultL2OperationGateOptions, type L2OperationGateOptions } from './l2OperationGate.js';
import {
  DistributedLockLostError,
  DistributedLockTimeoutError,
  maintainLock,
  supportsDistributedLock,
  type DistributedLockOptions,
  type LoadLease,
} from './distributedLock.js';
import type { CacheEvent, CacheEventHandler } from './events.js';
import { MemoryStore, type MemoryStoreStats } from './memoryStore.js';
import type { MemoryBudget } from './memoryBudget.js';
import { matchesPattern } from './pattern.js';
import { ObservabilityCollector } from '../observability/collector.js';
import { ObservabilityInspector } from '../observability/inspector.js';
import {
  createObservabilityHandler,
  type ObservabilityRequestHandler,
} from '../observability/handler.js';
import {
  startObservabilityServer,
  type ObservabilityServerHandle,
} from '../observability/server.js';
import {
  resolveObservabilityOptions,
  type ObservabilityOptions,
} from '../observability/types.js';
import { publishTelemetry, TELEMETRY_CHANNEL_NAME } from '../observability/telemetry.js';

interface StaleEntry {
  encoded: Buffer;
  bytes: number;
  expiresAt: number;
}

interface NegativeEntry {
  expiresAt: number;
  bytes: number;
}

interface KeyRevision {
  value: number;
  references: number;
  bytes: number;
  registered: boolean;
}

interface MutationGuard<K extends CacheKey> {
  key: K;
  state: KeyRevision;
  revision: number;
  epoch: number;
  storageKey: K;
  signal?: AbortSignal;
  publicationAllowed?: boolean;
}

/** Closing is terminal; statistics remain available for shutdown diagnostics. */
export class CacheClosedError extends Error {
  readonly code = 'CACHE_CLOSED';
  constructor() { super('Cache is closed'); this.name = 'CacheClosedError'; }
}

export class InflightOverloadError extends Error {
  readonly code = 'INFLIGHT_OVERLOADED';
  constructor(readonly key: CacheKey) {
    super('The cache singleflight follower budget is full');
    this.name = 'InflightOverloadError';
  }
}

const MAX_GENERATION_ENTRIES = 10_000;
const MAX_GENERATION_BYTES = 2 * 1024 * 1024;
const MAX_AUXILIARY_MAP_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_WAITERS = 10_000;
const FOLLOWER_METADATA_BYTES = 160;

export interface HybridCacheResilienceOptions {
  l2CircuitBreaker?: CircuitBreakerOptions;
  l2OperationGate?: L2OperationGateOptions;
  eventBusCircuitBreaker?: CircuitBreakerOptions;
}

export type CacheLayer<K extends CacheKey = string, V = unknown> = CacheStore<K, V> | false;

export interface HybridCacheOptions<K extends CacheKey = string, V = unknown> extends CacheOptions {
  l1?: CacheLayer<K, V>;
  l2?: CacheLayer<K, V>;
  eventBus?: EventBus;
  /** Events are accepted only from this exact scope when configured. */
  eventNamespace?: string;
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
  /**
   * Enable the live observability dashboard. `true` uses defaults (localhost
   * server on port 7077 at /observelazyily, credentials lazydev/lazydev), or pass
   * an options object. Disabled by default — zero hot-path cost when off.
   */
  observability?: boolean | ObservabilityOptions;
}

export class HybridCache<K extends CacheKey = string, V = unknown> implements CacheStore<K, V> {
  private readonly l1?: CacheStore<K, V>;
  private readonly l2?: CacheStore<K, V>;
  private readonly inflight = new Map<K, InflightEntry<K, V> & { bytes: number }>();
  private readonly source: string;
  private readonly l2CircuitBreaker: CircuitBreaker;
  private readonly eventBusCircuitBreaker: CircuitBreaker;
  private readonly stale = new Map<K, StaleEntry>();
  private readonly memoryBudget?: MemoryBudget;
  private readonly ownsL1: boolean;
  private readonly unregisterStaleBudget?: () => void;
  private staleBytes = 0;
  private readonly negative = new Map<K, NegativeEntry>();
  private readonly generations = new Map<string, number>();
  private readonly seenEvents = new Map<string, number>();
  private readonly keyRevisions = new Map<K, KeyRevision>();
  private readonly activeLeaders = new Set<AbortController>();
  private readonly maxActiveLeaders: number;
  private generationBytes = 0;
  private negativeBytes = 0;
  private seenEventBytes = 0;
  private keyRevisionBytes = 0;
  private inflightBytes = 0;
  private activeFollowers = 0;
  private rejectedFollowers = 0;
  private followerBytes = 0;
  private readonly maxWaiters: number;
  private generationTrackingSaturated = false;
  private closed = false;
  private invalidationTrusted = true;
  private mutationEpoch = 0;
  private invalidationRevision = 0;
  private lastBusStatus?: EventBusStatus;
  private removeBusStatusListener?: () => void;
  private readonly eventHandlers = new Set<CacheEventHandler>();
  private readonly readyPromise: Promise<void>;
  private subscriptionError?: unknown;
  private closePromise?: Promise<void>;
  private observabilityHandler?: ObservabilityRequestHandler;
  private observabilityServer?: ObservabilityServerHandle;
  private readonly originGate: OriginLoadGate<K>;
  private readonly l2Gate: L2OperationGate;

  constructor(private readonly options: HybridCacheOptions<K, V> = {}) {
    validateCacheBudgets(options);
    assertBudget('eventDedupeMaxEntries', options.eventDedupeMaxEntries, true);
    assertBudget('eventDedupeTtlMs', options.eventDedupeTtlMs);
    assertBudget('broadcastSetMaxBytes', options.broadcastSetMaxBytes, true);
    if (options.eventNamespace !== undefined && (typeof options.eventNamespace !== 'string'
      || Buffer.byteLength(options.eventNamespace) > 64 * 1024
      || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(options.eventNamespace))) {
      throw new TypeError('eventNamespace must be a well-formed Unicode string of at most 64 KiB');
    }
    configureCacheLogger(options.logging);
    this.ownsL1 = options.l1 === undefined;
    this.l1 = options.l1 === false ? undefined : options.l1 ?? new MemoryStore<K, V>(options);
    this.memoryBudget = options.memoryBudget
      ?? (this.l1 as { memoryBudget?: MemoryBudget } | undefined)?.memoryBudget;
    this.unregisterStaleBudget = this.memoryBudget && options.failSafe?.enabled !== false
      ? this.memoryBudget.register(() => this.evictOneStale())
      : undefined;
    this.l2 = options.l2 === false ? undefined : options.l2;
    this.source = options.source ?? createSourceId();
    this.l2CircuitBreaker = new CircuitBreaker(options.resilience?.l2CircuitBreaker);
    this.l2Gate = new L2OperationGate(defaultL2OperationGateOptions(options.resilience?.l2OperationGate));
    this.eventBusCircuitBreaker = new CircuitBreaker(options.resilience?.eventBusCircuitBreaker);
    this.originGate = new OriginLoadGate(options.originLoad, this.memoryBudget);
    this.maxActiveLeaders = (options.originLoad?.maxConcurrent ?? DEFAULT_ORIGIN_MAX_CONCURRENT)
      + (options.originLoad?.maxQueued ?? DEFAULT_ORIGIN_MAX_QUEUED);
    this.maxWaiters = options.inflight?.maxWaiters ?? DEFAULT_MAX_WAITERS;
    options.events?.forEach((handler) => this.eventHandlers.add(handler));

    if (options.eventBus && options.subscribeToEvents !== false) {
      this.invalidationTrusted = false;
      this.removeBusStatusListener = options.eventBus.onStatus?.((status: EventBusStatus) => {
        if (this.closed) return;
        this.lastBusStatus = status;
        if (status === 'connecting' || status === 'disconnected' || status === 'error') this.markInvalidationUntrusted();
        if (status === 'subscribed') void this.restoreInvalidationTrust().catch((error) => {
          this.markInvalidationUntrusted();
          errorLog('failed to reconcile L1 after event-bus recovery', { error });
        });
      });
      this.readyPromise = options.eventBus
        .subscribe(async (rawEvent) => {
          if (this.closed) return;
          // Custom adapters receive the same metadata checks as built-in buses.
          // Other scopes cannot affect trust or consume this cache's dedupe budget.
          if (this.options.eventNamespace !== undefined && typeof rawEvent === 'object' && rawEvent !== null
            && !(rawEvent instanceof Uint8Array) && rawEvent.namespace !== this.options.eventNamespace) return;
          const event = decodeInvalidationEvent(rawEvent);
          if (!event) {
            this.markInvalidationUntrusted();
            return;
          }
          if (this.options.eventNamespace !== undefined
            && event.namespace !== this.options.eventNamespace) return;
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

          try {
            if (event.type === 'del') {
              await this.applyRemoteDelete(event, eventId);
              return;
            }

            if (event.type === 'set') {
              await this.applyRemoteSet(event, eventId);
              return;
            }

            await this.deleteByPatternLocal(event.pattern, false);
          } catch (error) {
            // Forget the event so a redelivery can actually be retried. Left
            // marked as seen, the redelivery a durable transport pays for would
            // be dropped as a duplicate and the invalidation lost for good.
            this.removeSeenEvent(eventId);
            throw error;
          }
        })
        .catch((error) => {
          this.subscriptionError = error;
          errorLog('event-bus subscription failed', { error });
          throw error;
        });
      this.readyPromise = this.readyPromise.then(() => this.restoreInvalidationTrust());
    } else {
      this.readyPromise = Promise.resolve();
    }

    this.setupObservability();
  }

  /**
   * Wire up the observability dashboard when enabled. The collector subscribes to
   * the same event stream `on()` uses, so the only hot-path cost is one extra
   * O(1) handler in the already-running emit loop. When disabled, this is a no-op.
   */
  private setupObservability(): void {
    const resolved = resolveObservabilityOptions(this.options.observability);

    if (!resolved.enabled) {
      return;
    }

    const collector = new ObservabilityCollector(resolved.maxEvents);
    this.eventHandlers.add(collector.handle);

    const inspector = new ObservabilityInspector({
      l1: this.l1 as CacheStore<CacheKey, unknown> | undefined,
      l2: this.l2 as CacheStore<CacheKey, unknown> | undefined,
      options: this.options,
      source: this.source,
      route: resolved.route,
      maxValueBytes: resolved.maxValueBytes,
      l2CircuitBreaker: this.l2CircuitBreaker,
      eventBusCircuitBreaker: this.eventBusCircuitBreaker,
      eventBus: this.options.eventBus,
      prometheus: resolved.prometheus.enabled
        ? {
            enabled: true,
            prefix: resolved.prometheus.prefix,
            endpoint: `${resolved.route}/metrics`,
          }
        : undefined,
      telemetryChannel: TELEMETRY_CHANNEL_NAME,
    });

    this.observabilityHandler = createObservabilityHandler({
      collector,
      inspector,
      options: resolved,
    });

    if (resolved.server) {
      try {
        this.observabilityServer = startObservabilityServer(this.observabilityHandler, {
          host: resolved.server.host,
          port: resolved.server.port,
          route: resolved.route,
        });
        debugLog('observability dashboard listening', { url: this.observabilityServer.url });
      } catch (error) {
        errorLog('observability server failed to start', { error });
      }
    }

    if (!resolved.quiet) {
      const where = this.observabilityServer ? ` at ${this.observabilityServer.url}` : ' (mounted handler)';
      // Intentionally console.warn (not the gated logger): this must surface even
      // in production, which is exactly where you do NOT want it left enabled.
      console.warn(
        `[lazy-layers-cache] Observability dashboard enabled${where}. ` +
          'It exposes cache contents + live activity and is intended for development/staging. ' +
          'Secure it (token / localhost bind) and avoid leaving it on in production. ' +
          'Set observability.quiet=true (or LAZY_OBS_QUIET=1) to silence this notice.',
      );
    }
  }

  /**
   * The framework-agnostic dashboard request handler, for mounting into an
   * existing HTTP server (Express/Fastify/raw http). Returns `undefined` when
   * observability is disabled. Returns `true` from the handler if it answered the
   * request, `false` to pass through.
   */
  getObservabilityHandler(): ObservabilityRequestHandler | undefined {
    return this.observabilityHandler;
  }

  /** The standalone dashboard server handle, if one was auto-started. */
  getObservabilityServer(): ObservabilityServerHandle | undefined {
    return this.observabilityServer;
  }

  /** Bounded origin-load health counters, suitable for a metrics adapter. */
  getOriginLoadStats(): ReturnType<OriginLoadGate<K>['stats']> {
    return this.originGate.stats();
  }

  /** Built-in L1 byte/admission counters, when the selected store exposes them. */
  getMemoryStats(): MemoryStoreStats | undefined {
    return this.l1 instanceof MemoryStore ? this.l1.stats() : undefined;
  }

  getL2OperationStats(): ReturnType<L2OperationGate['stats']> { return this.l2Gate.stats(); }

  getCoordinationStats(): { activeLeaders: number; maxActiveLeaders: number; generationEntries: number; generationBytes: number; generationTrackingSaturated: boolean; negativeBytes: number; eventDedupeBytes: number; keyRevisionBytes: number; inflightBytes: number; inflightEntries: number; activeFollowers: number; maxWaiters: number; rejectedFollowers: number; followerBytes: number } {
    return {
      activeLeaders: this.activeLeaders.size,
      maxActiveLeaders: this.maxActiveLeaders,
      generationEntries: this.generations.size,
      generationBytes: this.generationBytes,
      generationTrackingSaturated: this.generationTrackingSaturated,
      negativeBytes: this.negativeBytes,
      eventDedupeBytes: this.seenEventBytes,
      keyRevisionBytes: this.keyRevisionBytes,
      inflightBytes: this.inflightBytes,
      inflightEntries: this.inflight.size,
      activeFollowers: this.activeFollowers,
      maxWaiters: this.maxWaiters,
      rejectedFollowers: this.rejectedFollowers,
      followerBytes: this.followerBytes,
    };
  }

  /** Stop the standalone observability server (if any). Safe to call when off. */
  async closeObservability(): Promise<void> {
    if (this.observabilityServer) {
      await this.observabilityServer.close();
      this.observabilityServer = undefined;
    }
  }

  /**
   * Wait until the event-bus subscription is active. Constructors cannot be
   * asynchronous, so managed startup calls this before accepting traffic.
   */
  async ready(): Promise<void> {
    this.ensureOpen();
    await this.readyPromise;

    if (this.subscriptionError !== undefined) {
      throw this.subscriptionError;
    }
  }

  /** Release resources owned by the cache. Safe to call more than once. */
  async close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    await this.closePromise;
  }

  private async closeResources(): Promise<void> {
    this.closed = true;
    this.mutationEpoch += 1;
    this.invalidationRevision += 1;
    // Reject queued origin work with its established gate error before aborting
    // the active leaders' cooperative cancellation signals.
    this.originGate.close();
    for (const controller of this.activeLeaders) controller.abort(new CacheClosedError());
    this.activeLeaders.clear();
    this.clearInflight();
    this.clearNegative();
    this.memoryBudget?.release(this.generationBytes, 'coordination-metadata');
    this.generations.clear();
    this.generationBytes = 0;
    this.memoryBudget?.release(this.seenEventBytes + this.keyRevisionBytes, 'coordination-metadata');
    this.seenEvents.clear();
    this.seenEventBytes = 0;
    this.keyRevisionBytes = 0;
    for (const state of this.keyRevisions.values()) state.registered = false;
    this.keyRevisions.clear();
    this.removeBusStatusListener?.();
    this.removeBusStatusListener = undefined;
    this.l2Gate.close();
    this.clearStale();
    this.unregisterStaleBudget?.();
    if (this.ownsL1 && this.l1 instanceof MemoryStore) this.l1.close();
    const results = await Promise.allSettled([
      this.closeObservability(),
      this.options.eventBus?.disconnect?.() ?? Promise.resolve(),
    ]);
    const failures = results.filter((result) => result.status === 'rejected');

    if (failures.length === 1) {
      throw failures[0].reason;
    }

    if (failures.length > 1) {
      throw new AggregateError(failures.map((failure) => failure.reason), 'Cache cleanup failed');
    }
  }

  async set(key: K, value: V, options: CacheOptions = {}): Promise<void> {
    this.ensureOpen();
    validateCacheBudgets(options);
    const guard = this.observeKey(key, true);
    try { await this.writeValue(key, value, options, guard); }
    finally { this.releaseKey(guard); }
  }

  private async writeValue(key: K, value: V, options: CacheOptions, guard: MutationGuard<K>): Promise<boolean> {
    if (!this.isCurrent(guard)) return false;
    const storageKey = guard.storageKey;

    const l1EncodedStore = this.isEncodedStore(this.l1);
    const l2EncodedStore = this.isEncodedStore(this.l2);
    const samePolicy = l1EncodedStore && l2EncodedStore
      && this.sameLayerCodecPolicy(options, 'L1', 'L2');
    let sharedEncoded: Buffer | undefined;
    let encodedL1: Buffer | undefined;
    let encodedL2: Buffer | undefined;
    if (samePolicy) {
      try { sharedEncoded = serializeWithStats(value, this.layerCodecOptions(options, 'L1')).buffer; }
      catch { /* value remains available to the caller */ }
      encodedL1 = sharedEncoded;
      encodedL2 = sharedEncoded;
    } else {
      if (l1EncodedStore) {
        try { encodedL1 = serializeWithStats(value, this.layerCodecOptions(options, 'L1')).buffer; }
        catch { /* value remains available to the caller */ }
      }
      if (l2EncodedStore) {
        try { encodedL2 = serializeWithStats(value, this.layerCodecOptions(options, 'L2')).buffer; }
        catch { /* value remains available to the caller */ }
      }
    }

    if (encodedL1 && l1EncodedStore) {
      await this.l1.setEncoded(storageKey, encodedL1, options);
    } else {
      await this.l1?.set(storageKey, value, options);
    }
    if (!this.isCurrent(guard)) {
      await this.discardObsoleteL1(storageKey);
      return false;
    }
    await this.runL2('set', storageKey, () => {
      if (!this.isCurrent(guard)) return Promise.resolve();
      if (encodedL2 && l2EncodedStore) return this.l2.setEncoded(storageKey, encodedL2, options);
      return this.l2?.set(storageKey, value, options) ?? Promise.resolve();
    }, undefined, encodedL2?.byteLength ?? 0);
    if (!this.isCurrent(guard)) {
      await this.discardObsoleteL1(storageKey);
      return false;
    }
    this.rememberStale(key, value, options, encodedL1 ?? encodedL2);
    this.removeNegative(key);

    this.emit({ type: 'set', key, levels: this.getActiveLevels() });
    debugLog('cache set', { key, levels: this.getActiveLevels() });
    return true;
  }

  async get(key: K): Promise<V | undefined> {
    this.ensureOpen();
    if (!this.versionedCacheSafe()) return undefined;
    const guard = this.observeKey(key);
    try { return await this.readValue(key, guard); }
    finally { this.releaseKey(guard); }
  }

  private async readValue(key: K, guard: MutationGuard<K>): Promise<V | undefined> {
    if (this.invalidationTrusted && this.hasNegative(key)) {
      this.emit({ type: 'miss', key, level: 'negative' });
      return undefined;
    }

    const storageKey = guard.storageKey;

    if (this.invalidationTrusted && this.l1) {
      let l1Encoded: { buffer: Buffer; ttlRemainingMs: number; originalBytes?: number } | undefined;
      let corruptL1 = false;
      let l1Value: V | undefined;
      if (this.isEncodedStore(this.l1)) {
        l1Encoded = await this.l1.getEncoded(storageKey);
        if (l1Encoded) {
          const record = decodeCacheRecord(l1Encoded.buffer, this.options.decodeLimits);
          corruptL1 = !record.hit;
          if (record.hit) l1Value = record.value as V;
        }
      } else {
        l1Value = await this.l1.get(storageKey);
      }

      if (corruptL1 && this.isCurrent(guard) && this.invalidationTrusted) {
        await this.l1.delete(storageKey);
      }

      if (l1Value !== undefined) {
        if (!this.isCurrent(guard) || !this.invalidationTrusted) return l1Value;
        this.rememberStale(key, l1Value, this.options, l1Encoded?.buffer);
        this.emit({ type: 'hit', key, level: 'L1' });
        debugLog('cache hit', { key, level: 'L1' });
        return l1Value;
      }

      this.emit({ type: 'miss', key, level: 'L1' });
      debugLog('cache miss', { key, level: 'L1' });
    }

    let encodedL2: { buffer: Buffer; ttlRemainingMs: number } | undefined;
    const l2ReadStarted = performance.now();
    const l2Value = await this.runL2(
      'get',
      storageKey,
      async () => {
        if (this.isEncodedStore(this.l2)) {
          encodedL2 = await this.l2.getEncoded(storageKey);
          return encodedL2 ? this.decodeValue(encodedL2.buffer) : undefined;
        }
        return this.l2?.get(storageKey) ?? Promise.resolve(undefined);
      },
      undefined,
    );

    if (l2Value !== undefined) {
      if (!this.invalidationTrusted || !this.isCurrent(guard)) return l2Value;
      if (encodedL2 && encodedL2.ttlRemainingMs >= 0) {
        encodedL2.ttlRemainingMs = Math.max(0, encodedL2.ttlRemainingMs - (performance.now() - l2ReadStarted));
      }
      const promoted = await this.promoteToL1(key, storageKey, l2Value, this.options, encodedL2);
      if (!this.invalidationTrusted || !this.isCurrent(guard)) {
        await this.discardObsoleteL1(storageKey);
        return l2Value;
      }
      this.rememberStale(key, l2Value, this.options, encodedL2?.buffer);
      this.emit({ type: 'hit', key, level: 'L2' });
      debugLog('cache hit', { key, level: 'L2', promotedTo: promoted ? 'L1' : undefined });
      return l2Value;
    }

    if (this.l2) {
      this.emit({ type: 'miss', key, level: 'L2' });
      debugLog('cache miss', { key, level: 'L2' });
    }

    return undefined;
  }

  async getOrSet(key: K, loader: CacheLoader<V>, options: CacheOptions = {}): Promise<V | undefined> {
    this.ensureOpen();
    validateCacheBudgets(options);
    if (!this.inflightDisabled(options)) {
      this.pruneInflightKey(key);
      const existing = this.inflight.get(key);
      if (existing && !this.isInflightExpired(existing)) {
        this.emit({ type: 'inflight:reuse', key });
        debugLog('cache inflight reuse', { key });
        return this.joinInflight(key, existing, options);
      }
    }

    const cached = await this.get(key);

    if (cached !== undefined) {
      return cached;
    }
    if (this.closed) throw new OriginLoadClosedError();

    if (this.invalidationTrusted && this.hasNegative(key)) {
      return undefined;
    }

    if (this.inflightDisabled(options)) {
      debugLog('cache lazy load', { key, inflight: false });
      return this.loadWithDistributedLock(key, loader, options);
    }

    this.pruneInflightKey(key);

    const existing = this.inflight.get(key);

    if (existing && !this.isInflightExpired(existing)) {
      this.emit({ type: 'inflight:reuse', key });
      debugLog('cache inflight reuse', { key });
      return this.joinInflight(key, existing, options);
    }

    debugLog('cache inflight start', { key });

    const bytes = this.reserveInflight(key);
    if (bytes === undefined) {
      this.emit({ type: 'inflight:bypass', key, reason: 'maxEntries' });
      debugLog('cache inflight bypassed', { key, reason: 'maxEntries' });
      return this.loadWithDistributedLock(key, loader, options);
    }

    // Register the entry before calling any custom store/loader, which can
    // synchronously re-enter close() and release all tracked reservations.
    const promise = Promise.resolve().then(() => this.loadWithDistributedLock(key, loader, options)).finally(() => {
      // An expired or invalidated entry may have been replaced while we waited.
      if (this.inflight.get(key)?.promise === promise) {
        this.removeInflight(key);
      }
      debugLog('cache inflight complete', { key });
    });

    this.inflight.set(key, {
      key,
      promise,
      bytes,
      startedAt: Date.now(),
      expiresAt: this.getInflightExpiresAt(options),
    });

    return promise;
  }

  /** Warm one key through the full read-through and peer-priming path. */
  async prewarm(key: K, loader: CacheLoader<V>, options: CacheOptions = {}): Promise<V | undefined> {
    return this.getOrSet(key, loader, options);
  }

  async has(key: K): Promise<boolean> {
    this.ensureOpen();
    if (!this.versionedCacheSafe()) return false;
    if (this.hasNegative(key)) {
      return false;
    }

    const storageKey = this.toStorageKey(key);

    if (this.invalidationTrusted && this.l1 && await this.l1.has(storageKey)) {
      return true;
    }

    return this.runL2('has', storageKey, () => this.l2?.has(storageKey) ?? Promise.resolve(false), false);
  }

  async delete(key: K): Promise<void> {
    this.ensureOpen();
    await this.deleteLocal(key);
    debugLog('cache delete', { key });

    await this.publishInvalidation({
      id: createEventId(),
      type: 'del',
      keys: [String(key)],
      source: this.source,
      ts: Date.now(),
      ...(this.generationForEvent(String(key)) === undefined ? {} : { generation: this.generationForEvent(String(key)) }),
      keyTypes: [typeof key === 'number' ? 'number' : 'string'],
    });
  }

  /** Invalidate one key locally, in L2, and across the event bus. */
  async invalidate(key: K): Promise<void> {
    await this.delete(key);
  }

  async deleteByPattern(pattern: string): Promise<void> {
    this.ensureOpen();
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

  /** Invalidate every matching key locally, in L2, and across the event bus. */
  async invalidateByPattern(pattern: string): Promise<void> {
    await this.deleteByPattern(pattern);
  }

  async clear(): Promise<void> {
    await this.deleteByPattern('*');
  }

  async size(): Promise<number> {
    this.ensureOpen();
    if (!this.versionedCacheSafe()) return 0;
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

  private async loadAndStore(
    key: K,
    loader: CacheLoader<V>,
    options: CacheOptions,
    guard: MutationGuard<K>,
    controller: AbortController,
    lease?: LoadLease,
    leaseToken?: string,
  ): Promise<V | undefined> {
    const startedAt = Date.now();
    let value: V | undefined;
    try {
      controller.signal.throwIfAborted();
      lease?.assertOwned();
      // Recheck both before and after queueing: another writer may fill the key.
      const queuedCached = await this.get(key);
      if (queuedCached !== undefined || this.hasNegative(key)) return queuedCached;
      let releaseOrigin: (() => void) | undefined;
      try {
        if (this.originLoadEnabled(options)) {
          releaseOrigin = await this.originGate.acquire(key, controller.signal);
        }
        controller.signal.throwIfAborted();
        lease?.assertOwned();
        const admittedCached = await this.get(key);
        controller.signal.throwIfAborted();
        lease?.assertOwned();
        if (admittedCached !== undefined || this.hasNegative(key)) return admittedCached;
        const reservation = releaseOrigin;
        const guardedLoader: CacheLoader<V> = (context) =>
          Promise.resolve()
            .then(() => {
              controller.signal.throwIfAborted();
              return loader(context);
            })
            .finally(() => reservation?.());
        // Once the loader starts, actual completion owns this reservation.
        // A caller timeout must not release a still-running origin operation.
        releaseOrigin = undefined;
        this.emit({ type: 'loader:start', key });
        const loading = this.runLoaderWithTimeouts(key, guardedLoader, controller, options);
        value = await (lease ? Promise.race([loading, lease.lost]) : loading);
        lease?.assertOwned();
      } finally {
        releaseOrigin?.();
      }
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const stale = this.getStale(key);

      this.emit({ type: 'loader:error', key, durationMs, error });
      errorLog('cache loader failed', { key, error });

      if (stale !== undefined && this.failSafeEnabled(options)) {
        this.emit({ type: 'stale:hit', key, reason: error instanceof LoaderTimeoutError ? error.reason : 'loader-error' });
        return stale;
      }

      if (error instanceof OriginLoadOverloadError || (error as { code?: string })?.code === 'ORIGIN_LOAD_CLOSED') {
        if (stale !== undefined && this.failSafeEnabled(options)) {
          this.emit({ type: 'stale:hit', key, reason: 'loader-error' });
          return stale;
        }
      }

      throw error;
    }

    this.emit({ type: 'loader:success', key, durationMs: Date.now() - startedAt });

    if (value === undefined) {
      if (guard.publicationAllowed === false) return undefined;
      if (!this.isCurrent(guard)) return undefined;
      this.setNegative(key, options);
      const stale = this.getStale(key);

      if (stale !== undefined && this.failSafeEnabled(options)) {
        return stale;
      }

      return undefined;
    }

    lease?.assertOwned();
    if (guard.publicationAllowed === false) return value;
    if (!this.isCurrent(guard)) return value;

    const atomicPublisher = lease && leaseToken
      ? this.getAtomicPublisher(this.l2)
      : undefined;

    if (atomicPublisher && lease && leaseToken) {
      const ownerToken = leaseToken;
      let encodedL2: Buffer | undefined;
      try {
        encodedL2 = serializeWithStats(value, this.layerCodecOptions(options, 'L2')).buffer;
      } catch {
        /* Keep the established fail-open behavior for values that cannot be
         * represented on the L2 wire. They are still useful to this caller,
         * but cannot satisfy the encoded atomic publication contract. */
      }

      if (!encodedL2) {
        // No authoritative publication occurred. Return the loader's value
        // without emitting success or creating local/peer cache state.
        return value;
      } else {
        const publication = await this.runL2<AtomicPublicationResult | undefined>(
          'publishIfOwner',
          guard.storageKey,
          () => this.isCurrent(guard)
            ? atomicPublisher.publishIfOwner(guard.storageKey, ownerToken, encodedL2!, options)
            : Promise.resolve(undefined),
          undefined,
          encodedL2.byteLength,
        );

        if (publication === 'not-owner') {
          /* A clean rejection is not a Redis outage. Re-read the winner when
           * one exists; otherwise surface lease loss instead of claiming the
           * uncommitted loader result was cached. */
          /* Bypass L1 here. A peer may have won in L2 while this process still
           * holds an older local value from before the lease was acquired. */
          const winner = await this.runL2<V | undefined>(
            'read-after-lease-loss',
            guard.storageKey,
            async () => {
              if (this.isEncodedStore(this.l2)) {
                const encodedWinner = await this.l2.getEncoded(guard.storageKey);
                return encodedWinner ? this.decodeValue(encodedWinner.buffer) : undefined;
              }
              return this.l2?.get(guard.storageKey) ?? Promise.resolve(undefined);
            },
            undefined,
          );
          if (winner !== undefined) return winner;
          throw new DistributedLockLostError(key);
        }

        if (publication !== 'published') {
          /* The command may have failed before or after Redis applied it. Do
           * not replay through set() and do not populate L1 from an uncertain
           * mutation; the caller can use the loader result and the next read
           * will reconcile against Redis. */
          return value;
        }
        if (!this.invalidationTrusted || !this.isCurrent(guard)) return value;

        /* L2 is committed. L1/stale/event publication is conditional on the
         * local invalidation epoch, so a concurrent delete cannot be undone by
         * this asynchronous promotion. */
        const encodedL1 = this.isEncodedStore(this.l1)
          ? (this.sameLayerCodecPolicy(options, 'L1', 'L2')
            ? encodedL2
            : this.tryEncodeForLayer(value, options, 'L1'))
          : undefined;
        await this.setL1Only(guard.storageKey, value, options, encodedL1);
        if (!this.invalidationTrusted || !this.isCurrent(guard)) {
          await this.discardObsoleteL1(guard.storageKey);
          return value;
        }
        this.rememberStale(key, value, options, encodedL1 ?? encodedL2);
        this.removeNegative(key);
        this.emit({ type: 'set', key, levels: this.getActiveLevels() });
        debugLog('cache set', { key, levels: this.getActiveLevels(), publication: 'atomic' });
      }
    } else {
      /* Custom lock stores from earlier releases do not expose an atomic
       * publisher. Keep their compatibility path; the optional capability is
       * what lets RedisStore provide the stronger lease-safe guarantee. */
      if (!await this.writeValue(key, value, options, guard)) return value;
      lease?.assertOwned();
    }

    if (this.shouldBroadcastSet() && this.isCurrent(guard)) {
      const event: SetEvent = {
        id: createEventId(),
        type: 'set',
        keys: [String(key)],
        value,
        ttlMs: options.ttlMs ?? this.options.ttlMs,
        source: this.source,
        ts: Date.now(),
        ...(this.generationForEvent(String(key)) === undefined ? {} : { generation: this.generationForEvent(String(key)) }),
        keyTypes: [typeof key === 'number' ? 'number' : 'string'],
      };

      /*
       * A value that cannot be encoded must not fail the read. The loader has
       * already succeeded and L1 holds the real object, so the correct
       * degradation is to skip the broadcast and let peers load it themselves.
       */
      let encodedBytes: number;

      try {
        encodedBytes = encodeInvalidationEvent(event).byteLength;
      } catch (error) {
        this.emit({ type: 'set:broadcast-skipped', key, reason: 'encode-failed' });
        errorLog('cache set broadcast skipped because the value could not be encoded', { key, error });
        return value;
      }

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
    this.ensureOpen();
    this.originGate.ensureOpen();
    if (this.activeLeaders.size >= this.maxActiveLeaders) {
      const stale = this.getStale(key);
      if (stale !== undefined && this.failSafeEnabled(options)) return stale;
      throw new OriginLoadOverloadError(key);
    }
    const controller = new AbortController();
    const guard = this.observeKey(key);
    guard.signal = controller.signal;
    this.activeLeaders.add(controller);
    try { return await this.loadWithDistributedLockInternal(key, loader, options, guard, controller); }
    finally { this.activeLeaders.delete(controller); this.releaseKey(guard); }
  }

  private async loadWithDistributedLockInternal(
    key: K, loader: CacheLoader<V>, options: CacheOptions,
    guard: MutationGuard<K>, controller: AbortController,
  ): Promise<V | undefined> {
    const l2 = this.l2;
    if (!this.distributedLockEnabled(options) || !supportsDistributedLock(l2)) {
      return this.loadAndStore(key, loader, options, guard, controller);
    }

    /* Locks and data must be derived from the same versioned storage key. This
     * matters when per-key generations are enabled: a lease for v0 must never
     * authorize publication into v1. */
    const storageKey = guard.storageKey;

    const lockTtlMs = options.distributedLock?.ttlMs ?? this.options.distributedLock?.ttlMs ?? DEFAULT_LOCK_TTL_MS;
    const pollMs = options.distributedLock?.pollMs ?? this.options.distributedLock?.pollMs ?? DEFAULT_LOCK_POLL_MS;
    const waitTimeoutMs = this.getLockWaitTimeoutMs(options);
    const onTimeout = options.distributedLock?.onTimeout ?? this.options.distributedLock?.onTimeout ?? 'throw';
    if (!Number.isFinite(lockTtlMs) || lockTtlMs <= 0
      || !Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0
      || !Number.isFinite(pollMs) || pollMs <= 0) {
      throw new RangeError('Distributed lock ttlMs and pollMs must be positive and finite, and waitTimeoutMs must be non-negative and finite');
    }
    const token = createEventId();
    const waitUntil = performance.now() + waitTimeoutMs;
    let contended = false;

    while (true) {
      controller.signal.throwIfAborted();
      this.ensureOpen();
      const acquiredAt = Date.now();
      const acquired = await this.runL2<boolean | undefined>(
        'acquireLock', storageKey, () => l2.acquireLock(storageKey, token, lockTtlMs), undefined,
      );

      if (acquired) {
        const lease = maintainLock(key, lockTtlMs, acquiredAt, l2.renewLock
          ? () => this.runL2('renewLock', storageKey, () => l2.renewLock!(storageKey, token, lockTtlMs), false)
          : undefined);
        const abortLease = () => {
          if (controller.signal.reason instanceof CacheClosedError) lease.stop();
          lease.controller.abort(controller.signal.reason);
        };
        controller.signal.addEventListener('abort', abortLease, { once: true });
        if (controller.signal.aborted) abortLease();
        guard.signal = lease.controller.signal;
        try {
          // A previous owner may have filled L2 between our miss and acquisition.
          const cached = await this.get(key);
          if (cached !== undefined) return cached;
          if (this.hasNegative(key)) return undefined;
          return await this.loadAndStore(key, loader, options, guard, lease.controller, lease, token);
        } finally {
          controller.signal.removeEventListener('abort', abortLease);
          lease.stop();
          await this.runL2('releaseLock', storageKey, () => l2.releaseLock(storageKey, token));
        }
      }

      // Preserve fail-open on Redis failure, but do not mistake contention for
      // an outage or bypass an owner we have already observed.
      if (acquired === undefined && !contended) {
        // A failed acquisition is not permission to replace a protected v2
        // winner. Fail open to this caller, without publishing an unleased fill.
        if (this.getAtomicPublisher(l2)) guard.publicationAllowed = false;
        return this.loadAndStore(key, loader, options, guard, controller);
      }
      contended = true;
      const remainingMs = waitUntil - performance.now();
      if (remainingMs > 0) await sleep(Math.min(pollMs, remainingMs), controller.signal);

      const cached = await this.get(key);
      if (cached !== undefined) return cached;
      if (this.hasNegative(key)) return undefined;
      if (performance.now() >= waitUntil) break;
    }

    this.emit({ type: 'lock:timeout', key, timeoutMs: waitTimeoutMs, onTimeout });
    if (onTimeout === 'load') {
      if (this.getAtomicPublisher(l2)) guard.publicationAllowed = false;
      return this.loadAndStore(key, loader, options, guard, controller);
    }

    const stale = this.getStale(key);
    if (stale !== undefined && this.failSafeEnabled(options)) {
      this.emit({ type: 'stale:hit', key, reason: 'lock-timeout' });
      return stale;
    }
    throw new DistributedLockTimeoutError(key, waitTimeoutMs);
  }

  private async deleteLocal(key: K, generation?: number): Promise<void> {
    const guard = this.observeKey(key, true);
    try {
    this.removeInflight(key);
    this.removeNegative(key);
    this.removeStale(key);
    const storageKey = guard.storageKey;
    this.advanceGenerationAfterDelete(String(key), generation);

    await this.l1?.delete(storageKey);
    await this.runL2('delete', storageKey, () => !this.closed
      && (guard.revision === guard.state.value || storageKey !== this.toStorageKey(key))
      ? this.l2?.delete(storageKey) ?? Promise.resolve()
      : Promise.resolve());
    this.emit({ type: 'delete', key });
    } finally { this.releaseKey(guard); }
  }

  /** Received invalidations only evict this process; the publisher owns L2. */
  private async deleteLocalOnly(key: K, generation?: number): Promise<void> {
    const guard = this.observeKey(key, true);
    try {
    this.removeInflight(key);
    this.removeNegative(key);
    this.removeStale(key);
    this.advanceGenerationAfterDelete(String(key), generation);
    await this.l1?.delete(guard.storageKey);
    this.emit({ type: 'delete', key });
    } finally { this.releaseKey(guard); }
  }

  private async deleteByPatternLocal(pattern: string, shared = true): Promise<void> {
    this.mutationEpoch += 1;
    for (const key of this.inflight.keys()) {
      if (matchesPattern(String(key), pattern)) {
        this.removeInflight(key);
      }
    }

    for (const key of this.negative.keys()) {
      if (matchesPattern(String(key), pattern)) {
        this.removeNegative(key);
      }
    }

    for (const key of this.stale.keys()) {
      if (matchesPattern(String(key), pattern)) {
        this.removeStale(key);
      }
    }

    await this.l1?.deleteByPattern(pattern);
    if (shared) {
      await this.runL2('deleteByPattern', pattern, () => this.l2?.deleteByPattern(pattern) ?? Promise.resolve());
    }
    this.emit({ type: 'delete-pattern', pattern });
  }

  private async publishInvalidation(event: Parameters<EventBus['publish']>[0]): Promise<void> {
    if (this.closed || !this.options.eventBus) {
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
      await this.options.eventBus.publish(this.options.eventNamespace === undefined
        ? event : { ...event, namespace: this.options.eventNamespace });
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
    payloadBytes?: number,
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
    payloadBytes = 0,
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

    const epoch = this.l2CircuitBreaker.currentEpoch;
    try {
      const retainedBytes = payloadBytes + Buffer.byteLength(String(keyOrPattern)) * 2 + 128;
      let reserved = false;
      let dispatched = false;
      const releaseRetention = () => {
        if (!reserved) return;
        reserved = false;
        this.memoryBudget?.release(retainedBytes, 'queue');
      };
      if (this.memoryBudget) {
        if (!this.memoryBudget.tryReserve(retainedBytes, 'queue')) throw new L2OperationOverloadError(operation);
        reserved = true;
      }
      const boundedCall = () => {
        dispatched = true;
        try { return Promise.resolve(call()).finally(releaseRetention); }
        catch (error) { releaseRetention(); throw error; }
      };
      let result: T;
      try { result = await this.l2Gate.run(operation, boundedCall, retainedBytes); }
      finally {
        // A queue rejection/expiry never dispatched this closure. A caller
        // timeout after dispatch keeps its reservation until actual settlement.
        if (!dispatched) releaseRetention();
      }
      this.l2CircuitBreaker.recordSuccess(epoch);
      return result;
    } catch (error) {
      const state = this.l2CircuitBreaker.recordFailure(epoch);
      this.emit({ type: 'l2:error', operation, key: keyOrPattern, state, error });
      errorLog('l2 cache operation failed open', { operation, key: keyOrPattern, state, error });
      return fallback;
    }
  }

  private inflightDisabled(options: CacheOptions): boolean {
    return options.inflight?.enabled === false || this.options.inflight?.enabled === false;
  }

  private originLoadEnabled(options: CacheOptions): boolean {
    return options.originLoad?.enabled !== false && this.options.originLoad?.enabled !== false;
  }

  /**
   * Opt-out. `loadWithDistributedLock` already falls through when L2 cannot
   * lock, so this costs a single-process cache nothing.
   */
  private distributedLockEnabled(options: CacheOptions): boolean {
    return options.distributedLock?.enabled !== false && this.options.distributedLock?.enabled !== false;
  }

  private canTrackNewInflight(): boolean {
    const maxEntries = this.options.inflight?.maxEntries ?? DEFAULT_INFLIGHT_MAX_ENTRIES;

    return maxEntries === undefined || maxEntries > 0 && this.inflight.size < maxEntries;
  }

  private reserveInflight(key: K): number | undefined {
    if (!this.canTrackNewInflight()) return undefined;
    const bytes = this.keyMetadataBytes(key);
    if (this.inflightBytes + bytes > MAX_AUXILIARY_MAP_BYTES) return undefined;
    if (this.memoryBudget && !this.memoryBudget.tryReserve(bytes, 'coordination-metadata')) return undefined;
    this.inflightBytes += bytes;
    return bytes;
  }

  private async joinInflight(key: K, entry: InflightEntry<K, V>, options: CacheOptions): Promise<V | undefined> {
    const maxWaiters = Math.min(this.maxWaiters, options.inflight?.maxWaiters ?? this.maxWaiters);
    if (this.activeFollowers >= maxWaiters
      || (this.memoryBudget && !this.memoryBudget.tryReserve(FOLLOWER_METADATA_BYTES, 'coordination-metadata'))) {
      this.rejectedFollowers += 1;
      throw new InflightOverloadError(key);
    }
    this.activeFollowers += 1;
    this.followerBytes += FOLLOWER_METADATA_BYTES;
    try { return await entry.promise; }
    finally {
      this.activeFollowers -= 1;
      this.followerBytes -= FOLLOWER_METADATA_BYTES;
      this.memoryBudget?.release(FOLLOWER_METADATA_BYTES, 'coordination-metadata');
    }
  }

  private removeInflight(key: K): void {
    const entry = this.inflight.get(key);
    if (!entry) return;
    this.inflight.delete(key);
    this.inflightBytes -= entry.bytes;
    this.memoryBudget?.release(entry.bytes, 'coordination-metadata');
  }

  private clearInflight(): void {
    this.memoryBudget?.release(this.inflightBytes, 'coordination-metadata');
    this.inflightBytes = 0;
    this.inflight.clear();
  }

  private getInflightTtlMs(options: CacheOptions): number | undefined {
    const explicit = options.inflight?.ttlMs ?? this.options.inflight?.ttlMs;
    if (explicit !== undefined) return explicit;
    const hardMs = options.timeouts?.hardMs ?? this.options.timeouts?.hardMs ?? DEFAULT_LOADER_HARD_TIMEOUT_MS;
    const waitMs = this.distributedLockEnabled(options) && supportsDistributedLock(this.l2)
      ? this.getLockWaitTimeoutMs(options) : 0;
    // Keep local callers together throughout the default wait + loader budget.
    return Math.max(DEFAULT_INFLIGHT_TTL_MS, waitMs + hardMs + DEFAULT_LOCK_POLL_MS);
  }

  private getLockWaitTimeoutMs(options: CacheOptions): number {
    const lockTtlMs = options.distributedLock?.ttlMs ?? this.options.distributedLock?.ttlMs ?? DEFAULT_LOCK_TTL_MS;
    const hardMs = options.timeouts?.hardMs ?? this.options.timeouts?.hardMs ?? DEFAULT_LOADER_HARD_TIMEOUT_MS;
    const pollMs = options.distributedLock?.pollMs ?? this.options.distributedLock?.pollMs ?? DEFAULT_LOCK_POLL_MS;
    return options.distributedLock?.waitTimeoutMs ?? this.options.distributedLock?.waitTimeoutMs
      ?? Math.max(lockTtlMs, hardMs) + pollMs;
  }

  private getInflightExpiresAt(options: CacheOptions): number | undefined {
    const ttlMs = this.getInflightTtlMs(options);

    return ttlMs === undefined ? undefined : Date.now() + ttlMs;
  }

  private isInflightExpired(entry: InflightEntry<K, V>): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= Date.now();
  }

  private pruneInflightKey(key: K): void {
    const entry = this.inflight.get(key);
    if (entry && this.isInflightExpired(entry)) this.removeInflight(key);
  }

  private async runLoaderWithTimeouts(
    key: K,
    loader: CacheLoader<V>,
    controller: AbortController,
    options: CacheOptions,
  ): Promise<V | undefined> {
    const softMs = options.timeouts?.softMs ?? this.options.timeouts?.softMs;
    const hardMs = options.timeouts?.hardMs
      ?? this.options.timeouts?.hardMs
      ?? DEFAULT_LOADER_HARD_TIMEOUT_MS;
    const loaderPromise = Promise.resolve().then(() => loader({ signal: controller.signal }));
    const stale = this.getStale(key);

    if (softMs !== undefined && stale !== undefined && this.failSafeEnabled(options)) {
      const result = await raceWithTimeout(loaderPromise, softMs, 'soft-timeout', controller.signal);

      if (result.timedOut) {
        controller.abort();
        this.emit({ type: 'loader:timeout', key, timeoutMs: softMs });
        throw new LoaderTimeoutError('soft-timeout');
      }

      return result.value;
    }

    if (hardMs !== undefined) {
      const result = await raceWithTimeout(loaderPromise, hardMs, 'hard-timeout', controller.signal);

      if (result.timedOut) {
        controller.abort();
        this.emit({ type: 'loader:timeout', key, timeoutMs: hardMs });
        throw new LoaderTimeoutError('hard-timeout');
      }

      return result.value;
    }

    return loaderPromise;
  }

  private rememberStale(key: K, value: V, options: CacheOptions, reusable?: Uint8Array): void {
    if (this.closed || !this.versionedCacheSafe() || !this.failSafeEnabled(options)) {
      return;
    }

    const staleTtlMs = options.failSafe?.staleTtlMs
      ?? this.options.failSafe?.staleTtlMs
      ?? DEFAULT_STALE_TTL_MS;

    if (staleTtlMs <= 0) {
      return;
    }

    let encoded: Uint8Array;
    try { encoded = reusable ?? serializeWithStats(value).buffer; } catch { return; }
    this.removeStale(key);
    const maxEntries = options.failSafe?.maxEntries ?? this.options.failSafe?.maxEntries ?? 1_000;
    const maxBytes = options.failSafe?.maxBytes ?? this.options.failSafe?.maxBytes ?? 16 * 1024 * 1024;
    if (maxEntries === 0 || maxBytes === 0) return;
    const bytes = encoded.byteLength + Buffer.byteLength(String(key)) * 2 + 80;
    if (bytes > maxBytes) return;
    if (this.memoryBudget && !this.memoryBudget.tryReserve(bytes, 'stale')) return;
    const owned = Buffer.allocUnsafeSlow(encoded.byteLength);
    owned.set(encoded);
    this.stale.set(key, { encoded: owned, bytes, expiresAt: Date.now() + staleTtlMs });
    this.staleBytes += bytes;
    while (this.stale.size > maxEntries || this.staleBytes > maxBytes) {
      const oldest = this.stale.keys().next().value;
      if (oldest === undefined) break;
      this.removeStale(oldest);
    }
  }

  private getStale(key: K): V | undefined {
    if (this.closed || !this.versionedCacheSafe() || !this.invalidationTrusted) return undefined;
    const entry = this.stale.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.removeStale(key);
      return undefined;
    }

    return this.decodeValue(entry.encoded);
  }

  private decodeValue(encoded: Uint8Array): V | undefined {
    const result = decodeCacheRecord(encoded, this.options.decodeLimits);
    return result.hit ? result.value as V : undefined;
  }

  private removeStale(key: K): void {
    const entry = this.stale.get(key);
    if (entry) {
      this.staleBytes -= entry.bytes;
      this.memoryBudget?.release(entry.bytes, 'stale');
    }
    this.stale.delete(key);
  }

  private clearStale(): void {
    if (this.staleBytes > 0) this.memoryBudget?.release(this.staleBytes, 'stale');
    this.stale.clear();
    this.staleBytes = 0;
  }

  private evictOneStale(): boolean {
    const oldest = this.stale.keys().next().value;
    if (oldest === undefined) return false;
    this.removeStale(oldest);
    return true;
  }

  private isEncodedStore(store: CacheStore<K, V> | undefined): store is EncodedCacheStore<K, V> {
    return (store as Partial<EncodedCacheStore<K, V>> | undefined)?.encodedFormat === 'lazy-layers-hc1'
      && typeof (store as Partial<EncodedCacheStore<K, V>> | undefined)?.setEncoded === 'function'
      && typeof (store as Partial<EncodedCacheStore<K, V>> | undefined)?.getEncoded === 'function';
  }

  private layerCodecOptions(options: CacheOptions, level: CacheLevel): CacheCodecOptions {
    return options.levels?.[level]?.codec
      ?? this.options.levels?.[level]?.codec
      ?? {};
  }

  private sameLayerCodecPolicy(options: CacheOptions, left: CacheLevel, right: CacheLevel): boolean {
    try {
      return JSON.stringify(this.layerCodecOptions(options, left))
        === JSON.stringify(this.layerCodecOptions(options, right));
    } catch {
      // A malformed policy is rejected by the serializer when it is selected;
      // do not reuse bytes across tiers when equality cannot be established.
      return false;
    }
  }

  private tryEncodeForLayer(value: V, options: CacheOptions, level: CacheLevel): Buffer | undefined {
    try {
      return serializeWithStats(value, this.layerCodecOptions(options, level)).buffer;
    } catch {
      return undefined;
    }
  }

  private getAtomicPublisher(
    store: CacheStore<K, V> | undefined,
  ): (CacheStore<K, V> & AtomicPublishStore<K>) | undefined {
    const capability = store as Partial<AtomicPublishStore<K>> | undefined;
    // The method alone is not enough to claim the stronger lease/fence
    // contract. Third-party stores must opt in explicitly so an old adapter
    // cannot accidentally publish stale loader results through the new path.
    return capability?.atomicPublicationSupported === true
      && typeof capability.publishIfOwner === 'function'
      ? store as CacheStore<K, V> & AtomicPublishStore<K>
      : undefined;
  }

  private async setL1Only(
    storageKey: K,
    value: V,
    options: CacheOptions,
    encoded?: Uint8Array,
  ): Promise<void> {
    if (encoded && this.isEncodedStore(this.l1)) {
      await this.l1.setEncoded(storageKey, encoded, options);
      return;
    }
    await this.l1?.set(storageKey, value, options);
  }

  private async promoteToL1(
    key: K,
    storageKey: K,
    value: V,
    options: CacheOptions,
    reusable?: { buffer: Buffer; ttlRemainingMs: number },
    invalidateOnBypass = false,
  ): Promise<boolean> {
    if (!this.l1) return false;
    const promotionStarted = performance.now();
    // Reuse L2 bytes only when both tiers deliberately selected the same
    // representation. An explicit L1 policy must not inherit compression or
    // JSON choices made for L2 during promotion.
    let encoded = reusable && this.sameLayerCodecPolicy(options, 'L1', 'L2')
      ? reusable.buffer
      : undefined;
    if (!encoded && this.isEncodedStore(this.l1)) {
      encoded = this.tryEncodeForLayer(value, options, 'L1');
      if (!encoded) { if (invalidateOnBypass) await this.l1.delete(storageKey); return false; }
    }
    const bytes = encoded ? encoded.byteLength + Buffer.byteLength(String(storageKey)) * 2 + 160 : 0;
    if (this.memoryBudget && !this.memoryBudget.permitsPromotion(bytes)) {
      if (invalidateOnBypass) await this.l1.delete(storageKey);
      const reason = this.memoryBudget.snapshot().pressureState === 'normal' ? 'budget' : 'pressure';
      this.emit({ type: 'promotion:bypassed', key, reason, bytes: encoded?.byteLength });
      return false;
    }
    const remaining = reusable && reusable.ttlRemainingMs >= 0
      ? reusable.ttlRemainingMs - (performance.now() - promotionStarted)
      : undefined;
    if (remaining !== undefined && remaining <= 0) {
      if (invalidateOnBypass) await this.l1.delete(storageKey);
      return false;
    }
    let promotionOptions = options;
    if (remaining !== undefined) {
      const ttlMs = Math.min(options.levels?.L1?.ttlMs ?? options.ttlMs ?? DEFAULT_CACHE_TTL_MS, remaining);
      promotionOptions = { ...options, ttlMs, levels: { ...options.levels, L1: { ...options.levels?.L1, ttlMs } } };
    }
    if (encoded && this.isEncodedStore(this.l1)) {
      await this.l1.setEncoded(storageKey, encoded, promotionOptions);
      return this.l1 instanceof MemoryStore ? this.l1.has(storageKey) : true;
    }
    await this.l1.set(storageKey, value, promotionOptions);
    return true;
  }

  /** Opt-out. Serving a slightly stale value beats serving an error. */
  private failSafeEnabled(options: CacheOptions): boolean {
    return options.failSafe?.enabled !== false && this.options.failSafe?.enabled !== false;
  }

  private hasNegative(key: K): boolean {
    if (this.closed || !this.versionedCacheSafe() || !this.invalidationTrusted) return false;
    const entry = this.negative.get(key);

    if (!entry) {
      return false;
    }

    if (entry.expiresAt <= Date.now()) {
      this.removeNegative(key);
      return false;
    }

    return true;
  }

  private setNegative(key: K, options: CacheOptions): void {
    if (this.closed || !this.versionedCacheSafe() || !this.invalidationTrusted) return;
    if (options.negativeCache?.enabled === false || this.options.negativeCache?.enabled === false) {
      return;
    }

    const ttlMs = options.negativeCache?.ttlMs
      ?? this.options.negativeCache?.ttlMs
      ?? DEFAULT_NEGATIVE_TTL_MS;

    if (ttlMs <= 0) {
      return;
    }

    const maxEntries = options.negativeCache?.maxEntries
      ?? this.options.negativeCache?.maxEntries
      ?? DEFAULT_NEGATIVE_MAX_ENTRIES;
    if (maxEntries === 0) return;

    while (maxEntries !== undefined && this.negative.size >= maxEntries) {
      const oldestKey = this.negative.keys().next().value;

      if (oldestKey === undefined) {
        break;
      }

      this.removeNegative(oldestKey);
    }

    const bytes = this.keyMetadataBytes(key);
    if (bytes > MAX_AUXILIARY_MAP_BYTES) return;
    this.removeNegative(key);
    while (this.negativeBytes + bytes > MAX_AUXILIARY_MAP_BYTES) {
      const oldestKey = this.negative.keys().next().value;
      if (oldestKey === undefined) break;
      this.removeNegative(oldestKey);
    }
    if (this.memoryBudget && !this.memoryBudget.tryReserve(bytes, 'coordination-metadata')) return;
    this.negative.set(key, { expiresAt: Date.now() + ttlMs, bytes });
    this.negativeBytes += bytes;
    this.emit({ type: 'negative:set', key, ttlMs });
  }

  private removeNegative(key: K): void {
    const entry = this.negative.get(key);
    if (!entry) return;
    this.negativeBytes -= entry.bytes;
    this.memoryBudget?.release(entry.bytes, 'coordination-metadata');
    this.negative.delete(key);
  }

  private clearNegative(): void {
    this.memoryBudget?.release(this.negativeBytes, 'coordination-metadata');
    this.negativeBytes = 0;
    this.negative.clear();
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
      this.storeGeneration(key, Math.max(currentGeneration, generation));
      return;
    }

    this.storeGeneration(key, currentGeneration + 1);
  }

  private advanceGenerationAfterRemoteSet(key: string, generation?: number): void {
    if (generation === undefined) {
      return;
    }

    this.storeGeneration(key, Math.max(this.getGeneration(key), generation));
  }

  private storeGeneration(key: string, generation: number): void {
    const bytes = this.keyMetadataBytes(key);
    if (!Number.isSafeInteger(generation) || generation < 0
      || (!this.generations.has(key)
        && (this.generations.size >= MAX_GENERATION_ENTRIES || this.generationBytes + bytes > MAX_GENERATION_BYTES
          || (this.memoryBudget && !this.memoryBudget.tryReserve(bytes, 'coordination-metadata'))))) {
      void this.saturateGenerationTracking('budget-or-invalid-generation')
        .catch((error) => errorLog('failed to clear L1 after generation saturation', { error }));
      return;
    }
    if (!this.generations.has(key)) this.generationBytes += bytes;
    this.generations.set(key, generation);
  }

  private saturateGenerationTracking(reason: 'budget-or-invalid-generation' | 'remote-generation-regression'): Promise<void> {
    if (this.generationTrackingSaturated) return Promise.resolve();
    this.generationTrackingSaturated = true;
    this.mutationEpoch += 1;
    this.clearInflight();
    this.clearNegative();
    this.clearStale();
    debugLog('generation tracking unsafe; versioned cache requires recreation', {
      reason,
      generationEntries: this.generations.size,
      generationBytes: this.generationBytes,
      versioned: this.options.versioning?.enabled === true,
    });
    return this.l1?.deleteByPattern('*') ?? Promise.resolve();
  }

  private generationForEvent(key: string): number | undefined {
    return this.generationTrackingSaturated && !this.generations.has(key) ? undefined : this.getGeneration(key);
  }

  private versionedCacheSafe(): boolean {
    return this.options.versioning?.enabled !== true || !this.generationTrackingSaturated;
  }

  private ensureOpen(): void { if (this.closed) throw new CacheClosedError(); }

  private observeKey(key: K, mutate = false): MutationGuard<K> {
    let state = this.keyRevisions.get(key);
    if (!state) {
      const bytes = this.keyMetadataBytes(key);
      const registered = this.keyRevisionBytes + bytes <= MAX_AUXILIARY_MAP_BYTES
        && (!this.memoryBudget || this.memoryBudget.tryReserve(bytes, 'coordination-metadata'));
      state = { value: 0, references: 0, bytes, registered };
      if (registered) { this.keyRevisions.set(key, state); this.keyRevisionBytes += bytes; }
    }
    state.references += 1;
    if (mutate) state.value += 1;
    return { key, state, revision: state.value, epoch: this.mutationEpoch, storageKey: this.toStorageKey(key) };
  }

  private releaseKey(guard: MutationGuard<K>): void {
    guard.state.references -= 1;
    if (guard.state.references === 0 && this.keyRevisions.get(guard.key) === guard.state) {
      this.keyRevisions.delete(guard.key);
      this.keyRevisionBytes -= guard.state.bytes;
      this.memoryBudget?.release(guard.state.bytes, 'coordination-metadata');
      guard.state.registered = false;
    }
  }

  private isCurrent(guard: MutationGuard<K>): boolean {
    return !this.closed && guard.state.registered && this.versionedCacheSafe() && !guard.signal?.aborted
      && guard.epoch === this.mutationEpoch && guard.revision === guard.state.value;
  }

  private keyMetadataBytes(key: CacheKey): number { return Buffer.byteLength(String(key)) * 2 + 96; }

  private async discardObsoleteL1(storageKey: K): Promise<void> {
    // Built-in MemoryStore commits before yielding: a newer mutation already
    // superseded that insertion. Deleting here could remove the newer value.
    // Arbitrary asynchronous adapters cannot offer that local commit ordering;
    // conservative eviction prevents their late write from serving old data.
    if (!(this.l1 instanceof MemoryStore)) await this.l1?.delete(storageKey);
  }

  isInvalidationTrusted(): boolean { return this.invalidationTrusted; }

  private markInvalidationUntrusted(): void {
    this.invalidationRevision += 1;
    this.invalidationTrusted = false;
    this.mutationEpoch += 1;
    this.clearInflight();
    this.clearNegative();
    this.clearStale();
    void this.l1?.deleteByPattern('*').catch((error) => errorLog('failed to flush untrusted L1', { error }));
    this.emit({ type: 'invalidation:untrusted' });
  }

  private async restoreInvalidationTrust(): Promise<void> {
    const revision = this.invalidationRevision;
    this.mutationEpoch += 1;
    this.clearInflight();
    this.clearNegative();
    this.clearStale();
    await this.l1?.deleteByPattern('*');
    if (revision !== this.invalidationRevision || this.closed
      || this.lastBusStatus === 'connecting' || this.lastBusStatus === 'disconnected' || this.lastBusStatus === 'error') return;
    this.invalidationTrusted = true;
    this.emit({ type: 'invalidation:trusted' });
  }

  private emit(event: CacheEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        errorLog('cache event handler failed', { event: event.type, error });
      }
    }

    // Telemetry hook: a single boolean check unless an APM is subscribed.
    publishTelemetry(event);
  }

  private hasSeenEvent(eventId: string): boolean {
    const seenAt = this.seenEvents.get(eventId);

    if (seenAt === undefined) {
      return false;
    }

    if (Date.now() - seenAt > this.getEventDedupeTtlMs()) {
      this.removeSeenEvent(eventId);
      return false;
    }

    return true;
  }

  private markEventSeen(eventId: string): void {
    const bytes = this.keyMetadataBytes(eventId);
    if (bytes > MAX_AUXILIARY_MAP_BYTES || this.getEventDedupeMaxEntries() === 0) return;
    this.removeSeenEvent(eventId);
    while (this.seenEvents.size >= this.getEventDedupeMaxEntries() || this.seenEventBytes + bytes > MAX_AUXILIARY_MAP_BYTES) {
      const oldestId = this.seenEvents.keys().next().value;

      if (oldestId === undefined) {
        return;
      }

      this.removeSeenEvent(oldestId);
    }
    if (this.memoryBudget && !this.memoryBudget.tryReserve(bytes, 'coordination-metadata')) return;
    this.seenEvents.set(eventId, Date.now());
    this.seenEventBytes += bytes;
  }

  private removeSeenEvent(eventId: string): void {
    if (!this.seenEvents.delete(eventId)) return;
    const bytes = this.keyMetadataBytes(eventId);
    this.seenEventBytes -= bytes;
    this.memoryBudget?.release(bytes, 'coordination-metadata');
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

  private isStaleGeneration(source: string, key: string, generation?: number): boolean {
    if (generation === undefined) return false;
    // Every accepted remote mutation advances the same per-key maximum before
    // yielding. A second source/key map is redundant and duplicates large keys.
    void source;
    return generation < this.getGeneration(key);
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
    // Process bounded event keys sequentially rather than allocating one
    // promise and local mutation per key at once.
    for (let index = 0; index < event.keys.length; index++) {
      if (this.closed) return;
      const rawKey = event.keys[index]!;
      const key = this.eventKey(rawKey, event.keyTypes?.[index]);

      if (this.isStaleGeneration(event.source, rawKey, event.generation)) {
        this.emitStaleInvalidation(event, eventId, key);
        if (this.options.versioning?.enabled === true) {
          // Delete generations are process-local and restart at zero. A lower
          // accepted delete can be a new mutation from a restarted peer. Scope
          // filtering has already run; never retain a higher-version value on
          // the assumption that this local counter is a durable global order.
          await this.saturateGenerationTracking('remote-generation-regression');
        }
        // Even unversioned caches keep delete counters for stale SET hints.
        // Those counters cannot justify retaining local data across a lower
        // delete from a restarted peer. Continue through exact/legacy eviction.
      }

      await this.deleteLocalOnly(key, event.generation);
      // A legacy event did not preserve the original key type. Deletion may
      // evict both aliases safely; payload priming must never guess a type.
      if (!event.keyTypes && String(Number(rawKey)) === rawKey && Number.isFinite(Number(rawKey))) {
        await this.deleteLocalOnly(Number(rawKey) as K, event.generation);
      }
    }
  }

  private async applyRemoteSet(event: SetEvent, eventId: string): Promise<void> {
    if (this.closed || !this.invalidationTrusted || !this.versionedCacheSafe()) return;
    if (this.generationTrackingSaturated && !this.l2) return;
    const localOptions: CacheOptions =
      event.ttlMs !== undefined ? { ...this.options, ttlMs: event.ttlMs } : this.options;

    for (let index = 0; index < event.keys.length; index++) {
      if (this.closed) return;
      const rawKey = event.keys[index]!;
      const key = this.eventKey(rawKey, event.keyTypes?.[index]);

      if (this.isStaleGeneration(event.source, rawKey, event.generation)) {
        this.emitStaleInvalidation(event, eventId, key);
        continue;
      }

      this.advanceGenerationAfterRemoteSet(rawKey, event.generation);
      const guard = this.observeKey(key, true);
      try {
        let value = event.value as V;
        let encoded: { buffer: Buffer; ttlRemainingMs: number } | undefined;
        if (this.l2) {
          // Peer events are hints when an authoritative shared tier exists.
          // Equal-generation late broadcasts must not install their old payload.
          const readStarted = performance.now();
          const authoritative = await this.runL2<V | undefined>('prime-current', guard.storageKey, async () => {
            if (this.isEncodedStore(this.l2)) {
              encoded = await this.l2.getEncoded(guard.storageKey);
              return encoded ? this.decodeValue(encoded.buffer) : undefined;
            }
            return this.l2?.get(guard.storageKey) ?? Promise.resolve(undefined);
          }, undefined);
          if (encoded && encoded.ttlRemainingMs >= 0) {
            encoded.ttlRemainingMs = Math.max(0, encoded.ttlRemainingMs - (performance.now() - readStarted));
          }
          if (authoritative === undefined) {
            if (!this.isCurrent(guard) || !this.invalidationTrusted) continue;
            await this.l1?.delete(guard.storageKey);
            this.removeNegative(key);
            this.removeStale(key);
            continue;
          }
          value = authoritative;
        }
        if (!this.isCurrent(guard) || !this.invalidationTrusted) continue;
        const promoted = await this.promoteToL1(key, guard.storageKey, value, localOptions, encoded, true);
        if (!this.isCurrent(guard) || !this.invalidationTrusted || this.isStaleGeneration(event.source, rawKey, event.generation)) {
          await this.discardObsoleteL1(guard.storageKey);
          continue;
        }
        this.rememberStale(key, value, localOptions, encoded?.buffer);
        this.removeNegative(key);
        this.removeInflight(key);
        if (promoted) {
          this.emit({ type: 'set:received', key, level: 'L1' });
          debugLog('cache set:received', { key, level: 'L1' });
        }
      } finally {
        this.releaseKey(guard);
      }
    }
  }

  private eventKey(rawKey: string, type?: 'string' | 'number'): K {
    return (type === 'number' ? Number(rawKey) : rawKey) as K;
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
  return `cache-${randomUUID()}`;
}

function createEventId(): string {
  return randomUUID();
}

function assertBudget(name: string, value: number | undefined, integer = false, max = Number.MAX_SAFE_INTEGER): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isSafeInteger(value)))) {
    throw new RangeError(`${name} budget must be non-negative and finite${integer ? ' (a safe integer)' : ''}`);
  }
}

/** Validate before allocating an owned L1 or executing an operation. */
function validateCacheBudgets(options: CacheOptions): void {
  if (options.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)) {
    throw new RangeError('ttlMs must be positive and finite');
  }
  if (options.inflight) {
    assertBudget('inflight.maxEntries', options.inflight.maxEntries, true);
    assertBudget('inflight.maxWaiters', options.inflight.maxWaiters, true);
    assertBudget('inflight.ttlMs', options.inflight.ttlMs);
  }
  if (options.negativeCache) {
    assertBudget('negativeCache.maxEntries', options.negativeCache.maxEntries, true);
    assertBudget('negativeCache.ttlMs', options.negativeCache.ttlMs);
  }
  if (options.failSafe) {
    assertBudget('failSafe.maxEntries', options.failSafe.maxEntries, true);
    assertBudget('failSafe.maxBytes', options.failSafe.maxBytes, true);
    assertBudget('failSafe.staleTtlMs', options.failSafe.staleTtlMs);
  }
  if (options.timeouts) {
    assertBudget('timeouts.softMs', options.timeouts.softMs, false, 2 ** 31 - 1);
    assertBudget('timeouts.hardMs', options.timeouts.hardMs, false, 2 ** 31 - 1);
  }
  if (options.originLoad) {
    assertBudget('originLoad.maxConcurrent', options.originLoad.maxConcurrent, true);
    if (options.originLoad.maxConcurrent === 0) throw new RangeError('originLoad.maxConcurrent must be a positive safe integer');
    assertBudget('originLoad.maxQueued', options.originLoad.maxQueued, true);
    assertBudget('originLoad.queueTimeoutMs', options.originLoad.queueTimeoutMs, true, 2 ** 31 - 1);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function raceWithTimeout<V>(
  promise: Promise<V | undefined>,
  timeoutMs: number,
  reason: LoaderTimeoutReason,
  signal: AbortSignal,
): Promise<{ timedOut: false; value: V | undefined } | { timedOut: true; reason: LoaderTimeoutReason }> {
  let timeout: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;

  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<never>((_, reject) => {
        // close() signals cancellation and forbids publication, while an
        // already-running loader that ignores cancellation keeps its response
        // contract within the original hard deadline.
        abort = () => { if (!(signal.reason instanceof CacheClosedError)) reject(signal.reason); };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }),
      new Promise<{ timedOut: true; reason: LoaderTimeoutReason }>((resolve) => {
        timeout = setTimeout(() => resolve({ timedOut: true, reason }), timeoutMs);
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
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
