import {
  classifyRedisError,
  MINIMUM_REDIS_MAJOR_VERSION,
  parseRedisServerVersion,
  type RedisHealthIssue,
  type RedisServerVersion,
} from './redisHealth.js';

/**
 * Redis commands whose presence matters to the cache and transaction
 * coordination paths. This is deliberately a small allow-list: capability
 * discovery never asks Redis for the unbounded output of `COMMAND`.
 */
export const REDIS_CAPABILITY_COMMANDS = Object.freeze([
  'eval',
  'evalsha',
  'script',
  'multi',
  'exec',
  'watch',
  'unwatch',
  'set',
  'get',
  'del',
  'unlink',
  'exists',
  'pexpire',
  'pttl',
  'publish',
  'subscribe',
  'ping',
  'time',
] as const);

export type RedisCapabilityName = (typeof REDIS_CAPABILITY_COMMANDS)[number];

export type RedisCapabilityState = 'supported' | 'unavailable' | 'unknown';

/** A safe reason for a capability state. Raw Redis messages are never kept. */
export type RedisCapabilityReason =
  | 'advertised'
  | 'unknown-command'
  | 'acl-denied'
  | 'transport'
  | 'timeout'
  | 'command-error'
  | 'malformed-response'
  | 'response-too-large'
  | 'client-method-unavailable'
  | 'unsupported-version'
  | 'not-queried';

export interface RedisCapabilityStateRecord {
  readonly status: RedisCapabilityState;
  readonly reason?: RedisCapabilityReason;
  /** A sanitized Redis/Node error code, when one is available. */
  readonly code?: string;
}

export interface RedisCapabilityDiscoveryLimits {
  /** Maximum time allowed for each INFO or COMMAND INFO request. */
  readonly timeoutMs: number;
  /** Maximum number of command names placed in COMMAND INFO. */
  readonly maxCommandNames: number;
  /** Maximum accepted INFO reply size in bytes. */
  readonly maxInfoBytes: number;
  /** Maximum accepted COMMAND INFO reply size in bytes. */
  readonly maxCommandReplyBytes: number;
}

export interface RedisCapabilityManifest {
  /** Wall-clock time at which the manifest was produced. */
  readonly generatedAt: number;
  /** Discovery duration in milliseconds, rounded to a stable non-negative value. */
  readonly durationMs: number;
  /** Always true. This field makes the bounded-discovery contract inspectable. */
  readonly bounded: true;
  readonly limits: RedisCapabilityDiscoveryLimits;
  readonly version?: RedisServerVersion;
  readonly info: RedisCapabilityStateRecord;
  readonly commandInfo: RedisCapabilityStateRecord;
  readonly capabilities: Readonly<Record<RedisCapabilityName, RedisCapabilityStateRecord>>;
}

/**
 * Minimal client contract used by capability discovery. The contract accepts
 * ioredis and compatible clients without importing or constructing a Redis
 * client. `on`/`off` are optional because discovery also works with one-shot
 * clients that do not expose reconnect events.
 */
export interface RedisCapabilityClient {
  info?: (section?: string) => Promise<unknown>;
  command?: (...args: string[]) => Promise<unknown>;
  on?: (event: string, listener: () => void) => unknown;
  off?: (event: string, listener: () => void) => unknown;
  removeListener?: (event: string, listener: () => void) => unknown;
}

/**
 * Compatibility contract for operators and client adapters. Discovery is
 * read-only and does not require `CONFIG`, scripting, or transaction commands
 * to be callable before their state is known.
 */
export const REDIS_CAPABILITY_CLIENT_CONTRACT = Object.freeze({
  requiredMethods: Object.freeze(['info', 'command']),
  optionalReconnectMethods: Object.freeze(['on', 'off', 'removeListener']),
  discoveryCommands: Object.freeze(['INFO server', 'COMMAND INFO <allow-list>']),
  mutatesRedisConfiguration: false,
  maxCommandNames: 64,
  minimumRedisMajorVersion: 6,
} as const);

export const DEFAULT_REDIS_CAPABILITY_TIMEOUT_MS = 250;
export const DEFAULT_REDIS_CAPABILITY_MAX_COMMAND_NAMES = REDIS_CAPABILITY_COMMANDS.length;
export const DEFAULT_REDIS_CAPABILITY_MAX_INFO_BYTES = 16 * 1024;
export const DEFAULT_REDIS_CAPABILITY_MAX_COMMAND_REPLY_BYTES = 64 * 1024;

/** Hard ceilings prevent an accidental option from making discovery unbounded. */
export const MAX_REDIS_CAPABILITY_COMMAND_NAMES = 64;
export const MAX_REDIS_CAPABILITY_INFO_BYTES = 64 * 1024;
export const MAX_REDIS_CAPABILITY_COMMAND_REPLY_BYTES = 256 * 1024;

