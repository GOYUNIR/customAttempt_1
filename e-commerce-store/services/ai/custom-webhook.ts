/**
 * SERVICES / AI — Custom webhook driver (bring-your-own image-to-3D endpoint).
 *
 * The operator supplies a full endpoint URL (a serverless function, a self-hosted
 * worker, or a third-party proxy). The store POSTs `{ imageUrl, prompt }` and
 * expects a JSON body back with a model URL — either synchronously or with a
 * `status` field that is polled on the same endpoint until `"complete"`.
 *
 * The API key (when set) is sent as `Authorization: Bearer …`. Zero `@/` imports.
 */

import { normalizeMeshFormat, sleep, type MeshDriver, type MeshGenerateResult, type MeshDriverResolutionOptions } from './mesh-driver.ts';
import type { Ai3dProvider } from '../config/types.ts';

export interface CustomWebhookDriverOptions extends MeshDriverResolutionOptions {
  apiKey: string;
  /** Required — the full endpoint URL to POST to. */
  endpoint: string;
}

export class CustomWebhookDriver implements MeshDriver {
  readonly provider: Ai3dProvider = 'custom_webhook';
  readonly configured: boolean;

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxPolls: number;
  private readonly pollDelayMs: number;

  constructor(options: CustomWebhookDriverOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.endpoint = String(options.endpoint || '').trim();
    // A webhook needs an endpoint; the key is optional (many proxies are unauthenticated).
    this.configured = Boolean(this.endpoint);
    this.fetchImpl = options.fetchImpl || fetch;
    this.maxPolls = Math.max(1, options.maxPolls ?? 10);
    this.pollDelayMs = Math.max(0, options.pollDelayMs ?? 3000);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async generate(imageUrl: string, prompt: string): Promise<MeshGenerateResult> {
    if (!this.configured) {
      return { ok: false, error: 'Custom webhook endpoint is not configured.', provider: this.provider, skipped: true };
    }
    try {
      for (let poll = 0; poll < this.maxPolls; poll += 1) {
        if (poll > 0 && this.pollDelayMs > 0) await sleep(this.pollDelayMs);
        const res = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ imageUrl, prompt }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          return { ok: false, error: `Custom webhook error ${res.status}: ${detail.slice(0, 300)}`, provider: this.provider };
        }
        const json = (await res.json().catch(() => null)) as {
          status?: string;
          modelUrl?: string;
          model_url?: string;
          thumbnailUrl?: string;
          model?: { url?: string };
        } | null;
        const status = String(json?.status || '').toLowerCase();
        const modelUrl = String(json?.modelUrl || json?.model_url || json?.model?.url || '');
        if (modelUrl) return { ok: true, modelUrl, thumbnailUrl: json?.thumbnailUrl, format: normalizeMeshFormat(modelUrl), provider: this.provider };
        if (status === 'failed' || status === 'error' || status === 'canceled') {
          return { ok: false, error: `Custom webhook task ${status}.`, provider: this.provider };
        }
      }
      return { ok: false, error: 'Custom webhook task timed out.', provider: this.provider };
    } catch (err) {
      return { ok: false, error: err, provider: this.provider };
    }
  }
}
