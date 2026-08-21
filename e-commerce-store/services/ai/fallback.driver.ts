/**
 * SERVICES / AI — primary → secondary fallback composite driver.
 *
 * Wraps the configured PRIMARY driver and an optional SECONDARY driver. When
 * the primary `complete()` fails, the secondary is tried automatically, so a
 * transient primary outage never blocks asset generation. The composite
 * reports the PRIMARY's provider (so the admin UI shows the primary), while a
 * successful secondary result still carries the secondary's own provider.
 * Zero `@/` imports so `node --test` loads it directly.
 */

import type { AiDriver, AiGenerateResult, AiProvider } from './types.ts';

export class FallbackAiDriver implements AiDriver {
  readonly provider: AiProvider;
  readonly configured: boolean;

  private readonly primary: AiDriver;
  private readonly secondary?: AiDriver;

  constructor(primary: AiDriver, secondary?: AiDriver) {
    this.primary = primary;
    this.secondary = secondary;
    this.provider = primary.provider;
    this.configured = primary.configured || Boolean(secondary?.configured);
  }

  async complete(prompt: string): Promise<AiGenerateResult> {
    const primaryResult = await this.primary.complete(prompt);
    if (primaryResult.ok) return primaryResult;

    if (this.secondary?.configured) {
      const secondaryResult = await this.secondary.complete(prompt);
      if (secondaryResult.ok) return secondaryResult;
      return {
        ok: false,
        error: secondaryResult.error ?? 'Secondary AI provider also failed.',
        provider: this.secondary.provider,
      };
    }

    return primaryResult;
  }
}
