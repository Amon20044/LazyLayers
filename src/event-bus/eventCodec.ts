import type { InvalidationEvent } from '../types/event.types.js';
import { decodeCacheRecord, serialize } from '../utils/serializer.js';

export interface EventDecodeOptions {
  /** Bound one invalidation's work fanout. Default: 4096 keys. */
  maxKeys?: number;
  /** Bound key and pattern text before scheduling handler work. Default: 64 KiB. */
  maxKeyBytes?: number;
}

export function encodeInvalidationEvent(event: InvalidationEvent): Buffer {
  return serialize(event);
}

export function decodeInvalidationEvent(raw: unknown, options: EventDecodeOptions = {}): InvalidationEvent | null {
  const maxKeys = options.maxKeys ?? 4096;
  const maxKeyBytes = options.maxKeyBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || !Number.isSafeInteger(maxKeyBytes) || maxKeyBytes < 1) {
    throw new RangeError('Event decode limits must be positive safe integers');
  }
  let event = raw;
  if (typeof raw === 'string' || raw instanceof Uint8Array) {
    if (typeof raw === 'string' && Buffer.byteLength(raw) > 25 * 1024 * 1024) return null;
    const decoded = decodeCacheRecord(typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw);
    if (!decoded.hit) return null;
    event = decoded.value;
  }

  return isInvalidationEvent(event, maxKeys, maxKeyBytes) ? event : null;
}

function isInvalidationEvent(value: unknown, maxKeys: number, maxKeyBytes: number): value is InvalidationEvent {
  if (!isRecord(value) || typeof value.source !== 'string' || typeof value.ts !== 'number' || !Number.isFinite(value.ts)) {
    return false;
  }

  if (value.namespace !== undefined && (typeof value.namespace !== 'string' || Buffer.byteLength(value.namespace) > maxKeyBytes)) return false;
  if (value.id !== undefined && (typeof value.id !== 'string' || Buffer.byteLength(value.id) > maxKeyBytes)) return false;
  if (Buffer.byteLength(value.source) > maxKeyBytes) return false;

  if (
    value.generation !== undefined
    && (
      typeof value.generation !== 'number'
      || !Number.isSafeInteger(value.generation)
      || value.generation < 0
    )
  ) {
    return false;
  }

  if (value.type === 'del') {
    return isDeleteEvent(value, maxKeys, maxKeyBytes);
  }

  if (value.type === 'pattern') {
    return isPatternEvent(value, maxKeyBytes);
  }

  if (value.type === 'set') {
    return isSetEvent(value, maxKeys, maxKeyBytes);
  }

  return false;
}

function isDeleteEvent(value: Record<string, unknown>, maxKeys: number, maxKeyBytes: number): boolean {
  const keys = value.keys;
  if (!Array.isArray(keys) || keys.length > maxKeys
    || !keys.every((key) => typeof key === 'string' && Buffer.byteLength(key) <= maxKeyBytes)) return false;
  if (value.keyTypes === undefined) return true;
  if (!Array.isArray(value.keyTypes) || value.keyTypes.length !== keys.length) return false;
  return value.keyTypes.every((type, index) => type === 'string'
    || (type === 'number' && Number.isFinite(Number(keys[index])) && String(Number(keys[index])) === keys[index]));
}

function isPatternEvent(value: Record<string, unknown>, maxKeyBytes: number): boolean {
  return typeof value.pattern === 'string' && Buffer.byteLength(value.pattern) <= maxKeyBytes;
}

function isSetEvent(value: Record<string, unknown>, maxKeys: number, maxKeyBytes: number): boolean {
  return isDeleteEvent(value, maxKeys, maxKeyBytes) && 'value' in value
    && (value.ttlMs === undefined || (typeof value.ttlMs === 'number' && Number.isFinite(value.ttlMs) && value.ttlMs > 0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
