# Memory and runtime audit

Baseline: `ca9c02a04349a89278cd81b5b25d0000503cc5a3` (0.6.2). `MemoryBudget` is a shared process-local accounting ledger. It deliberately is not a process RSS limit. Forced-GC process deltas, OS peak RSS, allocation sampling and a structural heap-snapshot analysis are recorded below; they have different meanings and must not be combined into an invented exact entry size.

## Encoded-entry accounting

Source: [`memoryStore.ts`](../src/cache/memoryStore.ts), [`memoryBudget.ts`](../src/cache/memoryBudget.ts), [`hybridCache.ts`](../src/cache/hybridCache.ts).

For a retained fresh entry, the implemented charge is exactly:

```text
encoded buffer byteLength + 2 × UTF-8 byteLength(String(key)) + 160
```

For a fail-safe snapshot, the charge is:

```text
encoded buffer byteLength + 2 × UTF-8 byteLength(String(key)) + 80
```

Each MemoryStore attempts to reserve 4096 bytes for its admission history. The owned value buffers use `Buffer.allocUnsafeSlow`, preventing a tiny subarray from retaining a huge original backing allocation. That ownership/copy behavior is tested. Shared budgets cap their *charged totals*, and pressure lowers the admission target; byte admission is not disabled by `autoEvict.enabled=false`.

The constants 160 and 80 remain estimates, not heap measurements. UTF-8 key bytes doubled do not equal actual V8 string storage (one-byte versus two-byte representation, slices, interning, cached hashes). The formula covers some key/metadata sizes but cannot prove a universal byte-level runtime heap bound. The profile's small-entry heap deltas are larger than these constants, although those process deltas also include structure/runtime changes and are not a dominator analysis of a single entry.

## Retained objects outside or only approximately inside the ledger

| Area | Baseline retention and risk |
|---|---|
| LRU storage | `lru-cache` allocates two maxEntries-length JS arrays, next/previous index arrays and free stack before any entry; TTL arrays appear on first write. These are not separately reserved. Empty-store memory depends on configured maximum, not resident count. |
| Entry metadata | Buffer wrapper, entry object, Map cells, array slots and index data are represented by one 160-byte estimate. No baseline heap snapshot substantiates it. |
| Stale snapshots | Independent copies, Map cells and 80-byte estimate; default fail-safe keeps a second encoded copy and refreshes it on every hit. |
| Closed stores | `clear` empties arrays but leaves them allocated. A caller retaining a closed store also retains its maxEntries-sized skeleton after the ledger reaches zero. |
| Key metadata maps | Singleflight, negatives, generations, remote generations and seen-event maps live outside L1's fresh-entry charge. Count caps help but do not cap arbitrarily long keys. |
| Active/waiting work | Promises, closures, AbortControllers, one timer per waiter/deadline; L2 queued payload bytes are bounded separately, active work slots held until settlement. Caller/result references are not in the MemoryBudget. |
| Serialization | Application graph, MessagePack workspace/output, packed copy, compressed output, prefixed copy and eventual owned L1/L2 buffers may coexist. These temporary allocations occur before admission rejection. |
| Reads | `MemoryStore.getEncoded` copies all encoded bytes. HybridCache decodes that copy then usually creates another stale snapshot buffer. Compressed decode retains expanded native output plus returned JS graph. |
| Redis/event clients | Their internal buffers, command queues, broker deliveries and listeners are not process-RSS bounded by MemoryBudget. Client/gate settings and transport behavior require separate verification. |
| Observability | Baseline rings have only a count limit; a single key/error string can be arbitrarily large. SSE ignores write(false), retains no client-count bound and continues buffering replay/live/heartbeats. Inspection values have a separate size cap. `deserializedBytes` is a serialized-size estimate, not retained heap. |
| Runtime/allocator | V8 code, stacks, native codec memory, GC reserves and allocator fragmentation are outside the ledger. RSS need not fall immediately when references disappear. |

An attacker cannot directly create Map hash collisions through the approximate frequency sketch, but unlimited key length/cardinality and compressed output are distinct resource-exhaustion surfaces.

## Copies and peak temporary memory

Let V be expanded serialized bytes and S be stored encoded bytes. A compressible record can have S ≪ V.

