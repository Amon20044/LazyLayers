import type { Redis as RedisClient } from 'ioredis';

import type {
  AtomicPublicationResult,
  CacheKey,
  CacheOptions,
  CacheStore,
  EncodedCacheStore,
  InspectableStore,
  KeyInspection,
  StoreInspectOptions,
  StoreInspection,
} from '../types/index.js';
import { debugLog, errorLog } from '../utils/debugLog.js';
import {
  decodeCacheRecord,
  estimateValueBytes,
  serialize,
  sizeSavings,
  type SerializeOptions,
} from '../utils/serializer.js';
import { DEFAULT_CACHE_TTL_MS } from './defaults.js';
import { matchesPattern } from './pattern.js';
import { resolveDecodeLimits } from '../utils/serializerPolicy.js';
import { validateRedisPipeline } from './redisPipeline.js';

/** Default keys-per-page (SCAN COUNT) when a dashboard inspects the L2 layer. */
const DEFAULT_INSPECT_LIMIT = 100;
/** Default truncation threshold for decoded values (256 KB). */
const DEFAULT_MAX_VALUE_BYTES = 256 * 1024;

/**
 * Versioned per-entry key layout used by ownership-checked scripts.
 *
 * The hash tag is derived from the complete logical key and is placed before
 * the caller's prefix. That keeps the data and lock keys in one Redis Cluster
 * slot while allowing a prefix containing braces to remain valid. There is no
 * namespace-wide tag, so unrelated keys continue to shard independently.
 */
const VERSIONED_KEY_PREFIX = 'lazy-layers:v2:';
const RELEASE_LOCK_SCRIPT_NAME = 'lazyLayersReleaseLockV1';
const RENEW_LOCK_SCRIPT_NAME = 'lazyLayersRenewLockV1';
const PUBLISH_IF_OWNER_SCRIPT_NAME = 'lazyLayersPublishIfOwnerV1';
const SNAPSHOT_SCRIPT_NAME = 'lazyLayersGetSnapshotV1';
const SET_AND_FENCE_SCRIPT_NAME = 'lazyLayersSetAndFenceV1';
const DELETE_AND_FENCE_SCRIPT_NAME = 'lazyLayersDeleteAndFenceV1';

const RELEASE_LOCK_LUA = `
local current = redis.call("get", KEYS[1])
if current == false or current ~= ARGV[1] then return 0 end
return redis.call("del", KEYS[1])
`;

const RENEW_LOCK_LUA = `
local current = redis.call("get", KEYS[1])
if current == false or current ~= ARGV[1] then return 0 end
return redis.call("pexpire", KEYS[1], ARGV[2])
`;

/** SET is intentionally inside the owner check; a separate SET can race lease expiry. */
const PUBLISH_IF_OWNER_LUA = `
local current = redis.call("get", KEYS[2])
if current == false or current ~= ARGV[1] then return 0 end
redis.call("set", KEYS[1], ARGV[2], "PX", ARGV[3])
return 1
`;

/** GET and PTTL must come from one Redis execution to avoid pairing generations. */
const SNAPSHOT_LUA = `
local size = redis.call("strlen", KEYS[1])
local limit = tonumber(ARGV[1]) or 26214400
if size > limit then return {false, -3, size, redis.call("pttl", KEYS[1])} end
local value = redis.call("get", KEYS[1])
if value == false then return {false, -2} end
return {value, redis.call("pttl", KEYS[1]), size}
`;

/** A direct write supersedes any in-flight fill holding this entry lease. */
const SET_AND_FENCE_LUA = `
redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2])
redis.call("del", KEYS[2])
return 1
`;

/** A direct delete must fence a fill before it can publish a late result. */
const DELETE_AND_FENCE_LUA = `
local deleted = redis.call("del", KEYS[1])
redis.call("del", KEYS[2])
return deleted
`;

type RedisScriptDefinition = {
  name: string;
  lua: string;
  numberOfKeys: number;
  readOnly?: boolean;
};

type ScriptRegistrationState = Map<string, boolean>;

/* ioredis keeps the per-connection SHA state internally. This map only avoids
 * redefining the same local command when several stores share one client. */
const scriptRegistrations = new WeakMap<object, ScriptRegistrationState>();

function registerRedisScript(redis: RedisClient, definition: RedisScriptDefinition): boolean {
  const client = redis as unknown as {
    defineCommand?: (name: string, definition: Omit<RedisScriptDefinition, 'name'>) => void;
  };

  if (typeof client.defineCommand !== 'function') {
    return false;
  }

  let registrations = scriptRegistrations.get(redis as object);
  if (!registrations) {
    registrations = new Map();
    scriptRegistrations.set(redis as object, registrations);
  }

  const known = registrations.get(definition.name);
  if (known !== undefined) {
    return known;
  }

  try {
    client.defineCommand(definition.name, {
      lua: definition.lua,
      numberOfKeys: definition.numberOfKeys,
      readOnly: definition.readOnly,
    });
    registrations.set(definition.name, true);
    return true;
  } catch (error) {
    /* Registration is local. A client without this extension still gets the
     * explicit EVAL fallback below, while the error remains observable. */
    registrations.set(definition.name, false);
    errorLog('redis script registration failed; using EVAL fallback', {
      script: definition.name,
      error,
    });
    return false;
  }
}

