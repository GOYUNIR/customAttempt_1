/**
 * SERVICES / AI — the universal AI-engine contract.
 *
 * Functional features NEVER call DeepSeek / OpenAI / Anthropic / Replicate /
 * Workers AI SDKs directly. They resolve the active driver through
 * `AiFactory.getDriver()` and call the single standardized method:
 *
 *   complete(prompt) — a text completion (used by the image-to-animation and
 *                      dynamic-SVG pipelines; the prompt encodes the task).
 *
 * Every driver accepts an injectable `fetchImpl` (or `runImpl` for the native
 * Workers AI binding) so the node --test runner can assert request shape with
 * zero network I/O. This file has zero `@/` imports on purpose.
 */

import type { AiProvider } from '../config/types.ts';

export type { AiProvider } from '../config/types.ts';

/** Mask an API key for the admin UI — `sk-ds-••••••••1234`. Never leaks a usable secret. */
export function maskApiKey(key: string): string {
  const v = String(key || '').trim();
  if (!v) return '';
  if (v.length <= 10) {
    const keep = Math.min(2, v.length);
    return `${v.slice(0, keep)}${'•'.repeat(Math.max(1, v.length - keep))}`;
  }
  return `${v.slice(0, 6)}${'•'.repeat(Math.max(4, v.length - 10))}${v.slice(-4)}`;
}

export type AiGenerateResult =
  | { ok: true; text: string; provider: AiProvider }
  | { ok: false; error?: unknown; provider: AiProvider; skipped?: boolean };

export interface AiDriver {
  readonly provider: AiProvider;
  /** Whether the driver has the secrets/binding it needs. */
  readonly configured: boolean;
  /** Standardized text completion (used for animation + SVG generation). */
  complete(prompt: string): Promise<AiGenerateResult>;
}
