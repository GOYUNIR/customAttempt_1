# Resume note (autonomous launch work order, started 2026-10-01)

Read this first when picking the work back up. Owner's guardrails: no real
email, no spending, Stripe test mode only, no secret changes; destructive
cleanup of TEST data is authorized (with a backup first).

| # | Task | State |
|---|---|---|
| 1 | Remove one-click destructive admin actions | DONE: "Wipe & Rebuild" route and UI removed; Seed stays hard-blocked in production |
| 2 | Launch reset, self-cleaning proofs, tolerant webhooks, storage + Stripe test cleanup | DONE: reset run (backup in launch-backups/), Stripe test cleaned, gate ends with --proof-only teardown (also removes proof-made products in the fixtures; the photo proof makes its own when store B is empty); fixture stores test4 + goyunir-test-1 kept (Connect onboarding is not hands-free) |
| 3 | Health endpoint + uptime monitor list | DONE: /api/health live; monitors in RELEASE-PLAN §10 |
| 4 | Staff/sales portals at phone width | DONE: drawer under 800px; verify-portal-phone.ts (375/390/414) in the gate |
| 5 | Discount codes (flag off) | DONE: built, flag OFF on every plan; verify-discounts.ts ALL PASS live (in the gate) |
| 6 | Hick's Law cheap fixes (DEFERRED-11) | DONE: stock panel, sales pickers, promotions form; logged the rest in ARCHITECTURE DEFERRED-11 |
| 7 | Speed: measure, safe caching | DONE: measured (RELEASE-PLAN "Speed"); two hint changes A/B-tested and reverted (no gain); no HTML caching (money pages stay uncached); verify-no-stale-money.ts in the gate |
| 8 | CSP enforcement plan | DONE: frames/images/media/fonts/object/base enforced; plan in RELEASE-PLAN "CSP plan"; csp-scan.ts in the gate |
| 9 | Store offboarding design | DONE (design only): OFFBOARDING.md, 4 owner decisions |
| 10 | Lean always-loaded context | DONE: STRATEGY.md 14,056 -> ~10.3KB (go-live list now points to RELEASE-PLAN); CLAUDE.md 24 B; AGENTS.md 142 B |
| 11 | Final full release gate on the clean database | IN PROGRESS. Three full runs on 2026-10-02 were NO-GO, each on 503s from production, never a wrong answer: Cloudflare Error 1102 (CPU limit, Workers Free), seen at 5-20% of requests in wrangler tail. Waits on Workers Paid (RELEASE-PLAN item 0). |

Running the gate: run nothing else against production while it runs (two proofs that toggle the same flag interfere with each other), and push nothing during a run, because every push redeploys the Worker, scripts-only pushes included. The gate takes about 30 minutes (signup abuse about 17 of them). Poll it until it finishes; never end a session while it's running.

The owner's open items are in RELEASE-PLAN.md under "WAITING ON ME".
