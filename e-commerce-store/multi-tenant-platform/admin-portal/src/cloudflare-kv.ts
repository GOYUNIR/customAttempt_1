/**
 * Cloudflare API client for KV cache invalidation.
 *
 * The Admin Portal deletes the tenant's `site_cache:v<N>:<siteKey>` keys
 * directly through the Cloudflare API (no Worker round-trip) so a
 * Save/Publish takes effect for the next visitor, instantly.
 *
 * Docs:
 *   https://developers.cloudflare.com/api/operations/workers-kv-namespace-delete-multiple-key-value-pairs
 */
export interface CloudflareCredentials {
  accountId: string;
  namespaceId: string;
  apiToken: string;
}

export interface CloudflareApiError {
  code: number;
  message: string;
}

export interface CloudflareBulkResult {
  success: boolean;
  errors: CloudflareApiError[];
  purgedKeys: string[];
}

interface CloudflareApiEnvelope {
  success: boolean;
  errors: CloudflareApiError[];
  messages: unknown[];
}

const API_BASE = 'https://api.cloudflare.com/client/v4';

async function requestCloudflare(
  credentials: CloudflareCredentials,
  url: string,
  init: RequestInit,
): Promise<CloudflareApiEnvelope> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${credentials.apiToken}`);
  headers.set('Content-Type', 'application/json');

  const response = await fetch(url, { ...init, headers });
  const body = (await response.json()) as Partial<CloudflareApiEnvelope>;

  return {
    success: response.ok && body.success === true,
    errors: Array.isArray(body.errors) ? (body.errors as CloudflareApiError[]) : [],
    messages: Array.isArray(body.messages) ? body.messages : [],
  };
}

/**
 * Delete many keys at once (bulk endpoint — up to 10,000 keys per call).
 * Deleting all cache versions of a site's keys is a no-op, so it is always
 * safe to call with every hostname the site owns.
 */
export async function deleteKvKeys(credentials: CloudflareCredentials, keys: string[]): Promise<CloudflareBulkResult> {
  const uniqueKeys = [...new Set(keys.map((key) => key.trim()).filter((key) => key.length > 0))];
  if (uniqueKeys.length === 0) {
    return { success: true, errors: [], purgedKeys: [] };
  }

  const url =
    `${API_BASE}/accounts/${encodeURIComponent(credentials.accountId)}` +
    `/storage/kv/namespaces/${encodeURIComponent(credentials.namespaceId)}/bulk/delete`;

  const envelope = await requestCloudflare(credentials, url, {
    method: 'DELETE',
    body: JSON.stringify(uniqueKeys),
  });

  return { success: envelope.success, errors: envelope.errors, purgedKeys: envelope.success ? uniqueKeys : [] };
}

/** Delete a single key (fallback / debugging path). */
export async function deleteKvKey(credentials: CloudflareCredentials, key: string): Promise<CloudflareBulkResult> {
  const trimmed = key.trim();
  if (!trimmed) return { success: true, errors: [], purgedKeys: [] };

  const url =
    `${API_BASE}/accounts/${encodeURIComponent(credentials.accountId)}` +
    `/storage/kv/namespaces/${encodeURIComponent(credentials.namespaceId)}/keys/${encodeURIComponent(trimmed)}`;

  const envelope = await requestCloudflare(credentials, url, { method: 'DELETE' });

  return { success: envelope.success, errors: envelope.errors, purgedKeys: envelope.success ? [trimmed] : [] };
}
