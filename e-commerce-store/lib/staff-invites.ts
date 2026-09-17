/**
 * STAFF INVITES — the missing primitive.
 *
 * Before this, the platform could produce exactly one staff identity: the
 * master super-admin created by the Setup Wizard. The eight RBAC roles from
 * 00015 were fully enforced and completely unassignable, which blocked staff
 * onboarding, sales reps (so the sales portal had no account that could use it)
 * and tenant owner provisioning, all at once.
 *
 * THE TOKEN IS NEVER STORED. `staff_invites.token_hash` holds SHA-256 of the
 * token; the token itself exists only in the emailed link. An invite row IS a
 * grant of privilege — whoever holds a live token can mint a staff account with
 * a role attached — so a database dump must not be usable to accept one. This
 * is the same reasoning as password hashing, applied to a credential that
 * happens to live in a URL.
 *
 * ACCEPTANCE IS THE DANGEROUS OPERATION, and it is ordered accordingly:
 *
 *   1. claim the invite row (a conditional UPDATE, the same compare-and-swap
 *      shape as lib/customer-profile.ts's balance spend) — this is what makes
 *      a double-click or a shared link unable to create two accounts
 *   2. create the Supabase Auth user
 *   3. create the public.users row that carries the role
 *
 * If step 2 or 3 fails, the claim is RELEASED so the invitee can try again
 * rather than being left holding a burnt token and no account. Claiming last
 * instead would let two simultaneous acceptances both pass the "is it pending?"
 * check and both create an account.
 */
import { createHash, randomBytes } from 'crypto';
import { getDb } from '@/lib/db/client';
import { eq, isNull } from '@/lib/db/query';
import { STAFF_ROLES, type StaffRole, isStaffRole } from '@/lib/staff-identity';

/** How long an invite stays usable. Matches the week Shopify and Stripe give. */
export const INVITE_TTL_DAYS = 7;

export type InviteRow = {
  id: string;
  tenant_id: string | null;
  email: string;
  role: string;
  invited_by_email: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type StaffInvite = {
  id: string;
  tenantId: string | null;
  email: string;
  role: StaffRole;
  invitedByEmail: string;
  expiresAt: string;
  createdAt: string;
  /** Derived, never stored — a stored status would drift from expires_at. */
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
};

const SELECT = [
  'id', 'tenant_id', 'email', 'role', 'invited_by_email',
  'expires_at', 'accepted_at', 'revoked_at', 'created_at',
];

const normalizeEmail = (email: unknown): string => String(email || '').trim().toLowerCase();

/** SHA-256, hex. The only form of the token that ever touches storage. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

/**
 * Status is DERIVED from the timestamps rather than stored.
 *
 * A stored status column would have to be updated when an invite expires,
 * which nothing is awake to do — so it would say 'pending' forever and the
 * acceptance path would have to re-check expires_at anyway. One source of
 * truth, computed where it is read.
 */
function statusOf(row: InviteRow, now = Date.now()): StaffInvite['status'] {
  if (row.accepted_at) return 'accepted';
  if (row.revoked_at) return 'revoked';
  if (new Date(row.expires_at).getTime() <= now) return 'expired';
  return 'pending';
}

const toInvite = (row: InviteRow): StaffInvite => ({
  id: row.id,
  tenantId: row.tenant_id,
  email: row.email,
  role: (isStaffRole(row.role) ? row.role : 'staff') as StaffRole,
  invitedByEmail: row.invited_by_email,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  status: statusOf(row),
});

export type CreateInviteResult =
  | { ok: true; invite: StaffInvite; token: string }
  | { ok: false; reason: 'invalid_email' | 'invalid_role' | 'already_staff' | 'already_invited' | 'error'; message: string };

/**
 * Issue an invite and return the ONE copy of the token that will ever exist.
 *
 * The caller must put it in the email and then forget it. Nothing else can
 * recover it — a "resend" issues a fresh token rather than re-sending the old
 * one, because the old one is genuinely unrecoverable by design.
 */
export async function createInvite(input: {
  email: string;
  role: string;
  tenantId?: string | null;
  invitedByEmail: string;
}): Promise<CreateInviteResult> {
  const email = normalizeEmail(input.email);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, reason: 'invalid_email', message: 'Enter a valid email address.' };
  }
  if (!isStaffRole(input.role)) {
    return {
      ok: false,
      reason: 'invalid_role',
      message: `Role must be one of: ${STAFF_ROLES.join(', ')}.`,
    };
  }
  const tenantId = input.tenantId ?? null;

  try {
    // Already staff? Inviting someone who can already sign in is a no-op at
    // best and a confusing second account at worst.
    const existing = (await getDb().select<{ id: string }>('users', {
      where: { email: eq(email) }, select: ['id'], limit: 1,
    })) as Array<{ id: string }>;
    if (existing.length > 0) {
      return { ok: false, reason: 'already_staff', message: 'That person already has a staff account.' };
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString();

    const rows = (await getDb().insert<InviteRow>('staff_invites', {
      tenant_id: tenantId,
      email,
      role: input.role,
      token_hash: hashInviteToken(token),
      invited_by_email: normalizeEmail(input.invitedByEmail) || 'unknown',
      expires_at: expiresAt,
    })) as InviteRow[];

    if (!rows?.[0]) return { ok: false, reason: 'error', message: 'Could not create the invitation.' };
    return { ok: true, invite: toInvite(rows[0]), token };
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    // The partial unique index (one live invite per email per tenant).
    if (/duplicate key|23505|staff_invites_one_pending_per_email/i.test(message)) {
      return {
        ok: false,
        reason: 'already_invited',
        message: 'There is already a pending invitation for that address. Revoke it first, or resend it.',
      };
    }
    console.error('[staff-invites] create failed', email, message);
    return { ok: false, reason: 'error', message: 'Could not create the invitation.' };
  }
}

