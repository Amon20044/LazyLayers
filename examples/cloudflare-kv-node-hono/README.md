# Cloudflare KV from Hono on Node.js

This example uses Cloudflare's KV REST API as the shared L2 of the full Node.js cache. It keeps the same `getOrSet` and `invalidateByPattern` API used by other Node.js frameworks.

1. Create a KV namespace and an API token with Workers KV read and write permissions scoped to its account.
2. Create the invalidation Queue and its [consumer](../cloudflare-kv-invalidation). Give the API token Workers KV read/write and Queues Write permissions.
3. Set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_KV_NAMESPACE_ID`, `CLOUDFLARE_INVALIDATION_QUEUE_ID`, `CLOUDFLARE_API_TOKEN`, and `ORIGIN_BASE_URL` in your secret store or shell environment.
4. From the repository root, run `npm run build` and `npm run example:cloudflare:node-hono`.

`GET /tenants/:tenantId/users/:userId` loads from the origin on a miss. Integrate `invalidateTenantUsers()` into your own write path after the authoritative write commits. The cache deletes KV and publishes an invalidation to the Queue. The example does not expose an unauthenticated cache purge endpoint.

The token remains in Node.js and is never sent to the browser. KV is eventually consistent, so choose a TTL and data type that tolerate cross-location propagation delay. See the [Cloudflare KV guide](../../documentation/content/docs/setups/cloudflare-kv.mdx).
