/**
 * CONNECT ROUTING — whose Stripe account a charge is made on. Pure, so the
 * rule that makes multi-merchant selling legal is unit-tested rather than
 * scattered across checkout routes.
 *
 * THE RULE (CONNECT.md §3):
 *   - A merchant with a connected account that Stripe has enabled for card
 *     payments is charged ON THAT ACCOUNT (a direct charge), with the platform
 *     fee as the application fee.
 *   - The legacy platform tenant — the one store that predates Connect — keeps
 *     charging on the platform account until its own connected account is
 *     enabled. It is the ONLY tenant that may ever do so.
 *   - Everyone else is refused until onboarding completes. FAIL CLOSED: taking
 *     a second merchant's customers' money into the platform's account is the
 *     exact liability Connect exists to remove, so "not sure" means "no".
 *
 * Relative imports only; the node test runner loads it directly.
 */

export type ConnectTenantState = {
  /** The single pre-Connect store allowed to charge on the platform account. */
  isLegacyPlatformTenant: boolean;
  stripeAccountId: string | null;
  /** Stripe's answer, cached on the tenant row (00033). */
  chargesEnabled: boolean;
};

export type ChargeRoute =
  | { route: 'connected'; stripeAccount: string }
  | { route: 'platform' }
  | { route: 'blocked'; reason: 'not_connected' | 'onboarding_incomplete' };

export function chargeRouteFor(state: ConnectTenantState): ChargeRoute {
  const account = state.stripeAccountId && /^acct_[A-Za-z0-9]+$/.test(state.stripeAccountId)
    ? state.stripeAccountId
    : null;
  if (account && state.chargesEnabled) return { route: 'connected', stripeAccount: account };
  if (state.isLegacyPlatformTenant) return { route: 'platform' };
  return { route: 'blocked', reason: account ? 'onboarding_incomplete' : 'not_connected' };
}

/**
 * Stripe's v2 Account → the cached columns. Reads defensively: v2 returns
 * null for anything not requested with `include`, and a missing field must
 * read as "not enabled", never as enabled.
 */
export function connectStatusFromAccount(account: any): {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirements: Record<string, unknown>;
} {
  const caps = account?.configuration?.merchant?.capabilities || {};
  const chargesEnabled = caps?.card_payments?.status === 'active';
  const payoutsEnabled = caps?.stripe_balance?.payouts?.status === 'active';
  const req = account?.requirements || {};
  const entries = Array.isArray(req?.entries) ? req.entries : [];
  return {
    chargesEnabled,
    payoutsEnabled,
    requirements: {
      // Only what the onboarding panel needs; never a gate.
      outstanding: entries.length,
      summary: req?.summary ?? null,
      cardPaymentsStatus: caps?.card_payments?.status ?? null,
    },
  };
}

/**
 * WHICH TENANT A CONNECT EVENT BELONGS TO — and the guard that stops one
 * merchant's event from ever touching another merchant's orders or stock.
 *
 * A Connect event carries `account` (the connected account it happened on).
 * That is the ONLY trustworthy source of the tenant: metadata is written by
 * our own code at charge creation and is corroboration, not authority. So:
 *   - no `account`, or an account attached to no tenant  -> refuse
 *   - metadata names a tenant, and it is a DIFFERENT one  -> refuse
 *   - requireMetadata and metadata names no tenant        -> refuse
 *     (every Connect-era charge we create carries tenant_id; one that does
 *      not was not created by this platform, or was created wrongly)
 * Refusing means doing nothing to any order or stock and logging it loudly.
 */
export type ConnectEventTenant =
  | { ok: true; tenantId: string }
  | { ok: false; reason: 'no_account' | 'unknown_account' | 'tenant_mismatch' | 'missing_tenant_metadata' };

export function resolveConnectEventTenant(input: {
  eventAccount: string | null | undefined;
  /** The tenant whose stripe_account_id equals eventAccount, or null. */
  tenantForAccount: string | null;
  metadataTenantId?: string | null;
  requireMetadata: boolean;
}): ConnectEventTenant {
  if (!input.eventAccount) return { ok: false, reason: 'no_account' };
  if (!input.tenantForAccount) return { ok: false, reason: 'unknown_account' };
  const meta = String(input.metadataTenantId || '').trim();
  if (!meta) {
    return input.requireMetadata ? { ok: false, reason: 'missing_tenant_metadata' } : { ok: true, tenantId: input.tenantForAccount };
  }
  if (meta !== input.tenantForAccount) return { ok: false, reason: 'tenant_mismatch' };
  return { ok: true, tenantId: input.tenantForAccount };
}
