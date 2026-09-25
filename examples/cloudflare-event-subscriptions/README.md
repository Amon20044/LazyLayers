# Cloudflare platform event subscriptions

This is a separate Queue consumer for Workers Builds and KV namespace creation/deletion events. These platform events do not include KV key writes or deletions and cannot be used as a cache invalidation bus.

From the repository root:

```bash
npm run cloudflare:events:dry-run
npx wrangler queues create lazy-layers-platform-events
npx wrangler queues create lazy-layers-platform-events-dlq
npx wrangler deploy --config examples/cloudflare-event-subscriptions/wrangler.jsonc
npx wrangler queues subscription create lazy-layers-platform-events --source kv --events namespace.created,namespace.deleted
npx wrangler queues subscription create lazy-layers-platform-events --source workersBuilds.worker --worker-name YOUR_WORKER --events build.started,build.failed,build.canceled,build.succeeded
```

Replace `YOUR_WORKER` with the Worker to monitor. The consumer logs a validated summary of each supported event. For webhook delivery, set `PLATFORM_EVENT_WEBHOOK_URL` using `npx wrangler secret put PLATFORM_EVENT_WEBHOOK_URL --config examples/cloudflare-event-subscriptions/wrangler.jsonc`. Failed deliveries retry and then go to the dead-letter queue after the configured limit.

See the [Cloudflare KV guide](../../documentation/content/docs/setups/cloudflare-kv.mdx) for the cache integration.
