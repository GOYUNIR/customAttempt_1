/**
 * LICENSING GATEKEEPER — CLIENT_LICENSE_KEY / LICENSE_SERVER_URL.
 *
 * This module is the single source of truth for "can this install write data?".
 * It checks the local environment (or KV) for a `CLIENT_LICENSE_KEY` (alias
 * `LICENSE_KEY`), then — when a `LICENSE_SERVER_URL` is configured — performs an
 * ASYNCHRONOUS check against the license server and CACHES the verdict in
 * memory so the server is not hammered on every request.
 *
 * Four modes (matching the product spec):
 *   - ACTIVE                 → full read/write access.
 *   - GRACE (1–3 days past)  → full access + a "License payment pending."
 *                              top banner.
 *   - EXPIRED / MISSING KEY  → Demo Mode: block POST/PUT/DELETE write routes
 *                              and restrict administrative controls.
 *
 * DESIGN — deliberately ZERO-import (no `@/`, no Node builtins beyond global
 * `fetch`/`process.env`) so the `node --test` runner loads it with a plain
 * `import … from '../lib/license.ts'`, exactly like `drop-timestamps.ts`.
 */

export type LicenseStatus = 'ACTIVE' | 'GRACE' | 'EXPIRED' | 'MISSING';

/** Payload shape the license server MAY return. Every field is optional so a
 *  partial/legacy server never crashes classification. */
export interface LicenseServerPayload {
  /** Whether the key is valid. True/False only — absence means "no verdict". */
  valid?: boolean;
  /** Explicit mode from the server (`active` | `grace` | `expired`). */
  status?: 'active' | 'grace' | 'expired';
  /** ISO-8601 expiry timestamp used to derive ACTIVE → GRACE → EXPIRED. */
  expiresAt?: string;
  /** Grace window length in days (defaults to GRACE_WINDOW_DAYS). */
  graceDays?: number;
}

export interface LicenseResult {
  status: LicenseStatus;
  /** Masked key for admin display, e.g. `sk-ds-••••••••1234`. Empty when missing. */
  keyMasked: string;
  /** Whole days remaining in grace (0 unless `status === 'GRACE'`). */
  graceDaysRemaining: number;
  /** Human-readable reason — only set for EXPIRED / MISSING. */
  reason: string;
  /** Whether POST/PUT/DELETE writes are allowed (ACTIVE + GRACE only). */
  writesAllowed: boolean;
}

/** Days past the expiry that GRACE still grants full access. */
export const GRACE_WINDOW_DAYS = 3;
const DAY_MS = 86_400_000;

/** In-memory verdict cache TTL (ms). */
export const LICENSE_CACHE_TTL_MS = 60_000;
/** Network timeout for the license server call (ms). */
export const LICENSE_SERVER_TIMEOUT_MS = 4_000;

/** Read the configured license key. CLIENT_LICENSE_KEY wins, LICENSE_KEY is the legacy alias. */
export function resolveLicenseKey(): string {
  return String(process.env.CLIENT_LICENSE_KEY || process.env.LICENSE_KEY || '').trim();
}

/** The license server URL (empty when unset — env-only mode). */
export function licenseServerUrl(): string {
  return String(process.env.LICENSE_SERVER_URL || '').trim();
}

/** Mask a key for the admin UI: keep the first 6 chars + last 4, bullet the
 *  middle — `sk-ds-••••••••1234`. Never leaks a usable secret. */
export function maskLicenseKey(key: string): string {
  const v = String(key || '').trim();
  if (!v) return '';
  if (v.length <= 10) {
    const keep = Math.min(2, v.length);
    return `${v.slice(0, keep)}${'•'.repeat(Math.max(1, v.length - keep))}`;
  }
  return `${v.slice(0, 6)}${'•'.repeat(Math.max(4, v.length - 10))}${v.slice(-4)}`;
}

/** Whether writes (POST/PUT/DELETE) are permitted for a given status. */
export function isWriteAllowed(status: LicenseStatus): boolean {
  return status === 'ACTIVE' || status === 'GRACE';
}

/** The top notification banner text for a given status (null = no banner). */
export function licenseBanner(status: LicenseStatus): string | null {
  if (status === 'GRACE') return 'License payment pending.';
  if (status === 'EXPIRED') return 'License expired — running in Demo Mode (writes disabled).';
  if (status === 'MISSING') return 'No license key — running in Demo Mode (writes disabled).';
  return null;
}


