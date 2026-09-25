/** Cloudflare account events delivered by Event Subscriptions through Queues. */
export type CloudflarePlatformEventType =
  | 'cf.kv.namespace.created'
  | 'cf.kv.namespace.deleted'
  | 'cf.workersBuilds.worker.build.started'
  | 'cf.workersBuilds.worker.build.failed'
  | 'cf.workersBuilds.worker.build.canceled'
  | 'cf.workersBuilds.worker.build.succeeded';

export interface CloudflarePlatformEvent {
  type: CloudflarePlatformEventType;
  source: { type: 'kv' | 'workersBuilds.worker'; workerName?: string };
  payload: { id?: string; name?: string; buildUuid?: string; status?: string; buildOutcome?: string | null };
  metadata: {
    accountId: string;
    eventSubscriptionId: string;
    eventSchemaVersion: number;
    eventTimestamp: string;
  };
}

const KV_TYPES = new Set<CloudflarePlatformEventType>([
  'cf.kv.namespace.created',
  'cf.kv.namespace.deleted',
]);
const BUILD_TYPES = new Set<CloudflarePlatformEventType>([
  'cf.workersBuilds.worker.build.started',
  'cf.workersBuilds.worker.build.failed',
  'cf.workersBuilds.worker.build.canceled',
  'cf.workersBuilds.worker.build.succeeded',
]);

/** Validate only the fields this package consumes. Unknown event types are ignored. */
export function parseCloudflarePlatformEvent(value: unknown): CloudflarePlatformEvent | null {
  if (!record(value) || typeof value.type !== 'string' || !record(value.source)
    || !record(value.payload) || !record(value.metadata)) return null;
  const type = value.type as CloudflarePlatformEventType;
  const source = value.source;
  const payload = value.payload;
  const metadata = value.metadata;
  if (typeof metadata.accountId !== 'string'
    || typeof metadata.eventSubscriptionId !== 'string'
    || !Number.isSafeInteger(metadata.eventSchemaVersion)
    || typeof metadata.eventTimestamp !== 'string'
    || !Number.isFinite(Date.parse(metadata.eventTimestamp))) return null;

  if (KV_TYPES.has(type)) {
    if (source.type !== 'kv' || typeof payload.id !== 'string' || typeof payload.name !== 'string') return null;
  } else if (BUILD_TYPES.has(type)) {
    if (source.type !== 'workersBuilds.worker'
      || typeof source.workerName !== 'string'
      || typeof payload.buildUuid !== 'string') return null;
  } else {
    return null;
  }
  return value as unknown as CloudflarePlatformEvent;
}

export function summarizeCloudflarePlatformEvent(event: CloudflarePlatformEvent): {
  type: CloudflarePlatformEventType;
  accountId: string;
  timestamp: string;
  resource: string;
  resourceId: string;
  outcome?: string | null;
} {
  return {
    type: event.type,
    accountId: event.metadata.accountId,
    timestamp: event.metadata.eventTimestamp,
    resource: event.source.type === 'kv' ? event.payload.name! : event.source.workerName!,
    resourceId: event.source.type === 'kv' ? event.payload.id! : event.payload.buildUuid!,
    ...(event.source.type === 'workersBuilds.worker' ? { outcome: event.payload.buildOutcome } : {}),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
