/**
 * Product lifecycle status — the SINGLE source of truth for a product's state.
 *
 * Replaces the legacy `isActive` / `isArchived` / `isUpcoming` boolean triple
 * with one strict enum:
 *
 *   - 'DRAFT'     — hidden, not yet live (replaces "hidden" + "upcoming").
 *   - 'ACTIVE'    — visible on the storefront.
 *   - 'ARCHIVED'  — retired (kept for history, never rendered as live).
 *
 * Redis is the primary store (not a SQL DB), so the "DB enum" is enforced at
 * the application layer here — every read/write path resolves through these
 * helpers, and the legacy booleans are DERIVED from the enum (never the other
 * way around on write) so a product can never end up in two states at once.
 *
 * This module is dependency-free (no `@/` imports) so `node --test`, the admin
 * client, and the API routes all import the same logic.
 */

export const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const PRODUCT_STATUS_LABELS: Record<ProductStatus, string> = {
  DRAFT: 'Draft (hidden)',
  ACTIVE: 'Active (visible)',
  ARCHIVED: 'Archived',
};

/** Type guard for the enum. */
export function isProductStatus(value: unknown): value is ProductStatus {
  return value === 'DRAFT' || value === 'ACTIVE' || value === 'ARCHIVED';
}

/** Normalize an arbitrary value to a valid status (falls back to `fallback`). */
export function normalizeProductStatus(value: unknown, fallback: ProductStatus = 'DRAFT'): ProductStatus {
  const s = String(value ?? '').trim().toUpperCase();
  return isProductStatus(s) ? s : fallback;
}

/**
 * Derive the enum status from a raw product record. An explicit `status` field
 * (the new canonical form) always wins; otherwise the legacy boolean triple is
 * resolved deterministically:
 *
 *   - archived  → ARCHIVED (highest precedence — it's terminal).
 *   - upcoming  → DRAFT    (hidden, not yet live).
 *   - isActive !== false → ACTIVE, else DRAFT.
 */
export function statusFromLegacy(input: {
  status?: unknown;
  isActive?: unknown;
  isArchived?: unknown;
  isUpcoming?: unknown;
} = {}): ProductStatus {
  if (isProductStatus(input.status)) return input.status;
  if (input.isArchived === true || input.isArchived === 'true') return 'ARCHIVED';
  if (input.isUpcoming === true || input.isUpcoming === 'true') return 'DRAFT';
  return input.isActive === false || input.isActive === 'false' ? 'DRAFT' : 'ACTIVE';
}

/**
 * Project the enum back onto the legacy booleans so every existing consumer
 * (storefront, catalog sync, sanity checks, live-state seeding) keeps working
 * with zero changes. The three booleans are mutually exclusive by construction.
 */
export function legacyBooleansFromStatus(status: ProductStatus): {
  isActive: boolean;
  isArchived: boolean;
  isUpcoming: boolean;
} {
  switch (status) {
    case 'ARCHIVED':
      return { isActive: false, isArchived: true, isUpcoming: false };
    case 'DRAFT':
      return { isActive: false, isArchived: false, isUpcoming: false };
    case 'ACTIVE':
      return { isActive: true, isArchived: false, isUpcoming: false };
  }
}