- A Node MessagePack write currently calls `pack`, `Buffer.from(pack(...))`, optionally allocates compressed output, `Buffer.concat` for HC1, and copies into L1-owned storage. Fail-safe adds a separate S-byte copy. Exact native workspace is codec-dependent and NOT MEASURED until profiling.
- At baseline and in the final scoped implementation, a default Hybrid L1 hit copies S bytes for `getEncoded`, allocates the decoded result, then replaces its stale buffer with another S-byte copy. The old stale buffer can await GC while the new buffer is already live. Bounded retained cache size does not imply low allocation rate. Unchanged-snapshot reuse is deferred pending dedicated mutation/expiry regressions and paired measurements; no hit-copy reduction is claimed.
- A portable gzip transform copies input into a ReadableStream, accumulates output chunks, then copies the chunks into a final output. The 25 MiB output cap limits logical output, while peak temporary output can approach two copies plus compressor/stream buffers.
- At baseline, Node gzip/zstd/LZ4/snappy decoding does not cap expanded bytes. Returning `null` only after native decoder failure does not prevent the allocation that caused failure. The strict record decoder now passes expanded-output caps to gzip/zstd and checks LZ4/Snappy advertised sizes before native decode. Public no-option decoding retains compatibility and remains an explicitly unbounded boundary.
- Baseline MessagePack binary fields can be subarray views of the input. Direct MemoryStore.get and inspector previews therefore exposed retained encoded bytes to mutation. Strict readers now use copyBuffers:true, copying binary fields into owned results; this adds O(binary payload bytes) allocation even when a Hybrid read already copied its encoded input. Public no-option deserializers retain their original input-view behavior.
- The inspector trusts `originalBytes` only when present, but a public encoded write can supply false metadata. A preview-size check must also constrain actual decode; metadata alone is not a resource bound.

## Source-backed P0/P1 issues

1. **Expanded decode and forged MessagePack lengths:** addressed in built-in Node/KV reads through bounded record decoders. Structural preflight checks container lengths before msgpackr allocation; byte caps alone were insufficient. Public legacy boundaries remain visible.
2. **Uncharged empty-store arrays:** addressed by count-valued dynamic LRU storage. It keeps the existing eviction policy and count semantics. Allocation now depends on high-water resident slots rather than configured maxEntries from an empty start.
3. **Closed-store skeleton retention:** addressed by dropping the private LRU reference on close, along with history and callback registration. A retained closed store no longer intentionally retains the array skeleton.
4. **Whole-cache expiry work:** `has` now disposes only its queried expired key; exact-count scans remain in size/stats. An admission iterator also now exposes expired victims, keeping its sample bounded at eight.
5. **Idle expired retention:** unchanged, intentional lazy reclamation. Expired payloads remain charged until queried, purged, evicted or closed. This remains bounded in the ledger and is not a long-term RSS guarantee.
6. **Malformed UTF-8 mutation:** strict Node/Worker readers now reject invalid encoded strings instead of silently replacing them with U+FFFD. JSON syntax and MessagePack structural validity alone did not detect this corruption.
7. **Live-feed buffering and oversized metadata:** addressed with at most 64 shared-handler SSE clients, 64 KiB encoded frames, stop/resume on socket backpressure and detached byte-bounded ring snapshots. The six bounded regressions fail on the frozen baseline; [`observability-bounds-before.tap`](raw/observability-bounds-before.tap) records the actual 42 writes after the first false write, oversized capture and missing limits.
8. **Returned binary values aliasing retained state:** a three-byte mutation corrupts both the baseline and first frozen build through direct get and inspect. [`binary-alias-frozen-diagnostic.log`](raw/binary-alias-frozen-diagnostic.log) records original [17,34,51] becoming [99,34,51] and then [99,88,51]. Strict Node/portable MessagePack readers now copy binary values; ownership/type/legacy controls are in [`audit-binary-ownership.test.js`](../test/audit-binary-ownership.test.js). This required copy is visible in allocation accounting rather than treated as an optimization.

## Reproducible executed profiles

Use isolated child Node processes for each module/version × payload size × compressibility. Child heap cap: 256 MiB; RSS abort: 512 MiB; child wall deadline: 20 s. Parent cleans up children and captures exit status. No network or live Redis is necessary.

