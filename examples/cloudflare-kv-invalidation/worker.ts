import {
  CloudflareWorkerKVStore,
  parseCloudflareInvalidationMessage,
  type CloudflareKVNamespace,
} from 'lazy-layers-cache/cloudflare';

interface Env { CACHE: CloudflareKVNamespace }
interface QueueMessage {
  body: unknown;
  ack(): void;
  retry(): void;
}
interface QueueBatch { messages: QueueMessage[] }

/** A dedicated consumer for application invalidations, separate from account events. */
export default {
  async queue(batch: QueueBatch, env: Env): Promise<void> {
    const store = new CloudflareWorkerKVStore(env.CACHE, { prefix: 'users-api:' });
    for (const item of batch.messages) {
      const message = parseCloudflareInvalidationMessage(item.body);
      if (!message || message.scope !== 'users-api') {
        console.error(JSON.stringify({ kind: 'cache-invalidation-rejected', reason: 'invalid-message-or-scope' }));
        item.ack();
        continue;
      }
      try {
        if (message.type === 'key') await store.delete(message.key);
        else await store.deleteByPattern(message.pattern);
        console.info(JSON.stringify({ kind: 'cache-invalidation-applied', id: message.id, type: message.type }));
        item.ack();
      } catch (error) {
        console.error(JSON.stringify({
          kind: 'cache-invalidation-failed', id: message.id,
          error: error instanceof Error ? error.message : String(error),
        }));
        item.retry();
      }
    }
  },
};
