# Bootstrap runbook: a fresh install on new accounts

The platform moves to its own name, domain and accounts as a FRESH INSTALL (owner, 2026-10-02):

- All data is disposable; downtime is fine.
- The old stack keeps running untouched until the new one passes the release gate.
- Nothing here needs the final name until the day it's chosen. Everything reads it from the bootstrap inputs.
- Items that need the name are listed under "BLOCKED ON NAME" in RELEASE-PLAN.md.

Below, **NAME** is the platform name and **DOMAIN** its root domain.

## 1. Long-lead items: start these first

They decide the date: each is waiting on someone else.

| Item | Typical wait | Owner | Notes |
|---|---|---|---|
| Name: trademark search, domain registration | days | you | Search the name in the trademark office of every country you'll sell in; buy DOMAIN at the registrar of your choice. |
| Stripe: new account, live-mode application, Connect platform profile | 1–7 days | you | Business details, bank account, identity. The Connect profile (Settings → Connect) describes the platform for Stripe's review. |
| Legal review of the Terms and Privacy pages, with the legal entity name | 1–3 weeks | you + counsel | Entity name goes in the `legalEntity` input; `PLATFORM_LEGAL_REVIEWED=true` after review. |
| Sending domain verification (SPF, DKIM, DMARC) | minutes to 48 h | bootstrap + DNS | Bootstrap adds the records; DNS propagation is the wait. |
| Workers Paid ($5/month) on the new Cloudflare account | instant | you | The old Free stack's Error 1102s don't apply on Paid. |
| Supabase plan (Free or Pro for daily backups) | instant | you | Decide before real data. |

## 2. Accounts and click paths (all under the new name)

1. **Cloudflare:**
   - **Add a site:** DOMAIN, Free plan. At the registrar, change the nameservers to the two Cloudflare shows.
   - **Workers & Pages → Plans:** Workers Paid.
   - **My Profile → API Tokens → Create Token** (Custom): `Zone.DNS:Edit`, `Account.Workers R2 Storage:Edit`, `Account.Turnstile:Edit`, `Zone.Workers Routes:Edit`, scoped to this account and zone. This is `CLOUDFLARE_BOOTSTRAP_TOKEN`; delete it after the move.
   - **R2 → Manage API tokens:** Object Read & Write on the media bucket (created by bootstrap). This gives `MEDIA_S3_ACCESS_KEY_ID` and `MEDIA_S3_SECRET_ACCESS_KEY`.
2. **Supabase:**
   - **New organization → New project:** pick the region nearest your customers and a strong database password.
   - **Project Settings → API:** URL, anon key, service_role key.
   - **Account → Access Tokens:** `SUPABASE_ACCESS_TOKEN`, for the operator machine only.
3. **Stripe:**
   - New account (test mode first).
   - **Developers → API keys:** `STRIPE_SECRET_KEY` (sk_test_…).
   - A restricted key with Webhook Endpoints write: `STRIPE_BOOTSTRAP_KEY`.
4. **Resend:**
   - New account.
   - **API Keys:** one Full-access key for bootstrap (`RESEND_BOOTSTRAP_KEY`, deleted after) and one Sending-access key for the platform (`RESEND_API_KEY`).
5. **GitHub:** the repo stays. Deploys come from the dashboard's git integration or CI (§9).

## 3. Inputs and secrets (never committed)

`bootstrap.json` (plain values, no secrets):

```json
{
  "name": "NAME",
  "domain": "DOMAIN",
  "worker": "NAME-platform",
  "cloudflareAccountId": "<Cloudflare account id>",
  "supabaseProject": "<project ref>",
  "adminEmail": "you@DOMAIN",
  "supportEmail": "support@DOMAIN",
  "alertEmail": "alerts@DOMAIN",
  "legalEntity": "<entity, after legal review>",
  "oldRootDomains": ""
}
```

`new.env`, secrets by name only (the checker `scripts/bootstrap/check-secrets.ts` lists every one, where it lives and how to get it):

```
SUPABASE_URL=  SUPABASE_ANON_KEY=  SUPABASE_SERVICE_ROLE_KEY=  SUPABASE_ACCESS_TOKEN=
MEDIA_S3_ACCESS_KEY_ID=  MEDIA_S3_SECRET_ACCESS_KEY=
CLOUDFLARE_BOOTSTRAP_TOKEN=  RESEND_BOOTSTRAP_KEY=  STRIPE_BOOTSTRAP_KEY=
STRIPE_SECRET_KEY=  RESEND_API_KEY=  BOOTSTRAP_ADMIN_PASSWORD=   (12+ characters)
```

