/**
 * SERVICES / AI — runtime factory.
 *
 * `AiFactory.getDriver()` is the ONLY way functional features obtain an AI
 * driver. Resolution order:
 *
 *   1. `global_platform_settings.ai_provider` + `.ai_api_key` (Setup Wizard).
 *   2. Legacy env fallback so an un-wizarded store works:
 *        DEEPSEEK_API_KEY    → DeepSeekDriver
 *        OPENAI_API_KEY      → OpenAiDriver
 *        ANTHROPIC_API_KEY   → AnthropicDriver
 *        REPLICATE_API_TOKEN → ReplicateDriver
 *   3. Native Cloudflare Workers AI binding (no key).
 *   4. null when nothing is configured → callers use the CSS/SVG fallbacks.
 */

import { getPlatformSettings } from '@/services/config/platform-settings';
import type { AiProvider } from '@/services/config/types';
import { createAiDriver, type AiDriverResolutionOptions } from './registry';
import type { AiDriver } from './types';
import { FallbackAiDriver } from './fallback.driver';

export class AiFactory {
  /** Resolve the active AI driver (cached settings; null when none). Returns a
   *  PRIMARY driver wrapped in a FallbackAiDriver when a SECONDARY is also
   *  configured, so a primary failure transparently fails over to the backup. */
  static async getDriver(opts?: { force?: boolean }): Promise<AiDriver | null> {
    const options: AiDriverResolutionOptions = {};
    const settings = await getPlatformSettings(opts);

    // 1. PRIMARY (mandatory) — wizard-configured first, then legacy env, then
    //    the native Workers AI binding.
    let primary: AiDriver | null = null;
    if (settings?.ai_provider) {
      const key = settings.ai_api_key || '';
      if (settings.ai_provider === 'workers_ai' || key) {
        primary = createAiDriver(settings.ai_provider, key, options);
      }
    }
    if (!primary) primary = AiFactory.resolveEnvPrimary(options);
    if (!primary) {
      const workersAi = createAiDriver('workers_ai', '', options);
      if (workersAi?.configured) primary = workersAi;
    }

    // 2. SECONDARY (optional) — wizard-configured only, no env fallback.
    let secondary: AiDriver | null = null;
    if (settings?.ai_provider_secondary) {
      const key = settings.ai_api_key_secondary || '';
      if (settings.ai_provider_secondary === 'workers_ai' || key) {
        secondary = createAiDriver(settings.ai_provider_secondary, key, options);
      }
    }

    if (!primary) return null;
    return secondary?.configured ? new FallbackAiDriver(primary, secondary) : primary;
  }

  /** Legacy env-var resolution for the PRIMARY driver (used when the wizard has
   *  not persisted an AI provider yet — e.g. a fresh clone). */
  private static resolveEnvPrimary(options: AiDriverResolutionOptions): AiDriver | null {
    const envDrivers: Array<[AiProvider, string | undefined]> = [
      ['deepseek', process.env.DEEPSEEK_API_KEY],
      ['openai', process.env.OPENAI_API_KEY],
      ['anthropic', process.env.ANTHROPIC_API_KEY],
      ['replicate', process.env.REPLICATE_API_TOKEN],
      ['openrouter', process.env.OPENROUTER_API_KEY],
      ['groq', process.env.GROQ_API_KEY],
      ['mistral', process.env.MISTRAL_API_KEY],
      ['google_gemini', process.env.GEMINI_API_KEY],
    ];
    for (const [provider, key] of envDrivers) {
      if (key && String(key).trim()) {
        return createAiDriver(provider, String(key).trim(), options);
      }
    }
    return null;
  }
}
