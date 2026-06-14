import diagnosticsChannel from 'node:diagnostics_channel';

import type { CacheEvent } from '../cache/events.js';

/**
 * Diagnostics-channel name carrying the raw cache event stream. This is the
 * zero-dependency telemetry substrate — OpenTelemetry instrumentation (or any
 * APM) can subscribe here to build spans/metrics without the library depending
 * on the OTel SDK. Mirrors the approach used by bentocache's `@bentocache/otel`.
 */
export const TELEMETRY_CHANNEL_NAME = 'lazycache:cache:event';

const channel = diagnosticsChannel.channel(TELEMETRY_CHANNEL_NAME);

/** True only when at least one subscriber is attached (cheap O(1) read). */
export function hasTelemetrySubscribers(): boolean {
  return channel.hasSubscribers;
}

/**
 * Publish an event to the telemetry channel. Guarded by `hasSubscribers` so it
 * is a single boolean check (and nothing else) on the hot path when no APM is
 * attached — keeping the "zero performance hindrance" guarantee intact.
 */
export function publishTelemetry(event: CacheEvent): void {
  if (channel.hasSubscribers) {
    channel.publish(event);
  }
}

/** Subscribe to the raw event stream. Returns an unsubscribe function. */
export function subscribeTelemetry(listener: (event: CacheEvent) => void): () => void {
  const onMessage = (message: unknown): void => listener(message as CacheEvent);
  diagnosticsChannel.subscribe(TELEMETRY_CHANNEL_NAME, onMessage);
  return () => {
    diagnosticsChannel.unsubscribe(TELEMETRY_CHANNEL_NAME, onMessage);
  };
}
