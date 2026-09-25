import {
  parseCloudflarePlatformEvent,
  summarizeCloudflarePlatformEvent,
} from 'lazy-layers-cache/cloudflare-events';

interface Env {
  /** Optional webhook destination. Set with `wrangler secret put`. */
  PLATFORM_EVENT_WEBHOOK_URL?: string;
}

interface QueueMessage {
  body: unknown;
  ack(): void;
  retry(): void;
}

interface QueueBatch {
  messages: QueueMessage[];
}

export default {
  async queue(batch: QueueBatch, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const event = parseCloudflarePlatformEvent(message.body);
      if (!event) {
        console.warn(JSON.stringify({ kind: 'cloudflare-platform-event-ignored' }));
        message.ack();
        continue;
      }

      const summary = summarizeCloudflarePlatformEvent(event);
      try {
        if (env.PLATFORM_EVENT_WEBHOOK_URL) {
          const response = await fetch(env.PLATFORM_EVENT_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(summary),
          });
          if (!response.ok) throw new Error(`Platform event webhook returned HTTP ${response.status}`);
        }
        console.info(JSON.stringify({ kind: 'cloudflare-platform-event', ...summary }));
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({
          kind: 'cloudflare-platform-event-delivery-failed',
          type: event.type,
          resourceId: summary.resourceId,
          error: error instanceof Error ? error.message : String(error),
        }));
        message.retry();
      }
    }
  },
};
