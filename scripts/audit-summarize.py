#!/usr/bin/env python3
"""Regenerate final audit tables from canonical raw results; standard library only."""
import json
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "audit/raw"
def read(name):
    return json.loads((RAW / name).read_text())
def median(values):
    return statistics.median(values)
def change(before, after):
    return "0" if before == after else "N/A" if before == 0 else f"{(after / before - 1) * 100:+.2f}%"
def table(headers, rows):
    return "\n".join(["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"] + ["| " + " | ".join(map(str, row)) + " |" for row in rows])
def write(name, content):
    (ROOT / "audit" / name).write_text(content.rstrip() + "\n")

micro = read("performance-comparison.json")
assert micro["before"] == "audit/raw/benchmark-before.json"
before_micro = read("benchmark-before.json")
after_micro = read("benchmark-after.json")
e2e = {v: read(f"e2e-{v}.json") for v in ["before", "after"]}
high = {v: read(f"e2e-{v}-high.json") for v in ["before", "after"]}
memory = {v: read(f"memory-{v}.json") for v in ["before", "after"]}
chaos = {v: read(f"chaos-{v}.json") for v in ["before", "after"]}
queues = {v: read(f"queues-{v}.json") for v in ["before", "after"]}
ci = read("ci-performance-comparison.json")
for v in e2e:
    assert len(e2e[v]["rows"]) == 33 and len(high[v]["rows"]) == 3
    assert memory[v]["completedCases"] == 28
    assert len(chaos[v]["rows"]) == 15 and chaos[v]["infrastructureError"] is None
assert chaos["after"]["failed"] == 0

def group(version, name):
    source = high if name == "warm-10000" else e2e
    return [row for row in source[version]["rows"] if row["name"] == name]
def metric(version, name, function):
    return median(function(row) for row in group(version, name))
def pair(name, function):
    return [metric(v, name, function) for v in ["before", "after"]]

micro_rows = []
for row in micro["rows"]:
    source = next(r for r in before_micro["rows"] if r["name"] == row["name"] and r["n"] == row["n"])
    micro_rows.append([f'{row["name"]}/{row["n"]}', source["runs"][0]["operations"], f'{row["baselineMs"]:.3f}', f'{row["afterMs"]:.3f}', f'{row["changePercent"]:+.2f}%', "REGRESSION" if row["regression"] else "not flagged"])

names = list(dict.fromkeys(row["name"] for row in e2e["before"]["rows"])) + ["warm-10000"]
e2e_rows = []
for name in names:
    values = []
    for v in ["before", "after"]:
        values.append(f'{metric(v,name,lambda r:r["result"]["successfulRps"]):.2f} / {metric(v,name,lambda r:r["result"]["arrivalToCompletionMs"]["p99"]):.3f}')
    origins = pair(name, lambda r:r["origin"]["requests"])
    errors = pair(name, lambda r:r["result"]["errors"])
    e2e_rows.append([name, *values, f"{origins[0]:g} → {origins[1]:g}", f"{errors[0]:g} → {errors[1]:g}"])

queue_rows = []
for b,a in zip(queues["before"]["rows"],queues["after"]["rows"]):
    values = []
    for field in ["enqueueMs", "drainMs", "retryFlushMs", "cpuMs", "peakRssBytes"]:
        divisor = 1048576 if field == "peakRssBytes" else 1
        x,y = [median(r[field] for r in row["runs"]) / divisor for row in [b,a]]
        values.append(f"{x:.3f} → {y:.3f}")
    queue_rows.append([b["n"], *values])

policy = read("policies-after.json")
policy_before = read("policies-before.json")
for b,a in zip(policy_before["rows"],policy["rows"]):
    assert (b["repeat"],b["workload"],b["admission"]) == (a["repeat"],a["workload"],a["admission"])
    assert all(b["result"][k] == a["result"][k] for k in ["hits", "originLoads", "objectHitRatio", "byteHitRatio"])
