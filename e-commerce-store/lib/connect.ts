/**
 * CONNECT — each merchant's own Stripe account (Accounts v2). Design:
 * CONNECT.md. Routing rule and status mapping: lib/connect-routing.ts (pure).
 *
 * THE CONFIGURATION, and why it is fixed (CONNECT.md §2):
 *   losses_collector: 'stripe'  Stripe, not the platform, is liable for a
 *                               merchant's negative balance.
 *   fees_collector:   'stripe'  Stripe bills the merchant its processing fee
 *                               directly, so application_fee_amount is ONLY
 *                               the platform fee — and the platform pays Stripe
 *                               nothing for Connect (no $2/active account, no
 *                               payout fees).
 *   dashboard:        'full'    the merchant's own full Stripe Dashboard —
 *                               matching the promise on the pricing page,
 *                               "Your own Stripe account — the money is yours".
 *                               NOT 'express': Stripe refuses it with these
 *                               responsibilities (probed 2026-09-25: "When
 *                               stripe_dashboard[type]=express, your platform
 *                               must collect fees and be liable for negative
 *                               balances"). 'none' would mean rebuilding
 *                               payouts and disputes UI ourselves. Onboarding
 *                               itself stays embedded in the merchant app.
 *   charges:          DIRECT    made on the merchant's account, so refunds and
 *                               disputes reduce THEIR balance. (Destination
 *                               charges debit the platform for both, "with or
 *                               without on_behalf_of" — Stripe's docs.)
 * Stripe's docs: responsibilities "can't be updated later". Changing this
 * object affects only accounts created afterwards; existing merchants keep
 * what they were created with.
 *
 * Nothing here runs until Connect is enabled on the platform's Stripe
 * account; until then Stripe refuses to create connected accounts.
 */
import type Stripe from 'stripe';
import { getDb } from '@/lib/db/client';
import { eq, isNull } from '@/lib/db/query';
import { resolveStripeClient } from '@/services/payment/factory';
import { chargeRouteFor, connectStatusFromAccount, type ChargeRoute } from '@/lib/connect-routing';
import { ensureDefaultTenant } from '@/lib/tenant-context';

export const CONNECT_ACCOUNT_DEFAULTS = {
  dashboard: 'full' as const,
  currency: 'usd' as const,
  responsibilities: { fees_collector: 'stripe' as const, losses_collector: 'stripe' as const },
};

const ACCOUNT_INCLUDE = ['configuration.merchant', 'requirements'] as const;

async function stripeOrThrow(): Promise<Stripe> {
  const stripe = await resolveStripeClient();
  if (!stripe) throw new Error('[connect] Stripe is not configured');
  return stripe as unknown as Stripe;
}

type TenantConnectRow = {
  id: string;
  name: string | null;
  stripe_account_id: string | null;
  connect_charges_enabled: boolean;
};

async function readTenant(tenantId: string): Promise<TenantConnectRow> {
  const row = ((await getDb().select<any>('tenants', {
    where: { id: eq(tenantId) },
    select: ['id', 'name', 'stripe_account_id', 'connect_charges_enabled'],
    limit: 1,
  })) as any[])[0];
  if (!row) throw new Error('[connect] unknown tenant ' + tenantId);
  return row as TenantConnectRow;
}

/**
 * Where a charge for this tenant must be made. The single entry point every
 * charge path will call (CONNECT.md §4). Throws if the tenant cannot be read —
 * the caller refuses the sale; it never guesses the platform account.
 */
export async function chargeRouteForTenant(tenantId: string): Promise<ChargeRoute> {
  const [row, legacyId] = await Promise.all([readTenant(tenantId), ensureDefaultTenant()]);
  return chargeRouteFor({
    isLegacyPlatformTenant: row.id === legacyId,
    stripeAccountId: row.stripe_account_id,
    chargesEnabled: Boolean(row.connect_charges_enabled),
  });
}

/**
 * The merchant's connected account, created on first call. Idempotent twice
 * over: Stripe dedupes the create by an idempotency key derived from the
 * tenant, and the tenant row is only written while it has no account, so two
 * concurrent calls converge on ONE account instead of orphaning a second.
 */
