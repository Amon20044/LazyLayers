import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { CloudflareKVRestNamespace, setupCache } from 'lazy-layers-cache';
// KV payloads use serializeCacheValue from this package. Do not JSON-encode them here.
import { CloudflareQueueInvalidationPublisher, CloudflareQueueRestSender } from 'lazy-layers-cache/cloudflare';

interface User { id: string; name: string }

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const kv = new CloudflareKVRestNamespace({
  accountId: required('CLOUDFLARE_ACCOUNT_ID'),
  namespaceId: required('CLOUDFLARE_KV_NAMESPACE_ID'),
  apiToken: required('CLOUDFLARE_API_TOKEN'),
});
const origin = required('ORIGIN_BASE_URL');
const cache = await setupCache<string, User>({
  namespace: 'users-api',
  redis: false,
  kv: { namespace: kv, store: { prefix: 'users-api:' } },
  invalidationPublisher: new CloudflareQueueInvalidationPublisher(
    new CloudflareQueueRestSender({
      accountId: required('CLOUDFLARE_ACCOUNT_ID'),
      queueId: required('CLOUDFLARE_INVALIDATION_QUEUE_ID'),
      apiToken: required('CLOUDFLARE_API_TOKEN'),
    }),
    'users-api',
  ),
  levels: { L2: { ttlMs: 5 * 60_000 } },
});

const app = new Hono();
app.get('/tenants/:tenantId/users/:userId', async (c) => {
  const { tenantId, userId } = c.req.param();
  const key = `tenant:${keyPart(tenantId)}:user:${keyPart(userId)}`;
  const user = await cache.getOrSet(key, async () => {
    const url = new URL(`/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}`, origin);
    const response = await fetch(url);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Origin returned HTTP ${response.status}`);
    return response.json() as Promise<User>;
  });
  return user === undefined ? c.notFound() : c.json(user);
});

/** Call after a successful authoritative write. */
export async function invalidateTenantUsers(tenantId: string): Promise<void> {
  await cache.invalidateByPattern(`tenant:${keyPart(tenantId)}:user:*`);
}

function keyPart(value: string): string {
  return encodeURIComponent(value).replace(/\*/g, '%2A');
}

const port = Number(process.env.PORT ?? '3000');
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new RangeError('PORT must be between 1 and 65535');
const server = serve({ fetch: app.fetch, port });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close();
    void cache.close();
  });
}
