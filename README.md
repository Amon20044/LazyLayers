# lazy-layers-cache

L1/L2 caching for Node.js services and Cloudflare Workers. Use Redis or Cloudflare KV as shared L2, with `getOrSet` and pattern invalidation in Hono or other frameworks.

[![npm version](https://img.shields.io/npm/v/lazy-layers-cache.svg)](https://www.npmjs.com/package/lazy-layers-cache)
[![CI](https://github.com/Amon20044/LazyLayers/actions/workflows/ci.yml/badge.svg)](https://github.com/Amon20044/LazyLayers/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/lazy-layers-cache.svg)](LICENSE)
[![types](https://img.shields.io/npm/types/lazy-layers-cache.svg)](https://www.npmjs.com/package/lazy-layers-cache)

**[Docs](https://lazy-layers-cache.vercel.app/docs)** · **[Memory and cost calculator](https://lazy-layers-cache.vercel.app/#calculator)** · **[LLM index](https://lazy-layers-cache.vercel.app/llms.txt)** · **[Full LLM context](https://lazy-layers-cache.vercel.app/llms-full.txt)**

## Get started

Requires Node.js 20 or 22+. Redis is optional for a single process.

```bash
npm install lazy-layers-cache
```

Save this as `cache-demo.mjs` and run `node cache-demo.mjs`:

```js
import { setupCache } from 'lazy-layers-cache'

const cache = await setupCache({ namespace: 'demo', redis: false })
let loaderCalls = 0

try {
  const loadUser = async () => {
    loaderCalls++
    return { id: '42', name: 'Ada' }
  }

  await cache.getOrSet('user:42', loadUser)
  const user = await cache.getOrSet('user:42', loadUser)
  console.log(user.name, loaderCalls) // Ada 1
} finally {
  await cache.close()
}
```

For multiple instances, set `REDIS_URL` and use:

```js
const cache = await setupCache({
  namespace: 'users-api',
  redis: { required: true },
})
```

`setupCache` creates Redis L2 and Redis Pub/Sub, checks readiness, and manages shutdown. Each instance keeps its own L1. Use the same namespace and Redis service for instances that share cached data.

The [quickstart](https://lazy-layers-cache.vercel.app/docs/quickstart) takes you from this example to database reads, invalidation, and shutdown.

## Cloudflare KV

Use the [Workers Hono example](examples/cloudflare-kv-hono) with the Worker-safe `lazy-layers-cache/cloudflare` import and a KV binding. Use the [Node.js Hono example](examples/cloudflare-kv-node-hono) with `CloudflareKVRestNamespace` and `setupCache({ kv: { namespace } })`. Both support `getOrSet` and `invalidateByPattern` with the same key pattern syntax. An optional [Cloudflare Queue consumer](examples/cloudflare-kv-invalidation) retries application invalidations from either runtime. The [Cloudflare KV guide](https://lazy-layers-cache.vercel.app/docs/setups/cloudflare-kv) covers setup, TTLs, and KV limits.

KV writes use the existing HC1 MessagePack serializer with adaptive gzip: payloads at least 1 KiB are compressed only when gzip saves at least 15% of the packed bytes. Set `compression: 'none'` in a KV store to skip the trial. Compression saves stored bytes, while per-key KV read/write/list/delete charges remain unchanged. Local L1 hits can avoid some KV reads. See the guide for the full cost model and consistency limits.

Cloudflare [Event Subscriptions](examples/cloudflare-event-subscriptions) report build and KV namespace lifecycle events to their own platform-monitoring Queue consumer. They do not report individual cache key changes. Application invalidations use the separate [invalidation Queue consumer](examples/cloudflare-kv-invalidation).

## The methods you need

| Task | Method | Details |
| --- | --- | --- |
| Read a value, loading it on a miss | `getOrSet(key, loader)` | [Read API](https://lazy-layers-cache.vercel.app/docs/reference/api#getorset) |
| Refresh after a committed database write | `invalidate(key)` | [Invalidation](https://lazy-layers-cache.vercel.app/docs/concepts/invalidation) |
| Invalidate a key family | `invalidateByPattern('tenant:42:*')` | [Pattern API](https://lazy-layers-cache.vercel.app/docs/reference/api#invalidatebypattern) |
| Warm a key before traffic needs it | `prewarm(key, loader)` | [Warm-up API](https://lazy-layers-cache.vercel.app/docs/reference/api#prewarm) |
| Release managed resources | `close()` | [Shutdown](https://lazy-layers-cache.vercel.app/docs/reference/api#lifecycle-methods) |

Commit database writes before invalidating. Keep cache loaders read-only. A cache lease reduces duplicate loads but does not authorize a business operation or guarantee exactly-once execution.

## What happens on a read

1. `getOrSet` returns a cached value from L1 or shared Redis L2 when available.
2. On a miss, in-flight dedupe shares work within the process. Redis per-key leases coordinate loaders across instances.
3. A successful load fills the cache. With an event bus, values within the broadcast limit can also warm peer L1 caches.
4. Redis or bus failures degrade the cache path. Eligible stale data can cover a loader failure, but loader errors, overload, or lock deadlines can still reach the caller.

Built-in L1 retains encoded values with LRU eviction, entry limits, and a shared memory budget. `setupCache` defaults to a 10 second L1 TTL and a 32 KiB peer-broadcast ceiling. Values above that ceiling skip peer priming. L1 admission can also decline a value under memory pressure.

Use [production setup](https://lazy-layers-cache.vercel.app/docs/setups/production) for deployment decisions and [configuration](https://lazy-layers-cache.vercel.app/docs/reference/configuration) for defaults and tuning. Redis Pub/Sub, RabbitMQ, NATS Core, and NATS JetStream have different [delivery guarantees](https://lazy-layers-cache.vercel.app/docs/guides/event-buses).

## Released in v0.5.3

**0.5.3 is released and available on npm.** It adds:

- **Transaction coordination:** the opt-in `lazy-layers-cache/transactions` API coordinates attempts around a durable operation using a Redis primary. It stays separate from the cache. Your database, provider idempotency, and reconciliation determine the business result.
- **Lease-checked Redis publication:** the store checks ownership and writes the value with its TTL in one Redis operation. A rejected lease cannot publish a successful cache fill.
- **Independent L1/L2 codecs:** choose the write representation per layer while continuing to read supported tagged HC1 values.
- **Redis-native retention:** native TTL and operator-managed eviction are the default. The namespace index is optional.
- **Read-only capability discovery:** bounded checks distinguish supported, unavailable, and unknown capabilities without changing Redis configuration.

When upgrading an existing Redis deployment, review the [key-layout migration](https://lazy-layers-cache.vercel.app/docs/reference/stores#the-key-layout). v2 and legacy keys are not dual-read. Keep `useIndex: true` while migrating a deployment that relies on the namespace catalogue.

Read the [0.5.3 changelog](https://github.com/Amon20044/LazyLayers/blob/main/CHANGELOG.md#053) for the full release and compatibility notes. For operation coordination, start with the [transaction reference](https://lazy-layers-cache.vercel.app/docs/reference/transactions) and [runnable ticketing example](https://github.com/Amon20044/LazyLayers/tree/main/examples/transaction-coordination).

## Find the next answer

| You want to… | Read |
| --- | --- |
| Add caching to an application | [Quickstart](https://lazy-layers-cache.vercel.app/docs/quickstart) |
| Follow one key through the system | [Walkthrough](https://lazy-layers-cache.vercel.app/docs/walkthrough) |
| Choose a deployment setup | [Production setup](https://lazy-layers-cache.vercel.app/docs/setups/production) |
| Handle timeouts and outages | [Failure handling](https://lazy-layers-cache.vercel.app/docs/guides/failure-handling) |
| Inspect cache behavior | [Observability](https://lazy-layers-cache.vercel.app/docs/guides/observability) |
| Look up a method or option | [API](https://lazy-layers-cache.vercel.app/docs/reference/api) · [Configuration](https://lazy-layers-cache.vercel.app/docs/reference/configuration) |

## Development

```bash
npm ci
npm run ci
npm run docs:build
```

`npm run ci` builds and checks the ESM/CommonJS package and runs the test suite. See the [benchmark guide](https://github.com/Amon20044/LazyLayers/tree/main/benchmarks) for reproducible performance and memory workloads, and the [examples](https://github.com/Amon20044/LazyLayers/tree/main/examples) for runnable integrations.

## License

[MIT](https://github.com/Amon20044/LazyLayers/blob/main/LICENSE)
