/**
 * SERVICES / AI — Meshy driver (image-to-3D via the openapi).
 *
 * Meshy is ASYNCHRONOUS:
 *   1. POST {base}/openapi/v1/image-to-3d → { result: "<taskId>" }
 *   2. GET  {base}/openapi/v1/image-to-3d/{taskId} polled until
 *      `status === "SUCCEEDED"` (then `model_urls.glb`) or `"FAILED"`.
 *
 * Zero `@/` imports so `node --test` loads it directly.
 */

import { normalizeMeshFormat, sleep, type MeshDriver, type MeshGenerateResult, type MeshDriverResolutionOptions } from './mesh-driver.ts';
import type { Ai3dProvider } from '../config/types.ts';

const MESHY_BASE_URL = 'https://api.meshy.ai';

export interface MeshyDriverOptions extends MeshDriverResolutionOptions {
  apiKey: string;
}

export class MeshyDriver implements MeshDriver {
  readonly provider: Ai3dProvider = 'meshy';
  readonly configured: boolean;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxPolls: number;
  private readonly pollDelayMs: number;

  constructor(options: MeshyDriverOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.configured = Boolean(this.apiKey);
    this.fetchImpl = options.fetchImpl || fetch;
    this.baseUrl = (options.baseUrl || MESHY_BASE_URL).replace(/\/+$/, '');
    this.maxPolls = Math.max(1, options.maxPolls ?? 40);
    this.pollDelayMs = Math.max(0, options.pollDelayMs ?? 3000);
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  async generate(imageUrl: string, prompt: string): Promise<MeshGenerateResult> {
    if (!this.configured) {
      return { ok: false, error: 'Meshy API key is not configured.', provider: this.provider, skipped: true };
    }
    try {
      const created = await this.fetchImpl(`${this.baseUrl}/openapi/v1/image-to-3d`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ image_url: imageUrl, object_prompt: prompt, enable_pbr: true }),
      });
      if (!created.ok) {
        const detail = await created.text().catch(() => '');
        return { ok: false, error: `Meshy error ${created.status}: ${detail.slice(0, 300)}`, provider: this.provider };
      }
      const createdJson = (await created.json().catch(() => null)) as { result?: string; id?: string } | null;
      const taskId = String(createdJson?.result || createdJson?.id || '');
      if (!taskId) return { ok: false, error: 'Meshy returned no task id.', provider: this.provider };

      for (let poll = 0; poll < this.maxPolls; poll += 1) {
        if (this.pollDelayMs > 0) await sleep(this.pollDelayMs);
        const res = await this.fetchImpl(`${this.baseUrl}/openapi/v1/image-to-3d/${taskId}`, { method: 'GET', headers: this.headers() });
        if (!res.ok) continue;
        const polled = (await res.json().catch(() => null)) as {
          status?: string;
          model_urls?: { glb?: string; gltf?: string; fbx?: string; usdz?: string };
          thumbnail_url?: string;
        } | null;
        const status = String(polled?.status || '').toUpperCase();
        if (status === 'SUCCEEDED') {
          const urls = polled?.model_urls || {};
          const modelUrl = String(urls.glb || urls.gltf || urls.fbx || urls.usdz || '');
          if (modelUrl) {
            return { ok: true, modelUrl, thumbnailUrl: polled?.thumbnail_url, format: normalizeMeshFormat(modelUrl), provider: this.provider };
          }
          return { ok: false, error: 'Meshy task succeeded but returned no model URL.', provider: this.provider };
        }
        if (status === 'FAILED' || status === 'CANCELED') {
          return { ok: false, error: `Meshy task ${status}.`, provider: this.provider };
        }
      }
      return { ok: false, error: 'Meshy task timed out.', provider: this.provider };
    } catch (err) {
      return { ok: false, error: err, provider: this.provider };
    }
  }
}
