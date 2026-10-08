# Complexity audit

Baseline: `ca9c02a04349a89278cd81b5b25d0000503cc5a3` (0.6.2). This report distinguishes the data-structure operation from serialization, returned-value copies, maintenance, and network work. Measurements are linked separately when available; source inspection alone is not a timing result.

## Variables and assumptions

- `N`: resident entries in one L1, including expired entries not yet removed.
- `K`: logical/storage key length; tenant prefix construction increases it.
- `V`: serialized expanded value size before compression. Stored bytes can be much smaller than `V`; decoding cannot be bounded by compressed size alone.
- `C`: concurrent requests; distinct in-flight keys are at most `C`.
- `I`: application instances. Process-local cache clients are a separate count, not automatically equal to `I`.
- `W`: waiting requests retained by one gate.
- `E`: queued invalidation events.
- `B`: configured cache byte-accounting budget, not RSS.

The additional parameter `M` is configured `maxEntries`. Baseline `lru-cache` allocates arrays for `M`, so replacing it with `N` would conceal a real memory cost. After the dynamic-storage fix, `H ≤ M` is the high-water number of allocated resident slots since construction; an open store can retain H slots even when current N is zero after clear. `S ≤ V + wire overhead` is stored encoded bytes under the selected policy. `D` is the returned JavaScript graph footprint and `G` is graph nodes/edges visited during serialization. These quantities are needed for correctness: equal wire sizes do not imply equal JavaScript heap size, and getters/toJSON can execute arbitrary user code.

Expected map/set lookup means ordinary hash-table behavior with a bounded load factor and ordinary keys. ECMAScript requires average sublinear access, not an unconditional worst-case O(1) guarantee. Fresh-string hashing/byte-length checks cost O(K); already-hashed strings may make the engine lookup cheaper, but the admission hash still visits K characters. Worst-case statements below separate known loops from unspecified engine/native behavior. No claim assumes an adversarial hash implementation has constant worst-case cost.

## L1 operations at baseline

Source: [`memoryStore.ts`](../src/cache/memoryStore.ts), with the installed `lru-cache` implementation in `node_modules/lru-cache/dist/esm/index.js` (`constructor`, `#indexes`, `#rindexes`, `purgeStale`, `pop`, `#initializeTTLTracking`, `#clear`). Lockfile versions, rather than README descriptions, determine this code.

| Operation | Best/expected time | Known worst-case loop | Auxiliary/allocation cost | Persistent cost / network |
|---|---|---|---|---|
| Construction | Θ(M), before entries exist | Θ(M) array initialization | Two M-slot JS arrays; three M-sized index/free arrays; 4 KiB history when reserved | Θ(M) structure, fixed history; 0 network |
| `get` miss | O(K) with history enabled | Engine map behavior | Promise wrapper; bounded frequency update | No returned value; 0 network |
| `get` hit | Expected O(K + V + G) including decode | Decoder/value expansion, not N scan | Returned graph O(D); codec output O(V); fixed tag/registry allocations | Resident encoded bytes retained; 0 network |
| `getEncoded` hit | Expected O(K + stored bytes) | No resident-entry scan | Full defensive Buffer copy, result object, Promise | Caller may retain copy; 0 network |
| Direct `MemoryStore.getOrSet` | Lookup plus one caller loader on miss, then serialization/insertion | Loader is arbitrary caller code; concurrent misses are not coalesced here | One caller Promise/result per invocation | Low-level store has no origin gate; 0 Redis operations |
| `set` | Serialization O(V + G), then encoded insertion | User serialization hooks are not bounded; first TTL write adds Θ(M) | Packed copy + compression output + prefixed copy + owned L1 copy | Encoded buffer + metadata; 0 network |
| `setEncoded` without admission pressure | Expected O(K + stored bytes) | At most 16 explicit eviction attempts; first TTL initialization Θ(M) | Owned unpooled Buffer copy, entry object, Promise; budget snapshot allocates category object | Incremental ledger update; 0 network |
| `worthAdmitting` under pressure | O(K + up to 8 victim key hashes) when victims are fresh | Θ(N) when the iterator skips expired entries before yielding samples | Iterator, yielded pairs; no value serialization | Fixed 4 KiB approximate history; 0 network |
| `has` | Θ(N), even for a fresh queried key | Full `purgeStale()` resident scan on every invocation | Iterator/Promise; disposal of expired buffers | 0 network |
| `delete` | Expected O(K) | Engine map behavior | Fixed-size disposal/accounting operations | Releases ledger and value reference; 0 network |
| `deleteByPattern` | Θ(N × match cost) | Baseline regex matching may backtrack exponentially for repeated stars | Pattern compile on miss; at most 500 regexes globally | Direct key deletion; 0 network |
| `size`, `stats` | Θ(N) because they purge stale entries | Full resident scan | Stats also clones category ledger | 0 network |
| `inspect` | Up to Θ(N × match cost + returned V/G) | Cursor offsets and nonmatches can scan N although page ≤1000 | Returned keys and optional decoded values | Page result retained by caller; 0 network |
| `clear`, `close` | Θ(N + M) | Dispose residents then fill allocated arrays of length M | Deletes references; close releases history | Baseline arrays stay reachable through a retained closed store; 0 network |

