import type { CircuitBreaker } from '../cache/circuitBreaker.js';
import type { EventBus } from '../event-bus/index.js';
import type {
  CacheKey,
  CacheOptions,
  CacheStore,
  StoreInspectOptions,
  StoreInspection,
} from '../types/index.js';
import { isInspectableStore } from '../types/index.js';
import type { ConfigSnapshot } from './types.js';

export interface InspectorDeps {
  l1?: CacheStore<CacheKey, unknown>;
  l2?: CacheStore<CacheKey, unknown>;
  options: CacheOptions & {
    eventBus?: EventBus;
    source?: string;
    broadcastSet?: boolean;
  };
  source: string;
  route: string;
  maxValueBytes: number;
  l2CircuitBreaker: CircuitBreaker;
  eventBusCircuitBreaker: CircuitBreaker;
  eventBus?: EventBus;
  prometheus?: { enabled: boolean; prefix: string; endpoint: string };
  telemetryChannel?: string;
}

/**
 * Pull-based, read-only introspection of the cache layers + config for the
 * dashboard. Every method here is invoked only in response to a dashboard
 * request — none of it runs on the cache hot path.
 */
export class ObservabilityInspector {
  constructor(private readonly deps: InspectorDeps) {}

  async inspectL1(options: StoreInspectOptions = {}): Promise<StoreInspection | null> {
    return this.inspectLayer(this.deps.l1, options);
  }

  async inspectL2(options: StoreInspectOptions = {}): Promise<StoreInspection | null> {
    return this.inspectLayer(this.deps.l2, options);
  }

  /** Best-effort layer sizes for Prometheus gauges (failures are swallowed). */
  async sizes(): Promise<{ l1Size?: number; l2Size?: number }> {
    const result: { l1Size?: number; l2Size?: number } = {};

    try {
      if (this.deps.l1) result.l1Size = await this.deps.l1.size();
    } catch {
      // layer unavailable — omit the gauge rather than fail the scrape
    }

    try {
      if (this.deps.l2) result.l2Size = await this.deps.l2.size();
    } catch {
      // layer unavailable — omit the gauge rather than fail the scrape
    }

    return result;
  }

  async config(): Promise<ConfigSnapshot> {
    const { options } = this.deps;
    const eventBus = this.deps.eventBus;

    let health: ConfigSnapshot['eventBus']['health'];
    let transport: string | undefined;

    if (eventBus?.healthCheck) {
      try {
        const result = await eventBus.healthCheck();
        transport = result.transport;
        health = {
          ok: result.ok,
          transport: result.transport,
          error: result.error === undefined ? undefined : String(result.error),
        };
      } catch (error) {
        health = { ok: false, transport: 'unknown', error: String(error) };
      }
    }

    return {
      source: this.deps.source,
      route: this.deps.route,
      layers: {
        l1: {
          enabled: this.deps.l1 !== undefined,
          inspectable: isInspectableStore(this.deps.l1),
          maxEntries: options.levels?.L1?.maxEntries,
          ttlMs: options.levels?.L1?.ttlMs ?? options.ttlMs,
        },
        l2: {
          enabled: this.deps.l2 !== undefined,
          inspectable: isInspectableStore(this.deps.l2),
          ttlMs: options.levels?.L2?.ttlMs ?? options.ttlMs,
        },
      },
      features: {
        inflight: options.inflight,
        negativeCache: options.negativeCache,
        failSafe: options.failSafe,
        timeouts: options.timeouts,
        versioning: options.versioning,
        distributedLock: options.distributedLock,
        broadcastSet: options.broadcastSet,
      },
      resilience: {
        l2CircuitBreaker: this.deps.l2CircuitBreaker.currentState,
        eventBusCircuitBreaker: this.deps.eventBusCircuitBreaker.currentState,
      },
      eventBus: {
        configured: eventBus !== undefined,
        transport,
        health,
      },
      prometheus: this.deps.prometheus,
      telemetry: { channel: this.deps.telemetryChannel },
    };
  }

  private async inspectLayer(
    store: CacheStore<CacheKey, unknown> | undefined,
    options: StoreInspectOptions,
  ): Promise<StoreInspection | null> {
    if (!isInspectableStore(store)) {
      return null;
    }

    return store.inspect({
      ...options,
      maxValueBytes: options.maxValueBytes ?? this.deps.maxValueBytes,
    });
  }
}