export async function ensureConnectedAccount(tenantId: string, contactEmail: string): Promise<string> {
  const tenant = await readTenant(tenantId);
  if (tenant.stripe_account_id) return tenant.stripe_account_id;

  const stripe = await stripeOrThrow();
  const account = await stripe.v2.core.accounts.create(
    {
      contact_email: contactEmail,
      display_name: tenant.name || undefined,
      dashboard: CONNECT_ACCOUNT_DEFAULTS.dashboard,
      configuration: {
        merchant: {
          // Payouts are not requestable here in API 2026-06-24.dahlia —
          // stripe_balance exists only on the recipient configuration's
          // create params (caught by the SDK's own typings). The merchant
          // configuration still REPORTS stripe_balance.payouts status, which
          // is what connectStatusFromAccount reads.
          capabilities: {
            card_payments: { requested: true },
          },
        },
      },
      defaults: {
        currency: CONNECT_ACCOUNT_DEFAULTS.currency,
        responsibilities: CONNECT_ACCOUNT_DEFAULTS.responsibilities,
      },
      include: [...ACCOUNT_INCLUDE],
    },
    { idempotencyKey: 'connect-account:' + tenantId },
  );

  const status = connectStatusFromAccount(account);
  const written = (await getDb().update<any>(
    'tenants',
    { where: { id: eq(tenantId), stripe_account_id: isNull() } },
    {
      stripe_account_id: account.id,
      connect_charges_enabled: status.chargesEnabled,
      connect_payouts_enabled: status.payoutsEnabled,
      connect_requirements: status.requirements,
      connect_synced_at: new Date().toISOString(),
    },
  )) as any[];
  if (written.length === 0) {
    // Someone else stored an account first. Return theirs — the idempotency
    // key makes it the same account unless the tenant's was set another way.
    const again = await readTenant(tenantId);
    if (again.stripe_account_id !== account.id) {
      console.error('[connect] tenant ' + tenantId + ' already had ' + again.stripe_account_id +
        '; created ' + account.id + ' is unattached — reconcile');
    }
    return String(again.stripe_account_id);
  }
  return account.id;
}

/**
 * A short-lived client secret for Stripe's embedded onboarding component
 * (Connect embedded components, `account_onboarding`). The merchant finishes
 * KYC inside the merchant app; Stripe collects and verifies it.
 */
export async function createOnboardingSession(tenantId: string): Promise<{ clientSecret: string; accountId: string }> {
  const tenant = await readTenant(tenantId);
  if (!tenant.stripe_account_id) throw new Error('[connect] tenant ' + tenantId + ' has no connected account yet');
  const stripe = await stripeOrThrow();
  const session = await stripe.accountSessions.create({
    account: tenant.stripe_account_id,
    components: { account_onboarding: { enabled: true } },
  });
  return { clientSecret: session.client_secret, accountId: tenant.stripe_account_id };
}

/**
 * Refresh the cached status from Stripe (the account.updated webhook calls
 * this; so can an explicit "check again" button). Stripe is the authority —
 * the row is only a cache that lets checkout decide without a Stripe call.
 */
export async function syncConnectedAccount(accountId: string): Promise<{ tenantId: string | null; chargesEnabled: boolean }> {
  const stripe = await stripeOrThrow();
  const account = await stripe.v2.core.accounts.retrieve(accountId, { include: [...ACCOUNT_INCLUDE] });
  const status = connectStatusFromAccount(account);
  const rows = (await getDb().update<any>(
    'tenants',
    { where: { stripe_account_id: eq(accountId) } },
    {
      connect_charges_enabled: status.chargesEnabled,
      connect_payouts_enabled: status.payoutsEnabled,
      connect_requirements: status.requirements,
      connect_synced_at: new Date().toISOString(),
    },
  )) as any[];
  if (rows.length === 0) {
    console.error('[connect] account ' + accountId + ' is not attached to any tenant — ignoring its status');
    return { tenantId: null, chargesEnabled: status.chargesEnabled };
  }
  return { tenantId: String(rows[0].id), chargesEnabled: status.chargesEnabled };
}

/** The tenant a connected account belongs to, or null. */
export async function tenantIdForAccount(accountId: string): Promise<string | null> {
  if (!/^acct_[A-Za-z0-9]+$/.test(String(accountId || ''))) return null;
  const row = ((await getDb().select<any>('tenants', {
    where: { stripe_account_id: eq(accountId) }, select: ['id'], limit: 1,
  })) as any[])[0];
  return row ? String(row.id) : null;
}

/**
 * The Connect endpoint's signing secret (00034): platform settings first, the
 * STRIPE_CONNECT_WEBHOOK_SECRET env var second. Empty when neither is set, and
 * the route then rejects everything rather than accepting unsigned events. A
 * read failure (including the column not existing yet) also yields empty:
 * fail closed.
 */
export async function resolveConnectWebhookSecret(): Promise<string> {
  try {
    const { GLOBAL_PLATFORM_SETTINGS_ROW_ID } = await import('@/services/config/types');
    const row = ((await getDb().select<any>('global_platform_settings', {
      where: { id: eq(GLOBAL_PLATFORM_SETTINGS_ROW_ID) }, select: ['payment_connect_webhook_secret'], limit: 1,
    })) as any[])[0];
    const fromSettings = String(row?.payment_connect_webhook_secret || '').trim();
    if (fromSettings) return fromSettings;
  } catch (err) {
    console.error('[connect] could not read the Connect webhook secret from settings', (err as Error)?.message || err);
  }
  return String(process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '').trim();
}