policy_rows = []
for name in dict.fromkeys(r["workload"] for r in policy["rows"]):
    cells=[]
    for enabled in [False,True]:
        rows=[r["result"] for r in policy["rows"] if r["workload"]==name and r["admission"]==enabled]
        cells.append(f'{median(r["objectHitRatio"] for r in rows)*100:.3f}% / {median(r["byteHitRatio"] for r in rows)*100:.3f}%')
    policy_rows.append([name,*cells])

write("08-benchmark-results.md", f'''# Executed benchmark results

The tested build improves expiry checks, follower registration, empty-cache retention and large event enqueue cost. It also increases warm-read and large accepted-herd costs. These are retained correctness/resource trade-offs, not a universal speedup. The final source SHA is `e451d7c9d3524779584211fe0571acff4e68cecbf1e32e6f8bb10f8face8fd08`; ESM SHA is `21ed478360f76848bfb2b79594169f80bda2b24fe0bf4f9caacbb9aa66608b95`. Baseline is commit `ca9c02a04349a89278cd81b5b25d0000503cc5a3` with the same dependency lock.

## Hardware, isolation and measurement

Executed on Apple M5, 10 logical CPUs, 16 GiB host memory, Darwin 25.5.0, Node 24.21.0. Docker Desktop 29.6.2 provides the isolated services; its VM has approximately 8.32 GB memory. Each UUID project caps Redis/RabbitMQ/NATS at 96/512/128 MiB and 1/1/0.5 CPUs. Only new loopback resources and synthetic data were used. Docker projects and owned processes were cleaned up.

Offline comparisons use fresh children and five repetitions per micro/queue case, two per memory case, three per trace/codec case. CPU experiments ran sequentially. There are 65 micro runs, 15 queue runs, 28 memory cases, 60 policy cases and 144 codec cases per revision. Full raw results, process budgets and module paths are in [raw](raw/). Old-space flags do not bound all V8/native/external memory; RSS sampling and hard container limits are separate controls.

Real E2E uses two independent cache processes, one controlled HTTP origin and a fresh independent load-generator process per phase. Payloads are 1 KiB; warm traces use seeded skew over 64 keys. L1 has 4096 entries and a 64 MiB accounting budget; admission is disabled for this control. Per worker: 8 active/32 queued origin loads, 150 ms queue deadline, 750 ms hard deadline. Leases use 1200 ms TTL, 1600 ms wait and 10 ms polling. Overload controls explicitly use 4/16 or 16/64 active/queued origin limits and a 50 ms origin delay.

The default E2E pair has 33 one-second phases per revision; the high-rate pair has three 10,000-RPS warm phases. These are short offered-rate samples, **not maximum or sustained capacity**. The generator has 64 sockets per worker: a 1000-call burst queues at the client and is not 1000 simultaneous server followers. Client outstanding requests, dispatch lag, dropped arrivals, status/error/timeout counts and p50/p95/p99/p99.9 are retained in JSON.

Latency includes planned-arrival dispatch delay. Unsent arrivals are explicit errors and excluded from quantiles, so quantiles alone must not hide saturation. HTTP-bypass calibration reached 10,000 offered RPS with no dropped requests. A 50,000-RPS calibration either lacked headroom or dropped requests; cache load at 50,000 and 100,000+ RPS is **NOT MEASURED**. Wrong-key/version checks apply to the controlled payloads; load phases do not establish arbitrary concurrent-update freshness.

## Paired microbenchmarks

Elapsed milliseconds per stated batch; all five repetitions are in [before](raw/benchmark-before.json), [after](raw/benchmark-after.json) and [comparison](raw/performance-comparison.json). Bootstrap uses 10,000 median resamples, a 95% family interval and tolerance max(10%, three baseline relative MADs). Shared-machine, short-run inference remains limited.

{table(["Case / resident or concurrent count", "Operations", "Before ms", "After ms", "Change", "Statistical gate"],micro_rows)}

`has` uses 64-byte values at N=32/1024/8192. Lookup uses 1 KiB values over 64 keys, 20,000 reads. Promotion uses 2048 independent 1 KiB keys with an in-process MemoryStore L2: no Redis/network throughput claim. In-flight tests time registration of 4000 followers while 32/1024 loaders are blocked, not complete request latency. Herd tests simulate 10 through 100,000 Promise callers; both explicitly provision `maxWaiters=100000` and require exactly one loader. Default follower caps are tested separately. Herd elapsed includes forced GC and completion; it is not an HTTP capacity figure.

## Real E2E

Cells are median successful completed RPS / median per-phase p99 milliseconds, across three phases. Burst rows use burst-completion rate, not a one-second offered RPS. Source: [default before](raw/e2e-before.json), [default after](raw/e2e-after.json), [high before](raw/e2e-before-high.json), [high after](raw/e2e-after-high.json).

{table(["Scenario", "Before RPS / p99 ms", "After RPS / p99 ms", "Origin requests before → after", "Errors before → after"],e2e_rows)}

Warm phases and lease-enabled bursts have zero client drops, wrong-key/version responses and errors. Cold single-key leases avoid cross-process origin duplication: one origin request with leases, two without, on both revisions. Disabling singleflight creates more origin operations/errors even with execution caps. Distinct-key saturation preserves bounded work and controlled rejection; increasing limits improves successful requests but raises tail latency and origin load. These controls do not establish per-tenant fairness or a cluster-global budget.

Stale-if-error hides origin errors from callers but still attempts almost one origin call per request. It is not evidence that an origin circuit breaker or negative/error cache prevents that traffic. Optional refresh shedding, tenant fairness and wider recovery scheduling remain backlog work. Strict-origin-error deliberately returns controlled 503 responses and is not counted as a successful-throughput scenario.

10,000-RPS warm p99 ranges overlap: before 3.793–9.333 ms, after 3.210–9.678 ms. The median difference is descriptive, not statistically proven. Worker CPU/RSS exclude Redis, origin and generator; client `sendCommand` counts include Lua requests but not every command executed inside Lua. Full Redis network traffic, exact bytes allocated/operation, continuously measured waiter peaks, physical 50/100-instance imbalance and production DB capacity are **NOT MEASURED**.

## Queue and policy controls

Queue cells show before → after medians over five fresh processes. RSS is per-child OS high-water in MiB. Enqueue wins do not conceal slower drain/flush or increased small-queue CPU/RSS.

{table(["Events", "Enqueue ms", "Drain ms", "Retry flush ms", "CPU ms", "RSS MiB"],queue_rows)}

Actual admission enabled vs disabled, 16,000 requests per trace, 128 entry / 256 KiB budget, three repeats. Cells are object hit ratio / byte hit ratio. Before/after hits and origin counts are identical for every paired case: no eviction policy was silently replaced.

{table(["Trace", "Admission disabled", "Existing admission enabled"],policy_rows)}

These controls are not implementations of CLOCK, FIFO, LFU, TinyLFU or W-TinyLFU. Advanced policies/routing remain research candidates rather than measured improvements. The [memory/codec report](04-memory-profile.md) contains all payload sizes, available JSON/MessagePack/gzip/Zstd/LZ4/Snappy controls, storage fractions and strict/public decode timing. No Brotli dependency was added.

## CI and reproducibility

The real seven-repeat PR-style gate completed and rejected four regressions: lookup, stale lookup and 1000/10000-caller herds. [CI receipt](raw/performance-ci.log.meta.json), [CI comparison](raw/ci-performance-comparison.json). This is an intentional visible review gate, not a pass or an automatic approval rejection. No release was made.

Use [reproduction instructions](README.md), `scripts/audit-ci.mjs`, `scripts/audit-summarize.py` and the bounded runners. The [workflow](../.github/workflows/performance.yml) stores PR/release-candidate history for 90 days and separates quick correctness/memory/performance checks from scheduled live-service/chaos/endurance runs. Critical correctness failures block release. Performance gates require repeated statistical evidence; retaining a justified safety cost still requires explicit baseline/release review.
''')

