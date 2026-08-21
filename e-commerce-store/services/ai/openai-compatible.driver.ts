/**
 * SERVICES / AI — generic OpenAI-compatible chat-completions driver.
 *
 * OpenRouter, Groq, Mistral and DeepSeek Lite all expose the OpenAI
 * `POST /chat/completions` shape, so a single class serves them all. The only
 * differences are the base URL, default model and the error label — all passed
 * in as options. Zero `@/` imports so `node --test` loads it directly.
 */

import type { AiDriver, AiGenerateResult, AiProvider } from './types.ts';

export interface OpenAiCompatibleDriverOptions {
  apiKey: string;
  provider: AiProvider;
  label: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatibleDriver implements AiDriver {
  readonly provider: AiProvider;
  readonly configured: boolean;

  private readonly apiKey: string;
  private readonly label: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleDriverOptions) {
    this.provider = options.provider;
    this.label = options.label;
    this.apiKey = String(options.apiKey || '').trim();
    this.configured = Boolean(this.apiKey);
    this.baseUrl = options.baseUrl;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async complete(prompt: string): Promise<AiGenerateResult> {
    if (!this.configured) {
      return { ok: false, error: `${this.label} API key is not configured.`, provider: this.provider, skipped: true };
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
        return { ok: false, error: `${this.label} error ${res.status}: ${detail.slice(0, 300)}`, provider: this.provider };
      }
      const data = (await res.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: string } }>;
      } | null;
      const text = String(data?.choices?.[0]?.message?.content || '').trim();
      if (!text) return { ok: false, error: `${this.label} returned an empty completion.`, provider: this.provider };
      return { ok: true, text, provider: this.provider };
    } catch (err) {
      return { ok: false, error: err, provider: this.provider };
    }
  }
}
