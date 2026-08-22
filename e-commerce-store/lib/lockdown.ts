/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LOCKDOWN ENGINE — immutable setup configuration.
 *
 * Once the initial system settings are configured during setup, the critical
 * system parameters below are LOCKED from being edited via public or standard
 * endpoints. Post-setup changes are restricted exclusively to authenticated
 * Tier 1 Super Admin sessions that have completed verified step-up
 * authentication (re-authenticated shortly before the change).
 *
 * This module is the PURE decision engine (what is allowed, why). The actual
 * persistence lives in `public.system_locks` (supabase/migrations/00003). It is
 * deliberately ZERO-import so it is edge-safe + `node --test`-loadable.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Roles relevant to lockdown decisions (mirrors lib/rbac.ts). */
export type ActorRole = 'super_admin' | 'sales' | 'owner' | 'staff' | 'customer';

/** The authenticated actor making a change. */
export interface LockActor {
  role: ActorRole | null;
  /** True only when the actor re-verified (step-up) within the TTL window. */
  stepUpVerified: boolean;
}

/** Environment/lifecycle context for the decision. */
export interface LockContext {
  /** Whether initial setup has completed (flips on once configuration exists). */
  isConfigured: boolean;
}

export type LockDecisionReason =
  | 'setup_phase' // not configured yet — anything goes during setup
  | 'not_locked' // the key is not a protected system parameter
  | 'forbidden' // locked key + not a super admin
  | 'requires_step_up' // locked key + super admin who has not re-verified
  | 'allowed'; // locked key + super admin with a fresh step-up

export interface LockDecision {
  allowed: boolean;
  reason: LockDecisionReason;
}

/**
 * The critical system parameters that become immutable after setup. These are
 * the highest-risk knobs: storage backend, admin auth, payment credentials and
 * the cron safety-net secret. Normal storefront/business settings (theme,
 * items, pricing, copy) are NOT locked — only these platform-level values.
 */
export const LOCKED_PARAMETER_KEYS: readonly string[] = [
  'storage_provider',
  'supabase_url',
  'supabase_service_role_key',
  'upstash_redis_rest_url',
  'upstash_redis_rest_token',
  'cloudflare_kv_binding',
  'admin_basic_auth_password',
  'cron_secret',
  'payment_provider',
  'payment_api_key',
  'payment_webhook_secret',
  'license_key',
  'license_server_url',
];

/** Whether a given configuration key is a protected system parameter. */
export function isLockedParameter(key: string): boolean {
  const k = String(key || '').trim().toLowerCase();
  return (LOCKED_PARAMETER_KEYS as readonly string[]).includes(k);
}

/** Whether a change to `key` requires a fresh step-up verification. */
export function requiresStepUp(role: ActorRole | null, key: string): boolean {
  return role === 'super_admin' && isLockedParameter(key);
}

/**
 * Decide whether a change to `key` is permitted. Fails closed: an unknown /
 * missing role can never mutate a locked parameter.
 */
export function evaluateLock(key: string, actor: LockActor, ctx: LockContext): LockDecision {
  if (!ctx.isConfigured) return { allowed: true, reason: 'setup_phase' };
  if (!isLockedParameter(key)) return { allowed: true, reason: 'not_locked' };
  if (actor.role !== 'super_admin') return { allowed: false, reason: 'forbidden' };
  if (!actor.stepUpVerified) return { allowed: false, reason: 'requires_step_up' };
  return { allowed: true, reason: 'allowed' };
}

/** Step-up verification freshness window (5 minutes). */
export const STEP_UP_TTL_MS = 5 * 60_000;

/** Whether a step-up verification at `verifiedAtMs` is still fresh. */
export function isStepUpFresh(verifiedAtMs: number | null | undefined, nowMs: number = Date.now()): boolean {
  if (typeof verifiedAtMs !== 'number' || !Number.isFinite(verifiedAtMs)) return false;
  return nowMs - verifiedAtMs < STEP_UP_TTL_MS;
}

/** Persisted lock state shape (maps 1:1 to `public.system_locks`). */
export interface LockState {
  key: string;
  locked: boolean;
  lockedAt: string | null;
  lockedBy: string | null;
  stepUpVerifiedAt: string | null;
}

/** Whether a persisted lock row still carries a fresh step-up verification. */
export function lockStateStepUpActive(state: LockState | null | undefined, nowMs: number = Date.now()): boolean {
  if (!state?.stepUpVerifiedAt) return false;
  const ms = Date.parse(state.stepUpVerifiedAt);
  if (!Number.isFinite(ms)) return false;
  return nowMs - ms < STEP_UP_TTL_MS;
}