function isNoScriptError(error: unknown): boolean {
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' && /NOSCRIPT/i.test(message);
}

function normalizeIntegerReply(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (Buffer.isBuffer(value)) return Number(value.toString('ascii'));
  return Number(value);
}

export interface RedisStoreOptions extends CacheOptions {
  prefix?: string;
  indexKey?: string;
  /** Defaults to false. It is implicitly selected when L2 maxEntries is set. */
  useIndex?: boolean;
  scanCount?: number;
  batchSize?: number;
  deleteStrategy?: 'unlink' | 'del';
  /**
   * `auto` uses the same-slot v2 layout when the client supports
   * `defineCommand`, and keeps the legacy layout for minimal test/custom
   * clients that only expose basic Redis methods. Set `v2` explicitly after a
   * staged migration. v2 and legacy keys are intentionally not dual-read: run
   * old writers with `legacy`, drain or explicitly backfill that namespace,
   * then roll all writers to `v2`. Use `legacy` only until old writers have
   * drained.
   */
  keyLayout?: 'auto' | 'legacy' | 'v2';
}

export class RedisStore<V> implements EncodedCacheStore<CacheKey, V>, InspectableStore {
  readonly encodedFormat = 'lazy-layers-hc1' as const;
  /** HybridCache checks this before relying on the stronger publication path. */
  readonly atomicPublicationSupported: boolean;
  /** Key protocol in use; v2 is the per-entry same-slot protocol. */
  readonly keyLayout: 'legacy' | 'v2';
  private readonly prefix: string;
  private readonly indexKey: string;
  private readonly options: RedisStoreOptions;
  private readonly useVersionedKeys: boolean;
  private readonly maxEncodedBytes: number;
  private readonly registeredScripts: {
    releaseLock: boolean;
    renewLock: boolean;
    publishIfOwner: boolean;
    snapshot: boolean;
    setAndFence: boolean;
    deleteAndFence: boolean;
  };

