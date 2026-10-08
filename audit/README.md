# Reproducing the cache audit

All load and fault tools create synthetic data and explicitly owned resources. Docker tests mint a UUID Compose project, expose only random loopback ports, cap Redis/RabbitMQ/NATS at 736 MiB total and 2.5 CPUs, and remove that project and volumes in `finally`. Runtime compatibility adds a capped 1 GiB / 1.5 CPU official Node container. Existing application containers are not fault targets.

Build once before running the following commands:

```sh
npm ci
npm run typecheck
npm run build
npm run test:audit
npm run bench:audit
npm run bench:audit:e2e
npm run test:audit:chaos
npm run audit:memory
```

Each runner records wall/heap/RSS/output budgets, exit status and hardware alongside raw results. RSS sampling is not an instantaneous allocation profiler or a process memory guarantee; container memory caps provide a separate hard infrastructure bound. A failed/aborted run is retained and cannot be reported as a successful capacity measurement.

Runner options use `--name=value`; unknown, incomplete and duplicate options fail before a child starts. `--heap-mib` sets V8 old-space size, not total V8, external Buffer, native or process memory. Young-generation space can make the reported V8 heap limit larger than this flag; the separate RSS/container limits cover different resources.

## Equivalent original and updated modules

The preserved baseline is commit `ca9c02a04349a89278cd81b5b25d0000503cc5a3`. Use the same installed dependency lock, Node/codec platform, harness revision, payloads and concurrency for both builds. Do not edit a compiled module while a measurement is running.

```sh
LAZY_AUDIT_MODULE=file:///absolute/baseline/dist/index.js LAZY_AUDIT_OUTPUT=audit/raw/benchmark-before.json npm run bench:audit
LAZY_AUDIT_MODULE=file:///absolute/updated/dist/index.js LAZY_AUDIT_OUTPUT=audit/raw/benchmark-after.json npm run bench:audit
node scripts/audit-compare.mjs audit/raw/benchmark-before.json audit/raw/benchmark-after.json
```

`LAZY_AUDIT_LABEL=before|after` selects Docker result names; `LAZY_AUDIT_MODULE` selects its library build. Real E2E uses two independent cache processes, one controlled HTTP origin and a separate load-generator process. Default three repeated one-second phases cover warm L1/L2, compression, leases/singleflight, overload and stale/error behavior. These are short reproducible samples, not sustained production capacity.

```sh
LAZY_AUDIT_LABEL=after-high LAZY_AUDIT_E2E_MAX_RPS=10000 LAZY_AUDIT_E2E_SCENARIOS=warm-10000 node scripts/audit-services.mjs benchmark
LAZY_AUDIT_NODE_MAJOR=20 LAZY_AUDIT_LABEL=node20 node scripts/audit-services.mjs runtime
LAZY_AUDIT_NODE_MAJOR=22 LAZY_AUDIT_LABEL=node22 node scripts/audit-services.mjs runtime
LAZY_AUDIT_LABEL=after node scripts/audit-runner.mjs --seconds=45 --rss-mib=512 --output=audit/raw/memory-smoke-after.log -- node --expose-gc scripts/audit-memory-smoke.mjs
```

High-rate phases are attempted only within configured/calibrated headroom. The generator records planned-arrival latency, dispatch lag and unsent traffic separately to expose coordinated omission/client saturation. The chaos harness verifies disposable container identity before every fault; a stable owned loopback proxy follows only that inspected container's port after restart.

## Profiles and experiments

`scripts/audit-memory-profile.mjs` measures six payload sizes/entropies, empty-store retention and a fixed working set in separate bounded children. Set `LAZY_AUDIT_SNAPSHOTS=1` and `LAZY_AUDIT_LABEL` for synthetic heap snapshots, then use `scripts/audit-heap-summary.mjs`. Exact allocation count/native fragmentation/instantaneous temporary peaks remain explicitly unmeasured.

`benchmarks/audit-policies.mjs` compares the actual current admission policy with disabled admission across ten trace categories. `benchmarks/audit-codecs.mjs` records the available tagged serialization/compression paths. `benchmarks/audit-queues.mjs` measures enqueue/drain scaling. Run each through `audit-runner.mjs --seconds=180 --rss-mib=768`; run CPU comparisons sequentially.

The new CI workflow runs fast critical regressions, a memory smoke and seven repeated equivalent microbenchmarks on PRs. Its bootstrap family interval and tolerance based on baseline variability avoid treating ordinary timing noise as proof. Scheduled checks run live services, E2E, chaos and bounded memory/codec/trace samples. Critical correctness failures block release regardless of performance.

## Metrics and report index

`scripts/audit-export-metrics.mjs` exports E2E JSON to Prometheus text; its optional loopback snapshot server can be scraped using `metrics/prometheus.yml`. Import `metrics/dashboard.json` into Grafana for before/after tables. These are bounded experiment snapshots, not live service histograms. Raw JSON is the source of truth.

| Report | Contents |
| --- | --- |
| [00](00-system-inventory.md) | Runtime, API, dependencies, integrations and defaults |
| [01](01-architecture.md) | Read/write/miss/refresh/invalidation/failure/shutdown diagrams |
| [02](02-risk-register.md) | Prioritized defects and remaining limits |
| [03](03-complexity-report.md) | Source-backed cost and allocation analysis |
| [04](04-memory-profile.md) | Heap, RSS, ownership, GC and memory experiments |
| [05](05-distributed-correctness.md) | Singleflight, leases, publication, races and invalidation |
| [06](06-research-comparison.md) | Required primary-source research and concrete decisions |
| [07](07-security-audit.md) | Isolation, malformed values, resource boundaries and deployment controls |
| [08](08-benchmark-results.md) | Executed workload results and measurement limits |
| [09](09-chaos-test-results.md) | Real faults, cleanup, recovery and unexecuted scenarios |
| [10](10-before-after-comparison.md) | Paired measurements and retained trade-offs |
| [11](11-future-architecture.md) | Architecture decisions and prioritized backlog |
| [12](12-production-readiness.md) | Independent verification and explicit release gates |

Operational changes and canary/rollback procedures are in [migration.md](migration.md). The audit does not publish a package or deploy production infrastructure.
