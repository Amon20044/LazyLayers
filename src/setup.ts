import { Redis as IORedis, type RedisOptions } from 'ioredis';

import type { EventBus, EventBusHealth, RedisEventBusOptions } from './event-bus/index.js';
import { RedisEventBus } from './event-bus/index.js';
import type {
  CacheLayer,
  LazyLayersCacheOptions,
  RedisStoreOptions,
} from './cache/index.js';
import { LazyLayersCache, RedisStore } from './cache/index.js';
import {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_INFLIGHT_TTL_MS,
  DEFAULT_L1_MAX_ENTRIES,
} from './cache/defaults.js';
import type { CacheKey } from './types/index.js';

export const PRODUCTION_L1_TTL_MS = 10_000;
export const PRODUCTION_INFLIGHT_MAX_ENTRIES = 10_000;
export const PRODUCTION_BROADCAST_SET_MAX_BYTES = 32 * 1024;
export const PRODUCTION_STARTUP_TIMEOUT_MS = 10_000;

export interface SetupRedisOptions {
  /** Existing client. When omitted, setup creates and owns one from `url`. */
  client?: IORedis;
  /** Falls back to `REDIS_URL`. */
  url?: string;
  /** Fail setup when neither `client`, `url`, nor `REDIS_URL` is available. */
  required?: boolean;
  /** Options used only when setup creates the client. */
  clientOptions?: RedisOptions;
  /** Redis L2 tuning. Prefix defaults to `<namespace>:cache:`. */
  store?: RedisStoreOptions;
  /** Redis event-bus tuning, or `false` for no bus. */
  eventBus?: RedisEventBusOptions | false;
  /** Channel defaults to `<namespace>:cache:events`. */
  channel?: string;
}

export interface CacheStartupOptions {
  /** Refuse to return a cache whose configured shared infrastructure is unhealthy. */
  requireHealthy?: boolean;
  /** Bound health, connection, and subscription readiness. */
  timeoutMs?: number;
}

export interface SetupCacheOptions<K extends CacheKey = string, V = unknown>
  extends Omit<LazyLayersCacheOptions<K, V>, 'l2' | 'eventBus'> {
  /** Isolates Redis keys and events. Falls back to `LAZY_LAYERS_NAMESPACE`, then the package name. */
  namespace?: string;
  /** Auto-configure Redis L2 and Redis Pub/Sub, or `false` for L1 only. */
  redis?: SetupRedisOptions | false;
  /** Explicit store override. `false` keeps the managed Redis bus but disables L2. */
  l2?: CacheLayer<K, V>;
  /** Explicit bus override. `false` disables event fan-out. */
  eventBus?: EventBus | false;
  startup?: CacheStartupOptions;
}

/**
 * A cache returned by {@link setupCache}. `close()` also releases a Redis
 * client created by setup. Caller-provided clients remain caller-owned.
 */
export class ManagedLazyLayersCache<
  K extends CacheKey = string,
  V = unknown,
> extends LazyLayersCache<K, V> {
  private managedClosePromise?: Promise<void>;

  constructor(
    options: LazyLayersCacheOptions<K, V>,
    private readonly ownedRedis?: IORedis,
  ) {
    super(options);
  }

  override async close(): Promise<void> {
    this.managedClosePromise ??= this.closeManagedResources();
    await this.managedClosePromise;
  }

  private async closeManagedResources(): Promise<void> {
    let cacheError: unknown;

    try {
      await super.close();
    } catch (error) {
      cacheError = error;
    }

    if (this.ownedRedis) {
      try {
        await this.ownedRedis.quit();
      } catch {
        this.ownedRedis.disconnect();
      }
    }

    if (cacheError !== undefined) {
      throw cacheError;
    }
  }
}

/**
 * Build a production-tuned cache and wait for shared infrastructure before
 * returning. With a Redis URL it wires L1, Redis L2, Redis Pub/Sub, distributed
 * per-key locks, bounded in-flight tracking, circuit breakers, and cleanup.
 * Without a Redis URL it resolves to the same protected L1-only cache.
 */