  constructor(
    private readonly redis: RedisClient,
    options: RedisStoreOptions = {},
  ) {
    this.options = options;
    this.maxEncodedBytes = resolveDecodeLimits(options.decodeLimits).maxEncodedBytes;
    this.prefix = options.prefix ?? 'cache:';
    if (typeof this.prefix !== 'string' || !wellFormedUnicode(this.prefix)) {
      throw new TypeError('RedisStore prefix must be a well-formed Unicode string');
    }
    for (const [name, value] of [['scanCount', options.scanCount], ['batchSize', options.batchSize]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new RangeError(`RedisStore ${name} must be a positive safe integer`);
    }
    const maxEntries = options.levels?.L2?.maxEntries;
    if (maxEntries !== undefined && (!Number.isSafeInteger(maxEntries) || maxEntries < 0)) {
      throw new RangeError('RedisStore L2 maxEntries must be a non-negative safe integer');
    }
    this.indexKey = options.indexKey ?? `${this.prefix}__index`;
    const hasDefineCommand = typeof (redis as unknown as { defineCommand?: unknown }).defineCommand === 'function';
    const hasEval = typeof (redis as unknown as { eval?: unknown }).eval === 'function';
    if (options.keyLayout === 'v2' && !hasDefineCommand && !hasEval) {
      throw new TypeError('RedisStore keyLayout:v2 requires defineCommand or EVAL support');
    }
    this.registeredScripts = {
      releaseLock: registerRedisScript(redis, {
        name: RELEASE_LOCK_SCRIPT_NAME,
        lua: RELEASE_LOCK_LUA,
        numberOfKeys: 1,
      }),
      renewLock: registerRedisScript(redis, {
        name: RENEW_LOCK_SCRIPT_NAME,
        lua: RENEW_LOCK_LUA,
        numberOfKeys: 1,
      }),
      publishIfOwner: registerRedisScript(redis, {
        name: PUBLISH_IF_OWNER_SCRIPT_NAME,
        lua: PUBLISH_IF_OWNER_LUA,
        numberOfKeys: 2,
      }),
      snapshot: registerRedisScript(redis, {
        name: SNAPSHOT_SCRIPT_NAME,
        lua: SNAPSHOT_LUA,
        numberOfKeys: 1,
      }),
      setAndFence: registerRedisScript(redis, {
        name: SET_AND_FENCE_SCRIPT_NAME,
        lua: SET_AND_FENCE_LUA,
        numberOfKeys: 2,
      }),
      deleteAndFence: registerRedisScript(redis, {
        name: DELETE_AND_FENCE_SCRIPT_NAME,
        lua: DELETE_AND_FENCE_LUA,
        numberOfKeys: 2,
      }),
    };

    const allScriptsRegistered = Object.values(this.registeredScripts).every(Boolean);
    let useVersionedKeys = options.keyLayout === 'v2'
      || (options.keyLayout !== 'legacy' && hasDefineCommand);
    if (useVersionedKeys && !hasEval && !allScriptsRegistered) {
      if (options.keyLayout === 'v2') {
        throw new TypeError('RedisStore keyLayout:v2 could not register every required script and EVAL is unavailable');
      }
      // `auto` must not select a key layout whose fencing commands cannot run.
      // Minimal/incompatible clients retain the legacy compatibility path.
      useVersionedKeys = false;
    }
    this.useVersionedKeys = useVersionedKeys;
    this.keyLayout = this.useVersionedKeys ? 'v2' : 'legacy';
    // The stronger publisher requires both a script executor and the v2
    // same-slot data/lease layout. A legacy layout must never advertise the
    // multi-key contract, even when the client happens to expose
    // `defineCommand`.
    this.atomicPublicationSupported = this.useVersionedKeys && (hasEval || allScriptsRegistered);
  }

  async set(key: CacheKey, value: V, options: CacheOptions = {}): Promise<void> {
    await this.setEncoded(key, serialize(value, this.codecOptions(options)), options);
  }

  async setEncoded(key: CacheKey, payload: Uint8Array, options: CacheOptions = {}): Promise<void> {
    this.assertDataKey(key);
    const ttlMs = this.resolveTtl(options);
    const maxEntries = this.resolveMaxEntries(options);
    const redisKey = this.toRedisKey(key);

    if (this.useVersionedKeys) {
      /* Data and its lease share a slot in v2, so an explicit write fences an
       * outstanding fill in the same server-side operation. Index bookkeeping
       * is intentionally outside this invariant and is repaired best-effort. */
      await this.executeScript(
        SET_AND_FENCE_SCRIPT_NAME,
        SET_AND_FENCE_LUA,
        [redisKey, this.toLockKey(key)],
        [Buffer.from(payload), ttlMs],
        false,
        this.registeredScripts.setAndFence,
      );
      await this.recordPublishedIndex(redisKey, options);
      debugLog('redis set', { key: redisKey, ttlMs, indexed: this.useIndex(), fenced: true });
      return;
    }

    const pipeline = this.redis.pipeline();

    pipeline.set(redisKey, Buffer.from(payload), 'PX', ttlMs);

    if (this.useIndex()) {
      // The score is the data key's expiry deadline, not a write counter. This
      // lets bounded maintenance remove dead catalogue members without a
      // keyspace scan. Entry-limit trimming is therefore an oldest-expiry
      // policy, not a strict global LRU guarantee.
      pipeline.zadd(this.indexKey, Date.now() + ttlMs, redisKey);
    }

    validateRedisPipeline(await pipeline.exec(), [
      { command: 'SET', key: redisKey },
      ...(this.useIndex() ? [{ command: 'ZADD', key: this.indexKey }] : []),
    ]);
    debugLog('redis set', { key: redisKey, ttlMs, indexed: this.useIndex() });

    if (maxEntries !== undefined && this.useIndex()) {
      await this.trimIndex(maxEntries);
    }
  }

  async get(key: CacheKey): Promise<V | undefined> {
    const encoded = await this.getEncoded(key);
    if (!encoded) return undefined;
    const result = decodeCacheRecord(encoded.buffer, this.options.decodeLimits);
    return result.hit ? result.value as V : undefined;
  }

  async getEncoded(key: CacheKey): Promise<{ buffer: Buffer; ttlRemainingMs: number } | undefined> {
    this.assertDataKey(key);
    const redisKey = this.toRedisKey(key);
    const snapshot = await this.readRawSnapshot(redisKey, this.maxEncodedBytes);
    const raw = snapshot.raw;
    const ttlRemainingMs = snapshot.ttlRemainingMs;

    if (snapshot.oversized) {
      debugLog('redis encoded record exceeds its read budget', { key });
      return undefined;
    }
    if (raw === null || ttlRemainingMs === -2) {
      await this.removeFromIndex(redisKey);
      debugLog('redis miss', { key });
      return undefined;
    }
    if (!Number.isSafeInteger(ttlRemainingMs) || ttlRemainingMs < -1) {
      debugLog('redis record rejected because its TTL is invalid', { key });
      return undefined;
    }
    debugLog('redis hit', { key });
    return { buffer: raw, ttlRemainingMs };
  }

  private supportsServerSnapshot(): boolean {
    const commands = this.redis as unknown as Record<string, unknown>;
    const command = commands[`${SNAPSHOT_SCRIPT_NAME}Buffer`] ?? commands[SNAPSHOT_SCRIPT_NAME];
    return (this.registeredScripts.snapshot && typeof command === 'function')
      || (this.useVersionedKeys && (typeof commands.evalBuffer === 'function' || typeof commands.eval === 'function'));
  }

  private async readRawSnapshot(redisKey: string, maxEncodedBytes: number): Promise<{ raw: Buffer | null; ttlRemainingMs: number; serializedBytes: number; oversized: boolean }> {
    let raw: Buffer | null;
    let ttlRemainingMs: number;
    let serializedBytes = 0;
    let oversized = false;
    if (this.supportsServerSnapshot()) {
      /* The Buffer variant is generated by ioredis alongside the named
       * command. If an injected client implements defineCommand only as a
       * spy, fall back to its ordinary binary read rather than assuming the
       * custom reply shape. */
      const snapshot = await this.executeScript(
        SNAPSHOT_SCRIPT_NAME,
        SNAPSHOT_LUA,
        [redisKey],
        [maxEncodedBytes],
        true,
      );
      const tuple = Array.isArray(snapshot) ? snapshot : [];
      const value = tuple[0];
      raw = value === false || value === null || value === undefined
        ? null
        : Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array | string);
      ttlRemainingMs = normalizeIntegerReply(tuple[1]);
      const size = normalizeIntegerReply(tuple[2]);
      serializedBytes = Number.isSafeInteger(size) && size >= 0 ? size : raw?.byteLength ?? 0;
      if (ttlRemainingMs === -3) {
        oversized = true;
        ttlRemainingMs = normalizeIntegerReply(tuple[3]);
      }
    } else {
      const tracksTtl = typeof this.redis.pttl === 'function';
      const [value, ttl] = await Promise.all([
        this.redis.getBuffer(redisKey),
        tracksTtl ? this.redis.pttl(redisKey) : Promise.resolve(-1),
      ]);
      raw = value;
      ttlRemainingMs = ttl;
      serializedBytes = raw?.byteLength ?? 0;
    }
    return { raw, ttlRemainingMs, serializedBytes, oversized: oversized || serializedBytes > maxEncodedBytes };
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
    this.assertDataKey(key);
    return (await this.redis.exists(this.toRedisKey(key))) === 1;
  }