LRU recency manipulation uses indexed previous/next links, not `Array.shift()`, and touches a constant number of links. Under the no-background-fetch assumption (MemoryStore never uses `fetch`), `pop()` removes one populated entry and returns immediately. Its generic dependency implementation contains a loop for background-fetch/undefined values, but that loop is not exercised by this adapter.

There is no per-entry expiry timer in baseline MemoryStore. Expired values leave on queried `get`, full purge, eviction, or shutdown. This reduces timer allocation but means an idle expired working set can remain retained until one of these paths runs. `size` promises an exact fresh count; an O(N) maintenance scan is defensible there. Putting that same scan in `has` is avoidable.

## Composition amplifies the L1 costs

Source: [`hybridCache.ts`](../src/cache/hybridCache.ts).

1. `promoteToL1` inserts the value then calls `MemoryStore.has(storageKey)` to determine whether admission succeeded. Filling N distinct keys invokes scans of sizes 1, 2, …, N: Θ(N²) resident checks even before origin/network cost. This is a reproducible complexity regression, not a conjecture about LRU lookup.
2. A warm L1 read calls `getEncoded`, makes a full defensive copy, decodes it, and by default calls `rememberStale`. That function removes the prior snapshot and copies the same encoded value into a new unpooled buffer. A hit therefore performs two O(stored-bytes) copies plus decode and a new stale-entry allocation. The stale snapshot has independent expiry semantics; reuse must preserve expiry extension and invalidation behavior.
3. `getOrSet` calls `pruneInflight` before initial lookup and again after `get`. Each prune visits every tracked distinct key. For a cold storm with F ≤ C tracked keys, this contributes O(F) per request and O(C²) in a growing distinct-key storm. A same-key storm has F=1 and hides this cost.
4. Same-policy L1/L2 direct writes reuse one encoding, which is good. Different policies encode independently, an intentional O(V + G) cost for each tier. Unsupported encoding attempts may fall back through the store's own setter and repeat a failing serialization.
5. Stale snapshot eviction uses `Map.keys().next()` plus delete, expected O(1). However one newly admitted large snapshot may evict many small snapshots: worst Θ(N), amortized linear in entries inserted/deleted across an operation sequence. A strict per-request bound requires an explicit eviction cap, possibly rejecting the new snapshot.

## Queue, singleflight, and maintenance accounting

