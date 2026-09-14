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
  deserialize,
  estimateValueBytes,
  inspectBuffer,
  serialize,
  sizeSavings,
  type SerializeOptions,
} from '../utils/serializer.js';
import { DEFAULT_CACHE_TTL_MS } from './defaults.js';
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
local value = redis.call("get", KEYS[1])
if value == false then return {false, -2} end
return {value, redis.call("pttl", KEYS[1])}
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
    this.prefix = options.prefix ?? 'cache:';
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
    const ttlMs = this.resolveTtl(options);
    const maxEntries = options.levels?.L2?.maxEntries ?? this.options.levels?.L2?.maxEntries;
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
    return encoded === undefined ? undefined : deserialize(encoded.buffer) as V;
  }

  async getEncoded(key: CacheKey): Promise<{ buffer: Buffer; ttlRemainingMs: number } | undefined> {
    const redisKey = this.toRedisKey(key);
    let raw: Buffer | null;
    let ttlRemainingMs: number;

    const snapshotCommand = (this.redis as unknown as Record<string, unknown>)[`${SNAPSHOT_SCRIPT_NAME}Buffer`]
      ?? (this.redis as unknown as Record<string, unknown>)[SNAPSHOT_SCRIPT_NAME];
    if (this.registeredScripts.snapshot && typeof snapshotCommand === 'function') {
      /* The Buffer variant is generated by ioredis alongside the named
       * command. If an injected client implements defineCommand only as a
       * spy, fall back to its ordinary binary read rather than assuming the
       * custom reply shape. */
      const snapshot = await this.executeScript(
        SNAPSHOT_SCRIPT_NAME,
        SNAPSHOT_LUA,
        [redisKey],
        [],
        true,
      );
      const tuple = Array.isArray(snapshot) ? snapshot : [];
      const value = tuple[0];
      raw = value === false || value === null || value === undefined
        ? null
        : Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array | string);
      ttlRemainingMs = normalizeIntegerReply(tuple[1]);
    } else {
      const tracksTtl = typeof this.redis.pttl === 'function';
      const [value, ttl] = await Promise.all([
        this.redis.getBuffer(redisKey),
        tracksTtl ? this.redis.pttl(redisKey) : Promise.resolve(-1),
      ]);
      raw = value;
      ttlRemainingMs = ttl;
    }

    if (raw === null || ttlRemainingMs === -2) {
      await this.removeFromIndex(redisKey);
      debugLog('redis miss', { key });
      return undefined;
    }

    debugLog('redis hit', { key });

    return { buffer: raw, ttlRemainingMs };
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
      await this.pruneExpiredIndexMembers();
      await this.deleteIndexedPattern(pattern);
      return;
    }

    const stream = this.redis.scanStream({
      match: this.toRedisPattern(pattern),
      count: this.getScanCount(),
    });

    for await (const keys of stream) {
      const batch = (keys as string[]).filter((key) => !this.isInternalRedisKey(key));

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
      await this.pruneExpiredIndexMembers();
      return this.redis.zcard(this.indexKey);
    }

    let count = 0;
    const stream = this.redis.scanStream({
      match: this.useVersionedKeys ? this.toRedisPattern('*') : `${this.prefix}*`,
      count: this.getScanCount(),
    });

    for await (const keys of stream) {
      count += (keys as string[]).filter((key) => !this.isInternalRedisKey(key)).length;
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
      redisKeys = found.filter((key) => !this.isInternalRedisKey(key));
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
    const ttlMs = this.resolveTtl(ttlOrOptions);
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
      return `${VERSIONED_KEY_PREFIX}*:${this.prefix}${pattern}`;
    }

    return `${this.prefix}${pattern}`;
  }

  private toLogicalKey(redisKey: string): string {
    if (this.useVersionedKeys && redisKey.startsWith(VERSIONED_KEY_PREFIX)) {
      const prefixMarker = `:${this.prefix}`;
      const prefixIndex = redisKey.indexOf(prefixMarker, VERSIONED_KEY_PREFIX.length);
      if (prefixIndex >= 0) {
        return redisKey.slice(prefixIndex + prefixMarker.length);
      }
    }

    return redisKey.startsWith(this.prefix) ? redisKey.slice(this.prefix.length) : redisKey;
  }

  private toLockKey(key: CacheKey): string {
    if (this.useVersionedKeys) {
      const logicalKey = String(key);
      return `${VERSIONED_KEY_PREFIX}{${this.toSlotTag(logicalKey)}}:${this.prefix}__lock:${logicalKey}`;
    }

    return `${this.prefix}__lock:${String(key)}`;
  }

  private isInternalRedisKey(redisKey: string): boolean {
    if (this.useVersionedKeys) {
      return redisKey.includes(`:${this.prefix}__`);
    }
    return redisKey.startsWith(`${this.prefix}__`);
  }

  /** encodeURIComponent escapes braces, so each complete logical key is its
   * own collision-free Cluster hash tag rather than sharing one global slot. */
  private toSlotTag(logicalKey: string): string {
    try {
      return encodeURIComponent(logicalKey) || '_';
    } catch {
      /* Invalid UTF-16 (for example a lone surrogate) is still represented by
       * a deterministic binary tag. Redis receives the same String(key) bytes
       * for the suffix, while the tag remains free of hash-tag delimiters. */
      return Buffer.from(logicalKey).toString('base64url') || '_';
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
    if (typeof options === 'number') return options;
    return options.levels?.L2?.ttlMs
      ?? options.ttlMs
      ?? this.options.levels?.L2?.ttlMs
      ?? this.options.ttlMs
      ?? DEFAULT_CACHE_TTL_MS;
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
      const maxEntries = typeof options === 'number'
        ? this.options.levels?.L2?.maxEntries
        : options.levels?.L2?.maxEntries ?? this.options.levels?.L2?.maxEntries;
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
