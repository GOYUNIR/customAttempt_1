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

export class AiFactory {
  /** Resolve the active AI driver (cached settings; null when none). */
  static async getDriver(opts?: { force?: boolean }): Promise<AiDriver | null> {
    const options: AiDriverResolutionOptions = {};

    // 1. Wizard-configured provider.
    const settings = await getPlatformSettings(opts);
    if (settings?.ai_provider) {
      const key = settings.ai_api_key || '';
      if (settings.ai_provider === 'workers_ai' || key) {
        return createAiDriver(settings.ai_provider, key, options);
      }
    }

    // 2. Legacy env fallbacks.
    const envDrivers: Array<[AiProvider, string | undefined]> = [
      ['deepseek', process.env.DEEPSEEK_API_KEY],
      ['openai', process.env.OPENAI_API_KEY],
      ['anthropic', process.env.ANTHROPIC_API_KEY],
      ['replicate', process.env.REPLICATE_API_TOKEN],
    ];
    for (const [provider, key] of envDrivers) {
      if (key && String(key).trim()) {
        return createAiDriver(provider, String(key).trim(), options);
      }
    }

    // 3. Native Workers AI binding.
    const workersAi = createAiDriver('workers_ai', '', options);
    if (workersAi?.configured) return workersAi;

    return null;
  }
}