/** Invites for a tenant (or platform-level when tenantId is null), newest first. */
export async function listInvites(tenantId: string | null, limit = 200): Promise<StaffInvite[]> {
  try {
    const rows = (await getDb().select<InviteRow>('staff_invites', {
      where: tenantId ? { tenant_id: eq(tenantId) } : {},
      select: SELECT,
      order: { column: 'created_at', ascending: false },
      limit,
    })) as InviteRow[];
    return (rows || []).map(toInvite);
  } catch (err) {
    console.error('[staff-invites] list failed', (err as Error)?.message || err);
    return [];
  }
}

/**
 * Revoke a pending invite.
 *
 * Scoped to rows that are not already accepted: revoking an accepted invite
 * would suggest it undoes the account, which it does not. Removing a staff
 * member is a different operation on a different table.
 */
export async function revokeInvite(id: string): Promise<boolean> {
  if (!id) return false;
  try {
    const updated = (await getDb().update<InviteRow>(
      'staff_invites',
      { where: { id: eq(id), accepted_at: isNull() } },
      { revoked_at: new Date().toISOString() },
    )) as InviteRow[];
    return Array.isArray(updated) && updated.length > 0;
  } catch (err) {
    console.error('[staff-invites] revoke failed', id, (err as Error)?.message || err);
    return false;
  }
}

export type LookupResult =
  | { ok: true; invite: StaffInvite }
  | { ok: false; reason: 'not_found' | 'accepted' | 'revoked' | 'expired' };

/**
 * Resolve a raw token to its invite, without consuming it — what the accept
 * PAGE calls so it can show who is being invited, and to what role, before
 * asking for a password.
 *
 * Every rejection reason is distinguished because they mean different things to
 * the person holding the link: an expired invite should be re-requested, an
 * accepted one means "you already have an account, sign in", and a revoked one
 * means someone deliberately withdrew it.
 */
export async function lookupInviteByToken(token: string): Promise<LookupResult> {
  const raw = String(token || '').trim();
  if (!raw) return { ok: false, reason: 'not_found' };
  try {
    const rows = (await getDb().select<InviteRow>('staff_invites', {
      where: { token_hash: eq(hashInviteToken(raw)) },
      select: SELECT,
      limit: 1,
    })) as InviteRow[];
    const row = rows?.[0];
    if (!row) return { ok: false, reason: 'not_found' };
    const status = statusOf(row);
    if (status !== 'pending') return { ok: false, reason: status };
    return { ok: true, invite: toInvite(row) };
  } catch (err) {
    console.error('[staff-invites] lookup failed', (err as Error)?.message || err);
    return { ok: false, reason: 'not_found' };
  }
}

/**
 * CLAIM an invite: mark it accepted, but only if it is still pending.
 *
 * This is the compare-and-swap that makes acceptance safe. The UPDATE requires
 * accepted_at and revoked_at to both still be NULL, so of two simultaneous
 * acceptances exactly one can win — the loser gets zero rows back and is told
 * the invite is already used, instead of both creating an account.
 *
 * Called BEFORE the account is created. See this file's header for why.
 */
export async function claimInvite(id: string): Promise<boolean> {
  try {
    const updated = (await getDb().update<InviteRow>(
      'staff_invites',
      { where: { id: eq(id), accepted_at: isNull(), revoked_at: isNull() } },
      { accepted_at: new Date().toISOString() },
    )) as InviteRow[];
    return Array.isArray(updated) && updated.length > 0;
  } catch (err) {
    console.error('[staff-invites] claim failed', id, (err as Error)?.message || err);
    return false;
  }
}

/**
 * Undo a claim, when creating the account afterwards failed.
 *
 * Without this the invitee is left holding a token that reports "already
 * accepted" for an account that does not exist — unable to proceed and unable
 * to explain why. An invite nobody consumed must go back to pending.
 */
export async function releaseClaim(id: string): Promise<void> {
  try {
    await getDb().update(
      'staff_invites',
      { where: { id: eq(id) } },
      { accepted_at: null },
      { returning: 'default' },
    );
  } catch (err) {
    console.error('[staff-invites] RELEASE FAILED for ' + id + ' — the invite is stuck as accepted with no account behind it', (err as Error)?.message || err);
  }
}

/** Record which account an accepted invite produced (bookkeeping, best-effort). */
export async function linkAcceptedUser(id: string, userId: string): Promise<void> {
  try {
    await getDb().update(
      'staff_invites',
      { where: { id: eq(id) } },
      { accepted_user_id: userId },
      { returning: 'default' },
    );
  } catch (err) {
    console.error('[staff-invites] link failed', id, (err as Error)?.message || err);
  }
}
