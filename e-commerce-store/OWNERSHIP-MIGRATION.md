# Ownership migration: the operator's identity is config

Who runs the platform (its name, domain, legal entity and addresses) is configuration, never code. A move or a rename changes values, then a check proves no old value is left on anything a stranger or merchant sees.

## The identity values

| Value | Config | Where it shows |
|---|---|---|
| Platform name | `PLATFORM_NAME` | marketing site, page titles, legal pages, platform emails (subject, brand, sender name), staff portal headers |
| Root domain | `PLATFORM_ROOT_DOMAIN` | every address: marketing apex, `admin.`, `sales.`, `app.`, `<store>.`; cookies; Turnstile hostname; webhook URLs |
| Old roots | `PLATFORM_OLD_ROOT_DOMAINS` | answers with a 301 to the same address on the new root (never shown) |
| Support address | `SUPPORT_EMAIL` | contact lines, reply-to on platform mail, legal pages |
| Alert address | `OPERATOR_ALERT_EMAIL` (falls back to `SUPPORT_EMAIL`) | operator alerts (e.g. the signup breaker); never shown to customers |
| Platform sender | `RESEND_FROM` (secret) | the From of platform mail: `NAME <notifications@DOMAIN>` |
| Legal entity | `PLATFORM_LEGAL_ENTITY`, `PLATFORM_LEGAL_REVIEWED` | Terms and Privacy |
| Description | `PLATFORM_DESCRIPTION` | marketing metadata |
| Media host | `MEDIA_S3_PUBLIC_BASE_URL` | photo URLs (`media.DOMAIN`) |

For a fresh install, all of these are generated from the bootstrap inputs (`scripts/bootstrap/wrangler-config.ts`, BOOTSTRAP-RUNBOOK.md). For a rename on the same install, `scripts/set-platform-domain.ts` rewrites them in `wrangler.jsonc`.

## The check

```
npx tsx scripts/bootstrap/identity-check.ts --old "<old name>,<old domain>,<old addresses>"
GATE_OLD_IDENTITY="..." npx tsx scripts/release-gate.ts --fresh        (the same, inside the gate)
npx tsx scripts/bootstrap/rehearse.ts                                     (locally, as a made-up name)
```

- **What it covers:**
  - platform pages: marketing home, terms, privacy, signup status, robots, sitemap, and the admin, sales and merchant sign-in pages, following redirects;
  - the platform's emails: sign-in code, staff invite, signup verify, existing account. They're rendered through the record-mode stub, never sent, and read back;
  - the alert address;
  - the generated Worker config.
- **What fails it:** an old value in visible text, a title, a link, an address or an email. A surface it couldn't check also fails it: "not clean until checked".
- **Listed apart, not a failure:** code identifiers built from the old name, such as the CSS class `goyunir-mkt-nav` or the storage key `goyunir_admin_device`. They're invisible to people, and renaming them is a separate job (below).
- **Stores' own pages are excluded.** A store keeps its own name, the GOYUNIR shop included.

Proven both ways on 2026-10-02:

- Against production with a made-up old identity: clean.
- Against production with the current stand-in as "old": 20 hits.
- The local rehearsal as "Larkspur Commerce" found that the marketing-root switch was missing from the generated config, and that `/sitemap.xml` rendered a store page. Both are fixed.

## What remains

1. **On the old database, the default tenant IS the GOYUNIR shop.**
   - What happens: the staff sign-in pages embed the default tenant's theme data, including its brand name and logo, so the rehearsal against the old database still shows "GOYUNIR" in that data on `admin.`, `sales.` and `app.`.
   - On a fresh install it's gone by construction: the default tenant is a neutral shell named after the platform, and the GOYUNIR shop moves over as an ordinary tenant (`tenant-transfer.ts --as-id`).
   - The cleaner fix, after launch: platform sign-in pages stop embedding any store's theme data. This is the "admin. is both the platform admin and the shop's admin" item in RELEASE-PLAN.md.
2. **Code identifiers:**
   - CSS classes, element ids, localStorage keys and cookie names start with `goyunir`.
   - They're invisible, but renaming storage keys and cookies signs everyone out and resets visitor ids, so it's a planned change, not a find-and-replace.
   - Listed after launch in RELEASE-PLAN.md.
3. **Test fixtures** keep their names (`goyunir-test-1`, `isolation-owner-b@goyunir.invalid`). They're proof data on sink domains, never shown to customers.
