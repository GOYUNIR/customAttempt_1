/**
 * SERVICES / AI — Google Gemini driver.
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}
 *   Docs: https://ai.google.dev/gemini-api/docs/text-generation
 *
 * The API key is passed as a query param (not an Authorization header), which
 * is why this needs its own driver instead of the OpenAI-compatible one.
 * Zero `@/` imports so `node --test` loads it directly.
 */

import type { AiDriver, AiGenerateResult, AiProvider } from './types.ts';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = 'gemini-1.5-flash';

export interface GoogleGeminiDriverOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  model?: string;
  baseUrl?: string;
}

export class GoogleGeminiDriver implements AiDriver {
  readonly provider: AiProvider = 'google_gemini';
  readonly configured: boolean;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: GoogleGeminiDriverOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.configured = Boolean(this.apiKey);
    this.fetchImpl = options.fetchImpl || fetch;
    this.model = options.model || GEMINI_MODEL;
    this.baseUrl = (options.baseUrl || GEMINI_BASE_URL).replace(/\/+$/, '');
  }

  async complete(prompt: string): Promise<AiGenerateResult> {
    if (!this.configured) {
      return { ok: false, error: 'Google Gemini API key is not configured.', provider: this.provider, skipped: true };
    }
    try {
      const url = `${this.baseUrl}/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, error: `Google Gemini error ${res.status}: ${detail.slice(0, 300)}`, provider: this.provider };
      }
      const data = (await res.json().catch(() => null)) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      } | null;
      const text = String(data?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text || '').trim();
      if (!text) return { ok: false, error: 'Google Gemini returned an empty completion.', provider: this.provider };
      return { ok: true, text, provider: this.provider };
    } catch (err) {
      return { ok: false, error: err, provider: this.provider };
    }
  }
}
