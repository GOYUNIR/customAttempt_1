/**
 * Single source of truth for admin-action labels shared across the admin
 * portal UI, API self-test output, and docs.
 *
 * These used to be hardcoded (and inconsistent) in multiple places — e.g. the
 * Developer tab titled a card "Tidy Redis Schema" while its button read
 * "Tidy & Migrate Redis Schema". Keeping the exact wording in one module means
 * the UI and the API can never drift apart again.
 *
 * This file has ZERO imports on purpose so it stays edge-safe and loadable by
 * the `node --test` runner (no `@/` alias).
 */

/** Canonical label for the Redis tidy/migrate maintenance action. */
export const TIDY_REDIS_ACTION_LABEL = 'Tidy & Migrate Redis Schema';

/** Canonical label for the third-party provider keys section. */
export const API_KEYS_INTEGRATIONS_LABEL = 'API Keys & Integrations';
