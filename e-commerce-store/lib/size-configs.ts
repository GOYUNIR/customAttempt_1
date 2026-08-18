/**
 * Per-size raffle configuration — "customize each raffle differently."
 *
 * A product can have MULTIPLE sizes running a raffle, and each size can draw on
 * its OWN schedule. `product.sizeConfigs` is a map keyed by the normalized
 * (lower-cased, trimmed) size label:
 *
 *   {
 *     'standard': { releaseEndsAt: '2026-08-20T18:00',
 *                   customDropSchedule: { mode: 'custom', customIntervalHours: 12 } },
 *     'collector': { releaseEndsAt: '2026-08-22T21:00' }
 *   }
 *
 *   - `releaseEndsAt`        → this size's OWN countdown end (blank = inherit
 *                              the product-level `releaseEndsAt`).
 *   - `customDropSchedule`   → this size's OWN recurring cadence (blank =
 *                              inherit product → global cadence).
 *
 * Every consumer (the draw engine, /api/store, /api/catalog/status and the
 * product-page countdown) resolves through these helpers so the UI always shows
 * the SAME timer the engine will draw on — never a size-mixed mismatch.
 *
 * This module is intentionally self-contained (no `@/` VALUE imports — only a
 * type-only reference to `DropScheduleConfig` that is erased at runtime) so the
 * `node --test` runner can load it directly.
 */

import type { DropScheduleConfig } from '@/lib/storefront-config';

export interface SizeRaffleConfig {
  /** This size's own countdown end (naive store-time wall clock). Empty/absent = inherit product-level. */
  releaseEndsAt?: string;
  /** This size's own recurring schedule. Empty/absent = inherit product → global. */
  customDropSchedule?: Partial<DropScheduleConfig>;
}

/** Normalize a size label the exact same way every consumer looks it up. */
export function sizeConfigKey(size: string): string {
  return String(size || '').trim().toLowerCase();
}

/** Read the raw `sizeConfigs` map off a product (never throws on malformed data). */
export function sizeConfigsOf(product: any): Record<string, SizeRaffleConfig> {
  const raw = product?.sizeConfigs;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, SizeRaffleConfig> = {};
  for (const [key, value] of Object.entries(raw as Record<string, any>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry: SizeRaffleConfig = {};
    if (typeof value.releaseEndsAt === 'string' && value.releaseEndsAt.trim()) {
      entry.releaseEndsAt = value.releaseEndsAt.trim();
    }
    if (value.customDropSchedule && typeof value.customDropSchedule === 'object' && !Array.isArray(value.customDropSchedule)) {
      entry.customDropSchedule = value.customDropSchedule as Partial<DropScheduleConfig>;
    }
    if (Object.keys(entry).length > 0) out[sizeConfigKey(key)] = entry;
  }
  return out;
}

/** This size's own countdown end, or '' when the size inherits the product value. */
export function getSizeReleaseEndsAt(product: any, size: string): string {
  const cfg = sizeConfigsOf(product)[sizeConfigKey(size)];
  return typeof cfg?.releaseEndsAt === 'string' ? cfg.releaseEndsAt.trim() : '';
}

/** This size's own recurring schedule, or undefined when it inherits product → global. */
export function getSizeCustomSchedule(product: any, size: string): Partial<DropScheduleConfig> | undefined {
  const cfg = sizeConfigsOf(product)[sizeConfigKey(size)];
  const value = cfg?.customDropSchedule;
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) {
    return value as Partial<DropScheduleConfig>;
  }
  return undefined;
}

/** Effective countdown end for a size: the per-size override wins, else product-level. */
export function resolveSizeReleaseEndsAt(product: any, size: string): string {
  return getSizeReleaseEndsAt(product, size) || String(product?.releaseEndsAt || '').trim();
}

/** Effective schedule for a size: per-size → per-product → caller-supplied global. */
export function resolveSizeSchedule(
  product: any,
  size: string,
  globalSchedule: Partial<DropScheduleConfig> | Record<string, any> = {},
): DropScheduleConfig {
  const productSchedule = { ...(globalSchedule || {}), ...(product?.customDropSchedule || {}) };
  return { ...productSchedule, ...(getSizeCustomSchedule(product, size) || {}) } as DropScheduleConfig;
}

/**
 * Sanitize an admin-provided `sizeConfigs` map. Only sizes that actually exist
 * on the product survive (a deleted/renamed size's config is dropped), and only
 * the fields the engine understands are kept. This is the ONLY writer used by
 * the admin products route.
 */
export function normalizeSizeConfigs(raw: unknown, priceCategories: unknown[] = []): Record<string, SizeRaffleConfig> {
  const available = new Set<string>();
  (Array.isArray(priceCategories) ? priceCategories : []).forEach((c: any) => {
    const key = sizeConfigKey(c?.size);
    if (key) available.add(key);
  });
  const out: Record<string, SizeRaffleConfig> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, any>)) {
    const k = sizeConfigKey(key);
    if (!k || !available.has(k)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry: SizeRaffleConfig = {};
    if (typeof value.releaseEndsAt === 'string' && value.releaseEndsAt.trim()) {
      entry.releaseEndsAt = value.releaseEndsAt.trim();
    }
    if (value.customDropSchedule && typeof value.customDropSchedule === 'object' && !Array.isArray(value.customDropSchedule)) {
      const schedule = value.customDropSchedule as Record<string, any>;
      const VALID_MODES = new Set(['fixed', 'hourly', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly', 'custom']);
      const mode = typeof schedule.mode === 'string' && VALID_MODES.has(schedule.mode) ? schedule.mode : null;
      if (mode) {
        const clean = (n: unknown, fallback = 0) => {
          const parsed = Number(n);
          return Number.isFinite(parsed) ? parsed : fallback;
        };
        entry.customDropSchedule = {
          mode: mode as 'fixed' | 'hourly' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom',
          timezone: typeof schedule.timezone === 'string' ? schedule.timezone : '',
          targetEndDateTime: typeof schedule.targetEndDateTime === 'string' ? schedule.targetEndDateTime : '',
          drawDayOfWeek: clean(schedule.drawDayOfWeek, 6),
          drawDayOfMonth: clean(schedule.drawDayOfMonth, 1),
          drawHour: clean(schedule.drawHour, 21),
          drawMinute: clean(schedule.drawMinute, 0),
          drawSecond: clean(schedule.drawSecond, 0),
          customIntervalHours: clean(schedule.customIntervalHours, 24),
        };
      }
    }
    if (Object.keys(entry).length > 0) out[k] = entry;
  }
  return out;
}
