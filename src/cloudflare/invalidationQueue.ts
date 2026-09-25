/** Application invalidations sent to a dedicated Cloudflare Queue. */
export type CloudflareInvalidationMessage =
  | { version: 1; id: string; scope: string; type: 'key'; key: string; timestamp: number }
  | { version: 1; id: string; scope: string; type: 'pattern'; pattern: string; timestamp: number };

export interface CloudflareQueueSender {
  send(body: CloudflareInvalidationMessage): Promise<void>;
}

export interface CloudflareInvalidationPublisher {
  publishKey(key: string): Promise<void>;
  publishPattern(pattern: string): Promise<void>;
}

/** Publishes application write invalidations through a Queue binding or REST sender. */
export class CloudflareQueueInvalidationPublisher implements CloudflareInvalidationPublisher {
  constructor(private readonly sender: CloudflareQueueSender, readonly scope: string) {
    if (!scope || scope.length > 128) throw new RangeError('Invalidation scope must contain 1 to 128 characters');
  }

  async publishKey(key: string): Promise<void> {
    validateTarget(key);
    await this.sender.send({ version: 1, id: crypto.randomUUID(), scope: this.scope, type: 'key', key, timestamp: Date.now() });
  }

  async publishPattern(pattern: string): Promise<void> {
    validateTarget(pattern);
    await this.sender.send({ version: 1, id: crypto.randomUUID(), scope: this.scope, type: 'pattern', pattern, timestamp: Date.now() });
  }
}

export interface CloudflareQueueRestOptions {
  accountId: string;
  queueId: string;
  apiToken: string;
  /** Default: 2 seconds. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Node.js sender using the Cloudflare Queues push-message API. */
export class CloudflareQueueRestSender implements CloudflareQueueSender {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly http: typeof fetch;

  constructor(private readonly options: CloudflareQueueRestOptions) {
    for (const [name, value] of Object.entries({ accountId: options.accountId, queueId: options.queueId, apiToken: options.apiToken })) {
      if (!value?.trim()) throw new TypeError(`Cloudflare Queue ${name} is required`);
    }
    this.timeoutMs = options.timeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new RangeError('Cloudflare Queue timeoutMs must be positive');
    this.http = options.fetch ?? fetch;
    this.url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}`
      + `/queues/${encodeURIComponent(options.queueId)}/messages`;
  }

  async send(body: CloudflareInvalidationMessage): Promise<void> {
    const response = await this.http(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body, content_type: 'json' }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Cloudflare Queue REST returned HTTP ${response.status}`);
    const result: unknown = await response.json();
    if (!record(result) || result.success !== true) throw new Error('Cloudflare Queue REST rejected the invalidation');
  }
}

/** Unknown or malformed messages are never applied to KV. */
export function parseCloudflareInvalidationMessage(value: unknown): CloudflareInvalidationMessage | null {
  if (!record(value) || value.version !== 1 || typeof value.id !== 'string' || !value.id
    || typeof value.scope !== 'string' || !value.scope || value.scope.length > 128
    || !Number.isSafeInteger(value.timestamp) || typeof value.type !== 'string') return null;
  if (value.type === 'key' && validTarget(value.key)) return value as CloudflareInvalidationMessage;
  if (value.type === 'pattern' && validTarget(value.pattern)) return value as CloudflareInvalidationMessage;
  return null;
}

function validateTarget(target: string): void {
  if (!validTarget(target)) throw new RangeError('Invalidation key or pattern must contain 1 to 512 UTF-8 bytes');
}

function validTarget(target: unknown): target is string {
  return typeof target === 'string' && target.length > 0 && new TextEncoder().encode(target).byteLength <= 512;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
