# Documentation plan

Working document. Not in navigation.

## Ownership rule

The primary agent owns information architecture, terminology and `docs.json`.
Subagents write page bodies only, inside a fixed scope, against facts verified
from source. No subagent invents an option name, a default, or a benchmark
figure. Terminology comes from `docs/AGENTS.md`.

## Scopes

| # | Scope | Pages | Source of truth | Owner |
|---|---|---|---|---|
| 1 | Get started | index, installation, quickstart, walkthrough | src/index.ts, src/cache/hybridCache.ts | primary (done) |
| 2 | Recommended setups | setups/single-process, setups/multi-instance, setups/production | src/types/core.types.ts, src/cache/defaults.ts | primary (done) |
| 3 | Concepts | concepts/* | src/cache, src/utils/serializer.ts | primary (done) |
| 4 | Redis + RabbitMQ buses | guides/buses/redis, guides/buses/rabbitmq | src/event-bus/redisEventBus.ts, rabbitmqEventBus.ts | primary (done) |
| 5 | NATS buses | guides/buses/nats-core, guides/buses/nats-jetstream | src/event-bus/natsEventBus.ts | agent A |
| 6 | Bus overview hub | guides/event-buses | all of src/event-bus | agent B |
| 7 | Serializer deep dive | concepts/serialization (expand), reference/wire-format | src/utils/serializer.ts, benchmarks/ | agent C |
| 8 | Architecture | architecture/* | src/cache/hybridCache.ts | primary (done) |
| 9 | Reference | reference/* | per-file map in AGENTS.md | primary (done) |

## Verified constants

Do not restate these from memory. They were read from source.

- `DEFAULT_CACHE_TTL_MS` 3_600_000, `DEFAULT_L1_MAX_ENTRIES` 1_000, `DEFAULT_INFLIGHT_TTL_MS` 5_000
- distributed lock: ttlMs 10_000, waitTimeoutMs 2_000, pollMs 50
- RedisStore: prefix `cache:`, indexKey `{prefix}__index`, deleteStrategy `unlink`
- observability: route `/observelazyily`, host 127.0.0.1, port 7077, maxEvents 1000,
  maxValueBytes 262144, credentials lazydev/lazydev
- serializer: prefixes HC1M / HC1G / HC1J, GZIP_MIN_BYTES 65536, savings threshold 0.15
- eventDedupeMaxEntries 10_000, eventDedupeTtlMs 300_000
- 22 `CacheEvent` variants, listed in src/cache/events.ts
- NATS uses the modular v3 packages: `@nats-io/transport-node`, `@nats-io/jetstream`

## Open questions

None currently blocking. Anything that cannot be established from source is left
out rather than guessed.
