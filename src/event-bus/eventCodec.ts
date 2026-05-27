import type { InvalidationEvent } from '../types/event.types.js';
import { deserialize, serialize } from '../utils/serializer.js';

export function encodeInvalidationEvent(event: InvalidationEvent): Buffer {
  return serialize(event);
}

export function decodeInvalidationEvent(raw: unknown): InvalidationEvent | null {
  const event = deserialize(raw);

  return isInvalidationEvent(event) ? event : null;
}

function isInvalidationEvent(value: unknown): value is InvalidationEvent {
  if (!isRecord(value) || typeof value.source !== 'string' || typeof value.ts !== 'number') {
    return false;
  }

  if (
    'generation' in value
    && (
      typeof value.generation !== 'number'
      || !Number.isSafeInteger(value.generation)
      || value.generation < 0
    )
  ) {
    return false;
  }

  if (value.type === 'del') {
    return isDeleteEvent(value);
  }

  if (value.type === 'pattern') {
    return isPatternEvent(value);
  }

  if (value.type === 'set') {
    return isSetEvent(value);
  }

  return false;
}

function isDeleteEvent(value: Record<string, unknown>): boolean {
  return Array.isArray(value.keys) && value.keys.every((key) => typeof key === 'string');
}

function isPatternEvent(value: Record<string, unknown>): boolean {
  return typeof value.pattern === 'string';
}

function isSetEvent(value: Record<string, unknown>): boolean {
  return Array.isArray(value.keys)
    && value.keys.every((key) => typeof key === 'string')
    && 'value' in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
