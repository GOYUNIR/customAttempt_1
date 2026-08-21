/**
 * SERVICES / AI — Cloudflare Workers AI driver (native binding).
 *
 * Runs on the platform's `AI` binding (`AI.run(model, { prompt })`) with ZERO
 * API key — the cheapest provider for Cloudflare deployments. When no binding
 * is present the driver reports `configured: false` and the factory falls back
 * to a keyed provider. `runImpl` is injectable for tests.
 */

import type { AiDriver, AiGenerateResult, AiProvider } from './types.ts';

const WORKERS_AI_MODEL = '@cf/meta/llama-3-8b-instruct';

export type WorkersAiRunFn = (model: string, input: { prompt: string }) => Promise<unknown>;

export interface WorkersAiDriverOptions {
  /** Inject the `AI.run` binding (defaults to auto-detecting `globalThis.AI`). */
  runImpl?: WorkersAiRunFn;
  model?: string;
}

function detectWorkersAiBinding(): WorkersAiRunFn | null {
  try {
    const g = globalThis as Record<string, unknown>;
    const ai = g.AI as { run?: unknown } | undefined;
    if (ai && typeof ai.run === 'function') {
      return (model: string, input: { prompt: string }) => (ai.run as (m: string, i: unknown) => Promise<unknown>)(model, input);
    }
  } catch {
    /* no binding */
  }
  return null;
}

export class WorkersAiDriver implements AiDriver {
  readonly provider: AiProvider = 'workers_ai';
  readonly configured: boolean;

  private readonly run: WorkersAiRunFn | null;
  private readonly model: string;

  constructor(options: WorkersAiDriverOptions = {}) {
    this.run = options.runImpl ?? detectWorkersAiBinding();
    this.model = options.model || WORKERS_AI_MODEL;
    this.configured = Boolean(this.run);
  }

  async complete(prompt: string): Promise<AiGenerateResult> {
    if (!this.run) {
      return { ok: false, error: 'Workers AI binding is not available.', provider: this.provider, skipped: true };
    }
    try {
      const output = await this.run(this.model, { prompt });
      let text = '';
      if (typeof output === 'string') text = output.trim();
      else if (output && typeof output === 'object') {
        const candidate = (output as { response?: unknown }).response;
        if (typeof candidate === 'string') text = candidate.trim();
        else if (Array.isArray(candidate)) {
          const first = (candidate as unknown[])[0];
          if (first && typeof first === 'object') text = String((first as { response?: unknown }).response || '').trim();
        }
      }
      if (!text) return { ok: false, error: 'Workers AI returned an empty completion.', provider: this.provider };
      return { ok: true, text, provider: this.provider };
    } catch (err) {
      return { ok: false, error: err, provider: this.provider };
    }
  }
}