[`audit-memory-profile.mjs`](../scripts/audit-memory-profile.mjs) runs 28 fresh children (14 cases × two repeats). Both canonical matrices completed 28/28 with all accounting, close and short-growth assertions true. The root runner imposed an additional 180-second / 768 MiB aggregate RSS budget and recorded no abort in [`memory-before.log.meta.json`](raw/memory-before.log.meta.json) and [`memory-after.log.meta.json`](raw/memory-after.log.meta.json). The machine is Apple M5, 10 logical CPUs, 16 GiB host RAM, Darwin 25.5.0 arm64, Node 24.21.0 / V8 13.6.233.17-node.53. All payloads are deterministic local data. Node 20/22 correctness matrices pass separately; their memory/performance matrices remain NOT MEASURED here.

The value cases use repeated-text plain objects and high-entropy Buffers, 16-byte logical keys, maxEntries 2048, a 64 MiB ledger and at most 16 MiB aggregate expanded resident payload. The number of entries is 256, 256, 256, 64, 16 and 1 as payload size increases. Public default codec round trips warm the runtime before empty/filled/deleted/held-closed/released checkpoints. The output stores each exact checkpoint and allocation sample separately.

The following paired values are the midpoint of the two independent run values, rounded for readability. C/I denotes compressible/incompressible. “Heap + external / entry” is `(filled − empty) / admitted entries`, not exact heap retained size. `external` and `arrayBuffers` overlap; only external is added. OS peak is the reported high-water RSS at the released-value checkpoint, before snapshot/allocation-profile phases; it includes runtime and temporary codec work rather than only retained entries.

| Payload | Entries | Before heap + external / entry, C / I, bytes | After heap + external / entry, C / I, bytes | Before OS peak MiB, C / I | After OS peak MiB, C / I |
|---|---:|---:|---:|---:|---:|
| 64 B | 256 | 787 / 760 | 764 / 753 | 89.16 / 89.10 | 89.59 / 89.93 |
| 1 KiB | 256 | 759 / 1719 | 737 / 1712 | 89.88 / 89.88 | 90.30 / 90.48 |
| 16 KiB | 256 | 738 / 17078 | 712 / 17054 | 107.69 / 106.92 | 109.37 / 107.85 |
| 256 KiB | 64 | 1271 / 263327 | 896 / 262952 | 142.39 / 145.54 | 147.54 / 146.67 |
| 1 MiB | 16 | 3780 / 1052295 | 2307 / 1050556 | 151.17 / 154.62 | 153.59 / 155.60 |
| 10 MiB | 1 | −1354 / 10478805 | −29558 / 10447845 | 231.41 / 229.77 | 254.29 / 230.91 |

| Payload | Stored bytes, C / I, unchanged | Before → after public encode median ms, C / I | Before → after public decode median ms, C / I |
|---|---:|---:|---:|
| 64 B | 81 / 70 | 0.00219 / 0.00229 → 0.00219 / 0.00227 | 0.00200 / 0.00169 → 0.00196 / 0.00167 |
| 1 KiB | 38 / 1031 | 0.00323 / 0.00365 → 0.00354 / 0.00360 | 0.00277 / 0.00160 → 0.00283 / 0.00173 |
| 16 KiB | 36 / 16391 | 0.01938 / 0.02471 → 0.01902 / 0.02458 | 0.01229 / 0.00163 → 0.01265 / 0.00152 |
| 256 KiB | 49 / 262153 | 0.12042 / 0.18137 → 0.11823 / 0.17846 | 0.12804 / 0.00254 → 0.11813 / 0.00242 |
| 1 MiB | 73 / 1048585 | 0.29127 / 0.63448 → 0.28696 / 0.63731 | 0.42485 / 0.00865 → 0.40402 / 0.00810 |
| 10 MiB | 362 / 10485769 | 3.27810 / 5.24708 → 5.29290 / 5.34288 | 7.35206 / 0.01996 → 7.32881 / 0.02244 |

The negative 10 MiB compressed per-entry deltas are retained as measured: a one-entry subtraction cannot isolate small metadata changes from runtime/GC noise. They are not negative cache memory. The 10 MiB codec case has only one timed round trip per child under the resource cap and cannot establish a stable latency distribution. Its compressed-case RSS and encode time increased, so no general peak-RSS or codec-speed improvement is claimed. The public one-argument codec measurements retain legacy decode semantics, including binary views, and do not measure the strict internal reader's added ownership copy. A fast Buffer decode is not interchangeable with decoding a large object/string.

