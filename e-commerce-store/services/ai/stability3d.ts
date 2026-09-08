/**
 * SERVICES / AI — Stability 3D driver (image-to-3D, Stability AI style).
 *
 * Stability's 3D endpoints are asynchronous: POST a generation job, then poll a
 * result endpoint for a `model_url` / GLB asset. The exact response shape varies
 * by model, so this driver is lenient about the success/URL fields. Zero `@/`
 * imports so `node --test` loads it directly.
 */

import { normalizeMeshFormat, sleep, type MeshDriver, type MeshGenerateResult, type MeshDriverResolutionOptions } from './mesh-driver.ts';
import type { Ai3dProvider } from '../config/types.ts';

const STABILITY3D_BASE_URL = 'https://api.stability.ai';

export interface Stability3dDriverOptions extends MeshDriverResolutionOptions {
  apiKey: string;
}

export class Stability3dDriver implements MeshDriver {
  readonly provider: Ai3dProvider = 'stability_3d';
  readonly configured: boolean;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxPolls: number;
  private readonly pollDelayMs: number;

  constructor(options: Stability3dDriverOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.configured = Boolean(this.apiKey);
    this.fetchImpl = options.fetchImpl || fetch;
    this.baseUrl = (options.baseUrl || STABILITY3D_BASE_URL).replace(/\/+$/, '');
    this.maxPolls = Math.max(1, options.maxPolls ?? 40);
    this.pollDelayMs = Math.max(0, options.pollDelayMs ?? 3000);
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  async generate(imageUrl: string, prompt: string): Promise<MeshGenerateResult> {
    if (!this.configured) {
      return { ok: false, error: 'Stability 3D API key is not configured.', provider: this.provider, skipped: true };
    }
    try {
      const created = await this.fetchImpl(`${this.baseUrl}/v2beta/3d/image-to-3d`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ image_url: imageUrl, prompt }),
      });
      if (!created.ok) {
        const detail = await created.text().catch(() => '');
        return { ok: false, error: `Stability 3D error ${created.status}: ${detail.slice(0, 300)}`, provider: this.provider };
      }
      const createdJson = (await created.json().catch(() => null)) as { id?: string; status?: string; model_url?: string; output?: unknown } | null;
      const taskId = String(createdJson?.id || '');
      if (!taskId) {
        // Some Stability endpoints return the model URL synchronously.
        const immediateUrl = String(createdJson?.model_url || '');
        if (immediateUrl) return { ok: true, modelUrl: immediateUrl, format: normalizeMeshFormat(immediateUrl), provider: this.provider };
        return { ok: false, error: 'Stability 3D returned no task id.', provider: this.provider };
      }

      for (let poll = 0; poll < this.maxPolls; poll += 1) {
        if (this.pollDelayMs > 0) await sleep(this.pollDelayMs);
        const res = await this.fetchImpl(`${this.baseUrl}/v2beta/3d/result/${taskId}`, { method: 'GET', headers: this.headers() });
        if (!res.ok) continue;
        const polled = (await res.json().catch(() => null)) as {
          status?: string;
          model_url?: string;
          output?: { model_url?: string };
        } | null;
        const status = String(polled?.status || '').toLowerCase();
        const modelUrl = String(polled?.model_url || polled?.output?.model_url || '');
        if (modelUrl) return { ok: true, modelUrl, format: normalizeMeshFormat(modelUrl), provider: this.provider };
        if (status === 'failed' || status === 'error' || status === 'canceled') {
          return { ok: false, error: `Stability 3D task ${status}.`, provider: this.provider };
        }
      }
      return { ok: false, error: 'Stability 3D task timed out.', provider: this.provider };
    } catch (err) {
      return { ok: false, error: err, provider: this.provider };
    }
  }
}