  async delete(key: CacheKey): Promise<void> {
    this.assertDataKey(key);
    await this.deleteKeys([this.toRedisKey(key)]);
  }

  async deleteByPattern(pattern: string): Promise<void> {
    if (this.useIndex()) {
      await this.pruneExpiredIndexMembers();
      await this.deleteIndexedPattern(pattern);
    } else {
    const stream = this.redis.scanStream({
      match: this.toRedisPattern(pattern),
      count: this.getScanCount(),
    });

    for await (const keys of stream) {
      const batch = (keys as string[]).filter((key) => {
        const parsed = this.parseRedisKey(key);
        return parsed?.kind === 'data' && matchesPattern(parsed.logicalKey, pattern);
      });

      if (batch.length > 0) {
        await this.deleteKeys(batch);
      }
    }
    }
    // Cold fills have a lease but no data/index member yet. They must also be
    // fenced; otherwise a pattern invalidation misses precisely those fills.
    if (this.useVersionedKeys) await this.fencePatternLeases(pattern);
  }

  async clear(): Promise<void> {
    await this.deleteByPattern('*');
  }

  async size(): Promise<number> {
    if (this.useIndex()) {
      await this.pruneExpiredIndexMembers();
      return this.redis.zcard(this.indexKey);
    }

    let count = 0;
    const stream = this.redis.scanStream({
      match: this.toRedisPattern('*'),
      count: this.getScanCount(),
    });

    for await (const keys of stream) {
      count += (keys as string[]).filter((key) => this.parseRedisKey(key)?.kind === 'data').length;
    }

    return count;
  }