export async function setupCache<K extends CacheKey = string, V = unknown>(
  options: SetupCacheOptions<K, V> = {},
): Promise<ManagedLazyLayersCache<K, V>> {
  const {
    namespace: rawNamespace,
    redis: redisInput,
    startup,
    l2: l2Override,
    eventBus: eventBusOverride,
    ...cacheOverrides
  } = options;

  const namespace = normalizeNamespace(
    rawNamespace
      ?? process.env.LAZY_LAYERS_NAMESPACE
      ?? process.env.npm_package_name
      ?? 'app',
  );
  const redisOptions = redisInput === false ? undefined : redisInput ?? {};
  const redisUrl = redisOptions?.url ?? process.env.REDIS_URL;
  const requireHealthy = startup?.requireHealthy !== false;
  const startupTimeoutMs = startup?.timeoutMs ?? PRODUCTION_STARTUP_TIMEOUT_MS;

  if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0) {
    throw new CacheSetupError('startup.timeoutMs must be a positive finite number');
  }

  if (redisOptions?.required && !redisOptions.client && !redisUrl) {
    throw new CacheSetupError('Redis is required, but no client or REDIS_URL was provided');
  }

  let redis = redisOptions?.client;
  let ownedRedis: IORedis | undefined;

  if (!redis && redisUrl) {
    ownedRedis = new IORedis(redisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      enableOfflineQueue: true,
      retryStrategy: (attempt: number) =>
        Math.min(attempt * 200, 2_000) + Math.floor(Math.random() * 100),
      ...redisOptions?.clientOptions,
    });
    redis = ownedRedis;
  }

  const generatedL2 = redis
    ? new RedisStore<V>(redis, {
        prefix: `${namespace}:cache:`,
        deleteStrategy: 'unlink',
        scanCount: 500,
        batchSize: 500,
        ...redisOptions?.store,
      })
    : undefined;
  const generatedBus = redis
    && eventBusOverride === undefined
    && redisOptions?.eventBus !== false
    ? new RedisEventBus(redis, redisOptions?.channel ?? `${namespace}:cache:events`, {
        retryQueue: { maxSize: 10_000 },
        handlerConcurrency: 16,
        ...redisOptions?.eventBus,
      })
    : undefined;

  const l2 = l2Override === false ? false : l2Override ?? generatedL2;
  const eventBus = eventBusOverride === false ? undefined : eventBusOverride ?? generatedBus;
  const cacheOptions: LazyLayersCacheOptions<K, V> = {
    ...cacheOverrides,
    levels: {
      L1: {
        maxEntries: DEFAULT_L1_MAX_ENTRIES,
        ttlMs: PRODUCTION_L1_TTL_MS,
        ...cacheOverrides.levels?.L1,
      },
      L2: {
        ttlMs: DEFAULT_CACHE_TTL_MS,
        ...cacheOverrides.levels?.L2,
      },
    },
    inflight: {
      ttlMs: DEFAULT_INFLIGHT_TTL_MS,
      maxEntries: PRODUCTION_INFLIGHT_MAX_ENTRIES,
      ...cacheOverrides.inflight,
    },
    broadcastSetMaxBytes:
      cacheOverrides.broadcastSetMaxBytes ?? PRODUCTION_BROADCAST_SET_MAX_BYTES,
    l2,
    eventBus,
  };

  let cache: ManagedLazyLayersCache<K, V> | undefined;

  try {
    if (redis && !eventBus) {
      try {
        await withSetupTimeout(redis.ping(), startupTimeoutMs, 'Redis startup health check');
      } catch (error) {
        if (requireHealthy) {
          throw error;
        }
      }
    }

    if (eventBus) {
      let health: EventBusHealth | undefined;

      try {
        health = await withSetupTimeout(
          connectAndCheck(eventBus),
          startupTimeoutMs,
          'Event-bus startup health check',
        );
      } catch (error) {
        if (requireHealthy) {
          throw error;
        }
      }

      if (health && !health.ok && requireHealthy) {
        throw new CacheSetupError(
          `The ${health.transport} event bus failed its startup health check`,
          health.error,
        );
      }
    }

    cache = new ManagedLazyLayersCache<K, V>(cacheOptions, ownedRedis);

    if (requireHealthy) {
      await withSetupTimeout(cache.ready(), startupTimeoutMs, 'Event-bus subscription');
    } else {
      void cache.ready().catch(() => undefined);
    }

    return cache;
  } catch (error) {
    if (cache) {
      await cache.close().catch(() => undefined);
    } else {
      await eventBus?.disconnect?.().catch(() => undefined);
      ownedRedis?.disconnect();
    }

    if (error instanceof CacheSetupError) {
      throw error;
    }

    throw new CacheSetupError('Cache setup failed', error);
  }
}

export class CacheSetupError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CacheSetupError';
  }
}

async function connectAndCheck(eventBus: EventBus): Promise<EventBusHealth> {
  if (eventBus.healthCheck) {
    return eventBus.healthCheck();
  }

  await eventBus.connect?.();

  return { ok: true, transport: eventBus.constructor.name || 'custom' };
}

function normalizeNamespace(namespace: string): string {
  const normalized = namespace.trim().replace(/^:+|:+$/g, '');

  if (!normalized) {
    throw new CacheSetupError('Cache namespace cannot be empty');
  }

  return normalized;
}

async function withSetupTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CacheSetupError('startup.timeoutMs must be a positive finite number');
  }

  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new CacheSetupError(`${operation} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
