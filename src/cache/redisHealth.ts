/** Lowest Redis major version supported by the core cache and Pub/Sub paths. */
export const MINIMUM_REDIS_MAJOR_VERSION = 6;

export interface RedisServerVersion {
  major: number;
  minor: number;
  patch: number;
}

export type RedisHealthIssueKind =
  | 'unsupported-version'
  | 'acl'
  | 'unknown-command'
  | 'malformed-info'
  | 'transport'
  | 'command';

export interface RedisHealthIssue {
  kind: RedisHealthIssueKind;
  /** A safe transport error code, when Redis or Node supplied one. */
  code?: string;
}

/**
 * Core Redis capability health. It deliberately contains only version numbers
 * and a classified issue, never an INFO payload, connection URL, or cache key.
 */
export interface RedisCoreHealth {
  ok: boolean;
  version?: RedisServerVersion;
  issue?: RedisHealthIssue;
}

export interface RedisInfoClient {
  info(section?: string): Promise<unknown>;
}

/** Parse the `redis_version` line from the standard `INFO server` reply. */
export function parseRedisServerVersion(info: unknown): RedisServerVersion | undefined {
  if (typeof info !== 'string') {
    return undefined;
  }

  const match = /(?:^|\r?\n)redis_version:(\d+)\.(\d+)\.(\d+)(?:\r?$|\r?\n)/m.exec(info);
  if (!match) {
    return undefined;
  }

  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return undefined;
  }

  return { major, minor, patch };
}

/**
 * Classify a Redis failure without preserving the server's raw message, which
 * can include command arguments or deployment-specific connection details.
 */
export function classifyRedisError(error: unknown): RedisHealthIssue {
  const candidate = error as { message?: unknown; code?: unknown } | undefined;
  const message = typeof candidate?.message === 'string' ? candidate.message : '';
  const code = safeErrorCode(candidate?.code);

  if (/\b(?:NOPERM|NOAUTH)\b/i.test(message)) {
    return redisHealthIssue('acl', code);
  }

  if (/\bunknown command\b/i.test(message)) {
    return redisHealthIssue('unknown-command', code);
  }

  if (
    code !== undefined
    || /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|socket|connection (?:is )?(?:closed|lost|reset)|network)\b/i.test(message)
  ) {
    return redisHealthIssue('transport', code);
  }

  return redisHealthIssue('command', code);
}

/**
 * Query only Redis core `INFO server` to validate the supported baseline.
 * Redis Stack modules, `MODULE LIST`, Search, and AI features are intentionally
 * not inspected by this core cache health check.
 */
export async function getRedisCoreHealth(client: RedisInfoClient): Promise<RedisCoreHealth> {
  try {
    const version = parseRedisServerVersion(await client.info('server'));
    if (!version) {
      return { ok: false, issue: { kind: 'malformed-info' } };
    }

    if (version.major < MINIMUM_REDIS_MAJOR_VERSION) {
      return {
        ok: false,
        version,
        issue: { kind: 'unsupported-version' },
      };
    }

    return { ok: true, version };
  } catch (error) {
    return { ok: false, issue: classifyRedisError(error) };
  }
}

function safeErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) {
    return undefined;
  }

  return value;
}

function redisHealthIssue(kind: RedisHealthIssueKind, code: string | undefined): RedisHealthIssue {
  return code === undefined ? { kind } : { kind, code };
}