| Component | Lookup/update | Worst known work | Retention / contention |
|---|---|---|---|
| Baseline Hybrid singleflight map | Expected O(K) map lookup plus full prune | Full prune described above | Bounded entry count by default; follower count not separately budgeted |
| Final Hybrid singleflight map | Expected O(K) lookup / queried-key expiry / incremental bytes | Close visits tracked entries; normal join has no unrelated-key scan | Default 10000 follower cap and 160-byte estimated follower charge, bounded key metadata, hard leader/origin limits; caller-owned promises/results remain separate |
| `OriginLoadGate` | Expected O(1) Set enqueue, remove, FIFO-head access | `close` Θ(W) | Defaults 32 active, 1024 waiters; one timeout and release closure per waiter/leader; no OS mutex |
| `L2OperationGate` | O(1) array append; baseline completion shifts array | Θ(W) `shift`, timeout `indexOf`/`splice`, close | Defaults 64 active, 1024 queued and 32 MiB queued payload; active deadlines do not release underlying work slots |
| Baseline invalidation handler queue | Array append plus Θ(E) pending-byte reduction on every admission | Θ(E²) total byte summation for E enqueues; array shift on drain/close | Count/encoded-byte limits; mutable event graphs and shared backing views can exceed the intended charge |
| Final invalidation handler/retry queues | Expected O(1) Set bookkeeping and incremental byte totals | Wire snapshot encode/copy/decode depends on bytes/keys; close/discard Θ(E) | Owned wire snapshots; active and pending bytes included; handlers/transport are external work |
| `MemoryBudget.tryReserve/release` | Expected O(category key length), incremental totals | Engine Map behavior | Category cardinality is caller-extensible; shared ledger only |
| `MemoryBudget.snapshot` | Θ(category count) | Clones every category | Fresh object on hot encoded writes |
| Budget registration/removal | Append amortized O(1), removal Θ(client count) | Array `indexOf`/`splice` | One shared sampling timer, unref'ed |
| Budget pressure eviction | Up to 32 client callbacks per sample | A client callback can itself do more work | Round-robin is bounded in callback count, not arbitrary callback duration |
| Memory signals | Platform file reads, process/V8 metrics | Mount/cgroup discovery + bounded ancestor traversal | Runs at construction/sampling, not a per-request lookup |

Promise `async` wrappers, telemetry closures, AbortControllers, and timers contribute constant allocation counts only for fixed-size metadata. A Promise holding a V-sized closure/result is not constant *bytes*. Uncooperative loaders and transports can retain application-owned references beyond caller deadlines; concurrency gates intentionally keep slots held until underlying settlement.

Gate limits are per cache/gate instance. With I independently configured application instances, admitted origin work can reach I × maxConcurrent and queued work I × maxQueue; multiple caches in one process can also multiply these bounds. A shared MemoryBudget does not itself provide a shared origin semaphore. Applications must size these limits against the actual database pool/capacity; cluster-wide admission and per-tenant fair share are not implemented or certified by the local gates.

The approximate frequency history is updated incrementally: every eighth lookup ages eight of its 4096 cells, then updates one hashed cell. Aging is bounded by eight fixed-width byte operations on a lookup, not a 4096-cell sweep. Hashing still visits K characters. The default sample does not require a heap, linked frequency buckets or separate timing wheel.

## Redis/network complexity

Source: [`redisStore.ts`](../src/cache/redisStore.ts), [`distributedLock.ts`](../src/cache/distributedLock.ts), [`redisPipeline.ts`](../src/cache/redisPipeline.ts).

| Path | Network count at baseline | Size-dependent work |
|---|---|---|
| L1 hit | 0 Redis commands | Key hash, defensive copy, decode, stale snapshot copy |
| Encoded L2 read | Bounded GET + PTTL path; adapter/capability dependent | O(K) key building, transferred stored bytes, O(V/G) decode |
| Ordinary L2 set | Bounded SET path, optional generation/index commands | Encoding and copied payload retained until transport settlement |
| Lease acquire | Atomic bounded server operation where supported | O(K) namespace/token work; not a keyspace scan |
| Safe publication | One atomic Lua/server operation where supported | Ownership check + write; value transfer O(stored bytes) |
| Lease contention | Polling proportional to wait timeout / poll interval per instance | Aggregate contention grows with I; local coalescing reduces calls per process |
| Direct delete | Bounded direct-key operations | O(K), excluding event propagation |
| Pattern invalidate/clear/inspect | Keyspace/cursor scans and batches | At least linear in visited key count; explicitly outside direct-key O(1) target |

The distributed-correctness report records the exact capability branches and tested command counts. A pipelined GET/PTTL is one network round trip but two Redis commands; these are different metrics and must not be combined.

## Serialization claims requiring correction

Source: [`serializer.ts`](../src/utils/serializer.ts), [`codecs.ts`](../src/utils/codecs.ts), [`portableSerializer.ts`](../src/utils/portableSerializer.ts).