export interface RedisCapabilityDiscoveryOptions {
  timeoutMs?: number;
  maxCommandNames?: number;
  maxInfoBytes?: number;
  maxCommandReplyBytes?: number;
  /** Restrict the command subset to inspect. Unknown names are ignored. */
  commandNames?: readonly RedisCapabilityName[];
  /** Override the minimum Redis major version for an adapter, if required. */
  minimumRedisMajorVersion?: number;
  /** Injectable clock for deterministic adapters and tests. */
  now?: () => number;
}

/**
 * Discover Redis core capabilities with two bounded, read-only requests:
 * `INFO server` and `COMMAND INFO` for a fixed allow-list. A discovery failure
 * is represented as `unknown` when the server may still support the command.
 * A command explicitly reported as absent is `unavailable`.
 */
export async function discoverRedisCapabilities(
  client: RedisCapabilityClient,
  options: RedisCapabilityDiscoveryOptions = {},
): Promise<RedisCapabilityManifest> {
  const limits = normalizeLimits(options);
  const minimumRedisMajorVersion = normalizeMinimumVersion(options.minimumRedisMajorVersion);
  const commandNames = normalizeCommandNames(options.commandNames, limits.maxCommandNames);
  const now = options.now ?? Date.now;
  const startedAt = now();

  const capabilities = createUnknownCapabilities('not-queried');
  let version: RedisServerVersion | undefined;
  let info: RedisCapabilityStateRecord;

  if (typeof client.info !== 'function') {
    info = state('unknown', 'client-method-unavailable');
  } else {
    try {
      const infoReply = await withTimeout(
        client.info('server'),
        limits.timeoutMs,
        'INFO server',
      );

      if (replyBytes(infoReply) > limits.maxInfoBytes) {
        info = state('unavailable', 'response-too-large');
      } else {
        version = parseRedisServerVersion(infoReply);
        info = version
          ? state('supported', 'advertised')
          : state('unavailable', 'malformed-response');
      }
    } catch (error) {
      info = failureState(error);
    }
  }

  if (version && version.major < minimumRedisMajorVersion) {
    markAll(capabilities, 'unavailable', 'unsupported-version');
    return manifest({
      generatedAt: now(),
      startedAt,
      now,
      limits,
      version,
      info,
      commandInfo: state('unavailable', 'unsupported-version'),
      capabilities,
    });
  }

  let commandInfo: RedisCapabilityStateRecord;

  if (typeof client.command !== 'function') {
    commandInfo = state('unknown', 'client-method-unavailable');
    markUnknown(capabilities, commandInfo);
  } else if (commandNames.length === 0) {
    commandInfo = state('unknown', 'not-queried');
  } else {
    try {
      // ioredis exposes COMMAND through command(...args). Only INFO and the
      // bounded allow-list are sent. No caller-supplied text reaches CONFIG.
      const commandReply = await withTimeout(
        client.command('INFO', ...commandNames),
        limits.timeoutMs,
        'COMMAND INFO',
      );

      if (replyBytes(commandReply) > limits.maxCommandReplyBytes) {
        commandInfo = state('unavailable', 'response-too-large');
        markUnknown(capabilities, commandInfo);
      } else {
        const parsed = parseCommandInfoReply(commandReply, commandNames);
        if (!parsed.valid) {
          commandInfo = state('unavailable', 'malformed-response');
          markUnknown(capabilities, commandInfo);
        } else {
          commandInfo = state('supported', 'advertised');

          for (const name of commandNames) {
            capabilities[name] = parsed.supported.has(name)
              ? state('supported', 'advertised')
              : state('unavailable', 'unknown-command');
          }
        }
      }
    } catch (error) {
      commandInfo = failureState(error);
      markUnknown(capabilities, commandInfo);
    }
  }

  return manifest({
    generatedAt: now(),
    startedAt,
    now,
    limits,
    version,
    info,
    commandInfo,
    capabilities,
  });
}

/** Return true only when the manifest positively advertises a command. */
export function hasRedisCapability(
  manifestValue: RedisCapabilityManifest,
  name: RedisCapabilityName,
): boolean {
  return manifestValue.capabilities[name]?.status === 'supported';
}

/**
 * Cache one manifest per connection and invalidate it on Redis reconnect. The
 * registry deduplicates simultaneous discovery calls and can be closed to
 * detach listeners in long-lived processes.
 */
export class RedisCapabilityRegistry {
  private manifestPromise?: Promise<RedisCapabilityManifest>;
  private readonly detachReconnect: () => void;

  constructor(
    private readonly client: RedisCapabilityClient,
    private readonly options: RedisCapabilityDiscoveryOptions = {},
  ) {
    this.detachReconnect = attachRedisReconnectInvalidation(client, () => this.invalidate());
  }

