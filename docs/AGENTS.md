# Writing for these docs

> **`docs/CONTRACT.md` is the source of truth.** Read it before writing anything.
> It carries the verified constants, the complete option surface, the exact bus
> constructor signatures, and the accuracy rules. This file covers only the
> conventions layered on top.

## The three rules people get wrong

1. **Use the intent-named production path.** Reads use `getOrSet`, background
   warm-up uses `prewarm`, single-key invalidation uses `invalidate`, and pattern
   invalidation uses `invalidateByPattern`. `get`, `set`, `delete`, and
   `deleteByPattern` are documented only on `docs/reference/api.mdx`.
2. **JavaScript tab first, TypeScript second.** Every `<CodeGroup>`.
3. **L1 has no configurable eviction policy.** It is LRU, with `maxEntries` and
   `ttlMs` as the only dials. Never write "choose an eviction policy".

## Production advice

Tuning means changing numbers, not disabling safety. Never present
`inflight: { enabled: false }`, `failSafe: { enabled: false }` or
`broadcastSet: false` as production guidance.

# Documentation project instructions

## About this project

- Mintlify docs for `lazy-layers-cache`, a hybrid L1/L2 cache for Node.js.
- Pages are MDX with YAML frontmatter. Configuration lives in `docs.json`.
- The source of truth is the TypeScript in `../src`, the tests in `../test`,
  and the benchmark harness in `../benchmarks`. Verify claims against those
  before publishing them.

## Terminology

Use these consistently. Do not swap in synonyms for variety.

| Use | Not |
| --- | --- |
| server / instance | node, box, machine |
| L1 / L2 | local cache, remote cache, tier one |
| loader | factory, resolver, fetcher |
| event bus | message bus, broker, transport (except when comparing transports) |
| in-flight dedupe | request coalescing, deduplication |
| store | driver, adapter, provider |

`getOrSet`, `set`, `delete`, `deleteByPattern` are method names. Write them in
code formatting, never prose-cased.

## Style preferences

- Second person for user actions. The software's name for its own behaviour:
  "the loader runs", not "we run the loader".
- Active voice. Sentence case headings.
- Explain the problem before the mechanism.
- Show code, then explain the non-obvious part of it. Never explain syntax.
- No marketing language, no filler, no concluding summaries that restate the page.
- Semicolons are not used in prose. Split the sentence instead.
- Every code fence carries a language tag.

## Content boundaries

- Do not document private helpers or internal constants with no conceptual value.
- Do not state a default, limit, guarantee or benchmark number that is not
  traceable to source. If it cannot be verified, leave it out.
- Distinguish what the library guarantees from what an operator must configure.
- Benchmark figures come from `../benchmarks` only, and byte counts are exact
  because the fixtures are seeded.

## Verification

Before changing a reference page, re-read the file it documents:

| Page | Source |
| --- | --- |
| `reference/configuration` | `src/types/core.types.ts`, `src/cache/hybridCache.ts`, `src/cache/defaults.ts` |
| `reference/api` | `src/index.ts`, `src/cache/hybridCache.ts` |
| `reference/cache-events` | `src/cache/events.ts` |
| `reference/stores` | `src/cache/memoryStore.ts`, `src/cache/redisStore.ts` |
| `reference/event-buses` | `src/event-bus/*.ts` |
| `reference/environment-variables` | `src/observability/types.ts`, `src/utils/serializer.ts` |
