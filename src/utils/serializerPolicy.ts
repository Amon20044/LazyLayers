/** Worker-compatible subset of the existing HC1 serializer policy. */
export const PORTABLE_GZIP_MIN_BYTES = 1_024;
export const MIN_COMPRESSION_SAVINGS = 0.15;
export type CloudflareKVCompression = 'auto' | 'none';

export function validateKVCompression(mode: CloudflareKVCompression | undefined): void {
  if (mode !== undefined && mode !== 'auto' && mode !== 'none') {
    throw new TypeError('Cloudflare KV compression must be auto or none');
  }
}