Canonical raw results are [`memory-before.json`](raw/memory-before.json), generated at 2026-10-08T14:00:37.564Z, and [`memory-after.json`](raw/memory-after.json), generated at 2026-10-08T13:59:38.011Z from the immutable revised final build. Baseline was recaptured after the final run with identical assertion plumbing and unchanged cache/workload; [`memory-before-initial.json`](raw/memory-before-initial.json) preserves the earlier receipt. The separately captured LRU-only intermediate is [`memory-lru-after.json`](raw/memory-lru-after.json); it must not be presented as the final decoder/full-library result.

Inspector sampling interval is 2048 bytes. Sampled byte totals and stack records are measured in a separate workload after memory checkpoints, not exact allocation counts. Explicit GC medians range from 2.913–3.330 ms before and 2.874–3.271 ms after across these cases; the observer also sees forced collections and is not an independent production pause distribution. The largest reported child OS RSS including the later snapshot/sampling phases is 299.14 MiB before and 309.17 MiB after; these phases intentionally differ from retained-value checkpoints. Root aggregate sampled RSS peaks are 280.88 and 345.00 MiB respectively and are sampling receipts, not exact peaks. All resource checks passed. Exact allocation count, exact temporary-allocation peak, precise single-entry dominator-retained size, and native allocator fragmentation are **NOT MEASURED**. RSS minus heap/external does not measure fragmentation.

```sh
node scripts/audit-runner.mjs --seconds=180 --rss-mib=768 --heap-mib=256 --output=audit/raw/memory-before.log -- env LAZY_AUDIT_MODULE=/private/tmp/lazy-layers-ca9c02a-audit/dist/index.js LAZY_AUDIT_LABEL=before LAZY_AUDIT_OUTPUT=audit/raw/memory-before.json LAZY_AUDIT_SNAPSHOTS=1 node scripts/audit-memory-profile.mjs
node scripts/audit-runner.mjs --seconds=180 --rss-mib=768 --heap-mib=256 --output=audit/raw/memory-after.log -- env LAZY_AUDIT_MODULE=/var/folders/c0/v0_qvxvs47d5n90q2z2lpx5h0000gn/T/lazy-layers-audit-final-m74j45f9/dist/index.js LAZY_AUDIT_LABEL=after LAZY_AUDIT_OUTPUT=audit/raw/memory-after.json LAZY_AUDIT_SNAPSHOTS=1 node scripts/audit-memory-profile.mjs
node scripts/audit-runner.mjs --seconds=20 --rss-mib=512 --output=audit/raw/heap-summary-before.log -- node --max-old-space-size=256 scripts/audit-heap-summary.mjs audit/raw/before-empty-stores.heapsnapshot audit/raw/heap-summary-before.json
```

Snapshots use a sanitized child environment and synthetic data. They run after retained-state checkpoints on reconstructed stores, so their own allocation/RSS is not included in entry deltas. The analyzer reports directly owned array/backing-node self sizes, not dominators or all reachable runtime objects.

## Skeleton retention evidence

Twenty empty stores with maxEntries 10000 each share a 100000-byte ledger. Both versions charge only 81920 bytes of admission history. The table uses the midpoint of the two forced-GC process deltas; this sum adds heapUsed and external once, not arrayBuffers again.

| Retained phase | Before heap + external bytes | After heap + external bytes | Change |
|---|---:|---:|---:|
| Twenty open empty stores | 3225444 + 1281920 = 4507364 | 28240 + 81920 = 110160 | −97.56% |
| Twenty closed stores still held by caller | 3239052 + 1200000 = 4439052 | 8344 + 0 = 8344 | −99.81% |
| Released-store checkpoint | 157840 + 60000 = 217840 | 0 + 0 = 0 | Delta reached zero after forced GC |

The independent structural snapshot finds 100 directly owned LRU arrays with 4406400 bytes in backing nodes plus 7520 array-wrapper bytes before. The final twenty empty stores have 120 small array wrappers totaling 3680 bytes and zero directly owned backing-node bytes. A held closed baseline store still has a private cache and 220320 backing bytes; the final held closed store has no private cache reference or owned LRU arrays. See [`heap-summary-before.json`](raw/heap-summary-before.json) and [`heap-summary-after.json`](raw/heap-summary-after.json). These are self sizes of directly owned nodes, not full dominator sizes or all reachable memory.

