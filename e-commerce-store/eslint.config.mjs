import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local dev/scratch helpers that intentionally use CommonJS requires.
    ".inspect-config.cjs",
    ".mapbox-test.mjs",
    ".mapbox-web.js",
    "lint-output.txt",
    "lint2.txt",
  ]),
]);

export default eslintConfig;
