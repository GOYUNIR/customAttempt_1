/**
 * ─────────────────────────────────────────────────────────────────────────────
 * UNIVERSAL ITEM ENGINE — public entry point.
 *
 * Re-exports the type registry + validator so callers (the /b business-owner
 * item editor, and eventually the draw/checkout engines) import from ONE place:
 *
 *   import { validateRules, listItemTypes, itemTypeHasCapability } from '@/lib/item-engine';
 *
 * ZERO runtime deps beyond the sibling modules (all relative `.ts` imports,
 * matching the `services/` driver-engine convention).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { validateJsonSchema } from './json-schema.ts';
import { getItemTypeMeta } from './registry.ts';
import { sanitizeItemType, type ItemType } from './types.ts';

export type {
  ItemType,
  ItemStatus,
  ItemCapability,
  ItemTypeMeta,
  ItemRecord,
  JsonSchema,
} from './types.ts';
export {
  ITEM_TYPE_IDS,
  ITEM_STATUSES,
  sanitizeItemType,
  sanitizeItemStatus,
} from './types.ts';
export { validateJsonSchema, deepEqual, type SchemaValidationResult } from './json-schema.ts';
export {
  ITEM_TYPES,
  getItemTypeMeta,
  isItemType,
  itemTypeHasCapability,
  listItemTypes,
} from './registry.ts';

export interface RulesValidationResult {
  ok: boolean;
  errors: string[];
  /** The resolved item type (or null when the input was not a known type). */
  itemType: ItemType | null;
}

/** Coerce an untrusted `rules` value into a plain object (never null/array). */
export function normalizeRules(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

/**
 * Validate a `rules` blob against the JSON Schema for its `itemType`.
 * Returns `{ ok, errors, itemType }` — `itemType` is null when the type is
 * unknown (callers should reject the item before storing it).
 */
export function validateRules(itemType: unknown, rules: unknown): RulesValidationResult {
  const resolved = sanitizeItemType(itemType);
  if (!resolved) {
    return { ok: false, errors: [`Unknown item type "${String(itemType)}"`], itemType: null };
  }
  const schema = getItemTypeMeta(resolved).jsonSchema;
  const result = validateJsonSchema(schema, normalizeRules(rules));
  return { ok: result.ok, errors: result.errors, itemType: resolved };
}
