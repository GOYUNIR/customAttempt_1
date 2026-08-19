import { defineCloudflareConfig } from '@opennextjs/cloudflare';

/**
 * OpenNext Cloudflare adapter config — consumed ONLY when deploying the
 * storefront to Cloudflare Workers/Pages (see DEPLOY-CLOUDFLARE.md). The
 * standard `npm run build` / `next build` path ignores this file entirely.
 *
 * The app is deliberately platform-agnostic: every route talks to Upstash
 * Redis, Stripe and Resend over plain HTTPS with no platform SDKs, so the
 * OpenNext build produces a single Worker that behaves exactly like the
 * Vercel / Netlify / Node deploys. The public JSON routes already emit
 * explicit `Cache-Control` + `CDN-Cache-Control` headers (see
 * `lib/cache-headers.ts`) that Cloudflare's edge honors, and `/media`/`/og`
 * carry `?v=` content-hash cache-busters, so no per-route overrides are
 * needed here.
 *
 * Install the adapter before building:
 *   npm install -D @opennextjs/cloudflare@latest wrangler@latest
 * then build + deploy (from the repo root):
 *   npx opennextjs-cloudflare build
 *   npx wrangler deploy
 */
export default defineCloudflareConfig({
  // No overrides required — kept explicit so the file documents itself and a
  // buyer can add caching/incremental-overrides without digging through docs.
});