- Fixed four-byte tags are O(1). Exported `hasPrefix` accepts an arbitrary-length prefix, so its general cost is Θ(prefix length); the fixed HC1 call sites satisfy the assumption.
- JSON and MessagePack visit a value graph; cost is O(V + G) for supported plain data under fixed codec settings. General user hooks, pathological graphs, or untrusted length metadata make an unconditional O(V) statement unsafe.
- Fixed-policy LZ4/Snappy and compression at fixed settings are treated as linear in bytes for engineering accounting; no formal native worst-case runtime bound has been established here.
- Baseline decompression has no Node output cap. A compressed input of small stored size may expand to huge V, so both decode time and temporary memory are unbounded by the ledger's admitted stored bytes.
- `codecByTag` creates `Object.values(CODECS)` and a closure every decode. Registry size is fixed at five codecs, so it is O(1) with avoidable constant allocations, not an asymptotic bottleneck.
- Portable gzip reads cap expanded body at 25 MiB while holding output chunks and then an output copy. Portable raw MessagePack/JSON do not enforce that decoded-body cap.
- `estimateValueBytes` measures UTF-8 JSON length, not retained heap. It is O(V + G), may execute user JSON hooks, and must not be used as proof of heap-budget safety.
- Native Map type/key identity is not preserved by the baseline default mapsAsObjects decoder: a Map with numeric key 1 and string key '1' loses an entry through object-key coercion. The strict reader preserves that existing wire behavior, not arbitrary native-value semantics. This is a documented unsupported-value boundary in report 04.

## Decisions and experiments

| Hypothesis | Evidence required | Decision status |
|---|---|---|
| Removing the full purge from `has` removes resident-count scaling without changing queried-key expiry | Varied-key has/fill baseline in [`benchmark-before.json`](raw/benchmark-before.json); purge-call and expiry-accounting regressions | Implemented; current `has` visits only the queried key; final timing comparison in report 10 |
| Dynamic LRU storage removes large empty-cache preallocation | [`memory-before.json`](raw/memory-before.json), [`heap-summary-before.json`](raw/heap-summary-before.json), isolated LRU-only [`memory-lru-after.json`](raw/memory-lru-after.json); count/eviction regressions | Implemented with count-valued maxSize, keeping the existing LRU policy; memory report records final measurements |
| Bounded decode rejects hostile expanded payload before native allocation | Tiny forged LZ4/Snappy headers, capped gzip, intercepted MessagePack array32 allocation, legal extension round trips | Implemented through additive explicit public limits and strict built-in record decoders; public no-option compatibility retained |
| Incremental singleflight expiry reduces distinct-storm overhead | Mixed/hot/distinct concurrency tests and many-live-key microbench | Implemented by the correctness workstream; see report 05 and final benchmarks |
| Reusing unchanged stale snapshots lowers hit allocation | Payload-size × hot-set × fail-safe enabled/disabled, mutation and expiry tests | Deferred; current hits still replace and copy stale snapshots. No copy-savings claim is made without this change and paired evidence |
| More advanced eviction/admission improves application cost | Uniform/Zipf/scan/shifting/large-object traces with object and byte hit ratio, CPU, metadata | Existing production policy preserved; candidate trace results and trade-offs in report 06/08 |
| Live-feed backpressure and oversized metadata can escape retained-entry budgets | Frozen baseline accepts 42 writes after the first false write, retains 128 KiB key/error strings, admits unlimited clients and invokes oversized JSON serialization; six bounded regressions in [`observability-bounds-before.tap`](raw/observability-bounds-before.tap) | Implemented socket drain handling, per-handler client/frame caps and byte-bounded detached capture snapshots; final tests recorded independently |
| Returning binary views from a retained wire buffer permits cache-state corruption | Three-byte nested Buffer mutation through direct MemoryStore.get/inspect corrupts both baseline and the first frozen build in [`binary-alias-frozen-diagnostic.log`](raw/binary-alias-frozen-diagnostic.log) | Strict MessagePack readers now copy binary fields before returning them; O(binary payload bytes) copy is a required ownership cost, not a speed optimization |

