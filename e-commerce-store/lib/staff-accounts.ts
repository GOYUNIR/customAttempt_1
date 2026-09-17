/**
 * STAFF ACCOUNT CREATION — the write side of staff identity.
 *
 * A staff account is TWO records that must agree: a Supabase Auth user (which
 * holds the password) and a `public.users` row (which holds the role and the
 * tenant). `public.users.id` is a foreign key to `auth.users(id)`, so the Auth
 * user has to exist first.
 *
 * THAT ORDERING CREATES THE ONLY INTERESTING FAILURE: an Auth user with no
 * `users` row. Such an account has a working password and NO role, so
 * `readStaffIdentity` returns null and the person is refused at sign-in with
 * "invalid email or password" — correct, but permanently confusing, and
 * invisible until they complain. So a failed `users` insert DELETES the Auth
 * user it just created. Creation either produces a whole account or leaves
 * nothing behind.
 *
 * `email_confirm: true` is set deliberately. The invitee proved control of the
 * address by opening a link that was emailed to it — that IS the verification,
 * and making them confirm a second time adds a step that verifies nothing.
 */
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { supabaseAuthFetch, readSupabaseEnv, supabaseServiceConfigured } from '@/services/config/supabase-client';
import type { StaffRole } from '@/lib/staff-identity';

export type CreateStaffAccountResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; reason: 'not_configured' | 'email_exists' | 'weak_password' | 'error'; message: string };

/** Supabase's own minimum. Stated here so the failure is a clear message
 *  rather than a GoTrue error string surfaced to an invitee. */
const MIN_PASSWORD_LENGTH = 8;

export async function createStaffAccount(input: {
  email: string;
  password: string;
  role: StaffRole;
  tenantId?: string | null;
  fullName?: string | null;
}): Promise<CreateStaffAccountResult> {
  const email = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');

  if (!supabaseServiceConfigured()) {
    return { ok: false, reason: 'not_configured', message: 'Supabase is not configured.' };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: 'weak_password',
      message: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  const { serviceRoleKey } = readSupabaseEnv();

  // ── 1. the Auth user (holds the password) ────────────────────────────────
  let authUserId = '';
  try {
    const created = (await supabaseAuthFetch('/admin/users', {
      key: serviceRoleKey,
      method: 'POST',
      body: {
        email,
        password,
        // The invite link was emailed to this address and opened from it.
        email_confirm: true,
        user_metadata: { role: input.role },
      },
    })) as { id?: string } | null;
    authUserId = String(created?.id || '');
    if (!authUserId) {
      return { ok: false, reason: 'error', message: 'Could not create the account.' };
    }
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    if (/email_exists|already been registered|already registered/i.test(message)) {
      return {
        ok: false,
        reason: 'email_exists',
        message: 'An account already exists for that email. Sign in instead.',
      };
    }
    if (/password/i.test(message) && /weak|short|length/i.test(message)) {
      return { ok: false, reason: 'weak_password', message: 'Choose a stronger password.' };
    }
    console.error('[staff-accounts] auth user create failed', email, message);
    return { ok: false, reason: 'error', message: 'Could not create the account.' };
  }

  // ── 2. the identity row (holds the role) ─────────────────────────────────
  try {
    await getDb().insert(
      'users',
      {
        id: authUserId,
        email,
        role: input.role,
        tenant_id: input.tenantId ?? null,
        is_super_admin: input.role === 'super_admin',
        full_name: input.fullName || null,
      },
      { returning: 'minimal' },
    );
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    console.error('[staff-accounts] users row failed, rolling back the auth user', email, message);
    // Roll back, or leave behind an account that can authenticate and has no
    // role — which reads as "invalid email or password" forever.
    try {
      await supabaseAuthFetch('/admin/users/' + authUserId, { key: serviceRoleKey, method: 'DELETE' });
    } catch (rollbackErr) {
      console.error(
        '[staff-accounts] ROLLBACK FAILED for ' + email + ' (auth user ' + authUserId + ') — ' +
          'an Auth account now exists with no staff row and must be deleted by hand',
        (rollbackErr as Error)?.message || rollbackErr,
      );
    }
    return { ok: false, reason: 'error', message: 'Could not create the account.' };
  }

  return { ok: true, userId: authUserId, email };
}

/**
 * Remove a staff account entirely — both records.
 *
 * The `users` row goes first: while it exists the person can sign in, so
 * deleting it is what actually revokes access. Deleting the Auth user first
 * would leave a window where the role row points at nothing.
 */
export async function deleteStaffAccount(email: string): Promise<boolean> {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !supabaseServiceConfigured()) return false;
  const { serviceRoleKey } = readSupabaseEnv();
  try {
    const rows = (await getDb().select<{ id: string }>('users', {
      where: { email: eq(normalized) }, select: ['id'], limit: 1,
    })) as Array<{ id: string }>;
    const id = rows?.[0]?.id;
    if (!id) return false;

    await getDb().remove('users', { where: { id: eq(id) } });
    try {
      await supabaseAuthFetch('/admin/users/' + id, { key: serviceRoleKey, method: 'DELETE' });
    } catch (err) {
      // Access is already revoked (the role row is gone). Log and carry on
      // rather than reporting a failure that would invite a retry which cannot
      // help.
      console.error('[staff-accounts] auth user delete failed after the users row was removed', normalized, (err as Error)?.message || err);
    }
    return true;
  } catch (err) {
    console.error('[staff-accounts] delete failed', normalized, (err as Error)?.message || err);
    return false;
  }
}
