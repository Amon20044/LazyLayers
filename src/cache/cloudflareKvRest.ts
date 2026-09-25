import type { CloudflareKVNamespace } from './cloudflareKvStore.js';

export interface CloudflareKVRestOptions {
  accountId: string;
  namespaceId: string;
  apiToken: string;
  /** Default: 2 seconds. */
  timeoutMs?: number;
  /** Mainly useful for testing or a custom HTTP stack. */
  fetch?: typeof fetch;
}

/** A Cloudflare KV namespace client for Node.js services outside Workers. */
export class CloudflareKVRestNamespace implements CloudflareKVNamespace {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly http: typeof fetch;

  constructor(private readonly options: CloudflareKVRestOptions) {
    for (const [field, value] of Object.entries({
      accountId: options.accountId,
      namespaceId: options.namespaceId,
      apiToken: options.apiToken,
    })) {
      if (!value || !value.trim()) throw new TypeError(`Cloudflare KV ${field} is required`);
    }
    this.timeoutMs = options.timeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError('Cloudflare KV REST timeoutMs must be a positive safe integer');
    }
    this.http = options.fetch ?? fetch;
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}`
      + `/storage/kv/namespaces/${encodeURIComponent(options.namespaceId)}`;
  }

  async get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null> {
    if (type !== 'arrayBuffer') throw new TypeError('Cloudflare KV REST only supports arrayBuffer reads');
    const response = await this.request(`/values/${encodeURIComponent(key)}`);
    if (response.status === 404) return null;
    await this.assertOk(response);
    return response.arrayBuffer();
  }

  async put(key: string, value: ArrayBuffer | ArrayBufferView, options: { expirationTtl: number }): Promise<void> {
    const query = new URLSearchParams({ expiration_ttl: String(options.expirationTtl) });
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const response = await this.request(`/values/${encodeURIComponent(key)}?${query}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    });
    await this.assertApiSuccess(response);
  }

  async delete(key: string): Promise<void> {
    const response = await this.request(`/values/${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (response.status === 404) return;
    await this.assertApiSuccess(response);
  }

  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const query = new URLSearchParams();
    if (options.prefix !== undefined) query.set('prefix', options.prefix);
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    // The REST API accepts 10..1000, whereas a Workers binding accepts 1..1000.
    query.set('limit', String(Math.max(10, Math.min(1_000, options.limit ?? 1_000))));
    const response = await this.request(`/keys?${query}`);
    await this.assertOk(response);
    const data: unknown = await response.json();
    if (!record(data) || data.success !== true || !Array.isArray(data.result)
      || !data.result.every((item: unknown) => record(item) && typeof item.name === 'string')) {
      throw new Error('Cloudflare KV REST returned an invalid key listing');
    }
    const info = record(data.result_info) ? data.result_info : {};
    const cursor = typeof info.cursor === 'string' && info.cursor ? info.cursor : undefined;
    return {
      keys: data.result as Array<{ name: string }>,
      list_complete: cursor === undefined,
      ...(cursor ? { cursor } : {}),
    };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.http(this.baseUrl + path, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.apiToken}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async assertOk(response: Response): Promise<void> {
    if (!response.ok) throw new Error(`Cloudflare KV REST returned HTTP ${response.status}`);
  }

  private async assertApiSuccess(response: Response): Promise<void> {
    await this.assertOk(response);
    const data: unknown = await response.json();
    if (!record(data) || data.success !== true) {
      throw new Error('Cloudflare KV REST reported an unsuccessful operation');
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
