/** Limits for the small, JSON-safe metadata records emitted by CacheEvent. */
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_VALUES = 4096;
const REJECT = Symbol('oversized or unsupported event metadata');

/**
 * Encode a bounded plain-data snapshot. The size check runs before stringify,
 * so an oversized string cannot first allocate an oversized JSON buffer.
 * No caller-owned object, getter or toJSON method is passed to stringify.
 */
export function encodeBoundedEvent(value: unknown, maxBytes: number): string | undefined {
  let bytes = 0;
  let values = 0;
  const ancestors = new Set<object>();
  const reserve = (size: number): void => {
    bytes += size;
    if (bytes > maxBytes) throw REJECT;
  };
  const string = (input: string): string => {
    reserve(2);
    for (let i = 0; i < input.length; i += 1) {
      const code = input.charCodeAt(i);
      if (code === 34 || code === 92) reserve(2);
      else if (code < 32) reserve(code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6);
      else if (code < 128) reserve(1);
      else if (code < 2048) reserve(2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = input.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { reserve(4); i += 1; }
        else reserve(6);
      } else reserve(code >= 0xdc00 && code <= 0xdfff ? 6 : 3);
    }
    return input;
  };
  const snapshot = (input: unknown, depth: number): unknown => {
    if (++values > MAX_METADATA_VALUES || depth > MAX_METADATA_DEPTH) throw REJECT;
    if (input === null) { reserve(4); return null; }
    switch (typeof input) {
      case 'string': return string(input);
      case 'boolean': reserve(input ? 4 : 5); return input;
      case 'number': {
        const encoded = JSON.stringify(input);
        reserve(encoded.length);
        return input;
      }
      case 'undefined': reserve(4); return null;
      case 'object': break;
      default: throw REJECT;
    }
    const object = input as object;
    if (ancestors.has(object)) throw REJECT;
    ancestors.add(object);
    try {
      if (Array.isArray(input)) {
        if (input.length > MAX_METADATA_VALUES || input.length > maxBytes) throw REJECT;
        reserve(2);
        const copy: unknown[] = [];
        for (let i = 0; i < input.length; i += 1) {
          if (i > 0) reserve(1);
          const property = Object.getOwnPropertyDescriptor(input, String(i));
          if (property && !('value' in property)) throw REJECT;
          copy.push(snapshot(property?.value, depth + 1));
        }
        return copy;
      }
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== null && prototype !== Object.prototype) throw REJECT;
      reserve(2);
      const copy: Record<string, unknown> = Object.create(null);
      let count = 0;
      for (const key in input) {
        if (!Object.hasOwn(input, key)) continue;
        if (++values > MAX_METADATA_VALUES) throw REJECT;
        const property = Object.getOwnPropertyDescriptor(input, key);
        if (!property || !('value' in property)) throw REJECT;
        if (property.value === undefined) continue;
        if (count++ > 0) reserve(1);
        string(key);
        reserve(1);
        copy[key] = snapshot(property.value, depth + 1);
      }
      return copy;
    } finally {
      ancestors.delete(object);
    }
  };
  try {
    const json = JSON.stringify(snapshot(value, 0));
    return Buffer.byteLength(json, 'utf8') <= maxBytes ? json : undefined;
  } catch {
    return undefined;
  }
}

/** Positive finite limits are required even for manually resolved options. */
export function eventLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
