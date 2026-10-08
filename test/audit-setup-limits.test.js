import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const selected = process.env.LAZY_LAYERS_AUDIT_ENTRY;
const entry = selected ? (selected.startsWith('file:') ? selected : pathToFileURL(selected).href) : new URL('../dist/index.js', import.meta.url).href;
const { setupCache, CacheSetupError, serialize } = await import(entry);
const { encodeKVRecord } = await import(new URL('cloudflare/kvWire.js', new URL('.', entry)));
const quiet = { enabled: false };

test('audit: managed KV forwards constructor expanded limits to its internal reader', { timeout: 2000 }, async () => {
  const entries = new Map();
  const namespace = {
    async get(key) { return entries.get(key)?.slice().buffer ?? null; },
    async put(key, bytes) { entries.set(key, Uint8Array.from(bytes)); },
    async delete(key) { entries.delete(key); },
    async list() { return { keys: [], list_complete: true }; },
  };
  const options = { namespace: 'configured', redis: false, eventBus: false, kv: { namespace }, l1: false, failSafe: { enabled: false }, logging: quiet, decodeLimits: { maxDecodedBytes: 1024 } };
  const cache = await setupCache(options);
  try {
    entries.set('configured:cache:large', encodeKVRecord(serialize({ payload: 'x'.repeat(32 * 1024) }, { compression: 'gzip' }), Date.now() + 60_000));
    assert.equal((await cache.get('large')) === undefined, true);
  } finally { await cache.close(); entries.clear(); }
});

test('audit: managed namespace rejects malformed Unicode and excessive scope text before setup', { timeout: 2000 }, async () => {
  for (const namespace of ['\ud800', 'scope:' + 'x'.repeat(64 * 1024)]) {
    await assert.rejects(setupCache({ namespace, redis: false, logging: quiet }), (error) => error instanceof CacheSetupError);
  }
});
