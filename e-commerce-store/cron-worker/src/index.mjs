/**
 * Cloudflare Workers scheduled task — the platform's equivalent of the Vercel
 * cron (see wrangler.jsonc in this directory for the daily trigger).
 *
 * On schedule, this worker fetches the app's own safety-net endpoints with the
 * shared CRON_SECRET — the same contract the Vercel cron and the Netlify
 * scheduled function use (see lib/cron-auth.ts in the parent app):
 *
 *   - /api/checkout/cron-draw    → the Redis-driven auto-draw engine
 *   - /api/cron/recovery         → entry-recovery reminder emails
 *   - /api/analytics/social-tick → social-proof counter tick
 *
 * Secrets/vars are read from the worker environment, never committed:
 *   - TARGET_URL  → the deployed store URL, e.g. https://your-store.com
 *   - CRON_SECRET → the same value used for any other platform's scheduler
 */
const cronWorker = {
  async scheduled(_event, env) {
    const base = String(env?.TARGET_URL || '').replace(/\/+$/, '');
    const secret = String(env?.CRON_SECRET || '');
    if (!base || !secret) {
      console.warn('[storefront-cron] SKIPPED — TARGET_URL or CRON_SECRET not configured');
      return;
    }
    for (const path of ['/api/checkout/cron-draw', '/api/cron/recovery', '/api/analytics/social-tick']) {
      try {
        const res = await fetch(`${base}${path}`, {
          headers: { authorization: `Bearer ${secret}` },
        });
        await res.arrayBuffer();
        console.log(`[storefront-cron] ${path} -> ${res.status}`);
      } catch (err) {
        console.error(`[storefront-cron] ${path} failed`, err?.message || err);
      }
    }
  },
};

export default cronWorker;