observations = {
"real-lease-expiry-stale-publication":"Old owner rejected on both; newer protected value remains.",
"frozen-process-past-lease-expiry":"Actual SIGSTOP beyond TTL; replacement wins; resumed old caller can receive its result but cannot replace protected L2.",
"leader-process-killed-mid-refresh":"Actual SIGKILL; a replacement loads after lease expiry on both.",
"lease-only-pattern-invalidation":"Baseline old publication succeeds; final publication is not-owner and absent.",
"redis-stopped-during-acquisition-safe-fallback":"Baseline unleased obsolete value overwrites winner; final keeps winner and suppresses peer publication.",
"redis-paused-during-publication-unknown-outcome":"One dispatched publication, no blind replay or L1/peer priming on an unknown outcome, both revisions.",
"redis-restart-rejects-previous-lease":"Pre-restart owner rejected on both; no RDB/AOF persistence. Restart is not failover.",
"redis-nested-and-literal-prefix-isolation":"Baseline plain parent clear deletes nested tenant; literal-glob own data remains. Final preserves nested/foreign values and removes own data.",
"redis-malformed-unicode-key-identity":"Baseline lone surrogate keys alias; final distinct identities and valid Unicode control pass.",
"shared-pubsub-channel-tenant-isolation":"Baseline returns tenant-a-value in tenant B; final scoped receiver returns absent.",
"pubsub-disconnect-missed-event-reconciliation":"Current L2 remains readable during gap; reconnect restores trust explicitly, both revisions.",
"bounded-origin-overload-and-recovery":"32 requests, 2 active/4 queued: 6 loads, 26 controlled rejections; healthy probe and empty queues, both.",
"shutdown-suppresses-late-fill":"Cooperative signal false → true; protected L2 is ABSENT on both. This case does not prove newly fixed late L2 publication.",
"corrupt-record-and-pretransfer-size-limits":"NULL_HIT → MISS; 8199-byte body read transfers 8222 → 29 response bytes; bounded previews omit values.",
"distributed-coalescing-simulated-instance-matrix":"2/10/50/100 logical caches, 4/20/100/200 requests; one loader each on both, in one process/shared Redis connection.",
}
chaos_rows=[]
recovery=[]
for b,a in zip(chaos["before"]["rows"],chaos["after"]["rows"]):
    assert b["name"] == a["name"]
    chaos_rows.append([b["name"],b["status"],a["status"],observations[b["name"]]])
    if "faultRecoveryMs" in b or "faultRecoveryMs" in a:
        recovery.append([b["name"],f'{b["faultRecoveryMs"]:.3f}' if "faultRecoveryMs" in b else "NOT MEASURED",f'{a["faultRecoveryMs"]:.3f}' if "faultRecoveryMs" in a else "NOT MEASURED"])
