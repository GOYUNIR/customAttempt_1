import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Vendor SDK import fence (ARCHITECTURE.md, Phase A3).
 *
 * Business logic must never import a vendor SDK directly — it goes through
 * the driver + factory ports in services/ (the lib/storage/* pattern). This
 * fence is what stops the abstraction decaying again: lib/adapters/ was built
 * once and ended up with zero business-logic importers precisely because
 * nothing enforced it.
 *
 * Type-only imports are allowed everywhere: they create no runtime coupling
 * and disappear at compile time.
 */
const VENDOR_SDK_FENCE = [
  {
    name: "stripe",
    allowTypeImports: true,
    message:
      "Import the PaymentDriver port (services/payment) instead of the Stripe SDK. Only services/payment/*.driver.ts may touch `stripe` directly.",
  },
  {
    name: "resend",
    allowTypeImports: true,
    message:
      "Import the EmailDriver port (services/email) instead of the Resend SDK. Only services/email/*.driver.ts may touch `resend` directly.",
  },
  {
    name: "mapbox-gl",
    allowTypeImports: true,
    message:
      "Import the MapDriver port (services/maps) instead of the Mapbox SDK. Only services/maps/*.driver.ts may touch `mapbox-gl` directly.",
  },
];

const VENDOR_SDK_FENCE_PATTERNS = [
  {
    group: ["@supabase/*"],
    allowTypeImports: true,
    message:
      "Go through the database port (services/config/supabase-client, and the DbClient port once Phase D lands) instead of the Supabase SDK.",
  },
];

/**
 * DATABASE PORT FENCE (ARCHITECTURE.md, Phase D4).
 *
 * `supabaseRestFetch` takes a raw PostgREST path, so every caller hand-writes
 * Supabase's query dialect. That is the deepest vendor coupling in the codebase
 * — 112 call sites across 27 files, and invisible to the vendor SDK fence above
 * because it is a LOCAL import, not a package. Business logic goes through the
 * DbClient port (lib/db/client.ts) instead, which takes a structured QuerySpec.
 */
const DB_PORT_FENCE = [
  {
    name: "@/services/config/supabase-client",
    importNames: ["supabaseRestFetch"],
    message:
      "Use the DbClient port — getDb() from @/lib/db/client — instead of supabaseRestFetch. Raw PostgREST paths hard-code Supabase's query dialect into business logic.",
  },
];

const DB_PORT_FENCE_PATTERNS = [
  {
    group: ["**/services/config/supabase-client", "**/services/config/supabase-client.ts"],
    importNames: ["supabaseRestFetch"],
    message:
      "Use the DbClient port — getDb() from @/lib/db/client — instead of supabaseRestFetch.",
  },
];

/**
 * `includeDbPort: false` keeps the vendor SDK fence fully enforced while
 * exempting a file from the DB port fence only. Grandfathered callers below
 * use it, so migrating them cannot quietly lose vendor-SDK protection.
 */
const fenceRule = (severity, { includeDbPort = true } = {}) => ({
  "@typescript-eslint/no-restricted-imports": [
    severity,
    {
      paths: includeDbPort ? [...VENDOR_SDK_FENCE, ...DB_PORT_FENCE] : VENDOR_SDK_FENCE,
      patterns: includeDbPort
        ? [...VENDOR_SDK_FENCE_PATTERNS, ...DB_PORT_FENCE_PATTERNS]
        : VENDOR_SDK_FENCE_PATTERNS,
    },
  ],
});

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Deliberate template decision: the admin portal + storefront are
      // pragmatic TypeScript (large `any`-typed state objects, Redis records,
      // Stripe/webhook payloads). Converting every `any` to `unknown` adds
      // noise and risk without runtime benefit, so this rule is OFF for the
      // whole repo. All other type rules (strict mode, no-unused-vars,
      // react-hooks/compiler) stay fully enforced.
      "@typescript-eslint/no-explicit-any": "off",
      // React Compiler's "set-state-in-effect" rule (react-hooks v6) flags
      // synchronous setState inside effect bodies. In this codebase the
      // flagged patterns are safe and idiomatic: async fetch chains (setState
      // runs only after `await`), localStorage draft-prefill on mount, and
      // interval/countdown tickers. The recommended "fixes" (adjusting state
      // during render, lifting state) would restructure working data flow with
      // regression risk for a template that ships as-is. `purity` (Date.now in
      // render) and `immutability` (TDZ / external mutation) remain enforced.
      "react-hooks/set-state-in-effect": "off",
      // The five <img> usages in this repo are all deliberate: the OG card and
      // favicon render inside ImageResponse (next/image is unavailable there),
      // and the admin/header logos use arbitrary admin-supplied URLs and data
      // URLs that the Next.js optimizer can't safely process. This is a perf
      // advisory rule, not a correctness one, so it is disabled repo-wide.
      "@next/next/no-img-element": "off",
      ...fenceRule("error"),
    },
  },
  {
    // The ONE layer allowed to touch a vendor SDK at runtime.
    files: ["services/**/*.driver.ts"],
    rules: { "@typescript-eslint/no-restricted-imports": "off" },
  },
  {
    // THE PORT AND ITS TRANSPORT — permanently exempt, same principle as
    // services/**/*.driver.ts: these files ARE the vendor boundary.
    //   lib/db/**                            the DbClient port itself
    //   services/config/supabase-client.ts   the PostgREST transport it calls
    //   scripts/verify-db-timeouts.ts        exercises that transport directly,
    //                                        which is the whole point of it
    //   lib/system-diagnostics.ts            probes RLS with the ANON key; the
    //                                        port uses service-role, which
    //                                        bypasses RLS and would make the
    //                                        check pass unconditionally
    files: ["lib/db/**/*.ts", "services/config/supabase-client.ts", "scripts/verify-db-timeouts.ts", "lib/system-diagnostics.ts"],
    rules: { ...fenceRule("error", { includeDbPort: false }) },
  },
  {
    // GRANDFATHERED — the 13 callers that predate the DbClient port.
    //
    // The fence lands green by exempting exactly these, so it cannot be
    // weakened later without this list shrinking. Each migration batch deletes
    // its entries; when the list is empty the block goes with it (Phase D4.5)
    // and the fence becomes absolute. A NEW file calling supabaseRestFetch is
    // an error today — the list is closed, not a pattern.
    //
    // Note these still get the full vendor SDK fence: only the DB port entry
    // is relaxed, so migrating one cannot quietly lose the other protection.
    files: [
      "app/api/admin/b2b/price-list/route.ts",
      "app/api/admin/b2b/quotes/route.ts",
      "app/api/admin/domains/route.ts",
      "app/api/admin/impersonate/route.ts",
      "app/api/admin/inventory-matrix/route.ts",
      "app/api/admin/telemetry/route.ts",
      "app/api/admin/tenants/route.ts",
      "app/api/admin/theme/route.ts",
      "app/api/admin/users/route.ts",
      "lib/postgres-catalog-read.ts",
      "lib/products.ts",
      "lib/raffle.ts",
      "scripts/migrate-redis-to-supabase.ts",
    ],
    rules: { ...fenceRule("error", { includeDbPort: false }) },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Platform tool/build output (never source — must never be linted):
    ".open-next/**",
    ".wrangler/**",
    "cron-worker/.wrangler/**",
    ".vercel/**",
    ".netlify/**",
    // Multi-tenant platform (Supabase + Workers/KV) — self-contained sibling
    // workspace with its own lint/typecheck/test scripts (see its README).
    "multi-tenant-platform/**",
    // Local dev/scratch helpers that intentionally use CommonJS requires.
    ".inspect-config.cjs",
    ".mapbox-test.mjs",
    ".mapbox-web.js",
    "lint-output.txt",
    "lint2.txt",
  ]),
]);

export default eslintConfig;
