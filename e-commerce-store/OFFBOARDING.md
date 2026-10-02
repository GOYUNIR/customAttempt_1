# Store offboarding: design (not built)

What happens when a merchant leaves. Written 2026-10-02 so the promises in
the Terms and Privacy pages have a concrete process behind them. Nothing here
is built yet; the decisions marked **[decision]** are the owner's.

## What we already promised (lib/platform-legal.ts)

- **Terms:** "cancel any paid plan, then ask us to close the store". You can ask for your data export before the store is closed. We can end the terms with 30 days' notice, or at once for a serious breach.
- **Terms:** paid plans run to the end of the paid period; there are no part-month refunds.
- **Privacy:** "When a store is closed, we delete or anonymise its data within a reasonable time, except what we must keep by law."

## What already exists to build on

| Piece | Where |
|---|---|
| Self-serve export (products, orders, customers; CSV/JSON) | `/api/merchant/export`, the dashboard's Export |
| Cancel at period end | Stripe customer portal (`lib/plan-billing.ts`, `subscription_cancel: at_period_end`) |
| A store that stops serving | `tenants.license_status` ('active', 'grace', 'expired'). Storefront and dashboard already refuse anything not active or grace (`lib/storefront-tenant.ts`, `lib/merchant-session.ts`) |
| Releasing a name | The abandoned-signup path renames the slug to `x--<id>` (migration in `merchant_signups`); `tenant_slug_aliases.expires_at` holds an old name for a while |
| Custom domains | `lib/cloudflare-saas.ts` (create/delete custom hostnames) |
| Deleting a store's data | `scripts/launch-reset.ts` already knows every tenant-owned table and the storage prefix `tenants/<id>/`, with a backup first |

## The flow

**1. Request (day 0).** Only the store owner can request closure, from Settings, by re-entering their password. Support can start it for an owner who emails from the owner address. **[decision]** Self-serve, or support-only at first? I recommend support-only until the first few closures, because the volume will be tiny.

**2. Final export (day 0).** Before anything changes, the platform makes the same export the owner can already download and emails the owner a signed link, valid for the grace period. The Terms promise is "you can ask for your export before the store is closed"; doing it automatically means nobody has to ask.

**3. Subscription (day 0).** Set the paid plan to cancel at period end, as the Terms say: no refund, and the plan lasts until the paid period ends. If the period ends after the grace period, the store is still closed when grace ends; the remaining days are lost (the Terms already say there are no part-month refunds).

**4. Store goes dark (day 0).**
- Set `license_status = 'grace'` plus a new `closing_at` timestamp. The storefront shows "This store has closed", and checkout, raffle entry and new holds are refused.
- Open stock holds are released, open discount reservations are released, and running draws are cancelled with entrants told by email.
- The dashboard stays open read-only for orders, refunds and export: the merchant still owes refunds and disputes on past orders.

**5. Grace period (day 0 to N).** The owner can reopen with one click, and everything is intact. **[decision]** N = 30 days (my recommendation). That matches the 30 days' notice we give when we end the terms.

**6. Close (day N).**
- `license_status = 'expired'`.
- The slug becomes `x--<id>` and the old name goes into `tenant_slug_aliases` for 90 days (pointing nowhere). Nobody can register it straight away and impersonate the store to its returning customers. **[decision]** The 90-day hold.
- Custom hostnames are deleted from Cloudflare for SaaS, and the domain is released.
- Staff accounts are unlinked. Their sign-in accounts are deleted unless they belong to another store.
- The Stripe connected account is disconnected, never deleted by us: it is the merchant's account, and refunds or disputes can arrive for up to about 120 days.

**7. Delete or anonymise (day N, the Privacy promise).**
- **Deleted:** products, photos and media (storage prefix `tenants/<id>/`), store config and themes, discount codes, holds, raffle entries, alert subscribers, invites, and the customers' marketing data.
- **Kept, anonymised:** orders and billing charges keep amounts, dates, tax and Stripe IDs for the legal retention period. The buyer's name, email and address are replaced with a stable hash. **[decision]** How long? I recommend 7 years for the financial fields (a common tax-record period), then a full delete; your legal review should confirm it for your jurisdiction.
- **Kept:** audit logs (Privacy already says so) and webhook dedupe rows.
- A backup is taken first, as launch-reset.ts does. The backup itself is deleted after 30 days, so it isn't a copy that outlives the promise.

**8. Confirmation.** One email to the owner: "Your store is closed and its data has been removed, except what the law makes us keep (order records, anonymised)."

## Building it (when budget allows)

1. Migration (additive): `tenants.closing_at`, `tenants.closed_at`.
2. `lib/offboarding.ts`: `startClosure(tenantId)`, `reopen(tenantId)`, `finishClosure(tenantId)`. The last one reuses launch-reset's table map, scoped to one tenant, with anonymising instead of deleting for orders.
3. A daily job (Cloudflare cron trigger, free) that runs `finishClosure` for stores past their grace period.
4. Proofs: a disposable store goes through the whole flow, checking that:
   - the storefront is dark at day 0;
   - reopening restores it;
   - at day N, no tenant row remains outside orders and billing;
   - order rows carry no buyer PII;
   - the name is held;
   - other stores are untouched (isolation).
