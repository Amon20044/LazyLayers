import type { ResolvedDecodeLimits } from './serializerPolicy.js';

type Utf8RangeValidator = (input: Uint8Array, start: number, end: number) => boolean;

const isContinuation = (byte: number): boolean => byte >= 0x80 && byte <= 0xbf;

/** UTF-8 range validation without decoded-string allocation in Worker runtimes. */
function isSafeUtf8(input: Uint8Array, start: number, end: number): boolean {
  for (let position = start; position < end;) {
    const first = input[position++];
    if (first < 0x80) continue;
    if (first >= 0xc2 && first <= 0xdf) {
      if (position >= end || !isContinuation(input[position++])) return false;
    } else if (first >= 0xe0 && first <= 0xef) {
      if (position + 1 >= end) return false;
      const second = input[position++];
      if (!(first === 0xe0 ? second >= 0xa0 && second <= 0xbf : first === 0xed ? second >= 0x80 && second <= 0x9f : isContinuation(second))) return false;
      if (!isContinuation(input[position++])) return false;
    } else if (first >= 0xf0 && first <= 0xf4) {
      if (position + 2 >= end) return false;
      const second = input[position++];
      if (!(first === 0xf0 ? second >= 0x90 && second <= 0xbf : first === 0xf4 ? second >= 0x80 && second <= 0x8f : isContinuation(second))) return false;
      if (!isContinuation(input[position++]) || !isContinuation(input[position++])) return false;
    } else return false;
  }
  return true;
}

/**
 * Validate lengths before msgpackr can allocate from untrusted container headers.
 * This scans the standard wire structure with O(depth) scratch space. Binary
 * bodies are skipped; string bodies are validated without constructing strings.
 * Own-record/reference/bundled extensions are not emitted by our default packer.
 */
