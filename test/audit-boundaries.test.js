import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'production';
const configured = process.env.LAZY_LAYERS_AUDIT_ENTRY;
const entry = configured ? (configured.startsWith('file:') ? configured : pathToFileURL(configured).href) : new URL('../dist/index.js', import.meta.url).href;
const root = new URL('.', entry);
const { matchesPattern } = await import(new URL('cache/pattern.js', root));
const { encodeInvalidationEvent, decodeInvalidationEvent } = await import(new URL('event-bus/eventCodec.js', root));
const base = { type: 'del', keys: ['user:1'], source: 'peer', ts: 1 };

test('audit: wildcard matcher preserves literal and newline semantics over seeded cases', { timeout: 2000 }, () => {
  let state = 0x22b8c31;
  const draw = (n) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  const alphabet = ['a', 'b', '*', '.', '[', ']', '?', '\\', '\n', '\r', '\u2028', '\u2029'];
  for (let i = 0; i < 4000; i++) {
    const value = Array.from({ length: draw(10) }, () => alphabet[draw(alphabet.length)]).join('');
    const pattern = Array.from({ length: draw(10) }, () => alphabet[draw(alphabet.length)]).join('');
    const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
    const expected = pattern === '*' || new RegExp(`^${escaped}$`).test(value);
    assert.equal(matchesPattern(value, pattern), expected, JSON.stringify({ value, pattern }));
  }
});

test('audit: adversarial wildcard matching completes within a bounded subprocess', { timeout: 2000 }, () => {
  const code = `import { matchesPattern } from ${JSON.stringify(new URL('cache/pattern.js', root).href)}; if (matchesPattern('a'.repeat(128), 'a*'.repeat(16) + 'b')) process.exit(2);`;
  const child = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', code], { timeout: 500, encoding: 'utf8' });
  assert.equal(child.status, 0, `wildcard subprocess failed or timed out: ${child.error?.code ?? child.stderr}`);
});

test('audit: invalidation metadata rejects nonfinite time and malformed typed keys', { timeout: 2000 }, () => {
  const invalid = [
    { ...base, ts: Number.NaN }, { ...base, ts: Infinity },
    { ...base, namespace: 12 }, { ...base, keyTypes: ['number', 'string'] },
    { ...base, keyTypes: ['object'] }, { ...base, keys: ['NaN'], keyTypes: ['number'] },
    { ...base, type: 'set', value: 1, ttlMs: Number.NaN },
    { ...base, type: 'set', value: 1, ttlMs: -1 },
  ];
  for (const value of invalid) assert.equal(decodeInvalidationEvent(encodeInvalidationEvent(value)), null);
  const valid = { ...base, namespace: 'tenant-a', keys: ['12'], keyTypes: ['number'] };
  assert.deepEqual(decodeInvalidationEvent(encodeInvalidationEvent(valid)), valid);
});

test('audit: event decode bounds key fanout before allocating invalidation operations', { timeout: 2000 }, () => {
  const encoded = encodeInvalidationEvent({ ...base, keys: Array.from({ length: 4097 }, (_, i) => `k:${i}`) });
  assert.equal(decodeInvalidationEvent(encoded), null);
});
