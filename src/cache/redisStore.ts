import type { Redis as RedisClient } from 'ioredis';

import type {
  CacheKey,
  CacheOptions,
  CacheStore,
  InspectableStore,
  KeyInspection,
  StoreInspectOptions,
  StoreInspection,
} from '../types/index.js';
import { debugLog } from '../utils/debugLog.js';
import {
  deserialize,
  estimateValueBytes,
  inspectBuffer,
  serialize,
  sizeSavings,
} from '../utils/serializer.js';
import { DEFAULT_CACHE_TTL_MS } from './defaults.js';

/** Default keys-per-page (SCAN COUNT) when a dashboard inspects the L2 layer. */
const DEFAULT_INSPECT_LIMIT = 100;
/** Default truncation threshold for decoded values (256 KB). */
const DEFAULT_MAX_VALUE_BYTES = 256 * 1024;

export interface RedisStoreOptions extends CacheOptions {
  prefix?: string;
  indexKey?: string;
  useIndex?: boolean;
  scanCount?: number;
  batchSize?: number;
  deleteStrategy?: 'unlink' | 'del';
}

export class RedisStore<V> implements CacheStore<CacheKey, V>, InspectableStore {
  private readonly prefix: string;
  private readonly indexKey: string;
  private readonly options: RedisStoreOptions;

  constructor(
    private readonly redis: RedisClient,
    options: RedisStoreOptions = {},
  ) {
    this.options = options;
    this.prefix = options.prefix ?? 'cache:';
    this.indexKey = options.indexKey ?? `${this.prefix}__index`;
  }

  async set(key: CacheKey, value: V, options: CacheOptions = {}): Promise<void> {
    const ttlMs = options.levels?.L2?.ttlMs
      ?? options.ttlMs
      ?? this.options.levels?.L2?.ttlMs
      ?? this.options.ttlMs
      ?? DEFAULT_CACHE_TTL_MS;
    const maxEntries = options.levels?.L2?.maxEntries ?? this.options.levels?.L2?.maxEntries;
    const redisKey = this.toRedisKey(key);
    const payload = serialize(value);
    const pipeline = this.redis.pipeline();

    pipeline.set(redisKey, payload, 'PX', ttlMs);

    if (this.useIndex()) {
      pipeline.zadd(this.indexKey, Date.now(), redisKey);
    }

    await pipeline.exec();
    debugLog('redis set', { key: redisKey, ttlMs, indexed: this.useIndex() });

    if (maxEntries !== undefined && this.useIndex()) {
      await this.trimIndex(maxEntries);
    }
  }

  async get(key: CacheKey): Promise<V | undefined> {
    const raw = await this.redis.getBuffer(this.toRedisKey(key));

    if (raw === null) {
      await this.removeFromIndex(this.toRedisKey(key));
      debugLog('redis miss', { key });
      return undefined;
    }

    debugLog('redis hit', { key });

    return deserialize(raw) as V;
  }

  async getOrSet(key: CacheKey, loader: () => Promise<V | undefined>, options?: CacheOptions): Promise<V | undefined> {
    const cached = await this.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const value = await loader();

    if (value === undefined) {
      return undefined;
    }

    await this.set(key, value, options);

    return value;
  }

  async has(key: CacheKey): Promise<boolean> {
    return (await this.redis.exists(this.toRedisKey(key))) === 1;
  }

  async delete(key: CacheKey): Promise<void> {
    await this.deleteKeys([this.toRedisKey(key)]);
  }

  async deleteByPattern(pattern: string): Promise<void> {
    if (this.useIndex()) {
      await this.deleteIndexedPattern(pattern);
      return;
    }

    const stream = this.redis.scanStream({
      match: this.toRedisPattern(pattern),
      count: this.getScanCount(),
    });

    for await (const keys of stream) {
      const batch = keys as string[];

      if (batch.length > 0) {
        await this.deleteKeys(batch);
      }
    }
  }

  async clear(): Promise<void> {
    await this.deleteByPattern('*');
  }

  async size(): Promise<number> {
    if (this.useIndex()) {
      return this.redis.zcard(this.indexKey);
    }

    let count = 0;
    const stream = this.redis.scanStream({
      match: `${this.prefix}*`,
      count: this.getScanCount(),
    });

    for await (const keys of stream) {
      count += (keys as string[]).length;
    }

    return count;
  }

