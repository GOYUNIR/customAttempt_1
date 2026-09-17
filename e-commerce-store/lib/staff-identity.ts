/**
 * STAFF IDENTITY — who a signed-in operator is, and what role they hold.
 *
 * `public.users` is the authoritative staff identity table (migration 00024,
 * which also backfilled it from `public.profiles`). Before that, the only staff
 * identity the platform could produce was the single master super-admin, and
 * the eight RBAC roles from 00015 were fully enforced and completely
 * unassignable because nothing ever inserted a row to assign them to.
 *
 * WHY THE ROLE IS READ HERE RATHER THAN CARRIED THROUGH THE SIGN-IN FLOW.
 * Sign-in is three steps — password, emailed 6-digit code, device cookie — and
 * threading a role through them would mean the role is decided at step one and
 * trusted at step three. Reading it from the database at the moment the device
 * is issued means a role change (or a revoked account) takes effect on the next
 * sign-in rather than whenever a stale session happens to expire, and there is
 * no point in the chain where a client-supplied role could be substituted.
 *
 * SERVICE-ROLE READ, deliberately. The password has already been verified
 * against Supabase Auth by the time this runs; this is a server-side lookup of
 * an already-authenticated identity, so it goes through the service role rather
 * than the caller's token. Reading `users` as the caller would make sign-in
 * depend on that table's RLS policy admitting a self-read — a policy change
 * could then lock every operator out, which is the one failure this area must
 * not have.
 */
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';

/** Roles that may sign in to a staff portal. `customer` is NOT one: customers
 *  authenticate through the storefront, never the admin/sales portals. */
export const STAFF_ROLES = [
  'super_admin',
  'sales',
  'sales_rep',
  'sales_admin',
  'deal_desk',
  'owner',
  'staff',
] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

export interface StaffIdentity {
  id: string;
  email: string;
  role: StaffRole;
  tenantId: string | null;
  isSuperAdmin: boolean;
  fullName: string | null;
}

type UserRow = {
  id: string;
  email: string;
  role: string | null;
  tenant_id: string | null;
  is_super_admin: boolean | null;
  full_name: string | null;
};

const SELECT = ['id', 'email', 'role', 'tenant_id', 'is_super_admin', 'full_name'];

const normalizeEmail = (email: unknown): string => String(email || '').trim().toLowerCase();

export function isStaffRole(role: unknown): role is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(String(role || ''));
}

/**
 * The staff identity for an email, or null when there is no staff row.
 *
 * Null means "not staff" and callers must treat it as a refusal, not as a
 * reason to fall back to a default role. A row whose `role` is not a staff role
 * (a stray 'customer', or a value written before 00015's CHECK) is also null:
 * an unrecognised role is not an invitation to guess.
 *
 * The one exception is `is_super_admin`, which OUTRANKS the role column. The
 * Setup Wizard stamps that flag and leaves `role` NULL, so a deployment whose
 * master account predates 00024's backfill still resolves correctly instead of
 * locking its only operator out.
 */
export async function readStaffIdentity(email: string): Promise<StaffIdentity | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  try {
    const rows = (await getDb().select<UserRow>('users', {
      where: { email: eq(normalized) },
      select: SELECT,
      limit: 1,
    })) as UserRow[];
    const row = rows?.[0];
    if (!row) return null;

    const isSuperAdmin = row.is_super_admin === true;
    const rawRole = String(row.role || '');
    if (!isSuperAdmin && !isStaffRole(rawRole)) return null;
    const role: StaffRole = isSuperAdmin ? 'super_admin' : (rawRole as StaffRole);

    return {
      id: row.id,
      email: row.email,
      role,
      tenantId: row.tenant_id ?? null,
      isSuperAdmin,
      fullName: row.full_name ?? null,
    };
  } catch (err) {
    console.error('[staff-identity] read failed', normalized, (err as Error)?.message || err);
    return null;
  }
}

/**
 * The metadata stamped onto an admin device record, so `resolveAdminActor`
 * reports the real role.
 *
 * Without this, a device issued by the normal two-step flow carried NO role at
 * all, and `resolveAdminActor` fell through to its legacy branch — granting
 * `owner` (full merchant access) to anyone who passed the emailed code. That
 * was survivable while exactly one account existed. It stops being survivable
 * the moment a sales rep can sign in.
 */
export function deviceMetaFor(identity: StaffIdentity): Record<string, unknown> {
  return {
    role: identity.role,
    tenantId: identity.tenantId,
    superAdmin: identity.isSuperAdmin,
    userId: identity.id,
  };
}