write("09-chaos-test-results.md",f'''# Isolated fault-test results

Final canonical pair: baseline **8 PASS / 7 FAIL**, final **15 PASS / 0 FAIL**, all 15 executed per revision, no infrastructure errors. [Before](raw/chaos-before.json), [after](raw/chaos-after.json), [before service receipt](raw/before-docker-chaos.log.meta.json), [after service receipt](raw/after-docker-chaos.log.meta.json). Original full correctness tests already passed; these separate fault regressions demonstrate additional defects and controls.

## Ownership and budgets

Only freshly minted UUID Docker projects were fault targets. The harness checks exact Redis container ID, project/service/disposable labels, memory cap and loopback mapping before every stop/start/pause/unpause. A bounded owned TCP proxy follows a changed port only after re-inspecting that exact container. Redis is 96 MiB / 1 CPU with 64 MiB noeviction server limit, persistence disabled. RabbitMQ/NATS are capped separately; these chaos faults target Redis and owned child workers.

Apple M5 / 10 logical CPUs / Darwin 25.5 / Node 24.21 / Docker 29.6.2; at most 200 simulated requests, 64 proxy sockets, 384 MiB harness RSS threshold, 64 MiB worker old-space, 250 ms Redis command deadline, 6–12-second case deadlines, 90-second harness / 120-second operation deadline and outer process/resource monitoring. SIGSTOP/SIGKILL apply only to owned test workers. Automatic cleanup heals the owned Redis, resumes/kills owned workers and removes the project/volumes. Both canonical projects were disposed cleanly.

## Outcomes

{table(["Scenario", "Before", "After", "Observed behavior"],chaos_rows)}

The expired/frozen-worker tests independently prove protected cache publication safety and ownership expiry. Random lease owner tokens are not monotonic fencing for external DB side effects. Preserved caller results after ownership loss are distinct from cache publication. The unleased-fallback regression keeps the authoritative-L2 winner assertion before any cache read-recovery poll.

## Recovery measurements

Single observations, not repeated latency distributions or demonstrated speed improvements. Durations begin at planned kill/release/restart and end at a verified PING or cache response; scenario details in JSON identify the endpoint.

{table(["Scenario", "Before ms", "After ms"],recovery)}

The stopped-acquisition case explicitly configures **100 ms L2 breaker cooldown** on both revisions; final additional cache-read recovery is {chaos["after"]["rows"][4]["cacheReadRecoveryMs"]:.3f} ms after resolving the old caller. It is separate from Docker restart-to-PING and is not the default 30-second cooldown's recovery time. Gap recovery asserts restored trust after a bounded 1.5-second poll; permanently bypassing L1 cannot pass that control.

## Harness corrections and unmeasured faults

Earlier runs are preserved and excluded: the first infrastructure attempt stopped on an ephemeral Docker port guard; the full unconnected-bus attempt failed lazy subscriber initialization on both revisions and used an invalid immediate read expectation during breaker cooldown. Later initialization uses public bus.connect before cache construction, identical configurations, explicit readiness and trust assertions. A pre-trust-assertion baseline run is also retained. Independent read-only review checked the final fixture's equivalence and meaningful recovery assertions.

Redis replication failover/Cluster resharding, packet loss, DNS failures, CPU throttling, an external DB pool, physical 10/50/100-worker crashes/scaling, long fault endurance, and external destination fencing are **NOT MEASURED**. The mock origin tests controlled asynchronous reads, not a production database. Ordinary Pub/Sub remains non-durable; detected-gap reconciliation does not recover every undelivered publisher event. [Distributed details](05-distributed-correctness.md), [security](07-security-audit.md), [remaining gates](12-production-readiness.md).
''')

