/**
 * SERVICES / AI — Replicate driver (predictions API).
 *
 * Replicate is ASYNCHRONOUS: POST /v1/predictions returns a prediction id, then
 * GET /v1/predictions/{id} is polled until `status: "succeeded"`. This driver
 * polls a bounded number of times (default 12, ~250ms apart) so the pipeline
 * stays within a request budget and never hangs.
 */

import type { AiDriver, AiGenerateResult, AiProvider } from './types.ts';

const REPLICATE_API_URL = 'https://api.replicate.com/v1/predictions';
const REPLICATE_MODEL = 'meta/meta-llama-3-8b-instruct';

export interface ReplicateDriverOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  model?: string;
  baseUrl?: string;
  maxPolls?: number;
  pollDelayMs?: number;
}

export class ReplicateDriver implements AiDriver {
  readonly provider: AiProvider = 'replicate';
  readonly configured: boolean;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxPolls: number;
  private readonly pollDelayMs: number;

  constructor(options: ReplicateDriverOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.configured = Boolean(this.apiKey);
    this.fetchImpl = options.fetchImpl || fetch;
    this.model = options.model || REPLICATE_MODEL;
    this.baseUrl = options.baseUrl || REPLICATE_API_URL;
    this.maxPolls = Math.max(1, options.maxPolls ?? 12);
    this.pollDelayMs = Math.max(0, options.pollDelayMs ?? 250);
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  private extractText(output: unknown): string {
    if (typeof output === 'string') return output.trim();
    if (Array.isArray(output)) return output.map((o) => String(o ?? '')).join('\n').trim();
    return '';
  }

  async complete(prompt: string): Promise<AiGenerateResult> {
    if (!this.configured) {
      return { ok: false, error: 'Replicate API token is not configured.', provider: this.provider, skipped: true };
    }
    try {
      const created = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model: this.model, input: { prompt, max_tokens: 2048 } }),
      });
      if (!created.ok) {
        const detail = await created.text().catch(() => '');
        return { ok: false, error: `Replicate error ${created.status}: ${detail.slice(0, 300)}`, provider: this.provider };
      }
      const prediction = (await created.json().catch(() => null)) as {
        id?: string;
        status?: string;
        output?: unknown;
      } | null;
      if (prediction?.status === 'succeeded') {
        const text = this.extractText(prediction.output);
        if (text) return { ok: true, text, provider: this.provider };
      }

      const id = String(prediction?.id || '');
      if (!id) return { ok: false, error: 'Replicate returned no prediction id.', provider: this.provider };

      for (let poll = 0; poll < this.maxPolls; poll += 1) {
        if (this.pollDelayMs > 0) await new Promise((r) => setTimeout(r, this.pollDelayMs));
        const res = await this.fetchImpl(`${this.baseUrl}/${id}`, { method: 'GET', headers: this.headers() });
        if (!res.ok) continue;
        const polled = (await res.json().catch(() => null)) as { status?: string; output?: unknown } | null;
        if (polled?.status === 'succeeded') {
          const text = this.extractText(polled.output);
          if (text) return { ok: true, text, provider: this.provider };
          return { ok: false, error: 'Replicate prediction produced no text output.', provider: this.provider };
        }
        if (polled?.status === 'failed' || polled?.status === 'canceled') {
          return { ok: false, error: `Replicate prediction ${polled.status}.`, provider: this.provider };
        }
      }

      return { ok: false, error: 'Replicate prediction timed out.', provider: this.provider };
    } catch (err) {
      return { ok: false, error: err, provider: this.provider };
    }
  }
}
