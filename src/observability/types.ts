import type { CacheEvent } from '../cache/events.js';

/** Default route the dashboard is served under. */
export const DEFAULT_OBSERVABILITY_ROUTE = '/__lazylayers';
/** Historical/playful alias route for backward compatibility. */
export const ALIAS_OBSERVABILITY_ROUTE = '/observelazyily';
/** Default standalone server binding — localhost only, opt into wider exposure. */
export const DEFAULT_OBSERVABILITY_HOST = '127.0.0.1';
export const DEFAULT_OBSERVABILITY_PORT = 7077;
/** Default ring-buffer size for the live event feed (never persisted). */
export const DEFAULT_OBSERVABILITY_MAX_EVENTS = 1000;
/** Default truncation threshold for decoded values shown in the dashboard. */
export const DEFAULT_OBSERVABILITY_MAX_VALUE_BYTES = 256 * 1024;
/** Default dashboard credentials. Override via options or env vars. */
export const DEFAULT_OBSERVABILITY_USERNAME = 'lazydev';
export const DEFAULT_OBSERVABILITY_PASSWORD = 'lazydev';

export interface ObservabilityServerOptions {
  /** Interface to bind. Defaults to 127.0.0.1. */
  host?: string;
  /** Port to listen on. Defaults to 7077. */
  port?: number;
  /** Start the standalone server automatically. Defaults to true. */
  autoStart?: boolean;
}

export interface ObservabilityAuthOptions {
  /** Basic-auth username. Defaults to `lazydev` (or LAZY_OBS_USER). */
  username?: string;
  /** Basic-auth password. Defaults to `lazydev` (or LAZY_OBS_PASSWORD). */
  password?: string;
  /** Optional shared token; when set, `?token=` or `Authorization: Bearer` also works. */
  token?: string;
  /** Disable all auth (NOT recommended). */
  disabled?: boolean;
}

export interface ObservabilityPrometheusOptions {
  /** Expose a Prometheus exposition endpoint at `{route}/metrics`. */
  enabled?: boolean;
  /** Metric name prefix. Defaults to `lazycache`. */
  prefix?: string;
  /** Allow unauthenticated scrapes of `{route}/metrics` (auth still guards the UI). */
  public?: boolean;
}

export interface ObservabilityOptions {
  /** Master switch. Also enabled when env LAZY_OBS_ENABLED is truthy. */
  enabled?: boolean;
  /** Base route for the dashboard. Defaults to `/observelazyily`. */
  route?: string;
  /** Max events held in the in-memory ring buffer (never persisted). */
  maxEvents?: number;
  /** Decoded values larger than this many bytes are truncated in the UI. */
  maxValueBytes?: number;
  /** Standalone server config, or `false` to only expose the mountable handler. */
  server?: ObservabilityServerOptions | false;
  /** Dashboard credentials. */
  auth?: ObservabilityAuthOptions;
  /** Prometheus metrics endpoint. `true` enables with defaults. */
  prometheus?: boolean | ObservabilityPrometheusOptions;
  /** Suppress the one-time "dev/staging only" startup notice. */
  quiet?: boolean;
}

export interface ResolvedObservabilityOptions {
  enabled: boolean;
  route: string;
  maxEvents: number;
  maxValueBytes: number;
  /** `null` when no standalone server should be started. */
  server: { host: string; port: number; autoStart: boolean } | null;
  auth: { username: string; password: string; token?: string; disabled: boolean };
  prometheus: { enabled: boolean; prefix: string; public: boolean };
  quiet: boolean;
}

