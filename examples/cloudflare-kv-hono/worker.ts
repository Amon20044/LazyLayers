import { Hono } from 'hono';
import {
  CloudflareWorkerCache,
  CloudflareWorkerMemoryStore,
  CloudflareQueueInvalidationPublisher,
  type CloudflareKVNamespace,
  type CloudflareQueueSender,
} from 'lazy-layers-cache/cloudflare';

interface User {
  id: string;
  name: string;
}

interface Bindings {
  CACHE: CloudflareKVNamespace;
  INVALIDATIONS: CloudflareQueueSender;
  ORIGIN_BASE_URL: string;
}

const app = new Hono<{ Bindings: Bindings }>();
const l1 = new CloudflareWorkerMemoryStore<User>(1_000);

app.get('/tenants/:tenantId/users/:userId', async (c) => {
  const { tenantId, userId } = c.req.param();
  const cache = new CloudflareWorkerCache<User>(c.env.CACHE, {
    prefix: 'users-api:',
    ttlMs: 5 * 60_000,
    l1,
    l1TtlMs: 10_000,
    invalidationPublisher: new CloudflareQueueInvalidationPublisher(c.env.INVALIDATIONS, 'users-api'),
  });
  const key = `tenant:${keyPart(tenantId)}:user:${keyPart(userId)}`;
  const user = await cache.getOrSet(key, async () => {
    const url = new URL(`/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}`, c.env.ORIGIN_BASE_URL);
    const response = await fetch(url);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Origin returned HTTP ${response.status}`);
    return response.json() as Promise<User>;
  });
  return user === undefined ? c.notFound() : c.json(user);
});

/** Call this only after the authoritative database update has committed. */
export async function invalidateTenantUsers(env: Bindings, tenantId: string): Promise<void> {
  const cache = new CloudflareWorkerCache<User>(env.CACHE, {
    prefix: 'users-api:', l1,
    invalidationPublisher: new CloudflareQueueInvalidationPublisher(env.INVALIDATIONS, 'users-api'),
  });
  await cache.invalidateByPattern(`tenant:${keyPart(tenantId)}:user:*`);
}

function keyPart(value: string): string {
  return encodeURIComponent(value).replace(/\*/g, '%2A');
}

export default app;
