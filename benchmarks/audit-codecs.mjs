#!/usr/bin/env node
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { isChild, moduleURL, childCase, quantiles, cpuMs, memory, random, gc, matrix } from './audit-experiment-utils.mjs';

const SIZES = [1024, 16 * 1024, 256 * 1024, 1024 * 1024];
const STRATEGIES = ['json', 'none', 'gzip', 'zstd', 'lz4', 'snappy'];
function data(bytes, entropy) {
  if (entropy === 'repeated-text') return { tenant: 'synthetic', id: 2026, payload: 'x'.repeat(bytes) };
  const value = Buffer.allocUnsafeSlow(bytes); const rng = random();
  for (let i = 0; i < bytes; i++) value[i] = 32 + Math.floor(rng() * 95);
  return { tenant: 'synthetic', id: 2026, payload: value.toString('ascii') };
}
async function experiment(mod, configuration) {
  const { size, strategy, entropy } = configuration;
  const available = strategy === 'lz4' ? mod.LZ4_AVAILABLE : strategy === 'snappy' ? mod.SNAPPY_AVAILABLE : strategy === 'zstd' ? mod.ZSTD_AVAILABLE : true;
  if (!available) return { skipped: true, reason: `${strategy} unavailable in this runtime`, memory: memory() };
  const value = data(size, entropy);
  const options = strategy === 'json' ? { format: 'json', compression: 'none' } : { format: 'msgpack', compression: [{ codec: strategy }] };
  const strictSupported = typeof mod.decodeCacheRecord === 'function';
  for (let i = 0; i < 2; i++) {
    const raw = mod.serializeWithStats(value, options); assert.deepEqual(mod.deserialize(raw.buffer), value);
    if (strictSupported) assert.deepEqual(mod.decodeCacheRecord(raw.buffer), { hit: true, value });
  }
  await gc(); const before = memory();
  const iterations = Math.min(100, Math.max(4, Math.floor(8 * 1024 * 1024 / size)));
  const encodeTimes = new Float64Array(iterations), publicDecodeTimes = new Float64Array(iterations), internalDecodeTimes = new Float64Array(iterations);
  const cpuStart = process.cpuUsage(); const started = performance.now(); let encoded, decoded;
  for (let i = 0; i < iterations; i++) {
    let at = performance.now(); encoded = mod.serializeWithStats(value, options); encodeTimes[i] = performance.now() - at;
    at = performance.now(); decoded = mod.deserialize(encoded.buffer); publicDecodeTimes[i] = performance.now() - at;
    at = performance.now();
    if (strictSupported) {
      const record = mod.decodeCacheRecord(encoded.buffer);
      internalDecodeTimes[i] = performance.now() - at;
      assert.equal(record.hit, true); decoded = record.value;
    } else {
      decoded = mod.deserialize(encoded.buffer);
      internalDecodeTimes[i] = performance.now() - at;
    }
  }
  const elapsedMs = performance.now() - started; const cpu = cpuMs(cpuStart); const peak = memory();
  assert.deepEqual(decoded, value);
  await gc(); const after = memory();
  return { payloadBytes: size, entropy, iterations, requestedStrategy: strategy, actualEncoding: encoded.encoding, expandedSerializedBytes: encoded.originalBytes, storedBytes: encoded.storedBytes, compressed: encoded.compressed, storageFraction: encoded.storedBytes / encoded.originalBytes, savingsFraction: encoded.compressionRatio, encodeMs: quantiles(encodeTimes), publicDecodeMs: quantiles(publicDecodeTimes), internalDecodeMs: quantiles(internalDecodeTimes), internalDecoder: strictSupported ? 'bounded record decoder' : 'legacy built-in decoder', strictSupported, elapsedMs, cpuMs: cpu, beforeMemory: before, afterMemory: after, memory: peak, exactAllocationCount: 'NOT MEASURED', exactTemporaryAllocationPeak: 'NOT MEASURED', allocatorFragmentation: 'NOT MEASURED', notes: ['Codec requests may fall back to MessagePack when actual savings do not meet the existing threshold.', 'Public one-argument decode remains legacy-compatible. Internal decode includes structural preflight and output limits only in the changed library.', 'Quantiles describe small local codec samples, not service response latency.'] };
}
if (isChild) {
  const mod = await import(moduleURL);
  console.log(JSON.stringify(await experiment(mod, childCase())));
} else {
  const cases = [];
  for (let repeat = 0; repeat < 3; repeat++) for (const size of SIZES) for (const entropy of ['repeated-text', 'high-entropy-ascii']) for (const strategy of STRATEGIES) cases.push({ repeat, size, entropy, strategy });
  await matrix(new URL(import.meta.url).pathname, cases, 'codecs', ['Existing library formats/codecs only; no dependencies or policy changes.', 'Same synthetic structured values in JSON and MessagePack; high-entropy ASCII is an explicit workload, not universally incompressible data.', 'Encode/public decode/internal decode reported separately; before built-in legacy reader vs after bounded reader is a correctness/performance trade-off.', 'Three independent processes per case, 4–100 timed samples each; no network or server throughput capability is measured.']);
}