function envString(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function envBool(name: string): boolean | undefined {
  const value = envString(name);
  if (value === undefined) return undefined;
  return value === '1' || value.toLowerCase() === 'true';
}

function envInt(name: string): number | undefined {
  const value = envString(name);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Merge explicit options with environment variables and defaults.
 * Precedence: explicit option > environment variable > default.
 *
 * Env vars: LAZY_OBS_ENABLED, LAZY_OBS_ROUTE, LAZY_OBS_HOST, LAZY_OBS_PORT,
 * LAZY_OBS_USER, LAZY_OBS_PASSWORD, LAZY_OBS_TOKEN, LAZY_OBS_NO_SERVER,
 * LAZY_OBS_NO_AUTH, LAZY_OBS_MAX_EVENTS, LAZY_OBS_MAX_VALUE_BYTES.
 */
export function resolveObservabilityOptions(
  input: boolean | ObservabilityOptions | undefined,
): ResolvedObservabilityOptions {
  const options: ObservabilityOptions = typeof input === 'boolean' ? { enabled: input } : input ?? {};

  const enabled = options.enabled ?? envBool('LAZY_OBS_ENABLED') ?? false;
  const route = options.route ?? envString('LAZY_OBS_ROUTE') ?? DEFAULT_OBSERVABILITY_ROUTE;
  const maxEvents =
    options.maxEvents ?? envInt('LAZY_OBS_MAX_EVENTS') ?? DEFAULT_OBSERVABILITY_MAX_EVENTS;
  const maxValueBytes =
    options.maxValueBytes ?? envInt('LAZY_OBS_MAX_VALUE_BYTES') ?? DEFAULT_OBSERVABILITY_MAX_VALUE_BYTES;

  const serverDisabled = options.server === false || envBool('LAZY_OBS_NO_SERVER') === true;
  const serverInput: ObservabilityServerOptions = options.server ? options.server : {};
  const server = serverDisabled
    ? null
    : {
        host: serverInput.host ?? envString('LAZY_OBS_HOST') ?? DEFAULT_OBSERVABILITY_HOST,
        port: serverInput.port ?? envInt('LAZY_OBS_PORT') ?? DEFAULT_OBSERVABILITY_PORT,
        autoStart: serverInput.autoStart ?? true,
      };

  const auth = {
    username:
      options.auth?.username ?? envString('LAZY_OBS_USER') ?? DEFAULT_OBSERVABILITY_USERNAME,
    password:
      options.auth?.password ?? envString('LAZY_OBS_PASSWORD') ?? DEFAULT_OBSERVABILITY_PASSWORD,
    token: options.auth?.token ?? envString('LAZY_OBS_TOKEN'),
    disabled: options.auth?.disabled ?? envBool('LAZY_OBS_NO_AUTH') ?? false,
  };

  const promInput: ObservabilityPrometheusOptions =
    typeof options.prometheus === 'boolean' ? { enabled: options.prometheus } : options.prometheus ?? {};
  const prometheus = {
    enabled: promInput.enabled ?? envBool('LAZY_OBS_PROMETHEUS') ?? false,
    prefix: promInput.prefix ?? envString('LAZY_OBS_PROMETHEUS_PREFIX') ?? 'lazycache',
    public: promInput.public ?? envBool('LAZY_OBS_PROMETHEUS_PUBLIC') ?? false,
  };

  const quiet = options.quiet ?? envBool('LAZY_OBS_QUIET') ?? false;

  return {
    enabled,
    route: normalizeRoute(route),
    maxEvents,
    maxValueBytes,
    server,
    auth,
    prometheus,
    quiet,
  };
}

/** Ensure the route starts with `/` and has no trailing slash (except root). */
export function normalizeRoute(route: string): string {
  let normalized = route.trim();
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

/** One captured event with monotonic sequence + capture timestamp. */
export interface RecordedEvent {
  seq: number;
  ts: number;
  type: CacheEvent['type'];
  /** Sanitized event payload (errors flattened to messages; no large values). */
  data: Record<string, unknown>;
}

export interface ObservabilityCounters {
  hitsL1: number;
  hitsL2: number;
  missesL1: number;
  missesL2: number;
  missesNegative: number;
  sets: number;
  deletes: number;
  deletePatterns: number;
  loaderStart: number;
  loaderSuccess: number;
  loaderError: number;
  loaderTimeout: number;
  inflightReuse: number;
  inflightBypass: number;
  staleHit: number;
  negativeSet: number;
  l2Error: number;
  l2Skipped: number;
  eventBusPublishError: number;
  eventBusPublishSkipped: number;
  invalidationReceived: number;
  invalidationDuplicate: number;
  invalidationStale: number;
  setReceived: number;
  setBroadcast: number;
  setBroadcastSkipped: number;
}

export interface OverviewSnapshot {
  startedAt: number;
  uptimeMs: number;
  /** Total events observed since start (monotonic). */
  totalEvents: number;
  /** Events currently held in the ring buffer. */
  bufferedEvents: number;
  maxEvents: number;
  hits: number;
  misses: number;
  /** Hit ratio in [0, 1]; 0 when there have been no lookups yet. */
  hitRatio: number;
  /** Total traffic offloaded from origin database (hits + inflight dedupe). */
  originOffloadRatio: number;
  counters: ObservabilityCounters;
}

export interface ConfigSnapshot {
  source: string;
  route: string;
  layers: {
    l1: { enabled: boolean; inspectable: boolean; maxEntries?: number; ttlMs?: number };
    l2: { enabled: boolean; inspectable: boolean; prefix?: string; ttlMs?: number; useIndex?: boolean };
  };
  features: {
    inflight?: unknown;
    negativeCache?: unknown;
    failSafe?: unknown;
    timeouts?: unknown;
    versioning?: unknown;
    distributedLock?: unknown;
    broadcastSet?: boolean;
  };
  resilience: {
    l2CircuitBreaker: string;
    eventBusCircuitBreaker: string;
  };
  eventBus: {
    configured: boolean;
    transport?: string;
    health?: { ok: boolean; transport: string; error?: string };
  };
  prometheus?: { enabled: boolean; prefix: string; endpoint: string };
  telemetry: { channel?: string };
}
