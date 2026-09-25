# Application invalidations over Cloudflare Queues

This consumer receives application-produced key and pattern invalidation messages. It repeats the KV deletion with retry and a dead-letter queue. It is separate from Cloudflare Event Subscriptions, which have no key change events.

Create the queue and its dead-letter queue, then deploy this consumer and the Hono producer from the repository root:

```bash
npx wrangler queues create lazy-layers-cache-invalidations
npx wrangler queues create lazy-layers-cache-invalidations-dlq
npm run cloudflare:invalidation:dry-run
npx wrangler deploy --config examples/cloudflare-kv-invalidation/wrangler.jsonc
npx wrangler deploy --config examples/cloudflare-kv-hono/wrangler.jsonc
```

Use the **same KV namespace ID** for `CACHE` in both Workers. Wrangler's automatic provisioning creates separate namespaces if you deploy both configs without setting a shared ID. Put the existing namespace ID in both `kv_namespaces` entries before deployment. Set `ORIGIN_BASE_URL` in the Hono producer config.

The message scope and KV prefix are fixed to `users-api` and `users-api:` in these examples. Change both sides together for your application. The consumer acknowledges messages from unknown scopes without touching KV. Transient deletion failures retry and eventually reach the dead-letter queue.

Queues deliver messages to a consumer, not to every Worker isolate. The per-isolate L1 remains bounded by its own TTL, and KV itself is eventually consistent. For strict read-after-write behavior, read from your authoritative origin or use a coordination system designed for it.