/** Whether licensing is ENFORCED for this install. Enforcement turns on when a
 *  `LICENSE_ENFORCED=true`, a `LICENSE_SERVER_URL`, or a `CLIENT_LICENSE_KEY`
 *  is configured — so a legacy storefront (nothing set) keeps working with full
 *  writes, while a gated white-label deployment enforces Demo Mode on
 *  MISSING/EXPIRED keys. */
export function licenseEnforced(): boolean {
  if (process.env.LICENSE_ENFORCED === 'true' || process.env.LICENSE_ENFORCED === '1') return true;
  return Boolean(licenseServerUrl() || resolveLicenseKey());
}


/**
 * PURE classification — no I/O. Given the key + an optional server verdict,
 * produce the `LicenseResult`. This is the unit-tested core; the async wrapper
 * below just fetches `server` and feeds it here.
 */
export function classifyLicense(input: {
  key: string;
  server: LicenseServerPayload | null;
  now?: number;
}): LicenseResult {
  const key = String(input.key || '').trim();
  const now = input.now ?? Date.now();
  const masked = maskLicenseKey(key);

  if (!key) {
    return {
      status: 'MISSING',
      keyMasked: '',
      graceDaysRemaining: 0,
      reason: 'No license key configured — running in Demo Mode.',
      writesAllowed: false,
    };
  }

  const server = input.server;
  const explicit =
    server?.status ?? (server?.valid === false ? 'expired' : server?.valid === true ? 'active' : null);

  if (explicit === 'active') {
    return { status: 'ACTIVE', keyMasked: masked, graceDaysRemaining: 0, reason: '', writesAllowed: true };
  }

  if (explicit === 'grace') {
    const graceDays = Math.max(0, Number(server?.graceDays ?? GRACE_WINDOW_DAYS));
    return { status: 'GRACE', keyMasked: masked, graceDaysRemaining: graceDays, reason: '', writesAllowed: true };
  }

  if (explicit === 'expired') {
    return {
      status: 'EXPIRED',
      keyMasked: masked,
      graceDaysRemaining: 0,
      reason: 'License expired — running in Demo Mode.',
      writesAllowed: false,
    };
  }

  // No explicit server verdict — derive from `expiresAt` when available.
  if (server?.expiresAt) {
    const exp = Date.parse(server.expiresAt);
    if (Number.isFinite(exp)) {
      const graceEnd = exp + GRACE_WINDOW_DAYS * DAY_MS;
      if (now > graceEnd) {
        return {
          status: 'EXPIRED',
          keyMasked: masked,
          graceDaysRemaining: 0,
          reason: 'License expired — running in Demo Mode.',
          writesAllowed: false,
        };
      }
      if (now > exp) {
        const graceDaysRemaining = Math.max(1, Math.ceil((graceEnd - now) / DAY_MS));
        return { status: 'GRACE', keyMasked: masked, graceDaysRemaining, reason: '', writesAllowed: true };
      }
      return { status: 'ACTIVE', keyMasked: masked, graceDaysRemaining: 0, reason: '', writesAllowed: true };
    }
  }

  // Key present with no server verdict and no expiry — trust the local key.
  return { status: 'ACTIVE', keyMasked: masked, graceDaysRemaining: 0, reason: '', writesAllowed: true };
}

const licenseCache = new Map<string, { value: LicenseResult; expiresAt: number }>();

/** Forget the cached verdict (tests + admin license refresh). */
export function clearLicenseCache(): void {
  licenseCache.clear();
}

async function fetchServerVerdict(
  key: string,
  url: string,
  fetchImpl: typeof fetch,
): Promise<LicenseServerPayload | null> {
  if (!url) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LICENSE_SERVER_TIMEOUT_MS);
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: key, client: 'storefront' }),
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as LicenseServerPayload | null;
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null; // network failure → fall back to env-only classification
  }
}

/** The runtime entry point: resolve the key, fetch the server verdict (cached),
 *  and classify. Injected `fetchImpl` keeps it testable. */
export async function getLicenseStatus(opts?: {
  force?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<LicenseResult> {
  const key = resolveLicenseKey();
  if (!key) return classifyLicense({ key: '', server: null });
  const cacheKey = `license:${key}`;
  const now = Date.now();
  if (!opts?.force) {
    const hit = licenseCache.get(cacheKey);
    if (hit && hit.expiresAt > now) return hit.value;
  }
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const url = licenseServerUrl();
  const server = await fetchServerVerdict(key, url, fetchImpl);
  const result = classifyLicense({ key, server, now });
  licenseCache.set(cacheKey, { value: result, expiresAt: now + LICENSE_CACHE_TTL_MS });
  return result;
}
