/**
 * Cloudflare Workers scheduled task — the platform's equivalent of the Vercel
 * cron (see wrangler.jsonc in this directory for the triggers).
 *
 * On schedule, this worker fetches the app's own endpoints with the shared
 * CRON_SECRET — the same contract the Vercel cron and the Netlify scheduled
 * function use (see lib/cron-auth.ts in the parent app):
 *
 *   daily ("0 0 * * *"):
 *   - /api/checkout/cron-draw    → the Redis-driven auto-draw engine
 *   - /api/cron/recovery         → entry-recovery reminder emails
 *   - /api/analytics/social-tick → social-proof counter tick
 *   every 10 minutes ("*\/10 * * * *"):
 *   - /api/cron/lead-nudge       → one reminder per lead waiting too long for a
 *                                  reply (does nothing while leads are off)
 *
 * Secrets/vars are read from the worker environment, never committed:
 *   - TARGET_URL  → the deployed platform URL (its root domain)
 *   - CRON_SECRET → the same value used for any other platform's scheduler
 */
const DAILY = ['/api/checkout/cron-draw', '/api/cron/recovery', '/api/analytics/social-tick'];
const FREQUENT = ['/api/cron/lead-nudge'];

const cronWorker = {
  async scheduled(event, env) {
    const base = String(env?.TARGET_URL || '').replace(/\/+$/, '');
    const secret = String(env?.CRON_SECRET || '');
    if (!base || !secret) {
      console.warn('[storefront-cron] SKIPPED — TARGET_URL or CRON_SECRET not configured');
      return;
    }
    const paths = String(event?.cron || '') === '0 0 * * *' ? [...DAILY, ...FREQUENT] : FREQUENT;
    for (const path of paths) {
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
