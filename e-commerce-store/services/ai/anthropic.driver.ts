/**
 * SERVICES / AI — Anthropic driver (Messages API).
 *   POST https://api.anthropic.com/v1/messages
 *   Headers: x-api-key + anthropic-version: 2023-06-01
 */

import type { AiDriver, AiGenerateResult, AiProvider } from './types.ts';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-3-5-haiku-latest';

export interface AnthropicDriverOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  model?: string;
  baseUrl?: string;
}

export class AnthropicDriver implements AiDriver {
  readonly provider: AiProvider = 'anthropic';
  readonly configured: boolean;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: AnthropicDriverOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.configured = Boolean(this.apiKey);
    this.fetchImpl = options.fetchImpl || fetch;
    this.model = options.model || ANTHROPIC_MODEL;
    this.baseUrl = options.baseUrl || ANTHROPIC_API_URL;
  }

  async complete(prompt: string): Promise<AiGenerateResult> {
    if (!this.configured) {
      return { ok: false, error: 'Anthropic API key is not configured.', provider: this.provider, skipped: true };
    }
    try {
      const res = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, error: `Anthropic error ${res.status}: ${detail.slice(0, 300)}`, provider: this.provider };
      }
      const data = (await res.json().catch(() => null)) as {
        content?: Array<{ type?: string; text?: string }>;
      } | null;
      const text = String(data?.content?.find((c) => c.type === 'text')?.text || '').trim();
      if (!text) return { ok: false, error: 'Anthropic returned an empty completion.', provider: this.provider };
      return { ok: true, text, provider: this.provider };
    } catch (err) {
      return { ok: false, error: err, provider: this.provider };
    }
  }
}