  /**
   * Read-only, cursor-paginated snapshot of the L2 keyspace for the dashboard.
   *
   * Uses a single SCAN/ZSCAN step (never a full keyspace blast) and pipelines the
   * per-key snapshot fetch. Server snapshots bound GET before network allocation,
   * and previews decode within their expanded-byte budget. Invoked only when
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
      await this.pruneExpiredIndexMembers();
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
        const parsed = this.parseRedisKey(members[i]);
        if (parsed?.kind === 'data' && matchesPattern(parsed.logicalKey, options.match ?? '*')) redisKeys.push(members[i]);
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
      redisKeys = found.filter((key) => {
        const parsed = this.parseRedisKey(key);
        return parsed?.kind === 'data' && matchesPattern(parsed.logicalKey, options.match ?? '*');
      });
    }

    const size = await this.size();
    const keys: KeyInspection[] = [];

    // SCAN COUNT is a hint; enforce the requested page bound locally too.
    redisKeys = redisKeys.slice(0, limit);
    if (redisKeys.length > 0 && this.supportsServerSnapshot()) {
      const cap = includeValues && Number.isSafeInteger(maxValueBytes) && maxValueBytes > 0
        ? Math.min(maxValueBytes, this.maxEncodedBytes) : 0;
      for (const redisKey of redisKeys) {
        const snapshot = await this.readRawSnapshot(redisKey, cap);
        const inspection: KeyInspection = {
          key: this.toLogicalKey(redisKey), ttlRemainingMs: snapshot.ttlRemainingMs,
          serializedBytes: snapshot.serializedBytes, deserializedBytes: 0,
          compressionRatio: 0, encoding: 'legacy',
        };
        if (includeValues) {
          const raw = snapshot.raw;
          if (cap === 0 || snapshot.oversized || raw === null) inspection.truncated = true;
          else {
            const tag = raw.toString('ascii', 0, 4);
            inspection.encoding = ({ HC1M: 'msgpack', HC1J: 'json', HC1G: 'msgpack-gzip', HC1Z: 'msgpack-zstd', HC1L: 'msgpack-lz4', HC1S: 'msgpack-snappy' } as Record<string, KeyInspection['encoding']>)[tag] ?? 'legacy';
            const configured = resolveDecodeLimits(this.options.decodeLimits);
            const decoded = decodeCacheRecord(raw, { ...configured, maxDecodedBytes: Math.min(cap, configured.maxDecodedBytes) });
            if (decoded.hit) {
              inspection.value = decoded.value;
              inspection.deserializedBytes = estimateValueBytes(decoded.value);
              inspection.compressionRatio = sizeSavings(inspection.serializedBytes, inspection.deserializedBytes);
            } else inspection.truncated = true;
          }
        }
        keys.push(inspection);
      }
    } else if (redisKeys.length > 0) {
      const pipeline = this.redis.pipeline();

      for (const redisKey of redisKeys) {
        pipeline.pttl(redisKey);
        if (includeValues) {
          pipeline.getBuffer(redisKey);
        }
      }

      const commands: { command: string; key?: string }[] = [];
      for (const redisKey of redisKeys) {
        commands.push({ command: 'PTTL', key: redisKey });
        if (includeValues) commands.push({ command: 'GET', key: redisKey });
      }
      const results = validateRedisPipeline(await pipeline.exec(), commands);
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
            inspection.serializedBytes = raw.byteLength;
            const tag = raw.toString('ascii', 0, 4);
            inspection.encoding = ({ HC1M: 'msgpack', HC1J: 'json', HC1G: 'msgpack-gzip', HC1Z: 'msgpack-zstd', HC1L: 'msgpack-lz4', HC1S: 'msgpack-snappy' } as Record<string, KeyInspection['encoding']>)[tag] ?? 'legacy';
            const configured = resolveDecodeLimits(this.options.decodeLimits);
            if (!Number.isSafeInteger(maxValueBytes) || maxValueBytes < 1 || raw.byteLength > maxValueBytes) {
              inspection.truncated = true;
            } else {
              const decoded = decodeCacheRecord(raw, {
                ...configured,
                maxDecodedBytes: Math.min(configured.maxDecodedBytes, maxValueBytes),
              });
              if (decoded.hit) {
                inspection.value = decoded.value;
                inspection.deserializedBytes = estimateValueBytes(decoded.value);
                inspection.compressionRatio = sizeSavings(inspection.serializedBytes, inspection.deserializedBytes);
              } else {
                inspection.truncated = true;
              }
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
    this.assertDataKey(key);
    this.resolveTtl(ttlMs);
    const result = await this.redis.set(this.toLockKey(key), token, 'PX', ttlMs, 'NX');

    return result === 'OK';
  }

  async releaseLock(key: CacheKey, token: string): Promise<void> {
    await this.executeScript(
      RELEASE_LOCK_SCRIPT_NAME,
      RELEASE_LOCK_LUA,
      [this.toLockKey(key)],
      [token],
      false,
      this.registeredScripts.releaseLock,
    );
  }

  async renewLock(key: CacheKey, token: string, ttlMs: number): Promise<boolean> {
    this.assertDataKey(key);
    this.resolveTtl(ttlMs);
    const result = await this.executeScript(
      RENEW_LOCK_SCRIPT_NAME,
      RENEW_LOCK_LUA,
      [this.toLockKey(key)],
      [token, ttlMs],
      false,
      this.registeredScripts.renewLock,
    );
    return normalizeIntegerReply(result) === 1;
  }

  /**
   * Publish an encoded L2 value only while `token` still owns the per-entry
   * lease. The ownership check and SET+PX happen in one Redis operation, so a
   * former owner cannot resume after takeover and overwrite the winner.
   *
   * A rejected owner is represented by `not-owner`; transport, ACL, script,
   * wrong-type and validation errors reject the promise and remain distinct
   * from a clean coordination result for HybridCache's fail-open boundary.
   */
  async publishIfOwner(
    key: CacheKey,
    token: string,
    payload: Uint8Array,
    ttlOrOptions: CacheOptions | number = {},
  ): Promise<AtomicPublicationResult> {
    this.assertDataKey(key);
    const ttlMs = this.resolveTtl(ttlOrOptions);
    this.resolveMaxEntries(ttlOrOptions);
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new RangeError('Redis publication ttlMs must be a positive safe integer');
    }
    if (typeof token !== 'string' || token.length === 0) {
      throw new TypeError('Redis publication token must be a non-empty string');
    }

