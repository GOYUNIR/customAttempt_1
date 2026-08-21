/**
 * SERVICES / AI — public barrel.
 *
 *   types.ts      — AiDriver contract + maskApiKey (AiProvider re-exported from
 *                   services/config/types.ts)
 *   registry.ts   — createAiDriver() + AI_DRIVER_CATALOG
 *   factory.ts    — AiFactory.getDriver() (platform settings → env → Workers AI)
 *   *.driver.ts   — DeepSeek / OpenAI / Anthropic / Replicate / Workers AI
 */

export * from './types';
export { createAiDriver, AI_DRIVER_CATALOG, type AiDriverResolutionOptions } from './registry';
export { AiFactory } from './factory';
