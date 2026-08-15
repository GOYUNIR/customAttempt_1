/**
 * Client-side "the countdown hit zero" trigger.
 *
 * When a product's raffle/opening countdown reaches zero, the page calls
 * `notifyDropDue()` so the server runs the draw IMMEDIATELY — no reliance on a
 * scheduled cron (Vercel cron was previously not configured at all, which is
 * exactly why drops never fired). The server side (`/api/checkout/auto-draw` +
 * `lib/auto-draw.ts`) is idempotent: it checks the pool's own timing and a 90s
 * per-pool cooldown, so many visitors pinging in the same second cannot
 * double-draw.
 *
 * Reliability guarantees here:
 *   - If the first POST fails (network blip, deploy in progress), the ping is
 *     RETRIED with backoff (2s → 8s → 25s) so a drop is not silently missed.
 *   - After the dedupe window (4 min), the trigger RE-ARMS so a tab left open
 *     past the zero-moment pings again if the pool is somehow still open — the
 *     server's due-check + cooldown make repeat pings completely harmless.
 */

const firedThisSession = new Set<string>();
const RETRY_DELAYS_MS = [2000, 8000, 25000];
const REARM_MS = 4 * 60 * 1000;

type DropOpts = { productId?: string; productName?: string; slug?: string };

function postDropDue(opts: DropOpts): Promise<Response> {
  return fetch('/api/checkout/auto-draw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productId: opts.productId || '',
      productName: opts.productName || '',
      slug: opts.slug || '',
    }),
  });
}

function pingWithRetry(opts: DropOpts, attempt: number): void {
  postDropDue(opts)
    .then((res) => {
      // A 4xx/5xx response (e.g. the rate limiter, or a draw already running)
      // is not fatal — the server-side cron safety net still exists.
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    })
    .catch(() => {
      if (attempt < RETRY_DELAYS_MS.length) {
        window.setTimeout(() => pingWithRetry(opts, attempt + 1), RETRY_DELAYS_MS[attempt]);
      }
    });
}

export function notifyDropDue(opts: DropOpts): void {
  if (typeof window === 'undefined') return;
  const key = opts.productId || opts.productName || opts.slug || '*';
  if (firedThisSession.has(key)) return;
  firedThisSession.add(key);

  // Fire-and-forget with automatic retries; the server owns the real
  // dedupe/cooldown.
  pingWithRetry(opts, 0);

  // Re-arm the trigger a few minutes later so a page left open (or a phone that
  // lost its connection at the exact zero-moment) gets a second chance to nudge
  // the server if the pool is still open.
  window.setTimeout(() => {
    firedThisSession.delete(key);
    if (document.visibilityState === 'visible') pingWithRetry(opts, 0);
  }, REARM_MS);
}

/** Clear the session dedupe set (used when the page needs to re-arm, e.g. after
 * a product reload that reveals a still-open pool). */
export function resetDropNotifications(): void {
  firedThisSession.clear();
}