  get(): Promise<RedisCapabilityManifest> {
    this.manifestPromise ??= discoverRedisCapabilities(this.client, this.options);
    return this.manifestPromise;
  }

  invalidate(): void {
    this.manifestPromise = undefined;
  }

  close(): void {
    this.detachReconnect();
    this.invalidate();
  }
}

/**
 * Attach invalidation to the `ready` event emitted after ioredis connects or
 * reconnects. Returns an idempotent detach function for application teardown.
 */
export function attachRedisReconnectInvalidation(
  client: RedisCapabilityClient,
  invalidate: () => void,
): () => void {
  if (typeof client.on !== 'function') {
    return () => undefined;
  }

  const listener = () => invalidate();
  client.on('ready', listener);
  let detached = false;

  return () => {
    if (detached) return;
    detached = true;

    if (typeof client.off === 'function') {
      client.off('ready', listener);
    } else {
      client.removeListener?.('ready', listener);
    }
  };
}

interface ParsedCommandInfo {
  valid: boolean;
  supported: Set<RedisCapabilityName>;
}

function parseCommandInfoReply(
  reply: unknown,
  names: readonly RedisCapabilityName[],
): ParsedCommandInfo {
  const supported = new Set<RedisCapabilityName>();
  const entries: unknown[] = [];

  if (Array.isArray(reply)) {
    // COMMAND INFO returns one entry per requested command. Supporting the
    // single-entry form makes adapters that unwrap one-element RESP arrays
    // compatible without broadening the request.
    if (
      names.length === 1
      && !(reply.length === 1 && (reply[0] === null || reply[0] === undefined))
      && isCommandInfoEntry(reply)
    ) {
      entries.push(reply);
    } else {
      entries.push(...reply);
    }
  } else if (isRecord(reply)) {
    for (const name of names) {
      entries.push(findRecordValue(reply, name));
    }
  } else {
    return { valid: false, supported };
  }

  if (entries.length < names.length) {
    return { valid: false, supported };
  }

  for (let index = 0; index < names.length; index += 1) {
    const entry = entries[index];
    if (entry === null || entry === undefined) continue;
    if (!isCommandInfoEntry(entry)) return { valid: false, supported };
    supported.add(names[index]);
  }

  return { valid: true, supported };
}

function isCommandInfoEntry(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (!isRecord(value)) return false;

  return 'name' in value || 'arity' in value || 'flags' in value || 'firstKey' in value;
}

function findRecordValue(record: Record<string, unknown>, name: string): unknown {
  return record[name] ?? record[name.toUpperCase()] ?? record[name.toLowerCase()];
}

function createUnknownCapabilities(
  reason: RedisCapabilityReason,
): Record<RedisCapabilityName, RedisCapabilityStateRecord> {
  const result = {} as Record<RedisCapabilityName, RedisCapabilityStateRecord>;
  for (const name of REDIS_CAPABILITY_COMMANDS) {
    result[name] = state('unknown', reason);
  }
  return result;
}

function markAll(
  capabilities: Record<RedisCapabilityName, RedisCapabilityStateRecord>,
  status: RedisCapabilityState,
  reason: RedisCapabilityReason,
): void {
  for (const name of REDIS_CAPABILITY_COMMANDS) {
    capabilities[name] = state(status, reason);
  }
}

function markUnknown(
  capabilities: Record<RedisCapabilityName, RedisCapabilityStateRecord>,
  discovery: RedisCapabilityStateRecord,
): void {
  for (const name of REDIS_CAPABILITY_COMMANDS) {
    capabilities[name] = state('unknown', discovery.reason ?? 'command-error', discovery.code);
  }
}

function normalizeCommandNames(
  requested: readonly RedisCapabilityName[] | undefined,
  maxCommandNames: number,
): RedisCapabilityName[] {
  const source = requested ?? REDIS_CAPABILITY_COMMANDS;
  const allowed = new Set<string>(REDIS_CAPABILITY_COMMANDS);
  const result: RedisCapabilityName[] = [];

  for (const candidate of source) {
    if (typeof candidate !== 'string' || !allowed.has(candidate) || result.includes(candidate as RedisCapabilityName)) {
      continue;
    }
    result.push(candidate as RedisCapabilityName);
    if (result.length >= maxCommandNames) break;
  }

  return result;
}