No TinyLFU/W-TinyLFU implementation is justified solely by the presence of an approximate history array. Baseline history is a single saturating, periodically decayed hashed counter and a frequency-per-byte victim sample. It is not a count-min sketch and must not be called W-TinyLFU. Hash collisions can affect admission quality but do not create key-value identity collisions because the LRU Map remains the authority.

## Final measured complexity experiments

[`audit.mjs`](../benchmarks/audit.mjs) uses one instance on Apple M5 / 10 logical CPUs / 16 GiB, Darwin 25.5.0 arm64, Node 24.21.0. Each row has five fresh subprocesses, a 512 MiB child heap, 45-second deadline and 640 MiB reported-peak limit, with an outer monitored runner. There is no network. Warm reads cycle through 64 distinct tenant/user keys and 1 KiB structured values; has uses 13–16-byte keys and 64-byte payloads. Promotion uses a controlled in-process L2 with 1 KiB values. In-flight registration measures synchronous follower registration while the stated number of distinct leaders is held pending, with origin limits explicitly disabled only for that structural experiment. These closed-loop costs are not open-loop service throughput or arrival-to-completion tail latency.

The canonical pair is [`benchmark-before.json`](raw/benchmark-before.json) / [`benchmark-after.json`](raw/benchmark-after.json). The comparator in [`performance-comparison.json`](raw/performance-comparison.json) uses 10000 deterministic bootstrap resamples, a 95% family interval for the median ratio and a regression tolerance of max(10%, 3 × baseline relative MAD). Five short repeats on shared hardware limit inference; structural regression tests remain the stronger proof that a resident scan was removed.

| Scenario | Resident entries / active keys / callers | Measured operations | Before median ms | After median ms | Change |
|---|---:|---:|---:|---:|---:|
| Queried `has` | N=32 | 4000 | 6.104 | 1.141 | −81.31% |
| Queried `has` | N=1024 | 4000 | 84.644 | 2.201 | −97.40% |
| Queried `has` | N=8192 | 4000 | 807.716 | 1.379 | −99.83% |
| L2→L1 distinct promotion | N=2048 | 2048 | 59.986 | 20.981 | −65.02% |
| Pending-key follower registration | 32 active keys | 4000 | 8.074 | 4.045 | −49.90% |
| Pending-key follower registration | 1024 active keys | 4000 | 101.602 | 2.524 | −97.52% |
| Warm L1 read, fail-safe off | N=64 | 20000 | 27.766 | 36.224 | +30.46% |
| Warm L1 read, fail-safe on | N=64 | 20000 | 40.782 | 49.395 | +21.12% |
| Accepted same-key herd | C=1000 | 1000 | 3.624 | 4.730 | +30.51% |
| Accepted same-key herd | C=10000 | 10000 | 14.956 | 27.564 | +84.30% |
| Accepted same-key herd | C=100000 | 100000 | 118.528 | 215.568 | +81.87% |

The varied-N has measurements support the removal of per-request Θ(N) work; their sub-millisecond engine/async overhead still varies and does not prove constant worst-case hashing. Promotion and distinct-key registration remove measured composition costs. The warm-read and 1000/10000/100000 accepted-herd regressions are flagged by the comparator and remain unresolved performance costs of the correctness/resource guards. Warm CPU per million calls rises from 2580.7 to 3409.2 ms with fail-safe off and from 4095.1 to 4838.7 ms with it on. This audit does not claim a universal lookup speedup or attribute all overhead to one unprofiled guard.

Every same-key herd completes one loader operation. Its maxWaiters is explicitly raised to 100000 on both sides for accepted-work comparison; the default final cap is 10000. The 100000-caller pending forced-GC process heap delta rises from 105.89 to 626.17 bytes per caller (median of five runs), including caller arrays, promises and coordination metadata rather than exact waiter retained size. Count/byte/deadline limits prevent the default queue from growing without bound; increasing them remains a provisioning choice. Default-cap shedding and recovery are tested separately in the correctness/load reports. No database or multi-instance throughput is inferred from this simulation.

### Invalidation queue accounting

Source: [`handlerQueue.ts`](../src/event-bus/handlerQueue.ts) and [`retryQueue.ts`](../src/event-bus/retryQueue.ts). The old handler retainedBytes getter reduces the full pending array for each enqueue, which makes a blocked E-event fill Θ(E²) even before serialization. The final queues maintain totals incrementally and use Set head/delete operations under ordinary engine behavior. Accepted handler records now copy their encoded bytes so a tiny view cannot retain a larger backing store; retry records are encoded/decoded snapshots. These ownership/validation costs remain byte-dependent.