export function isSafeMessagePack(input: Uint8Array, limits: ResolvedDecodeLimits, validUtf8: Utf8RangeValidator = isSafeUtf8): boolean {
  if (input.byteLength > limits.maxDecodedBytes) return false;
  let position = 0;
  let totalValues = 0;
  const pending = [1];
  const advance = (bytes: number): boolean => {
    if (bytes < 0 || bytes > input.byteLength - position) return false;
    position += bytes;
    return true;
  };
  const length = (bytes: number): number => {
    if (bytes > input.byteLength - position) return -1;
    let value = 0;
    for (let i = 0; i < bytes; i++) value = value * 256 + input[position++];
    return value;
  };
  const string = (bytes: number): boolean => bytes >= 0 && bytes <= input.byteLength - position
    && validUtf8(input, position, position + bytes) && advance(bytes);
  const container = (items: number, map = false): boolean => {
    if (items < 0 || items > limits.maxCollectionLength) return false;
    const children = map ? items * 2 : items;
    // Each serialized child requires at least one byte. Reject before allocation.
    if (children > input.byteLength - position || pending.length > limits.maxDepth) return false;
    if (children) pending.push(children);
    return true;
  };
  const extension = (bytes: number): boolean => {
    if (bytes < 0 || bytes + 1 > input.byteLength - position) return false;
    const type = input[position++];
    if (type === 0x65 || type === 0x73 || type === 0x78) {
      // msgpackr Error/Set/RegExp wrappers consume one following ordinary value.
      return bytes === 1 && advance(bytes) && container(1);
    }
    if (type === 0x00) return bytes === 1 && advance(bytes); // undefined
    if (type === 0xff) return [1, 4, 8, 12].includes(bytes) && advance(bytes); // dates, including Invalid Date
    if (type === 0x42) return bytes > 0 && advance(bytes); // arbitrary-size bigint
    if (type === 0x74) {
      if (bytes < 1) return false;
      const typeCode = input[position];
      const widths = [1, 1, 1, 2, 2, 4, 4, 4, 8, 8, 8];
      const width = widths[typeCode];
      if (!(typeCode === 16 || typeCode === 17 || (width && (bytes - 1) % width === 0))) return false;
      return advance(bytes);
    }
    return false;
  };

  while (pending.length) {
    const parent = pending.length - 1;
    if (pending[parent] === 0) { pending.pop(); continue; }
    pending[parent]--;
    if (++totalValues > limits.maxTotalValues) return false;
    if (position >= input.byteLength) return false;
    const tag = input[position++];
    if (tag < 0x80 || tag >= 0xe0) continue;
    if (tag < 0x90) { if (!container(tag - 0x80, true)) return false; continue; }
    if (tag < 0xa0) { if (!container(tag - 0x90)) return false; continue; }
    if (tag < 0xc0) { if (!string(tag - 0xa0)) return false; continue; }
    switch (tag) {
      case 0xc0: case 0xc2: case 0xc3: break;
      case 0xc1: return false; // reserved token, not an ordinary cached value
      case 0xc4: if (!advance(length(1))) return false; break;
      case 0xc5: if (!advance(length(2))) return false; break;
      case 0xc6: if (!advance(length(4))) return false; break;
      case 0xd9: if (!string(length(1))) return false; break;
      case 0xda: if (!string(length(2))) return false; break;
      case 0xdb: if (!string(length(4))) return false; break;
      case 0xc7: if (!extension(length(1))) return false; break;
      case 0xc8: if (!extension(length(2))) return false; break;
      case 0xc9: if (!extension(length(4))) return false; break;
      case 0xca: case 0xce: case 0xd2: if (!advance(4)) return false; break;
      case 0xcb: case 0xcf: case 0xd3: if (!advance(8)) return false; break;
      case 0xcc: case 0xd0: if (!advance(1)) return false; break;
      case 0xcd: case 0xd1: if (!advance(2)) return false; break;
      case 0xd4: if (!extension(1)) return false; break;
      case 0xd5: if (!extension(2)) return false; break;
      case 0xd6: if (!extension(4)) return false; break;
      case 0xd7: if (!extension(8)) return false; break;
      case 0xd8: if (!extension(16)) return false; break;
      case 0xdc: if (!container(length(2))) return false; break;
      case 0xdd: if (!container(length(4))) return false; break;
      case 0xde: if (!container(length(2), true)) return false; break;
      case 0xdf: if (!container(length(4), true)) return false; break;
      default: return false;
    }
  }
  return position === input.byteLength;
}

/** Bound JSON nesting/collection cardinality before JSON.parse allocates values. */
export function isSafeJson(input: Uint8Array, limits: ResolvedDecodeLimits): boolean {
  if (input.byteLength > limits.maxDecodedBytes) return false;
  const stack: Array<{ close: number; items: number; content: boolean }> = [];
  let quoted = false;
  let totalValues = 1;
  for (let i = 0; i < input.byteLength; i++) {
    const byte = input[i];
    if (quoted) {
      if (byte === 92) { i++; continue; }
      if (byte === 34) quoted = false;
      continue;
    }
    const current = stack.at(-1);
    if (byte === 34) { quoted = true; if (current) current.content = true; continue; }
    if (byte === 123 || byte === 91) {
      if (current) current.content = true;
      if (stack.length >= limits.maxDepth) return false;
      stack.push({ close: byte === 123 ? 125 : 93, items: 1, content: false });
    } else if (byte === 125 || byte === 93) {
      if (!current || current.close !== byte) return false;
      if (current.content && current.items > limits.maxCollectionLength) return false;
      if (current.content) totalValues += current.items * (current.close === 125 ? 2 : 1);
      if (totalValues > limits.maxTotalValues) return false;
      stack.pop();
    } else if (byte === 44 && current) {
      if (++current.items > limits.maxCollectionLength) return false;
    } else if (byte !== 32 && byte !== 9 && byte !== 10 && byte !== 13 && current) {
      current.content = true;
    }
  }
  return !quoted && stack.length === 0;
}
