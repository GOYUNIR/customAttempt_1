/**
 * SERVICES / AI — DeepSeek driver (OpenAI-compatible chat completions).
 *
 * DeepSeek Pro exposes an OpenAI-compatible endpoint, so this driver shares the
 * request shape with the OpenAI driver but hits DeepSeek's host + model.
 *   POST https://api.deepseek.com/chat/completions
 *   Docs: https://api-docs.deepseek.com/
 */

import type { AiDriver, AiGenerateResult, AiProvider } from './types.ts';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

export interface DeepSeekDriverOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  model?: string;
  baseUrl?: string;
}

export class DeepSeekDriver implements AiDriver {
  readonly provider: AiProvider = 'deepseek';
  readonly configured: boolean;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: DeepSeekDriverOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.configured = Boolean(this.apiKey);
    this.fetchImpl = options.fetchImpl || fetch;
    this.model = options.model || DEEPSEEK_MODEL;
    this.baseUrl = options.baseUrl || DEEPSEEK_API_URL;
  }

  async complete(prompt: string): Promise<AiGenerateResult> {
    if (!this.configured) {
      return { ok: false, error: 'DeepSeek API key is not configured.', provider: this.provider, skipped: true };
    }
    try {
      const res = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7,
          max_tokens: 2048,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, error: `DeepSeek error ${res.status}: ${detail.slice(0, 300)}`, provider: this.provider };
      }
      const data = (await res.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: string } }>;
      } | null;
      const text = String(data?.choices?.[0]?.message?.content || '').trim();
      if (!text) return { ok: false, error: 'DeepSeek returned an empty completion.', provider: this.provider };
      return { ok: true, text, provider: this.provider };
    } catch (err) {
      return { ok: false, error: err, provider: this.provider };
    }
  }
}