[`audit-queues.mjs`](../benchmarks/audit-queues.mjs) compares five fresh subprocesses per size, using 52-byte prepared invalidation wires and one blocked handler, with 128 MiB child heap / 10-second child deadline and a 90-second / 512 MiB outer budget. It isolates bookkeeping with a deliberately small fixed event; it is not a representative event-server throughput result. Both matrices pass their delivery/count/byte-release checks in [`queues-before.json`](raw/queues-before.json) / [`queues-after.json`](raw/queues-after.json).

| Events | Handler enqueue ms before→after | Handler drain ms before→after | Retry flush ms before→after | Aggregate CPU ms before→after | Child peak RSS MiB before→after |
|---:|---:|---:|---:|---:|---:|
| 32 | 0.094→0.105 | 0.073→0.091 | 0.529→0.872 | 1.441→2.157 | 67.69→67.92 |
| 1024 | 2.131→0.424 | 0.487→0.891 | 2.041→3.644 | 14.550→16.339 | 73.63→75.86 |
| 8192 | 172.173→2.343 | 3.054→8.935 | 8.184→27.388 | 208.960→86.838 | 82.98→120.61 |

At 8192 events, enqueue improves 98.64% and aggregate CPU improves 58.44%; drain/retry flush time and RSS increase. At smaller queues, the extra ownership/validation overhead outweighs the removed scan in aggregate CPU. These medians have no dedicated queue confidence gate. The bounded L2OperationGate still uses array shift/indexOf/splice with Θ(W) known work; that distinct transport queue was not established as a measured bottleneck and was not rewritten.

### Actual admission controls

[`audit-policies.mjs`](../benchmarks/audit-policies.mjs) runs 16000 accesses per cold trace, 128 resident slots, a 256 KiB ledger, varied tenant keys, ten workload families and three fresh repeats per admission setting. The before and after matrices each pass 60/60, with identical object hits, byte hits and loader counts on every trace. This supports preserving the policy while changing storage and safety guards, not improving policy quality.

On the final Zipf trace, admission increases object hit ratio from 71.006% to 72.069% but aggregate CPU from 69.958 to 85.395 ms. On a shifting hot set it decreases hits from 98.4% to 89.2% and increases origin loads from 256 to 1728. With heterogeneous 64 B / 1 KiB / 16 KiB / 128 KiB objects it increases object hit ratio from 5.394% to 12.3% while decreasing byte hit ratio from 2.527% to 0.153%. Applications must choose against real origin cost and workload; no W-TinyLFU/affinity/service change follows from these controls. Full data and CPU/RSS distributions are in [`policies-before.json`](raw/policies-before.json), [`policies-after.json`](raw/policies-after.json) and reports 06/08. Other eviction algorithms have not been implemented or benchmarked against this library and remain NOT MEASURED.

## Implemented L1 and decoder bounds

