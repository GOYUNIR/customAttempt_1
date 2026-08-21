/**
 * SERVICES / AI — driver registry (pure factory helper).
 *
 * `createAiDriver()` maps a provider string to its concrete driver. Free of
 * `@/` imports and network access so `node --test` loads it directly — the
 * runtime `AiFactory` (factory.ts) resolves provider + key and delegates here.
 */

import type { AiProvider } from './types.ts';
import type { AiDriver } from './types.ts';
import { DeepSeekDriver } from './deepseek.driver.ts';
import { OpenAiDriver } from './openai.driver.ts';
import { AnthropicDriver } from './anthropic.driver.ts';
import { ReplicateDriver } from './replicate.driver.ts';
import { WorkersAiDriver, type WorkersAiRunFn } from './workers-ai.driver.ts';
import { OpenAiCompatibleDriver } from './openai-compatible.driver.ts';
import { GoogleGeminiDriver } from './google-gemini.driver.ts';

export interface AiDriverResolutionOptions {
  fetchImpl?: typeof fetch;
  model?: string;
  baseUrl?: string;
  runImpl?: WorkersAiRunFn;
  maxPolls?: number;
  pollDelayMs?: number;
}

/** Resolve the provider string → driver instance. Returns null for unknown. */
export function createAiDriver(
  provider: AiProvider,
  apiKey: string,
  options: AiDriverResolutionOptions = {},
): AiDriver | null {
  switch (provider) {
    case 'deepseek':
      return new DeepSeekDriver({ apiKey, fetchImpl: options.fetchImpl, model: options.model, baseUrl: options.baseUrl });
    case 'deepseek_lite':
      return new OpenAiCompatibleDriver({
        apiKey,
        provider: 'deepseek_lite',
        label: 'DeepSeek Lite',
        baseUrl: options.baseUrl || 'https://api.deepseek.com/chat/completions',
        model: options.model || 'deepseek-chat',
        fetchImpl: options.fetchImpl,
      });
    case 'openai':
      return new OpenAiDriver({ apiKey, fetchImpl: options.fetchImpl, model: options.model, baseUrl: options.baseUrl });
    case 'anthropic':
      return new AnthropicDriver({ apiKey, fetchImpl: options.fetchImpl, model: options.model, baseUrl: options.baseUrl });
    case 'replicate':
      return new ReplicateDriver({
        apiKey,
        fetchImpl: options.fetchImpl,
        model: options.model,
        baseUrl: options.baseUrl,
        maxPolls: options.maxPolls,
        pollDelayMs: options.pollDelayMs,
      });
    case 'openrouter':
      return new OpenAiCompatibleDriver({
        apiKey,
        provider: 'openrouter',
        label: 'OpenRouter',
        baseUrl: options.baseUrl || 'https://openrouter.ai/api/v1/chat/completions',
        model: options.model || 'openrouter/auto',
        fetchImpl: options.fetchImpl,
      });
    case 'groq':
      return new OpenAiCompatibleDriver({
        apiKey,
        provider: 'groq',
        label: 'Groq',
        baseUrl: options.baseUrl || 'https://api.groq.com/openai/v1/chat/completions',
        model: options.model || 'llama-3.1-8b-instant',
        fetchImpl: options.fetchImpl,
      });
    case 'mistral':
      return new OpenAiCompatibleDriver({
        apiKey,
        provider: 'mistral',
        label: 'Mistral',
        baseUrl: options.baseUrl || 'https://api.mistral.ai/v1/chat/completions',
        model: options.model || 'mistral-small-latest',
        fetchImpl: options.fetchImpl,
      });
    case 'google_gemini':
      return new GoogleGeminiDriver({ apiKey, fetchImpl: options.fetchImpl, model: options.model, baseUrl: options.baseUrl });
    case 'workers_ai':
      return new WorkersAiDriver({ runImpl: options.runImpl, model: options.model });
    default:
      return null;
  }
}

/** Every supported provider (used by the Setup Wizard dropdown + tests). */
export const AI_DRIVER_CATALOG: ReadonlyArray<{ provider: AiProvider; label: string; hint: string }> = [
  { provider: 'deepseek', label: 'DeepSeek Pro', hint: 'OpenAI-compatible — DEEPSEEK_API_KEY. Best price/quality for animation prompts (the default primary).' },
  { provider: 'deepseek_lite', label: 'DeepSeek Lite', hint: 'Same DeepSeek API, lighter tier — a cheap secondary fallback.' },
  { provider: 'openai', label: 'OpenAI', hint: 'OPENAI_API_KEY — GPT-4o-mini chat completions.' },
  { provider: 'anthropic', label: 'Anthropic', hint: 'ANTHROPIC_API_KEY — Claude Messages API.' },
  { provider: 'openrouter', label: 'OpenRouter', hint: 'OPENROUTER_API_KEY — one key for hundreds of models (OpenAI-compatible).' },
  { provider: 'groq', label: 'Groq', hint: 'GROQ_API_KEY — fast Llama inference (OpenAI-compatible).' },
  { provider: 'mistral', label: 'Mistral', hint: 'MISTRAL_API_KEY — Mistral models (OpenAI-compatible).' },
  { provider: 'google_gemini', label: 'Google Gemini', hint: 'GEMINI_API_KEY — Gemini 1.5 Flash text generation.' },
  { provider: 'replicate', label: 'Replicate', hint: 'REPLICATE_API_TOKEN — hosted models (async predictions).' },
  { provider: 'workers_ai', label: 'Workers AI', hint: 'Native Cloudflare binding — no key required.' },
];
