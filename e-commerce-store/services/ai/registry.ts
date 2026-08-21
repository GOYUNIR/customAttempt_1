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
    case 'workers_ai':
      return new WorkersAiDriver({ runImpl: options.runImpl, model: options.model });
    default:
      return null;
  }
}

/** Every supported provider (used by the Setup Wizard dropdown + tests). */
export const AI_DRIVER_CATALOG: ReadonlyArray<{ provider: AiProvider; label: string; hint: string }> = [
  { provider: 'deepseek', label: 'DeepSeek Pro', hint: 'OpenAI-compatible — DEEPSEEK_API_KEY. Best price/quality for animation prompts.' },
  { provider: 'openai', label: 'OpenAI', hint: 'OPENAI_API_KEY — GPT-4o-mini chat completions.' },
  { provider: 'anthropic', label: 'Anthropic', hint: 'ANTHROPIC_API_KEY — Claude Messages API.' },
  { provider: 'replicate', label: 'Replicate', hint: 'REPLICATE_API_TOKEN — hosted Llama etc. (async predictions).' },
  { provider: 'workers_ai', label: 'Workers AI', hint: 'Native Cloudflare binding — no key required.' },
];