Bootstrap reads secrets only from `--env new.env` or the shell, **never from `.env.local`** (the old stack's), so old keys can't leak into the new install.

## 4. Rehearse first (any time, no accounts needed)

```
npx tsx scripts/bootstrap/run.ts --name "Larkspur Commerce" --domain larkspur.example \
    --cloudflare-account x --admin-email a@larkspur.example --target local --fake-services --apply --twice
npx opennextjs-cloudflare build && npx tsx scripts/bootstrap/rehearse.ts
npx tsx scripts/bootstrap/schema-parity.ts
```

- The first applies every step to an in-memory database and fake services, then proves a second run has nothing to do.
- The second runs the real Worker bundle under a made-up name and checks every platform page and email for the old identity.
- The third proves the live schema is exactly what the migrations build.

Status 2026-10-02:

- Every check passes, except the staff sign-in pages carrying the default store's theme data. That's data on the OLD database: on a fresh install the default tenant is a neutral shell. See OWNERSHIP-MIGRATION.md.
- The schema check found and fixed two real gaps: a missing settings column, and RLS on the policy tables.

## 5. The install, step by step

```
npx tsx scripts/bootstrap/run.ts --config bootstrap.json --env new.env              # dry run: read it
npx tsx scripts/bootstrap/run.ts --config bootstrap.json --env new.env --apply --only database
npx tsx scripts/bootstrap/run.ts --config bootstrap.json --env new.env --apply --only cloudflare
npx tsx scripts/bootstrap/run.ts --config bootstrap.json --env new.env --apply --only resend
npx tsx scripts/bootstrap/run.ts --config bootstrap.json --env new.env --apply --only worker-secrets
```

1. **database:** all migrations, recorded the way the Supabase CLI records them, and the default-tenant shell named NAME. It refuses a database that already holds a schema it didn't install.
2. **cloudflare:** proxied DNS for DOMAIN and `*.DOMAIN`, the private R2 bucket, the Turnstile widget (its secret goes into the Worker). Put the printed site key into `bootstrap.json` as `turnstileSiteKey`, then re-run to regenerate the config.
3. **resend:** the sending domain, and its records in Cloudflare as DNS only, then a verification request.
4. **worker-secrets:** set once, never overwritten; `CRON_SECRET` is generated.
5. **Deploy:**
   - Copy `bootstrap-out/DOMAIN/wrangler.jsonc` over the repo's `wrangler.jsonc` on a branch for the new install, or a fork.
   - Connect it in Cloudflare → Workers → the Worker → Settings → Builds (git integration), or use CI (§9). Build command: `npm run build:cloudflare`.
   - Wait for `https://DOMAIN/api/health` to answer `{"status":"ok"}`.
6. `--apply --only first-admin`: the first super-admin, through the site's own Setup Wizard route, with the Stripe and Resend keys from `new.env`.
7. `--apply --only stripe-webhooks`: the platform and Connect endpoints. Their signing secrets go into the settings row. This step comes last because the first wizard save writes the provider fields.
8. A plain `run.ts` (dry run) now shows "nothing to do" on every step.

## 6. Proof fixtures and the shops

The release gate's proofs use fixed stores. They're recreated with the SAME ids, so the proofs run unchanged:

```
npx tsx scripts/bootstrap/tenant-transfer.ts export --tenant 13591c9e-82e4-4c23-8d94-249cef6fa775   # test4 (Connect fixture)
npx tsx scripts/bootstrap/tenant-transfer.ts export --tenant ff8d5e59-1a07-4e83-bc13-f949c745d9de   # goyunir-test-1 (store B)
npx tsx scripts/bootstrap/tenant-transfer.ts export --tenant 3b6f7db1-7645-4c52-aefe-cc8be563c359   # demo
for f in bootstrap-out/transfer/{test4,goyunir-test-1,demo}.json; do
  npx tsx scripts/bootstrap/tenant-transfer.ts import --file $f --env new.env --apply
  npx tsx scripts/bootstrap/tenant-transfer.ts copy-media --file $f --env new.env --apply
done
```

Then, once, by hand in Stripe **test** mode:

- Invite an owner to test4 (admin → Stores → test4 → Invite owner, a sink-domain address).
- Sign in as that owner, open Settings → Payments → Connect, and complete Stripe's test onboarding with test data.

`npx tsx scripts/bootstrap/check-fixtures.ts` confirms all of it.

**The GOYUNIR shop becomes an ordinary tenant:**

```
npx tsx scripts/bootstrap/tenant-transfer.ts export --tenant 00000000-0000-0000-0000-00000000000d
npx tsx scripts/bootstrap/tenant-transfer.ts import --file bootstrap-out/transfer/goyunir.json --env new.env \
    --as-id $(node -e "console.log(crypto.randomUUID())") --as-slug goyunir --apply
npx tsx scripts/bootstrap/tenant-transfer.ts copy-media --file bootstrap-out/transfer/goyunir.json --env new.env --apply
```

- The shop lives at `goyunir.DOMAIN`.
- To serve it on its own domain: admin → the store → Domains → add `goyunir.com`, then point goyunir.com's DNS at the new platform as the domain screen says. Do this only after the old stack is retired from that domain (§8).
- Its owner reconnects Stripe from Settings → Payments, because a connected account never moves between Stripe platforms.

## 7. Move day (hour by hour)

| When | What | Check |
|---|---|---|
| T−7 days | Long-lead items done: domain on Cloudflare, Stripe test keys, Resend account, Workers Paid. | — |
| T−2 days | Steps 1–4 (database, cloudflare, resend, worker-secrets). DNS and the sending domain propagate. | `run.ts` dry run: only first-admin and stripe-webhooks left. |
| T−1 day | Deploy (step 5). First admin, webhooks (6–7). Fixtures and shops (§6). | `/api/health` ok; `check-fixtures.ts` ALL PASS. |
| T 0:00 | `GATE_OLD_IDENTITY="GOYUNIR,goyunir.com,goyunir@gmail.com" npx tsx scripts/release-gate.ts --fresh` with `PROOF_ROOT_DOMAIN=DOMAIN` and the NEW `.env.local`. | GO. |
| T 0:40 | `npx tsx scripts/verify-domain-migration.ts DOMAIN` (DNS, mail, webhooks, cookies, headers). | Every line PASS. |
| T 1:00 | Turn on what launch needs: Stripe live keys (wizard), live webhooks (`run.ts --only stripe-webhooks` with a live restricted key), `STOREFRONT_SSR=on`. Signup stays off until you say so. | Gate again on test keys if anything changed. |
| T 2:00 | Announce the new address. The old stack keeps serving the old domain unchanged. | — |
| T+7 days | Point goyunir.com at the new platform (§6). Retire the old Worker, then delete the old accounts' keys. Delete the bootstrap tokens (Cloudflare, Resend, Stripe restricted). | Old domain 301s or serves the shop from the new platform. |

## 8. Rollback

- **Until goyunir.com is pointed** (T+7 days), the old stack is untouched and still serving. Rollback means not announcing the new address, or announcing the old one again. Nothing on the old stack changed.
- **After goyunir.com moves:**
  - remove the custom domain on the new platform;
  - restore the old Worker's route for goyunir.com (it's still in the old account until retired);
  - point the DNS back.

  DNS answers within minutes because everything is proxied through Cloudflare.
- **On the new install:** bootstrap is re-runnable. To start the database over, delete the Supabase project, create a new one and run `--only database` again; nothing else depends on its contents.

## 9. Deploys: CI as an alternative to the dashboard's git integration

Today's deploys are Cloudflare's git integration: push to `main` builds and deploys the Worker. `wrangler deploy` is never run locally.

The proposal: deploy from GitHub Actions instead. `ci/github-deploy.example.yml` is a ready workflow, inactive until it's copied to `.github/workflows/`.

| | Dashboard git integration (today) | GitHub Actions (proposed) |
|---|---|---|
| Checks before deploy | none (the pre-push hook runs locally) | typecheck + unit tests in CI, so a broken push never deploys |
| Who holds the deploy credential | Cloudflare | a GitHub secret (`CLOUDFLARE_API_TOKEN`, Workers Scripts Edit, one Worker) |
| Logs | Cloudflare dashboard | GitHub run log, next to the commit |
| Cost | free | free for this repo's size |
| Setup | already done | add the secret, enable the workflow, disconnect the dashboard build |

**My recommendation:** CI on the new install, because a deploy can't skip the tests. It's your call, since it moves a credential into GitHub.
