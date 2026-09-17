/**
 * CUSTOMER PROFILE — loyalty, consent and role (H7).
 *
 * These moved out of the KV `store:users` blob because the merchant panel,
 * CRM and automation need to act on them: a reactivation campaign needs
 * opt-in status and a loyalty balance, compliance needs consent timestamps,
 * and the panel needs role.
 *
 * Authentication (password, emailVerified) deliberately stayed in KV —
 * DEFERRED-6. So `store:users` remains the auth record while THIS is the
 * authoritative record for everything else about a customer.
 *
 * REWARDS ARE MONEY. lib/account/redeem-points mints a real promo code
 * against the balance, so a lost update here hands out free credit. Every
 * change goes through adjustRewards, which uses a compare-and-swap on top of
 * the distributed lock rather than trusting the lock alone — the lock was
 * itself found to provide no mutual exclusion earlier today (see
 * lib/redis-lock.ts), and the CAS is what makes this correct even if that
 * happens again.
 */
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { ensureCustomer } from '@/lib/customers';

export type CustomerProfile = {
  customerId: string;
  email: string;
  rewardsBalance: number;
  emailOptIn: boolean | null;
  termsAgreedAt: string | null;
  role: string;
};

type ProfileRow = {
  id: string;
  email: string;
  rewards_balance: number | null;
  email_opt_in: boolean | null;
  terms_agreed_at: string | null;
  role: string | null;
};

const SELECT = ['id', 'email', 'rewards_balance', 'email_opt_in', 'terms_agreed_at', 'role'];

const toProfile = (row: ProfileRow): CustomerProfile => ({
  customerId: row.id,
  email: row.email,
  rewardsBalance: Math.max(0, Math.floor(Number(row.rewards_balance) || 0)),
  emailOptIn: row.email_opt_in === null || row.email_opt_in === undefined ? null : Boolean(row.email_opt_in),
  termsAgreedAt: row.terms_agreed_at || null,
  role: String(row.role || 'customer'),
});

const normalizeEmail = (email: unknown): string => String(email || '').trim().toLowerCase();

/**
 * Jittered backoff between CAS attempts.
 *
 * The first version retried IMMEDIATELY. That keeps every contender in
 * lockstep: they lose the compare-and-swap together, re-read the same balance
 * at the same instant and collide again, so the retry budget burns down
 * without anyone making progress. Ten concurrent grants against one balance
 * dropped two of them that way — measured against the live database in
 * scripts/verify-customer-profile.ts, not guessed. Full jitter spreads the
 * retries so they stop landing on top of each other.
 */
const backoff = (attempt: number): Promise<void> =>
  new Promise((resolve) => {
    const ceiling = Math.min(250, 10 * 2 ** attempt);
    setTimeout(resolve, Math.floor(Math.random() * ceiling));
  });

/** The profile for an email, or null when there is no customer record yet. */
export async function readProfile(tenantId: string, email: string): Promise<CustomerProfile | null> {
  const normalized = normalizeEmail(email);
  if (!tenantId || !normalized) return null;
  try {
    const rows = (await getDb().select<ProfileRow>('customers', {
      where: { tenant_id: eq(tenantId), email: eq(normalized) },
      select: SELECT,
      limit: 1,
    })) as ProfileRow[];
    return rows?.[0] ? toProfile(rows[0]) : null;
  } catch (err) {
    console.error('[customer-profile] read failed', normalized, (err as Error)?.message || err);
    return null;
  }
}

export type AdjustResult =
  | { ok: true; balance: number }
  | { ok: false; reason: 'no_customer' | 'insufficient_points' | 'contended' | 'error'; balance?: number };

/**
 * Add or spend loyalty points.
 *
 * `delta` is signed: positive grants, negative spends. A spend that would
 * take the balance below zero is REFUSED rather than clamped — clamping would
 * silently hand out more credit than the customer had.
 *
 * Compare-and-swap with bounded retry, the same shape as
 * lib/inventory.ts's decrementInventory: the UPDATE requires the balance to
 * still equal what was just read, so two concurrent redemptions cannot both
 * spend the same points. A lost CAS is retried (someone else changed the
 * balance), and only reported as contention once the retries run out — never
 * as "insufficient points", which would be a lie about why it failed.
 */
