/**
 * Client-side "the countdown hit zero" trigger.
 *
 * When a product's raffle/opening countdown reaches zero, the page calls
 * `notifyDropDue()` so the server runs the draw IMMEDIATELY — no reliance on a
 * scheduled cron (Vercel cron was previously not configured at all, which is
 * exactly why drops never fired). The server side (`/api/checkout/auto-draw` +
 * `lib/auto-draw.ts`) is idempotent: it checks the pool's own timing and a 90s
 * per-pool cooldown, so many visitors pinging in the same second cannot
 * double-draw. This helper only dedupes the SAME product within a page session
 * to avoid pointless network chatter.
 */

const firedThisSession = new Set<string>();

export function notifyDropDue(opts: {
  productId?: string;
  productName?: string;
  slug?: string;
}): void {
  if (typeof window === 'undefined') return;
  const key = opts.productId || opts.productName || opts.slug || '*';
  if (firedThisSession.has(key)) return;
  firedThisSession.add(key);

  // Fire-and-forget; the server owns the real dedupe/cooldown.
  fetch('/api/checkout/auto-draw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productId: opts.productId || '',
      productName: opts.productName || '',
      slug: opts.slug || '',
    }),
  }).catch(() => {
    // Best-effort — the cron safety net still exists.
  });
}

/** Clear the session dedupe set (used when the page needs to re-arm, e.g. after
 * a product reload that reveals a still-open pool). */
export function resetDropNotifications(): void {
  firedThisSession.clear();
}