  /**
   * Read-only, cursor-paginated snapshot of the L2 keyspace for the dashboard.
   *
   * Uses a single SCAN/ZSCAN step (never a full keyspace blast) and pipelines the
   * per-key PTTL + value fetch. Values are decoded via {@link inspectBuffer} so we
   * report wire encoding + stored bytes without re-serializing. Invoked only when
   * a dashboard tab is open — it never touches the cache hot path.
   */
  async inspect(options: StoreInspectOptions = {}): Promise<StoreInspection> {
    const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_INSPECT_LIMIT;
    const includeValues = options.includeValues !== false;
    const maxValueBytes = options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
    const cursor = options.cursor ?? '0';
    const matchPattern = this.toRedisPattern(options.match ?? '*');

    let nextCursor: string;
    let redisKeys: string[];

    if (this.useIndex()) {
      const [returnedCursor, members] = await this.redis.zscan(
        this.indexKey,
        cursor,
        'MATCH',
        matchPattern,
        'COUNT',
        limit,
      );
      nextCursor = returnedCursor;
      redisKeys = [];
      for (let i = 0; i < members.length; i += 2) {
        redisKeys.push(members[i]);
      }
    } else {
      const [returnedCursor, found] = await this.redis.scan(
        cursor,
        'MATCH',
        matchPattern,
        'COUNT',
        limit,
      );
      nextCursor = returnedCursor;
      // Exclude internal bookkeeping keys (index zset, lock keys).
      redisKeys = found.filter((key) => !key.startsWith(`${this.prefix}__`));
    }

    const size = await this.size();
    const keys: KeyInspection[] = [];

    if (redisKeys.length > 0) {
      const pipeline = this.redis.pipeline();

      for (const redisKey of redisKeys) {
        pipeline.pttl(redisKey);
        if (includeValues) {
          pipeline.getBuffer(redisKey);
        }
      }

      const results = (await pipeline.exec()) ?? [];
      let resultIndex = 0;

      for (const redisKey of redisKeys) {
        const ttlResult = results[resultIndex++];
        const ttlValue = ttlResult?.[1];
        const inspection: KeyInspection = {
          key: this.toLogicalKey(redisKey),
          ttlRemainingMs: typeof ttlValue === 'number' ? ttlValue : undefined,
          serializedBytes: 0,
          deserializedBytes: 0,
          compressionRatio: 0,
          encoding: 'legacy',
        };

        if (includeValues) {
          const bufferResult = results[resultIndex++];
          const raw = bufferResult?.[1];

          if (Buffer.isBuffer(raw)) {
            const decoded = inspectBuffer(raw);
            inspection.serializedBytes = decoded.storedBytes;
            inspection.deserializedBytes = estimateValueBytes(decoded.value);
            inspection.compressionRatio = sizeSavings(
              inspection.serializedBytes,
              inspection.deserializedBytes,
            );
            inspection.encoding = decoded.encoding;

            if (decoded.storedBytes > maxValueBytes) {
              inspection.truncated = true;
            } else {
              inspection.value = decoded.value;
            }
          }
        }

        keys.push(inspection);
      }
    }

    return {
      size,
      cursor: nextCursor === '0' ? undefined : nextCursor,
      keys,
    };
  }

  async acquireLock(key: CacheKey, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(this.toLockKey(key), token, 'PX', ttlMs, 'NX');

    return result === 'OK';
  }

  async releaseLock(key: CacheKey, token: string): Promise<void> {
    await this.redis.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      1,
      this.toLockKey(key),
      token,
    );
  }

  private toRedisKey(key: CacheKey): string {
    return `${this.prefix}${String(key)}`;
  }

  private toRedisPattern(pattern: string): string {
    return `${this.prefix}${pattern}`;
  }

  private toLogicalKey(redisKey: string): string {
    return redisKey.startsWith(this.prefix) ? redisKey.slice(this.prefix.length) : redisKey;
  }

  private toLockKey(key: CacheKey): string {
    return `${this.prefix}__lock:${String(key)}`;
  }

  private useIndex(): boolean {
    return this.options.useIndex !== false;
  }

  private getScanCount(): number {
    return this.options.scanCount ?? 1_000;
  }

  private getBatchSize(): number {
    return this.options.batchSize ?? 500;
  }

  private async deleteIndexedPattern(pattern: string): Promise<void> {
    const stream = this.redis.zscanStream(this.indexKey, {
      match: this.toRedisPattern(pattern),
      count: this.getScanCount(),
    });
    let batch: string[] = [];

    for await (const items of stream) {
      const entries = items as string[];

      for (let index = 0; index < entries.length; index += 2) {
        batch.push(entries[index]);

        if (batch.length >= this.getBatchSize()) {
          await this.deleteKeys(batch);
          batch = [];
        }
      }
    }

    if (batch.length > 0) {
      await this.deleteKeys(batch);
    }

    debugLog('redis delete indexed pattern', { pattern });
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }

    for (let index = 0; index < keys.length; index += this.getBatchSize()) {
      const batch = keys.slice(index, index + this.getBatchSize());
      const pipeline = this.redis.pipeline();

      if (this.options.deleteStrategy === 'del') {
        pipeline.del(...batch);
      } else {
        pipeline.unlink(...batch);
      }

      if (this.useIndex()) {
        pipeline.zrem(this.indexKey, ...batch);
      }

      await pipeline.exec();
      debugLog('redis delete batch', {
        count: batch.length,
        strategy: this.options.deleteStrategy ?? 'unlink',
        indexed: this.useIndex(),
      });
    }
  }

  private async removeFromIndex(redisKey: string): Promise<void> {
    if (this.useIndex()) {
      await this.redis.zrem(this.indexKey, redisKey);
    }
  }

  private async trimIndex(maxEntries: number): Promise<void> {
    const size = await this.redis.zcard(this.indexKey);
    const overflow = size - maxEntries;

    if (overflow <= 0) {
      return;
    }

    const keys = await this.redis.zrange(this.indexKey, 0, String(overflow - 1));

    await this.deleteKeys(keys);
    debugLog('redis index trim', { maxEntries, removed: keys.length });
  }
}