| Operation | Before | After | Assumptions and retained trade-off |
|---|---|---|---|
| LRU construction | Θ(M) arrays, including empty caches | O(1) structure plus optional 4096-byte history | First shared budget creation still performs platform sampling; the structure statement excludes that work |
| `has(key)` | Θ(N) purge plus key lookup | Expected O(K); at most one expired-key deletion | Ordinary Map behavior; has no longer purges unrelated expired keys |
| Distinct-key fill promotion | Θ(N²) has scans | Expected O(total key bytes + total copied encoded bytes), plus bounded admission/eviction and loader/network work | Dynamic array growth is amortized under the runtime's normal geometric growth; one growth can copy O(H) slots |
| LRU touch / victim removal | Indexed O(1) link edits | Same | No background `fetch()` entries in this adapter; hashing is separate |
| Admission victim sample | Hidden Θ(N) stale skip | At most eight visible victim samples | Temporarily enables allowStale during a synchronous, finally-restored iterator; supported keys are primitive string/number, so no user key hooks run inside that scope |
| Expiry on lookup | Lazy queried-key removal | Same; has also disposes its queried expired key | Idle expired values remain bounded by the ledger until queried, maintenance, eviction or close |
| `size` / `stats` | Θ(N) scan | Θ(N) scan retained | An exact fresh-entry count is a maintenance operation, not an O(1) target |
| Pattern match / pattern invalidation | Repeated-star regex can backtrack exponentially | Anchored literal/KMP match O(K + pattern length), then scan N keys | [`pattern.ts`](../src/cache/pattern.ts) searches disjoint value ranges and builds each literal failure table once; O(pattern length) scratch, no unconditional direct-key O(1) claim |
| Open-store persistent structure | Θ(M) | Θ(H), H ≤ M | Arrays do not promise to shrink to current N after eviction/clear |
| `clear` / `close` | Θ(N + M), closed arrays remain held | Θ(N + H) LRU work; close drops the private LRU reference | Open clear may retain capacity; shared-budget unregistration adds Θ(registered client count); held closed stores release cache-owned arrays |
| Strict MessagePack preflight | None | O(wire tokens + validated UTF-8 bytes), O(depth) scratch | maxDecodedBytes, depth, individual collection and aggregate value limits checked before unpack; container claims must fit remaining input; binary payload bodies are skipped |
| Strict JSON preflight | None | Θ(V), O(depth) scratch before JSON.parse | Final JSON.parse validates syntax; encoded/decoded bytes and collection work are bounded |
| Compression output | Node unbounded; portable gzip capped | Strict Node gzip/zstd output cap; LZ4/Snappy advertised-size validation; portable chunk limit | Codec algorithms and returned graph heap are separate costs; a compressed S-byte entry does not imply O(S) decode |

Finite decoder caps are resource guards, not a claim that arbitrary JavaScript graph construction costs O(1). Known MessagePack bigint extensions use divide-and-conquer large-integer arithmetic, and RegExp extensions compile patterns; neither has a formal linear worst-case runtime proof here. Strict decoders reject record-definition, structured-reference, bundled-string and unknown custom extensions, which the library's default packer does not emit. Public no-option decode keeps legacy compatibility and therefore remains an explicitly unbounded boundary.

## Optional observability complexity and bounds

Sources: [`collector.ts`](../src/observability/collector.ts), [`handler.ts`](../src/observability/handler.ts), [`eventEncoding.ts`](../src/observability/eventEncoding.ts), [`types.ts`](../src/observability/types.ts). These costs apply when observability is enabled; the default cache integration does not capture the dashboard feed.

Let R be maxEvents, T the encoded event/frame byte cap, and L the number of subscribers. Counter and circular-slot updates visit constant metadata, but event capture is not O(1) in key/error size. It checks bounded plain metadata, encodes it, then parses the bounded encoding to detach caller-owned references. Under the normal typed CacheEvent/plain-data assumption, this costs O(T + metadata nodes) and allocates O(T + metadata nodes), capped at depth 8 and 4096 visited values. Actual small-event work depends on K and metadata size. An oversized string is rejected before JSON.stringify creates its full encoded representation. Oversized/unsupported capture payloads become data.truncated=true while counters and the monotonic sequence still advance; an explicitly tiny cap that cannot fit the event header sheds the captured record entirely.

Fan-out costs Θ(L) callbacks, each of which may have its own encoding cost. Synchronous user callbacks must return promptly: swallowing exceptions cannot preempt a slow callback. Each shared HTTP handler defaults to 64 active SSE clients, with 503 for excess clients and a 64 KiB UTF-8 frame cap. Replay, live and heartbeat writes stop after write(false) or writableNeedDrain; drain allows future live events again. No application event queue is retained while blocked. A writable socket can retain its native high-water mark plus the last bounded frame and transport overhead; this is a bound on application writes, not an exact process RSS guarantee. Multiple application-created handlers and arbitrary in-process subscribe calls remain caller-controlled.

The ring retains at most R bounded JSON snapshots. Serialized bytes plus bounded object-node counts constrain the captured graph, but runtime object/header overhead is not exactly T bytes. recentEvents() is Θ(buffered events) and allocates a returned array of references; reset() is Θ(R). The encoder counts even omitted undefined properties toward its work budget and uses bounded bigint thresholds before decimal conversion. Arbitrary Proxy hooks, custom property enumeration and user callbacks can run unbounded caller code or incur engine-dependent enumeration work; no universal constant-time or allocation-free claim covers such inputs. These metadata guards are intentionally simple and retain the default lightweight integration.

