# GOYUNIR — Raffle Storefront

A weekly allocation-drop raffle site. Visitors enter with an email, shipping
address, and a card on file; on a schedule (or when an admin triggers it),
winners are drawn and their cards are automatically charged.

## The one file you'll ever need to edit

**`e-commerce-store/goyunir.config.ts`** — every product, price, drop
schedule, social-proof setting, and catalog entry lives there, with inline
comments explaining every field. You should not need to touch any other
file for normal day-to-day operation.

Everything else in this repo is plumbing: Stripe checkout, Redis storage,
the admin portal, and the draw logic. Those files should only change if
you're adding an actual new feature.

## How the raffle works

1. Someone fills out the form on the site (email + address) and clicks
   enter — this creates an "intent."
2. They're sent to Stripe to save a card (no charge yet) — on success,
   this becomes a confirmed "entry."
3. One entry per email, one entry per physical card, per drop — this is
   enforced automatically (matches how SNKRS/CONFIRMED-style raffles work).
4. At the scheduled time (or when an admin clicks "Trigger Draw" in
   `/admin`), winners are randomly selected up to the configured inventory
   limit and their saved cards are charged automatically.
5. Non-winners and anyone who started but never finished checkout are
   never deleted — everything is permanently logged in the searchable
   ledger in `/admin`, and the pool resets so people can enter the next
   drop.

## Timezones

All schedule times in `goyunir.config.ts` are set in a real timezone (default
`America/Los_Angeles`, i.e. PST/PDT) — change the `timezone` field once and
every on-site countdown recalculates automatically, DST included.

**Exception:** the automatic-charge cron job (`vercel.json`) is scheduled by
Vercel, which only runs cron in UTC. If you change the draw day/time in
`goyunir.config.ts`, update the cron line in `e-commerce-store/vercel.json`
to match. Rough PST → UTC conversion:

| PST time | UTC (winter/PST) | UTC (summer/PDT) |
|---|---|---|
| 9:00 PM | 05:00 next day | 04:00 next day |
| 12:00 AM | 08:00 | 07:00 |

Vercel cron doesn't auto-adjust for Daylight Saving — expect the actual
charge to drift by an hour from the on-site countdown twice a year unless
you manually nudge the cron expression.

## Environment variables (set in Vercel project settings)

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRODUCT_ID` (optional) — global default Stripe price ID; used when a
  product/size has no per-product Stripe ID set in `/admin`. Per-product IDs
  set in admin always win. There is no hardcoded Stripe price ID in this
  template — if none is set anywhere, checkout fails with an obvious
  placeholder instead of charging the wrong account.
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `ADMIN_BASIC_AUTH_USERNAME`
- `ADMIN_BASIC_AUTH_PASSWORD`
- `CRON_SECRET`

## Stripe setup checklist

- Add a webhook endpoint in the Stripe Dashboard pointing to
  `https://yourdomain.com/api/stripe/webhook`, subscribed to
  `checkout.session.completed`.
- Enable the Customer Portal (Settings → Billing → Customer Portal) with
  "Payment methods" turned on — this powers the "Update Payment Method"
  button on `/account`.

## Sharing specific products

Every product has a `slug` in `goyunir.config.ts`. Share
`yoursite.com/<slug>` to send someone straight to that item (add
`?size=100ml` to preselect a size). `yoursite.com` on its own always shows
the first active, non-archived product.

## Archiving products

Two ways:
- **Manual** — in `/admin`, under "Catalog Archive," click "Archive This
  Product" any time. Click "Restore to Active" to bring it back. No deploy
  needed.
- **Scheduled** — set `scheduledArchiveAt` / `scheduledUnarchiveAt` on a
  product in `goyunir.config.ts` and it happens automatically at that
  wall-clock time, no admin action required.

Archived products automatically appear on the `/catalog` page's archive
section with their available-from/until dates. Nothing about a product's
history is ever deleted.

## Managing your own entry (as a customer)

`/account` — verify with the email + last 4 card digits used at entry.
From there you can cancel your entry, edit your shipping address, or
update your payment method via Stripe's own secure portal.

## Admin portal

`/admin` (protected by `ADMIN_BASIC_AUTH_USERNAME`/`PASSWORD`) — trigger
draws, manage the catalog archive, see who's currently online, and search
the full permanent entry ledger by email/address/product.