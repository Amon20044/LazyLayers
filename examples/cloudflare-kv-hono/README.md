# Cloudflare KV from Hono on Workers

This Worker uses a KV binding as L2 and an optional per-isolate L1. `getOrSet` reads from the origin on a miss. `invalidateTenantUsers()` shows how to delete a key family after the authoritative write commits.

1. Replace `ORIGIN_BASE_URL` in `wrangler.jsonc` with your origin URL.
2. Create `lazy-layers-cache-invalidations` and `lazy-layers-cache-invalidations-dlq` Queues, then set the same `CACHE` namespace ID in this Worker and the [invalidation consumer](../cloudflare-kv-invalidation).
3. From the repository root, run `npm run cloudflare:hono:dry-run` to validate the bundle.
4. Deploy with `npx wrangler deploy --config examples/cloudflare-kv-hono/wrangler.jsonc`.

The Node.js root entrypoint contains native dependencies. Workers import `lazy-layers-cache/cloudflare`. Keep one `CloudflareWorkerMemoryStore` per KV namespace and application prefix. The L1 is local to an isolate and its short TTL bounds how long it can retain a value after another isolate invalidates it.

`invalidate` and `invalidateByPattern` delete KV and publish a durable application invalidation. The consumer retries the deletion. Queue delivery does not clear L1 in every isolate. The optional module-level L1 is only reused while that isolate lives and may disappear at any time; it is never shared across isolates. See the [Cloudflare KV guide](../../documentation/content/docs/setups/cloudflare-kv.mdx) for limits and pattern deletion behavior.
