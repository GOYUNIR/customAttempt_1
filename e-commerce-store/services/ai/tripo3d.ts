/**
 * SERVICES / AI — Tripo3D driver (image-to-3D via the v2 OpenAPI).
 *
 * Tripo3D is ASYNCHRONOUS:
 *   1. POST {base}/v2/openapi/task  → { code: 0, data: { task_id } }
 *   2. GET  {base}/v2/openapi/task/{task_id} is polled until
 *      `data.status === "success"` (then `data.output.model.url` + format), or
 *      `"failed"` / `"canceled"`.
 *
 * The product image is passed BY URL (the provider fetches it) so a `/media/…`
 * ref or CDN URL works without the store re-uploading bytes. Zero `@/` imports so
 * `node --test` loads it directly.
 */

import { normalizeMeshFormat, sleep, type MeshDriver, type MeshGenerateResult, type MeshSubmitResult, type MeshDriverResolutionOptions } from './mesh-driver.ts';
import type { Ai3dProvider } from '../config/types.ts';

const TRIPO3D_BASE_URL = 'https://api.tripo3d.ai';

export interface Tripo3dDriverOptions extends MeshDriverResolutionOptions {
  apiKey: string;
}

export class Tripo3dDriver implements MeshDriver {
  readonly provider: Ai3dProvider = 'tripo3d';
  readonly configured: boolean;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxPolls: number;
  private readonly pollDelayMs: number;
  private readonly model: string;

  constructor(options: Tripo3dDriverOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.configured = Boolean(this.apiKey);
    this.fetchImpl = options.fetchImpl || fetch;
    this.baseUrl = (options.baseUrl || TRIPO3D_BASE_URL).replace(/\/+$/, '');
    this.maxPolls = Math.max(1, options.maxPolls ?? 40);
    this.pollDelayMs = Math.max(0, options.pollDelayMs ?? 3000);
    this.model = String(options.model || '').trim();
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  async submitTask(imageUrl: string, prompt: string): Promise<MeshSubmitResult> {
    if (!this.configured) {
      return { ok: false, error: 'Tripo3D API key is not configured.', provider: this.provider, skipped: true };
    }
    try {
      // Kick off the image_to_model task. A configured model string (e.g.
      // `tripo3d-v2.0`) is forwarded so the operator can pin an engine version.
      const taskBody: Record<string, unknown> = { type: 'image_to_model', image: imageUrl, prompt };
      if (this.model) taskBody.model = this.model;
      const created = await this.fetchImpl(`${this.baseUrl}/v2/openapi/task`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(taskBody),
      });
      if (!created.ok) {
        const detail = await created.text().catch(() => '');
        return { ok: false, error: `Tripo3D error ${created.status}: ${detail.slice(0, 300)}`, provider: this.provider };
      }
      const createdJson = (await created.json().catch(() => null)) as { code?: number; data?: { task_id?: string } } | null;
      const taskId = String(createdJson?.data?.task_id || '');
      if (!taskId) return { ok: false, error: 'Tripo3D returned no task id.', provider: this.provider };
      return { ok: true, taskId, provider: this.provider };
    } catch (err) {
      return { ok: false, error: err, provider: this.provider };
    }
  }

  async pollTask(taskId: string): Promise<MeshGenerateResult> {
    if (!this.configured) {
      return { ok: false, error: 'Tripo3D API key is not configured.', provider: this.provider, skipped: true };
    }
    try {
      // Poll until success / failed / canceled (bounded).
      for (let poll = 0; poll < this.maxPolls; poll += 1) {
        if (this.pollDelayMs > 0) await sleep(this.pollDelayMs);
        const res = await this.fetchImpl(`${this.baseUrl}/v2/openapi/task/${taskId}`, { method: 'GET', headers: this.headers() });
        if (!res.ok) continue;
        const polled = (await res.json().catch(() => null)) as {
          code?: number;
          data?: { status?: string; output?: { model?: { url?: string; format?: string }; rendered_image?: { url?: string }; model_url?: string } };
        } | null;
        const status = String(polled?.data?.status || '').toLowerCase();
        if (status === 'success') {
          const output = polled?.data?.output || {};
          const model = output.model || {};
          const modelUrl = String(model.url || output.model_url || '');
          const thumbnailUrl = String(output.rendered_image?.url || '');
          const format = normalizeMeshFormat(model.format || modelUrl);
          if (modelUrl) return { ok: true, modelUrl, thumbnailUrl, format, provider: this.provider };
          return { ok: false, error: 'Tripo3D task succeeded but returned no model URL.', provider: this.provider };
        }
        if (status === 'failed' || status === 'canceled' || status === 'cancelled') {
          return { ok: false, error: `Tripo3D task ${status}.`, provider: this.provider };
        }
      }
      return { ok: false, error: 'Tripo3D task timed out.', provider: this.provider };
    } catch (err) {
      return { ok: false, error: err, provider: this.provider };
    }
  }

  async generate(imageUrl: string, prompt: string): Promise<MeshGenerateResult> {
    const submitted = await this.submitTask(imageUrl, prompt);
    if (!submitted.ok) {
      return { ok: false, error: submitted.error, provider: this.provider, skipped: submitted.skipped };
    }
    return this.pollTask(submitted.taskId);
  }
}