    const encoded = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const redisKey = this.toRedisKey(key);
    const lockKey = this.toLockKey(key);
    const result = await this.executeScript(
      PUBLISH_IF_OWNER_SCRIPT_NAME,
      PUBLISH_IF_OWNER_LUA,
      [redisKey, lockKey],
      [token, encoded, ttlMs],
      false,
      this.registeredScripts.publishIfOwner,
    );

    if (normalizeIntegerReply(result) !== 1) {
      debugLog('redis publication rejected because the lease is not owned', { key });
      return 'not-owner';
    }

    /* The shared index is deliberately maintained outside the two-key script:
     * it is namespace-wide and may be in another Cluster slot. Its failure
     * cannot turn an already committed data write into `not-owner`. */
    await this.recordPublishedIndex(redisKey, ttlOrOptions);
    debugLog('redis publication committed', { key, ttlMs });
    return 'published';
  }

  /** Compatibility spelling for adapters that call the operation a SET. */
  async setEncodedIfOwner(
    key: CacheKey,
    token: string,
    payload: Uint8Array,
    ttlOrOptions: CacheOptions | number = {},
  ): Promise<AtomicPublicationResult> {
    return this.publishIfOwner(key, token, payload, ttlOrOptions);
  }

  /** Explicit spelling for callers that distinguish encoded publication. */
  async publishEncodedIfOwner(
    key: CacheKey,
    token: string,
    payload: Uint8Array,
    ttlOrOptions: CacheOptions | number = {},
  ): Promise<AtomicPublicationResult> {
    return this.publishIfOwner(key, token, payload, ttlOrOptions);
  }

  private toRedisKey(key: CacheKey): string {
    if (this.useVersionedKeys) {
      const logicalKey = String(key);
      return `${VERSIONED_KEY_PREFIX}{${this.toSlotTag(logicalKey)}}:${this.prefix}${logicalKey}`;
    }

    return `${this.prefix}${String(key)}`;
  }

  private toRedisPattern(pattern: string): string {
    if (this.useVersionedKeys) {
      return `${VERSIONED_KEY_PREFIX}*:${escapeRedisGlob(this.prefix)}${cachePatternToRedisGlob(pattern)}`;
    }

    return `${escapeRedisGlob(this.prefix)}${cachePatternToRedisGlob(pattern)}`;
  }

  private toLogicalKey(redisKey: string): string {
    return this.parseRedisKey(redisKey)?.logicalKey ?? redisKey;
  }

  private toLockKey(key: CacheKey): string {
    if (this.useVersionedKeys) {
      const logicalKey = String(key);
      return `${VERSIONED_KEY_PREFIX}{${this.toSlotTag(logicalKey)}}:${this.prefix}__lock:${logicalKey}`;
    }

    return `${this.prefix}__lock:${String(key)}`;
  }

  private isInternalRedisKey(redisKey: string): boolean {
    return this.parseRedisKey(redisKey)?.kind !== 'data';
  }

  private assertDataKey(key: CacheKey): void {
    if (!this.useVersionedKeys && (String(key).startsWith('__lock:') || this.toRedisKey(key) === this.indexKey)) {
      throw new RangeError('RedisStore legacy key collides with reserved index/lease metadata; use a different key or v2 layout');
    }
  }

  private parseRedisKey(redisKey: string): { kind: 'data' | 'lock'; logicalKey: string } | undefined {
    if (redisKey === this.indexKey) return undefined;
    if (!this.useVersionedKeys) {
      if (!redisKey.startsWith(this.prefix)) return undefined;
      const logicalKey = redisKey.slice(this.prefix.length);
      return logicalKey.startsWith('__lock:')
        ? { kind: 'lock', logicalKey: logicalKey.slice('__lock:'.length) }
        : { kind: 'data', logicalKey };
    }
    if (!redisKey.startsWith(`${VERSIONED_KEY_PREFIX}{`)) return undefined;
    const tagEnd = redisKey.indexOf('}:', VERSIONED_KEY_PREFIX.length);
    if (tagEnd < 0) return undefined;
    const suffix = redisKey.slice(tagEnd + 2);
    if (!suffix.startsWith(this.prefix)) return undefined;
    const logicalKey = suffix.slice(this.prefix.length);
    // Rebuilding the full key validates both prefix scope and the logical-key
    // hash tag. A nested namespace or a logical '__lock:' key cannot masquerade
    // as this cache's lease merely by sharing a byte prefix.
    if (this.toRedisKey(logicalKey) === redisKey) return { kind: 'data', logicalKey };
    if (logicalKey.startsWith('__lock:')) {
      const lockedKey = logicalKey.slice('__lock:'.length);
      if (this.toLockKey(lockedKey) === redisKey) return { kind: 'lock', logicalKey: lockedKey };
    }
    return undefined;
  }

  private async fencePatternLeases(pattern: string): Promise<void> {
    const stream = this.redis.scanStream({
      match: `${VERSIONED_KEY_PREFIX}*:${escapeRedisGlob(this.prefix)}__lock:${cachePatternToRedisGlob(pattern)}`,
      count: this.getScanCount(),
    });
    for await (const keys of stream) {
      for (const redisKey of keys as string[]) {
        const parsed = this.parseRedisKey(redisKey);
        if (parsed?.kind !== 'lock' || !matchesPattern(parsed.logicalKey, pattern)) continue;
        await this.executeScript(
          DELETE_AND_FENCE_SCRIPT_NAME,
          DELETE_AND_FENCE_LUA,
          [this.toRedisKey(parsed.logicalKey), redisKey],
          [], false, this.registeredScripts.deleteAndFence,
        );
      }
    }
  }

  /** encodeURIComponent escapes braces, so each complete logical key is its
   * own collision-free Cluster hash tag rather than sharing one global slot. */
  private toSlotTag(logicalKey: string): string {
    try {
      return encodeURIComponent(logicalKey) || '_';
    } catch {
      /* Invalid UTF-16 still has a deterministic tag that is free of hash-tag
       * delimiters and remains distinct after Redis's UTF-8 wire encoding. */
      // UTF-8 replacement would collapse distinct lone surrogates. Preserve
      // every UTF-16 code unit; ':' is absent from ordinary URI-encoded tags,
      // so this fallback is disjoint from all valid-Unicode tags.
      return `utf16:${Buffer.from(logicalKey, 'utf16le').toString('base64url')}`;
    }
  }

  private async executeScript(
    name: string,
    lua: string,
    keys: readonly string[],
    args: readonly unknown[],
    bufferReply: boolean,
    registered = true,
  ): Promise<unknown> {
    const commandName = bufferReply ? `${name}Buffer` : name;
    const command = (this.redis as unknown as Record<string, unknown>)[commandName];
    if (registered && typeof command === 'function') {
      try {
        return await (command as (...values: unknown[]) => Promise<unknown>).apply(
          this.redis,
          [...keys, ...args],
        );
      } catch (error) {
        /* NOSCRIPT is definitive: the server did not run the mutation. It is
         * safe to reload through EVAL once. Timeouts and all other errors are
         * deliberately allowed to reject; replaying an uncertain mutation is
         * not safe. ioredis normally performs this recovery itself for a
         * defineCommand script, but injected adapters may not. */
        if (!isNoScriptError(error)) throw error;
      }
    }

    const evalName = bufferReply ? 'evalBuffer' : 'eval';
    const evaluator = (this.redis as unknown as Record<string, unknown>)[evalName];
    if (typeof evaluator === 'function') {
      return (evaluator as (...values: unknown[]) => Promise<unknown>).apply(this.redis, [
        lua,
        keys.length,
        ...keys,
        ...args,
      ]);
    }

    /* Minimal injected clients often expose only EVAL. */
    return this.redis.eval(
      lua,
      keys.length,
      ...keys,
      ...(args as Array<string | Buffer | number>),
    );
  }

  private resolveTtl(options: CacheOptions | number): number {
    const ttlMs = typeof options === 'number' ? options : options.levels?.L2?.ttlMs
      ?? options.ttlMs
      ?? this.options.levels?.L2?.ttlMs
      ?? this.options.ttlMs
      ?? DEFAULT_CACHE_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('RedisStore ttlMs must be a positive safe integer');
    return ttlMs;
  }

  private resolveMaxEntries(options: CacheOptions | number): number | undefined {
    const maxEntries = typeof options === 'number' ? this.options.levels?.L2?.maxEntries
      : options.levels?.L2?.maxEntries ?? this.options.levels?.L2?.maxEntries;
    if (maxEntries !== undefined && (!Number.isSafeInteger(maxEntries) || maxEntries < 0)) {
      throw new RangeError('RedisStore L2 maxEntries must be a non-negative safe integer');
    }
    return maxEntries;
  }

  private codecOptions(options: CacheOptions): SerializeOptions {
    return options.levels?.L2?.codec
      ?? this.options.levels?.L2?.codec
      ?? {};
  }

  private async recordPublishedIndex(redisKey: string, options: CacheOptions | number): Promise<void> {
    if (!this.useIndex()) return;

    try {
      await this.redis.zadd(this.indexKey, Date.now() + this.resolveTtl(options), redisKey);
      const maxEntries = this.resolveMaxEntries(options);
      if (maxEntries !== undefined) await this.trimIndex(maxEntries);
    } catch (error) {
      /* The data + TTL commit has already succeeded. Index repair is bounded
       * bookkeeping, so preserve the committed result and surface diagnostics
       * without misclassifying it as ownership loss. */
      errorLog('redis publication index maintenance failed', { key: redisKey, error });
    }
  }

  private useIndex(): boolean {
    // Redis TTL/native eviction is the default. An explicit L2 maxEntries
    // request opts into the bounded catalogue needed to enforce that local
    // policy; callers can still force a scan path with useIndex:false.
    return this.options.useIndex ?? this.options.levels?.L2?.maxEntries !== undefined;
  }

  private async pruneExpiredIndexMembers(): Promise<void> {
    if (!this.useIndex()) return;
    const removeExpired = (this.redis as unknown as {
      zremrangebyscore?: (key: string, min: string | number, max: string | number) => Promise<unknown>;
    }).zremrangebyscore;
    if (typeof removeExpired !== 'function') return;
    try {
      await removeExpired.call(this.redis, this.indexKey, '-inf', Date.now());
    } catch (error) {
      // Catalogue repair is maintenance. A Redis command failure must not turn
      // a successful cache read into an application failure.
      errorLog('redis index expiry repair failed', { error });
    }
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
        const key = entries[index]!;
        const parsed = this.parseRedisKey(key);
        if (parsed?.kind !== 'data' || !matchesPattern(parsed.logicalKey, pattern)) continue;
        batch.push(key);

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
      const batch = keys.slice(index, index + this.getBatchSize()).filter((key) => this.parseRedisKey(key)?.kind === 'data');
      if (batch.length === 0) continue;

      if (this.useVersionedKeys) {
        /* Each v2 data/lease pair is same-slot. Execute one fenced delete per
         * entry; a multi-key pattern is not required to be globally atomic. */
        for (const redisKey of batch) {
          if (this.isInternalRedisKey(redisKey)) continue;
          const logicalKey = this.toLogicalKey(redisKey);
          await this.executeScript(
            DELETE_AND_FENCE_SCRIPT_NAME,
            DELETE_AND_FENCE_LUA,
            [redisKey, this.toLockKey(logicalKey)],
            [],
            false,
            this.registeredScripts.deleteAndFence,
          );
        }
        if (this.useIndex()) {
          await this.redis.zrem(this.indexKey, ...batch);
        }
        debugLog('redis delete batch', {
          count: batch.length,
          strategy: 'del',
          indexed: this.useIndex(),
          fenced: true,
        });
        continue;
      }

      const pipeline = this.redis.pipeline();

      if (this.options.deleteStrategy === 'del') {
        pipeline.del(...batch);
      } else {
        pipeline.unlink(...batch);
      }

      if (this.useIndex()) {
        pipeline.zrem(this.indexKey, ...batch);
      }

      validateRedisPipeline(await pipeline.exec(), [
        { command: this.options.deleteStrategy === 'del' ? 'DEL' : 'UNLINK', key: batch[0] },
        ...(this.useIndex() ? [{ command: 'ZREM', key: this.indexKey }] : []),
      ]);
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
    await this.pruneExpiredIndexMembers();
    const size = await this.redis.zcard(this.indexKey);
    const overflow = size - maxEntries;

    if (overflow <= 0) {
      return;
    }

    const selected = await this.redis.zrange(
      this.indexKey,
      0,
      String(overflow - 1),
      'WITHSCORES',
    );
    const candidates: Array<{ key: string; score?: string }> = [];
    // Redis returns [member, score, ...] for WITHSCORES. Keep compatibility
    // with small injected clients that return members only.
    const hasScores = selected.length > 0
      && selected.length % 2 === 0
      && selected.every((value, index) => index % 2 === 0 || Number.isFinite(Number(value)));
    if (hasScores) {
      for (let index = 0; index < selected.length; index += 2) {
        candidates.push({ key: selected[index], score: selected[index + 1] });
      }
    } else {
      for (const key of selected) candidates.push({ key });
    }

    const zscore = (this.redis as unknown as {
      zscore?: (key: string, member: string) => Promise<string | null>;
    }).zscore;
    const victims: string[] = [];
    for (const candidate of candidates) {
      if (candidate.score !== undefined && typeof zscore === 'function') {
        const current = await zscore.call(this.redis, this.indexKey, candidate.key);
        // A refresh updates the expiry score. Recheck immediately before the
        // destructive operation so a victim selected from an older snapshot
        // is skipped rather than deleting the refreshed value.
        if (current === null || current !== candidate.score) continue;
      }
      victims.push(candidate.key);
    }

    await this.deleteKeys(victims);
    debugLog('redis index trim', { maxEntries, selected: candidates.length, removed: victims.length });
  }
}

function escapeRedisGlob(value: string): string {
  return value.replace(/[\\*?[\]]/g, '\\$&');
}

function cachePatternToRedisGlob(value: string): string {
  return value.replace(/[\\?[\]]/g, '\\$&');
}

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