UTF-8 validation rejects wire bytes that upstream permissive readers otherwise replace with U+FFFD. The Node reader uses `node:buffer`'s validator on body views; those views allocate metadata per string but do not copy string contents. The Worker validator visits bytes without building decoded strings or per-character objects. Node strict JSON also validates UTF-8; portable strict JSON uses a fatal TextDecoder. Public no-option readers retain their prior replacement behavior. The tiny L1 regression reproduces the baseline returning `'�'` from a corrupt record in [`utf8-l1-before.tap`](raw/utf8-l1-before.tap).

Strict readers also set msgpackr copyBuffers:true. Its readBin copying branch uses Uint8Array.prototype.slice.call; the default branch is src.subarray and can expose retained L1 bytes through a returned Buffer. Direct MemoryStore.get and inspector previews previously allowed a caller to mutate the cached record. Copying returned binary fields adds O(binary bytes) allocation/work and preserves the Node Buffer output type; public no-option decoding retains its original input-view behavior. Typed-array extensions already copy upstream. Four ownership/type/legacy controls cover this boundary separately from plain-object ownership tests.

The separate Worker facade still has count-bounded, cloned-object L1 rather than the Node MemoryBudget and lacks the Node gate's full bounded-waiter/origin protections. Its coordinated per-key lifecycle/revision fix is described in the correctness report; that does not establish a byte budget, origin concurrency limit or follower budget. Worker origin concurrency, follower retention and arbitrary value graph heap remain explicit platform-specific readiness limitations.

The exported standalone MemoryStore.getOrSet remains a low-level get→loader→set convenience and does not inherit HybridCache's singleflight/origin admission. Concurrent direct-store misses may each invoke a caller loader. Applications requiring overload protection must use the coordinating Node facade or impose their own bounded admission; the library-wide audit does not claim that every low-level adapter API is protected.

The linear-scan regressions are structural: tests count global purge calls or Map lookups rather than depend on noisy wall-clock thresholds. The array32 regression intercepts an advertised 131072-slot allocation so the baseline cannot exceed its test memory budget. Nineteen early memory/decoder cases produced 18 failures and one pass on the frozen baseline, then all passed in the compiled batch; see [`memory-regressions-before.tap`](raw/memory-regressions-before.tap) and [`memory-codec-regressions-batch2.tap`](raw/memory-codec-regressions-batch2.tap). The latter includes 70 existing relevant cases for 89/89 passes and predates the final UTF-8/KV/observability additions.

The first candidate passed 476 tests before the separate three-byte ownership check exposed the missing binary case. The new four ownership tests fail by mutation assertions on both the baseline and that candidate, with setup/type controls retained in [`binary-ownership-before.tap`](raw/binary-ownership-before.tap) and [`binary-ownership-first-freeze.tap`](raw/binary-ownership-first-freeze.tap). The invalid initial fixture attempt is preserved separately and is not used as correctness evidence.

The revised frozen source digest is `e451d7c9d3524779584211fe0571acff4e68cecbf1e32e6f8bb10f8face8fd08` / ESM digest `21ed478360f76848bfb2b79594169f80bda2b24fe0bf4f9caacbb9aa66608b95`. The final isolated Docker suite passes 480/480 with zero skips in [`after-docker-test.log`](raw/after-docker-test.log), and independent focused verification passes 93/93 in [`independent-verification-tests.log`](raw/independent-verification-tests.log). Its resource-safe controls, including array32, legitimate null and binary mutation, are recorded separately in [`independent-verification-after.json`](raw/independent-verification-after.json). Node 20/22 each pass a separate 480-test Docker and type/build/package run in [`node20-docker-runtime.log`](raw/node20-docker-runtime.log) / [`node22-docker-runtime.log`](raw/node22-docker-runtime.log), with the Node 20 transitive @nats-io/nuid engine>=22 qualification retained. Timing, live Redis and final readiness evidence remain separate in reports 08/10/12.