function normalizeLimits(options: RedisCapabilityDiscoveryOptions): RedisCapabilityDiscoveryLimits {
  return {
    timeoutMs: boundedPositiveInteger(
      options.timeoutMs,
      DEFAULT_REDIS_CAPABILITY_TIMEOUT_MS,
      1,
      60_000,
    ),
    maxCommandNames: boundedPositiveInteger(
      options.maxCommandNames,
      DEFAULT_REDIS_CAPABILITY_MAX_COMMAND_NAMES,
      1,
      MAX_REDIS_CAPABILITY_COMMAND_NAMES,
    ),
    maxInfoBytes: boundedPositiveInteger(
      options.maxInfoBytes,
      DEFAULT_REDIS_CAPABILITY_MAX_INFO_BYTES,
      1,
      MAX_REDIS_CAPABILITY_INFO_BYTES,
    ),
    maxCommandReplyBytes: boundedPositiveInteger(
      options.maxCommandReplyBytes,
      DEFAULT_REDIS_CAPABILITY_MAX_COMMAND_REPLY_BYTES,
      1,
      MAX_REDIS_CAPABILITY_COMMAND_REPLY_BYTES,
    ),
  };
}

function normalizeMinimumVersion(value: number | undefined): number {
  return boundedPositiveInteger(value, MINIMUM_REDIS_MAJOR_VERSION, 1, 99);
}

function boundedPositiveInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value === undefined) return fallback;
  return Math.min(max, Math.max(min, value));
}

function state(
  status: RedisCapabilityState,
  reason?: RedisCapabilityReason,
  code?: string,
): RedisCapabilityStateRecord {
  return Object.freeze(code === undefined ? { status, reason } : { status, reason, code });
}

function failureState(error: unknown): RedisCapabilityStateRecord {
  if (isDiscoveryTimeout(error)) {
    return state('unknown', 'timeout', safeCode(error));
  }

  const issue = classifyRedisError(error);
  return stateForIssue(issue);
}

function stateForIssue(issue: RedisHealthIssue): RedisCapabilityStateRecord {
  switch (issue.kind) {
    case 'acl':
      return state('unavailable', 'acl-denied', issue.code);
    case 'unknown-command':
      return state('unavailable', 'unknown-command', issue.code);
    case 'transport':
      return state('unknown', 'transport', issue.code);
    case 'malformed-info':
      return state('unavailable', 'malformed-response', issue.code);
    case 'unsupported-version':
      return state('unavailable', 'unsupported-version', issue.code);
    case 'command':
    default:
      return state('unknown', 'command-error', issue.code);
  }
}

function manifest(input: {
  generatedAt: number;
  startedAt: number;
  now: () => number;
  limits: RedisCapabilityDiscoveryLimits;
  version?: RedisServerVersion;
  info: RedisCapabilityStateRecord;
  commandInfo: RedisCapabilityStateRecord;
  capabilities: Record<RedisCapabilityName, RedisCapabilityStateRecord>;
}): RedisCapabilityManifest {
  const duration = input.now() - input.startedAt;
  return Object.freeze({
    generatedAt: input.generatedAt,
    durationMs: Number.isFinite(duration) && duration >= 0 ? duration : 0,
    bounded: true as const,
    limits: Object.freeze({ ...input.limits }),
    ...(input.version ? { version: input.version } : {}),
    info: input.info,
    commandInfo: input.commandInfo,
    capabilities: Object.freeze({ ...input.capabilities }),
  });
}

function replyBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (Buffer.isBuffer(value)) return value.byteLength;
  return boundedValueBytes(value, 256 * 1024 + 1);
}

/** Measure a response up to a cap without recursively serializing untrusted data. */
function boundedValueBytes(value: unknown, cap: number): number {
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  let total = 0;

  while (stack.length > 0 && total <= cap) {
    const current = stack.pop();
    if (current === null || current === undefined) {
      total += 4;
    } else if (typeof current === 'string') {
      total += Buffer.byteLength(current);
    } else if (typeof current === 'number' || typeof current === 'boolean' || typeof current === 'bigint') {
      total += 16;
    } else if (Buffer.isBuffer(current)) {
      total += current.byteLength;
    } else if (typeof current === 'object') {
      if (seen.has(current)) continue;
      seen.add(current);
      if (Array.isArray(current)) {
        total += 2;
        for (const item of current) stack.push(item);
      } else {
        total += 2;
        for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
          total += Buffer.byteLength(key) + 2;
          stack.push(item);
        }
      }
    }
  }

  return total;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeCode(error: unknown): string | undefined {
  const value = (error as { code?: unknown } | undefined)?.code;
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : undefined;
}

function isDiscoveryTimeout(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | undefined;
  return candidate?.code === 'REDIS_CAPABILITY_DISCOVERY_TIMEOUT'
    || (typeof candidate?.message === 'string' && /\btimeout\b/i.test(candidate.message));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${operation} timed out`);
      error.name = 'RedisCapabilityDiscoveryTimeoutError';
      Object.defineProperty(error, 'code', {
        value: 'REDIS_CAPABILITY_DISCOVERY_TIMEOUT',
        enumerable: true,
      });
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