export async function adjustRewards(
  tenantId: string,
  email: string,
  delta: number,
  opts?: { stripeCustomerId?: string | null },
): Promise<AdjustResult> {
  const normalized = normalizeEmail(email);
  const change = Math.floor(Number(delta) || 0);
  if (!tenantId || !normalized) return { ok: false, reason: 'no_customer' };
  if (change === 0) {
    const current = await readProfile(tenantId, normalized);
    return current ? { ok: true, balance: current.rewardsBalance } : { ok: false, reason: 'no_customer' };
  }

  // A grant may legitimately be the first thing that ever happens to a
  // customer (welcome points at signup), so create the record if needed. A
  // SPEND never creates one — spending from a balance that does not exist is
  // a bug in the caller, not a reason to mint a row.
  if (change > 0) {
    const created = await ensureCustomer(tenantId, normalized, opts?.stripeCustomerId ?? null);
    if (!created) return { ok: false, reason: 'no_customer' };
  }

  // A GRANT and a SPEND fail differently, so they get different budgets.
  //
  // A spend is conditional: it can legitimately be refused, the customer is
  // shown an error and retries, and nothing is lost. A grant is
  // unconditional — the points have been EARNED (a purchase completed, an
  // account was verified) — so giving up on one silently destroys money the
  // customer is owed, with nothing but a log line to show for it. Grants
  // therefore try roughly twice as hard before admitting defeat.
  const ATTEMPTS = change > 0 ? 12 : 6;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (attempt > 0) await backoff(attempt);
    const profile = await readProfile(tenantId, normalized);
    if (!profile) return { ok: false, reason: 'no_customer' };

    const next = profile.rewardsBalance + change;
    if (next < 0) {
      return { ok: false, reason: 'insufficient_points', balance: profile.rewardsBalance };
    }

    try {
      const updated = (await getDb().update<ProfileRow>(
        'customers',
        {
          where: {
            tenant_id: eq(tenantId),
            id: eq(profile.customerId),
            // THE COMPARE-AND-SWAP: the balance must still be what we read.
            rewards_balance: eq(profile.rewardsBalance),
          },
        },
        { rewards_balance: next },
      )) as ProfileRow[];
      if (Array.isArray(updated) && updated.length > 0) return { ok: true, balance: next };
      // Zero rows: someone changed the balance between the read and the
      // write. Back off, re-read and try again rather than reporting a wrong
      // reason.
    } catch (err) {
      console.error('[customer-profile] rewards CAS failed', normalized, (err as Error)?.message || err);
      return { ok: false, reason: 'error' };
    }
  }
  // Out of attempts. Nothing was lost — the balance is whatever the winners
  // left it at — but for a GRANT this is money the customer earned and did not
  // receive, so it is the caller's job to shout about it, not to shrug.
  return { ok: false, reason: 'contended' };
}

/**
 * Record consent and/or role. Only the fields supplied are written, so a
 * caller that knows about opt-in does not clobber a role it never saw.
 */
export async function setProfileFields(
  tenantId: string,
  email: string,
  fields: { emailOptIn?: boolean | null; termsAgreedAt?: string | null; role?: string },
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!tenantId || !normalized) return false;
  const patch: Record<string, unknown> = {};
  if ('emailOptIn' in fields) patch.email_opt_in = fields.emailOptIn;
  if ('termsAgreedAt' in fields) patch.terms_agreed_at = fields.termsAgreedAt;
  if ('role' in fields && fields.role) patch.role = fields.role;
  if (Object.keys(patch).length === 0) return true;

  try {
    const customerId = await ensureCustomer(tenantId, normalized);
    if (!customerId) return false;
    await getDb().update(
      'customers',
      { where: { tenant_id: eq(tenantId), id: eq(customerId) } },
      patch,
      { returning: 'default' },
    );
    return true;
  } catch (err) {
    console.error('[customer-profile] profile write failed', normalized, (err as Error)?.message || err);
    return false;
  }
}
