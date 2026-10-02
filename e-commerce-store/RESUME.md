# Resume note (autonomous launch work order, started 2026-10-01)

Read this first when picking the work back up. Owner's guardrails: no real
email, no spending, Stripe test mode only, no secret changes; destructive
cleanup of TEST data is authorized (with a backup first).

| # | Task | State |
|---|---|---|
| 1 | Remove one-click destructive admin actions | DONE: "Wipe & Rebuild" route and UI removed; Seed stays hard-blocked in production |
| 2 | Launch reset, self-cleaning proofs, tolerant webhooks, storage + Stripe test cleanup | DONE: reset run (backup in launch-backups/), Stripe test cleaned, gate ends with --proof-only teardown; fixture stores test4 + goyunir-test-1 kept (Connect onboarding is not hands-free) |
| 3 | Health endpoint + uptime monitor list | DONE: /api/health live; monitors in RELEASE-PLAN §10 |
| 4 | Staff/sales portals at phone width | DONE: drawer under 800px; verify-portal-phone.ts (375/390/414) in the gate |
| 5 | Discount codes (flag off) | |
| 6 | Hick's Law cheap fixes (DEFERRED-11) | |
| 7 | Speed: measure, safe caching | |
| 8 | CSP enforcement plan | |
| 9 | Store offboarding design | |
| 10 | Lean always-loaded context | |
| 11 | Final full release gate on the clean database | |

The owner's open items are in RELEASE-PLAN.md under "WAITING ON ME".