The isolated LRU-only intermediate reduced the empty-store heap delta to 24256 bytes and external delta to 81920 bytes, and the held-closed delta to 4392 heap bytes and zero external bytes. This remains a causal intermediate for the array/close fix; the paired table above uses final metadata and strict-reader code. Dynamic storage can still retain its high-water H slots while an open cache is empty; close releases that private structure. Whole-process RSS includes allocator/runtime effects and does not fall by the same percentages as these reference-retention deltas.

## Serialization/compression cost controls

[`audit-codecs.mjs`](../benchmarks/audit-codecs.mjs) completed 144/144 cases before and after: four sizes (1 KiB, 16 KiB, 256 KiB, 1 MiB), repeated text/high-entropy ASCII, six existing strategies and three fresh subprocesses each. Each child has 256 MiB heap, 512 MiB RSS and 20-second deadline, with a 180-second matrix budget. There are 4–100 timed operations per phase depending on value size. JSON and MessagePack receive the same structured value. Encoding, public legacy decoding and internal decoding are measured separately, with assertions outside timing. No dependencies, compression default or wire policy changed.

The representative repeated-text rows below use median-of-three run medians. Before internal decoding uses the existing legacy reader; after uses bounded preflight, UTF-8 validation and owned binary results. The table measures this intentional safety cost; it does not compare equivalent validation guarantees. Wire sizes are identical before/after.

| Strategy | Wire bytes, 1 KiB / 256 KiB | Final encode median ms, 1 KiB / 256 KiB | Internal decode median ms before→after, 1 KiB | Internal decode median ms before→after, 256 KiB |
|---|---:|---:|---:|---:|
| JSON | 1073 / 262193 | 0.00121 / 0.15392 | 0.00129→0.00600 | 0.10625→0.30279 |
| MessagePack, none | 1065 / 262187 | 0.00221 / 0.06404 | 0.00154→0.00325 | 0.03167→0.04000 |
| Gzip | 70 / 338 | 0.01337 / 0.41358 | 0.00437→0.00629 | 0.09646→0.11525 |
| Zstandard | 60 / 73 | 0.01042 / 0.13246 | 0.00650→0.00675 | 0.09013→0.10392 |
| LZ4 | 62 / 1088 | 0.00350 / 0.05696 | 0.00262→0.00479 | 0.12292→0.13242 |
| Snappy | 94 / 12348 | 0.00358 / 0.07946 | 0.00246→0.00454 | 0.09808→0.10629 |

This workload shows why maximum compression ratio alone is insufficient. At 256 KiB repeated text, Zstandard stores 73 bytes while no compression stores 262187, but bounded decode costs 0.10392 versus 0.04000 ms. At 1 KiB high-entropy ASCII, requested gzip falls back to a 1065-byte uncompressed MessagePack record after spending 0.01692 ms encoding, versus 0.00212 ms with compression disabled. At 256 KiB high-entropy ASCII, gzip does cross the existing savings threshold (217965 wire bytes), but encoding costs 3.05417 ms versus 0.06108 ms with none. ASCII entropy is not universally incompressible; these are specific deterministic traces, not a universal threshold recommendation.

Full before/after encode/decode distributions, observed RSS, ratios, actual codec fallbacks and aggregate CPU are in [`codecs-before.json`](raw/codecs-before.json) and [`codecs-after.json`](raw/codecs-after.json), with broader comparisons in reports 06/08. The matrix demonstrates the finite-read guards' latency cost and the existing compression trade-offs. Brotli, alternative serializers and routing/admission interactions remain NOT MEASURED; exact native allocation counts, temporary peaks and fragmentation remain NOT MEASURED in every codec row.

## Budget and decode compatibility

`CacheOptions.decodeLimits` and `CloudflareWorkerKVStoreOptions.decodeLimits` are additive constructor options. Built-in strict readers default to maxEncodedBytes/maxDecodedBytes 25 MiB, depth 128, per-container elements 1000000 and aggregate visited values 1000000. Overrides must be positive safe integers. Explicit public `deserialize(raw, limits)` and portable `deserializeCacheValue(raw, limits)` opt in to the same bounds. No-option public APIs preserve prior behavior, including the portable gzip reader's existing 25 MiB expanded cap.

Well-formed internal records beyond the configured caps or unsupported foreign MessagePack record/reference/bundled extensions now miss and reload rather than allocate unbounded graphs or masquerade as cached null. Default plain-object encodings round-trip, and known Date/typed-array/Set/Error/RegExp/bigint extension fixtures match their legacy decoded values. These tests do not prove that the default packer preserves every native JavaScript type. Callers that intentionally use vetted larger records must raise the relevant byte/collection limits and provision memory for temporary copies and returned graphs. This does not turn the ledger into an RSS guarantee.

