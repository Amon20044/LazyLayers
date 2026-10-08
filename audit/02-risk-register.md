# Risk register

Priorities: P0 = isolation/data corruption/stale publication/unbounded overload; P1 = resource retention or hot-path cost; P2 = measured policy/codec trade-offs; P3 = optional architectural research. The original library passed its existing tests while the new baseline regressions exposed these failures. Final executed evidence and gate status are in `05-distributed-correctness.md`, `07-security-audit.md`, and `12-production-readiness.md`; a passing benchmark does not override a failed gate.

| Risk | Priority | Baseline trigger | Implemented response / verification artifact |
| --- | --- | --- | --- |
| Cross-prefix peer priming | P0 | Same bus with different L2 prefixes blindly accepts peer value | Explicit event scope plus authoritative own-L2 snapshot; isolation regressions |
| Destructive glob-prefix crossover | P0 | Literal Redis namespace contains glob metacharacters or nested prefix | Escape scan patterns and validate canonical complete v2 namespace/key shape |
| Lease-only pattern invalidation | P0 | Miss leader owns lease, no resident data exists during scan | Enumerate/fence matching live leases, independently test stale publication |
| Delayed former leader corrupts peer L1 | P0 | Equal-generation set hint arrives after newer protected Redis publication | Hint reads current authoritative value, guarded local commit and elapsed TTL |
| Initial coordination outage stale overwrite | P0 | Unlocked failure path resumes after another owner publishes | Read-only fail-open result, protected cache/event publication suppressed |
| Indexed inspection crosses tenant scope | P0 | Untrusted index contains a foreign namespace member | Strict namespace validation before inspection; regression |
| Corrupt cache record becomes valid null | P0 | Unsupported/malformed HC1 or LLK returns null | Strict hit/miss result internally, valid null preserved |
| Returned binary aliases retained cache bytes | P0 | Direct MemoryStore.get/inspect MessagePack binary fields are mutable subarrays | Strict readers copy binary output; baseline/frozen candidate mutation reproductions and regressions |
| Decompression/structural allocation exhaustion | P0 | Tiny compressed/header payload creates huge decoded output/array/depth | Per-codec preallocation/output bounds, MessagePack/JSON/UTF-8 preflight |
| Late local fill or promotion after invalidation/close | P0 | Async read/write completes after same-key mutation or lifecycle transition | Refcounted bounded per-key revisions and broad lifecycle epoch |
| Unbounded negative/revision/key/event metadata | P0/P1 | Infinite unique keys, huge keys, NaN/Infinity configuration | Finite counts/bytes/shared reservations; tombstone saturation disables unsafe version caching |
| Same-key follower retention | P0/P1 | Many callers retain reactions on one stalled leader | Finite follower budget and typed overload; authorized large simulation overrides cap explicitly |
| Retained L2 keys not charged | P1 | Delayed GET/HAS/lease closures with long keys report zero queued bytes | Key/pattern metadata and shared-budget reservation through actual settlement |
| Retry active byte cap bypass | P1 | Stalled active flush plus newly admitted event exceeds maxBytes | Count active bytes, reject if no evictable waiting work, retain active accounting after clear |
| Delivery queue bypass/resurrection | P1 | Unencodable raw object treated as zero bytes, closed queue accepts new work | Owned encoded snapshots, encode rejection, terminal queue lifecycle |
| NATS Core client iterator backlog | P1 | Broker outpaces async handler | Callback reception into finite owned wire queue; JetStream pull byte bound |
| Rabbit consumer/channel gap invisible | P0/P1 | Cancellation/channel-only loss or invalid message leaves trusted L1 | Status observers, bounded handlers/prefetch, conservative gap recovery |
| L1 membership O(N) | P1 | Every has() purges all expired entries | Query-only expiry/release, source complexity proof and scaled benchmark |
| Inflight lookup O(C) | P1 | Full map expiry sweep twice per follower registration | Lazy queried-key expiry plus bounded maintenance |
| LRU preallocation/close retention | P1 | Every configured store eagerly allocates capacity arrays; held closed store retains them | Dynamic LRU count sizing, close drops cache reference; forced GC and heap snapshot proof |
| Catastrophic wildcard backtracking | P1 | Repeated stars/literals produce exponential regular-expression search | Literal KMP segment matching preserving original newline behavior; seeded equivalence and subprocess timeout |
| Unrelated fills invalidate one another | P1 | Global mutation epoch on each independent write | Per-key mutation revisions; concurrent distinct-fill regression |
| Admission policy workload regressions | P2 | Default sketch/byte admission protects stale popularity or small objects | Preserve default; measured workload-specific disabled-admission guidance, no speculative TinyLFU rewrite |
| Strict decoder/ownership safety CPU overhead | P2 | Added validation/reservations on every encoded read | Measure before/after; retain correctness even when warm-cache costs rise |

## Remaining limitations that must stay visible

| Risk | Scope / next action |
| --- | --- |
| Redis asynchronous failover and real Cluster | Single Redis Docker instance does not prove linearizable leases after failover or Cluster topology/ACL behavior. Run provisioned topology tests before claiming that contract. |
| Legacy/custom L2 publication | Check-then-write cannot give v2 atomic publication guarantees. Upgrade adapter capability or explicitly scope the deployment contract. |
| Custom asynchronous L1 | A generic adapter lacks atomic conditional commit. Conservative deletion prevents exposing an old value but may discard a newer value; strong retention requires adapter support. |
| Pub/Sub publisher loss | Subscriber recovery detects observable gaps; it cannot recover an invalidation that was never delivered to any subscriber. Authoritative source version/outbox/reconciliation required for strict coherence. |
| Memory accounting versus RSS | Ledger estimates and per-component caps do not bound V8/native/client/caller/transient memory exactly. Long-duration working sets and platform cgroups remain release gates. |
| Worker facade | Its L1/origin/follower/version-map budgets are weaker than the Node coordinator. Do not advertise Node readiness guarantees for this facade. |
| Cross-process/tenant origin fairness | Per-cache bounds do not create a database-wide or per-tenant allocation. Application pool limits/fair admission remain required. |
| Cooperative cancellation | Ignoring-abort origin/client work can remain active; finite admission prevents unlimited owned starts, but the library cannot forcibly stop arbitrary JavaScript or a database side effect. |
| Pattern invalidation atomicity | A paginated scan is not an atomic snapshot against brand-new concurrent keys/leases. Source versions/epochs are needed for a stronger namespace transaction. |
| Load duration/hardware | Laptop one-second phases and bounded simulations do not establish sustained production throughput, fragmentation, capacity or failover recovery guarantees. |
| Node 20 dependency support | Functional live tests pass, but a production NATS transitive dependency declares Node >=22; validate/pin a supported dependency matrix before claiming every integration supports Node 20. |
| Telemetry and deployment security | Raw events/dashboard may reveal keys/errors. Redis TLS/ACL, authentication and authorization freshness are not inferred by the library. |

No outstanding limitation is labelled resolved merely because its targeted tests or throughput are good. The prioritized backlog is in `11-future-architecture.md`.
