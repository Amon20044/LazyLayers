# Isolated fault-test results

Final canonical pair: baseline **8 PASS / 7 FAIL**, final **15 PASS / 0 FAIL**, all 15 executed per revision, no infrastructure errors. [Before](raw/chaos-before.json), [after](raw/chaos-after.json), [before service receipt](raw/before-docker-chaos.log.meta.json), [after service receipt](raw/after-docker-chaos.log.meta.json). Original full correctness tests already passed; these separate fault regressions demonstrate additional defects and controls.

## Ownership and budgets

Only freshly minted UUID Docker projects were fault targets. The harness checks exact Redis container ID, project/service/disposable labels, memory cap and loopback mapping before every stop/start/pause/unpause. A bounded owned TCP proxy follows a changed port only after re-inspecting that exact container. Redis is 96 MiB / 1 CPU with 64 MiB noeviction server limit, persistence disabled. RabbitMQ/NATS are capped separately; these chaos faults target Redis and owned child workers.

Apple M5 / 10 logical CPUs / Darwin 25.5 / Node 24.21 / Docker 29.6.2; at most 200 simulated requests, 64 proxy sockets, 384 MiB harness RSS threshold, 64 MiB worker old-space, 250 ms Redis command deadline, 6–12-second case deadlines, 90-second harness / 120-second operation deadline and outer process/resource monitoring. SIGSTOP/SIGKILL apply only to owned test workers. Automatic cleanup heals the owned Redis, resumes/kills owned workers and removes the project/volumes. Both canonical projects were disposed cleanly.

## Outcomes

| Scenario | Before | After | Observed behavior |
| --- | --- | --- | --- |
| real-lease-expiry-stale-publication | PASS | PASS | Old owner rejected on both; newer protected value remains. |
| frozen-process-past-lease-expiry | PASS | PASS | Actual SIGSTOP beyond TTL; replacement wins; resumed old caller can receive its result but cannot replace protected L2. |
| leader-process-killed-mid-refresh | PASS | PASS | Actual SIGKILL; a replacement loads after lease expiry on both. |
| lease-only-pattern-invalidation | FAIL | PASS | Baseline old publication succeeds; final publication is not-owner and absent. |
| redis-stopped-during-acquisition-safe-fallback | FAIL | PASS | Baseline unleased obsolete value overwrites winner; final keeps winner and suppresses peer publication. |
| redis-paused-during-publication-unknown-outcome | PASS | PASS | One dispatched publication, no blind replay or L1/peer priming on an unknown outcome, both revisions. |
| redis-restart-rejects-previous-lease | PASS | PASS | Pre-restart owner rejected on both; no RDB/AOF persistence. Restart is not failover. |
| redis-nested-and-literal-prefix-isolation | FAIL | PASS | Baseline plain parent clear deletes nested tenant; literal-glob own data remains. Final preserves nested/foreign values and removes own data. |
| redis-malformed-unicode-key-identity | FAIL | PASS | Baseline lone surrogate keys alias; final distinct identities and valid Unicode control pass. |
| shared-pubsub-channel-tenant-isolation | FAIL | PASS | Baseline returns tenant-a-value in tenant B; final scoped receiver returns absent. |
| pubsub-disconnect-missed-event-reconciliation | PASS | PASS | Current L2 remains readable during gap; reconnect restores trust explicitly, both revisions. |
| bounded-origin-overload-and-recovery | PASS | PASS | 32 requests, 2 active/4 queued: 6 loads, 26 controlled rejections; healthy probe and empty queues, both. |
| shutdown-suppresses-late-fill | FAIL | PASS | Cooperative signal false → true; protected L2 is ABSENT on both. This case does not prove newly fixed late L2 publication. |
| corrupt-record-and-pretransfer-size-limits | FAIL | PASS | NULL_HIT → MISS; 8199-byte body read transfers 8222 → 29 response bytes; bounded previews omit values. |
| distributed-coalescing-simulated-instance-matrix | PASS | PASS | 2/10/50/100 logical caches, 4/20/100/200 requests; one loader each on both, in one process/shared Redis connection. |

The expired/frozen-worker tests independently prove protected cache publication safety and ownership expiry. Random lease owner tokens are not monotonic fencing for external DB side effects. Preserved caller results after ownership loss are distinct from cache publication. The unleased-fallback regression keeps the authoritative-L2 winner assertion before any cache read-recovery poll.

## Recovery measurements

Single observations, not repeated latency distributions or demonstrated speed improvements. Durations begin at planned kill/release/restart and end at a verified PING or cache response; scenario details in JSON identify the endpoint.

| Scenario | Before ms | After ms |
| --- | --- | --- |
| leader-process-killed-mid-refresh | 186.817 | 187.451 |
| redis-stopped-during-acquisition-safe-fallback | 218.231 | 225.936 |
| redis-restart-rejects-previous-lease | 217.768 | 196.536 |
| pubsub-disconnect-missed-event-reconciliation | 63.842 | 64.334 |
| bounded-origin-overload-and-recovery | 0.443 | 0.434 |

The stopped-acquisition case explicitly configures **100 ms L2 breaker cooldown** on both revisions; final additional cache-read recovery is 0.515 ms after resolving the old caller. It is separate from Docker restart-to-PING and is not the default 30-second cooldown's recovery time. Gap recovery asserts restored trust after a bounded 1.5-second poll; permanently bypassing L1 cannot pass that control.

## Harness corrections and unmeasured faults

Earlier runs are preserved and excluded: the first infrastructure attempt stopped on an ephemeral Docker port guard; the full unconnected-bus attempt failed lazy subscriber initialization on both revisions and used an invalid immediate read expectation during breaker cooldown. Later initialization uses public bus.connect before cache construction, identical configurations, explicit readiness and trust assertions. A pre-trust-assertion baseline run is also retained. Independent read-only review checked the final fixture's equivalence and meaningful recovery assertions.

Redis replication failover/Cluster resharding, packet loss, DNS failures, CPU throttling, an external DB pool, physical 10/50/100-worker crashes/scaling, long fault endurance, and external destination fencing are **NOT MEASURED**. The mock origin tests controlled asynchronous reads, not a production database. Ordinary Pub/Sub remains non-durable; detected-gap reconciliation does not recover every undelivered publisher event. [Distributed details](05-distributed-correctness.md), [security](07-security-audit.md), [remaining gates](12-production-readiness.md).