lookup=next(r for r in micro["rows"] if r["name"]=="lookup")
entry=[]; empty=[]; held=[]
for v in ["before","after"]:
    rows=[r for r in memory[v]["results"] if r.get("size")==1024 and r.get("entropy")=="incompressible"]
    entry.append(median(r["approximateEntryDeltas"]["heapPlusExternalBytes"] for r in rows))
    rows=[r for r in memory[v]["results"] if r["scenario"]=="skeleton"]
    empty.append(median(r["memory"]["liveDelta"]["heapUsed"]+r["memory"]["liveDelta"]["external"] for r in rows))
    held.append(median(r["memory"]["heldClosedDelta"]["heapUsed"]+r["memory"]["heldClosedDelta"]["external"] for r in rows))
peak=[max(r["aggregateWorkerPeakSampledRssBytes"] for r in e2e[v]["rows"])/1048576 for v in ["before","after"]]
cpu=pair("warm-10000",lambda r:r["cpuMsPerMillion"])
p99=pair("warm-10000",lambda r:r["result"]["arrivalToCompletionMs"]["p99"])
rps=pair("warm-10000",lambda r:r["result"]["successfulRps"])
redis=pair("cold-one-key-lease",lambda r:r["redisOpsPerSentRequest"])
origin=pair("cold-one-key-lease",lambda r:r["originAmplification"])
hit=pair("warm-10000",lambda r:r["cacheHitEventsPerSentRequest"]*100)
restart=[next(r for r in chaos[v]["rows"] if r["name"]=="redis-restart-rejects-previous-lease")["faultRecoveryMs"] for v in ["before","after"]]
comparison_rows=[
["L1 lookup latency (batch mean, 1 KiB/64 keys)",f'{lookup["baselineMs"]/20:.3f} µs',f'{lookup["afterMs"]/20:.3f} µs',f'{lookup["changePercent"]:+.2f}%'],
["Memory per entry (approx incremental 1 KiB binary cohort)",f'{entry[0]:.1f} B',f'{entry[1]:.1f} B',change(*entry)],
["Peak RSS (max sum of worker phase peaks, 33-phase E2E)",f'{peak[0]:.3f} MiB',f'{peak[1]:.3f} MiB',change(*peak)],
["Worker CPU per 1M requests (10k-RPS warm)",f'{cpu[0]:.1f} ms',f'{cpu[1]:.1f} ms',change(*cpu)],
["p99 arrival latency (10k-RPS warm)",f'{p99[0]:.3f} ms',f'{p99[1]:.3f} ms',change(*p99)],
["Successful throughput (10k offered RPS warm)",f'{rps[0]:.2f} RPS',f'{rps[1]:.2f} RPS',change(*rps)],
["Redis client ops/request (cold single-key lease burst)",f'{redis[0]:.3f}',f'{redis[1]:.3f}',change(*redis)],
["Origin amplification (one cold-key episode)",f'{origin[0]:g}',f'{origin[1]:g}',change(*origin)],
["Cache hit event ratio (10k-RPS warm)",f'{hit[0]:.1f}%',f'{hit[1]:.1f}%',f'{hit[1]-hit[0]:+.1f} percentage points'],
["Fault recovery (Redis restart-to-PING, single observation)",f'{restart[0]:.3f} ms',f'{restart[1]:.3f} ms',change(*restart)],
["20 empty caches, heap plus external delta",f'{empty[0]:,.0f} B',f'{empty[1]:,.0f} B',change(*empty)],
["20 closed caches held by caller, heap plus external delta",f'{held[0]:,.0f} B',f'{held[1]:,.0f} B',change(*held)],
]
write("10-before-after-comparison.md",f'''# Before/after comparison and decisions

Baseline `ca9c02a04349a89278cd81b5b25d0000503cc5a3` versus the frozen final source `e451d7c9d3524779584211fe0571acff4e68cecbf1e32e6f8bb10f8face8fd08`, same lockfile. Node 24.21.0 / Apple M5 / 10 logical CPUs / 16 GiB / Darwin 25.5 / Docker 29.6.2. All values below derive from canonical JSON using [audit-summarize.py](../scripts/audit-summarize.py); [result summary](raw/result-summary.json). More workloads and distributions are in [benchmark results](08-benchmark-results.md).

## Required comparison

{table(["Metric", "Before", "After", "Change"],comparison_rows)}

These rows intentionally show costs as well as gains. Micro L1 latency is median batch elapsed/20,000 operations, not an HTTP p99. Memory is a forced-GC cohort delta of heap plus external memory, excluding empty-store allocation; exact retained memory/entry is **NOT MEASURED**. Two samples cannot prove the small per-entry change. The large empty-store/held-close gain has separate structural snapshot evidence and repeated checkpoints.

E2E uses two independent cache processes, a controlled HTTP origin and a separate generator; 1 KiB values, seeded 64-key skew, three one-second 10k-RPS phases, 64 client sockets per worker and bounded queues/deadlines. Throughput is demand-limited, not maximum capacity. p99 ranges overlap; CPU/p99/recovery changes are descriptive, not confidence claims. Peak RSS is the maximum **sum of individual worker sampled phase peaks** across 33 phases; the peaks need not occur simultaneously and exclude Redis/origin/generator. Redis counts are client commands/Lua requests, not Lua-internal operations or total network bytes. Cold lease bursts have 1000 offered calls, one ideal origin miss episode and at most 128 active HTTP sockets. Fault recovery is one disposable no-persistence Redis restart, not replica failover or a statistically established speedup.

Exact allocations/operation, native fragmentation, total Redis traffic, hours-long retained-heap stability, 50k/100k cache capacity and external DB fencing remain **NOT MEASURED**.

## Incremental decisions

| Hypothesis / change | Evidence | Decision |
| --- | --- | --- |
| Full expiry sweeps and in-flight pruning add N/C-dependent work to requests. Use per-key expiry/coalescing and bounded maintenance. | `has` at8192 entries −99.83%; 1024-active-key follower registration −97.52%; promotions −65.02%, five repeats. | Keep; expected Map costs still include hashing/key cost and bounded maintenance. |
| Preallocated LRU arrays retain substantial memory even when empty/closed. Use dynamically growing count-bounded LRU and drop owned cache reference on close. | Empty heap+external −97.56%; held-close −99.81%; owned-array snapshot backing4,406,400→0 B. Earlier isolated LRU profile is preserved. | Keep; JS backing capacity during a long-lived high-water workload is not an exact RSS guarantee. |
| Recomputing queue bytes on enqueue causes quadratic storm cost. Use owned FIFO records and incremental counters. |8192-event enqueue −98.64%, aggregate CPU208.960→86.838 ms; drain/flush and small-queue/RSS costs increase. | Keep bounded accounting and enqueue improvement; slower paths remain visible. |
| Unleased fallback, namespace collisions and corrupt record interpretation can violate correctness/isolation. | Real chaos8pass/7fail→15pass/0fail; tenant value leakage and unleased overwrite reproduced; focused regressions green. | Keep correctness fixes; random owners do not provide external monotonic fencing. |
| Strict preflight/owned buffers and finite follower reservations add warm/accepted-follower cost. | Warm lookup+30.46%, stale lookup+21.12%; large herd regressions; seven-repeat CI rejects four cases. | Keep security/resource controls; performance release review remains red. Do not waive the gate or reset baseline silently. |
| A more complex admission/compression/routing default might reduce total cost. | Actual admission has trace-dependent hit/byte-hit trade-offs; codecs vary by entropy/size. No full W-TinyLFU or routing comparison was executed. | Preserve uncomplicated defaults; no new production dependencies or routing service. |

Source changes include cancellation/rechecks, safe publication and per-key revision guards, bounded follower/metadata/event/telemetry retention, scoped/authoritative peer handling, conservative reconnect recovery, bounded internal decoding and Redis STRLEN-before-GET. Tests accompany critical findings. Public method signatures, exports and legacy one-argument codec behavior are retained; tightened resource/close/error behavior and operational compatibility are documented in [migration notes](migration.md). Dependency lock and production dependencies are unchanged.

## Verification and remaining gates

Original full live-service suite356/356; final480/480, zero skips/failures. Node20 and22 each480/480 with build/typecheck/package verification, plus local24. Independent focused verification93/93 includes separately constructed binary ownership controls. Both28-case memory matrices and30-second memory smokes pass. All15 final real fault cases pass. Documentation lint/types pass; full108-page static-site generation exceeded local memory budgets and is not reported as passed.

The seven-repeat performance gate actually returns exit1 without a resource abort. Redis failover/Cluster, undetected/lost invalidations, external source fencing, legacy/custom non-atomic adapters, Worker aggregate limits, tenant/global origin fairness, exact RSS≤B and long endurance remain open. No production-ready declaration, package release or production deployment was made. [Independent readiness gates](12-production-readiness.md), [prioritized backlog](11-future-architecture.md).
''')

(RAW / "result-summary.json").write_text(json.dumps({
    "baselineCommit":"ca9c02a04349a89278cd81b5b25d0000503cc5a3",
    "finalSourceSha256":"e451d7c9d3524779584211fe0571acff4e68cecbf1e32e6f8bb10f8face8fd08",
    "comparisonColumns":["metric","before","after","change"],"comparison":comparison_rows,
    "microComparison":micro["rows"],"ciFlaggedRegressions":[r["name"]+"/"+str(r["n"]) for r in ci["rows"] if r["regression"]],
    "chaos":{"beforePass":8,"beforeFail":7,"afterPass":15,"afterFail":0},
    "qualification":"Derived tables; raw JSON and per-run metadata remain authoritative. No unmeasured value is inferred."
},indent=2)+"\n")
print("Generated audit/08,09,10 and audit/raw/result-summary.json")