An existing unsupported-value boundary is JavaScript Map identity. Default msgpackr pack emits a MessagePack map, but the baseline global unpacker and the new strict unpacker both default to mapsAsObjects:true. String-key Maps return plain objects; keys such as number 1 and string '1' collide during object-key coercion and one value is lost. This audit does not silently rewrite that wire/type semantic. Applications requiring native Map key identity need a separately defined compatible codec contract; the limitation remains in the risk/backlog rather than being certified by the extension fixtures.

The inspector limits actual decode in addition to supplied originalBytes metadata, so a forged small metadata value cannot bypass the preview cap. Rejected/corrupt L1 records are removed and release their fresh ledger charge. Corrupt KV reads are not automatically deleted, since an eventually consistent read must not delete a newer writer's state; they reload as misses.

The native prefix assumptions are source-backed: [`lz4-napi uncompress_sync`](https://github.com/antoniomuso/lz4-napi/blob/main/src/lib.rs) calls size-prepended block decode; [`lz4_flex uncompressed_size`](https://github.com/PSeitz/lz4_flex/blob/main/src/block/mod.rs) reads a four-byte little-endian length, and its [safe block decoder](https://github.com/PSeitz/lz4_flex/blob/main/src/block/decompress_safe.rs) allocates that output length and rejects literals/matches exceeding capacity. Native output may coexist with a copied Node Buffer, so a 25 MiB expanded-body limit is not a 25 MiB total temporary-memory limit. The installed package/native versions and actual wire-prefix fixtures are recorded in inventory/tests; the linked upstream source was read during this audit, not used as proof of every native build's allocator behavior.

## Lifecycle verification matrix

| Transition | Existing evidence | Remaining requirement |
|---|---|---|
| Expiration | Queried expired key misses and releases its charge; global purge-call regression | Lifecycle-specific retained heap after idle expiry remains NOT MEASURED |
| Eviction | Count/byte caps, ownership and pressure tests pass | Explicit per-eviction dominator/allocator reclamation remains NOT MEASURED |
| Invalidation/delete | Profile delete checkpoints release all fresh charges; Buffer backing deltas are recorded | Long-duration transport/invalidation retention remains NOT MEASURED |
| Failed refresh | Error fallback retains eligible stale data | Confirm follower/result/closure release and failure-path heap |
| Cancelled/timed-out load | Gate retains uncooperative active work intentionally | Cooperative cancellation cleanup and stalled bounded-slot recovery |
| Redis timeout/disconnect | L2 gate/transport safety tests | Isolated live transport retained-buffer and reconnection profiles |
| Shutdown | Ledger zero, post-close no-loader/no-write regressions, held-closed skeleton profile | Native client listeners/timers and transport buffers require separate integration evidence |

## Readiness interpretation

A passing accounting test proves `accountedBytes ≤ target` and correct ledger release. It does not prove heap/RSS ≤ B, precise per-entry metadata cost or zero application-held references. Strict decompression/structure caps are separately tested, and temporary codec/output copies are finite under those caps but are not reserved against the retained-entry ledger.

The revised frozen source/build is source SHA-256 `e451d7c9d3524779584211fe0571acff4e68cecbf1e32e6f8bb10f8face8fd08`, ESM SHA-256 `21ed478360f76848bfb2b79594169f80bda2b24fe0bf4f9caacbb9aa66608b95`. The final isolated Docker suite passes 480/480 with zero skips and independent focused verification passes 93/93; evidence is linked from [`after-docker-test.log`](raw/after-docker-test.log), [`independent-verification-tests.log`](raw/independent-verification-tests.log) and [`independent-verification-after.json`](raw/independent-verification-after.json). Separate Node 20 and Node 22 Docker runs each pass 480/480, type/build/package checks in [`node20-docker-runtime.log`](raw/node20-docker-runtime.log) / [`node22-docker-runtime.log`](raw/node22-docker-runtime.log). The Node 20 run retains the transitive @nats-io/nuid engine>=22 compatibility qualification; its passing exercised tests do not override that dependency's declared support. The earlier 476-case pass did not cover binary aliasing; the added mutation regressions forced a revised build before any final measurements. Correctness tests do not substitute for retained-heap/RSS profiles or performance measurements.

The six-cycle working-set smoke uses 128 keys, 512 replacements/deletions per cycle and clear between cycles. Canonical before and final after profiles keep external memory constant across their six checkpoints and return fresh charges to zero each time; closed ledgers also reach zero. Before heap growth is 57608 and 57536 bytes, after 61296 and 61392 bytes. Both final runs have 62920-byte heap ranges versus 59072 bytes before. All pass the fixed 589824-byte smoke tolerance, and the small measured increase is kept visible. Six short cycles do not establish indefinitely stable heap; long memory soak, failure-path heap snapshots and runtime-specific heap profiles remain open readiness gates.

The final memory harness now exits unsuccessfully for any false accounting/close assertion. Its short post-GC growth smoke permits a 512 KiB fixed slack plus 64 KiB rounded baseline variability; the initial calibration was below 64 KiB and the canonical repeat remains below it. This generous noise allowance detects large short-run retention, not small leaks or production stability. The injected false-ledger fixture verifies a failed assertion returns exit 1 in [`memory-harness-regression.tap`](raw/memory-harness-regression.tap); it is a harness-control test, not a cache measurement. The added assertions do not change the frozen before workload.

A separate 30-second bounded working-set smoke also passes before and after in [`memory-smoke-before.json`](raw/memory-smoke-before.json) / [`memory-smoke-after.json`](raw/memory-smoke-after.json), with the final resource receipt in [`memory-smoke-after.log.meta.json`](raw/memory-smoke-after.log.meta.json). It uses 512 working keys, 256 resident slots, 1 KiB payloads, a 2 MiB ledger, 512 MiB child RSS cap, at most 5000 cycles and a 50 ms duty delay. Before completes 541 cycles / 450112 operations in 30.085 seconds; after completes 545 cycles / 453440 operations in 30.072 seconds. Both have no failure and zero closed-ledger bytes. Duty delay and fixed duration make these counts unsuitable as throughput claims. This extends the short retention check; it remains a smoke/endurance sample, not hours-long or fault-path production stability.

## Optional event-feed retention

The collector now retains a detached JSON-safe snapshot with default maxEventBytes 65536 rather than caller-owned metadata objects. Oversized keys, standard Error.message strings, large bigint metadata and unsupported graphs shed capture data with a visible truncated flag. Counters/sequence still advance. Supported ordinary small CacheEvent payloads keep their data; source arrays and string backing stores are detached through bounded encode/parse. Limits apply to encoded metadata and bounded graph-node/depth counts, not precise V8 retained bytes. A custom event-byte constructor limit is additive; deliberately tiny limits can drop a record whose header cannot fit.

Each shared observability handler has optional maxStreamClients (default 64) and maxStreamEventBytes (default 65536) settings. A blocked socket gets no further application writes or queued event objects until drain. The last bounded write can overshoot the native high-water mark; transport buffers, server/socket metadata and user-held recentEvents snapshots remain separate memory. Close/finish/error cleanup removes the timer, subscriber and drain/close callbacks and releases the client slot exactly once. Arbitrary in-process listeners and repeatedly created handlers are caller-controlled, so this does not claim a global cap across independently created handlers.

Capture performs bounded encoding/parse and SSE performs bounded encoding per writable subscriber. This optional correctness guard adds CPU/allocation work; its overhead is NOT MEASURED as a dedicated performance comparison. Arbitrary caller Proxy hooks or synchronous listeners cannot be preempted. See report 03 for the precise complexity assumptions rather than an O(1) fan-out claim.

The separate Worker L1 stores structuredClone values with a count cap but no Node MemoryBudget, and its origin/follower path does not have the full Node bounds. The coordinated local lifecycle/revision cleanup is documented in the correctness report; strict KV decoding and local revision guards do not certify shared KV publication, Worker overload or heap behavior. This platform limitation remains visible even if Node cache gates and throughput checks pass.

Direct standalone MemoryStore.getOrSet also lacks the coordinating facade's singleflight/origin gate. Caller loader/result retention is not bounded by the L1 byte ledger. Its miss convenience should not be substituted for the Node facade when origin protection is required.

Origin/queue/follower bounds are per configured cache/gate. Aggregate work across I instances or multiple cache objects can multiply those limits; the shared byte ledger is not a cluster-wide origin semaphore. Per-tenant fairness, coordinated global origin capacity and individually cancelled follower retention remain separate requirements, not inferred from a passing local queue test.
