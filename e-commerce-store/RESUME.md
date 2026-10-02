# Resume note

Read this first when picking the work back up.

Guardrails:
- No real email (record-mode stub only); signup stays off.
- No spending or new cloud resources; Stripe stays in test mode.
- No secrets pasted or rotated.
- Destructive cleanup of TEST data is authorized, with a local backup first.

The platform name and domain are NOT chosen. They are variables read from config. Anything that needs the final values goes on RELEASE-PLAN.md's "BLOCKED ON NAME" list.

Owner decisions (2026-10-02):
- The move to new accounts is a fresh install, and the old stack stays until the new one passes the gate.
- Workers Paid will be bought on the new account; Error 1102s on the old Free stack are not regressions.
- Offboarding is design only (decisions recorded in OFFBOARDING.md).
- Discount codes stay built and OFF.

## Work order 2 (2026-10-02)

| # | Task | State |
|---|---|---|
| 0 | Decided items | DONE: operator-alert budget (5/day, outside the counter, tests mutation-checked); offboarding decisions recorded; BLOCKED ON NAME list added |
| 1 | Storefront first screen server-rendered, behind a flag | DONE: STOREFRONT_SSR (off), ?ssr=1 override; store home 3.35s -> 2.07s, product 2.87s -> 1.55s LCP; CPU +10-20ms (Paid fine); verify-storefront-ssr.ts + no-stale-money in the gate |
| 2 | Bootstrap-in-a-box, runbook, ownership migration | DONE: scripts/bootstrap/ (run.ts dry-run default, 6 idempotent steps, PGlite+fakes rehearsal --twice; secrets manifest+checker; schema parity; identity check; wrangler-dev name rehearsal; tenant transfer + media copy; fixtures check); gate: parity, secrets, fixtures every run, identity in --fresh; BOOTSTRAP-RUNBOOK.md, OWNERSHIP-MIGRATION.md, ci/github-deploy.example.yml. Found+fixed: ai3d_model column missing on live (Setup Wizard save broken), RLS on 2 policy tables (00046), marketing-root flag missing from config, /sitemap.xml 200 store page |
| 3 | Speed-to-lead for our sales team | |
| 4 | Merchant day-one gaps: ranked list, then build the top ones | |
| 5 | Industry starter presets as data | |
| 6 | BOOKINGS-DESIGN.md (design only) | |
| 7 | Homepage and marketing copy pass, stranger-eye audit | |
| 8 | t() helper and ImageProvider abstraction | |
| 9 | Discount codes stay OFF | standing |
| 10 | (the owner's message ended at "10." with nothing after it) | ask |

## Work order 1 (2026-10-01/02): all 11 items done

The final release gate was GO on 2026-10-02 at 10:55Z: 16/16 steps, 0 retries.

## Running the gate

- Run nothing else against production while it runs: two proofs that toggle the same flag interfere with each other.
- Push nothing during a run: every push redeploys the Worker, scripts-only pushes included.
- It takes about 30 minutes, about 17 of them in the signup-abuse step.
- Poll it until it finishes; never end a turn while it's running.
- Retry rule (in release-gate.ts): a step is retried once, only on a connection timeout with no failed check. A step that needs it two runs in a row is NO-GO.

The owner's open items are in RELEASE-PLAN.md under "BLOCKED ON NAME" and "WAITING ON ME".
