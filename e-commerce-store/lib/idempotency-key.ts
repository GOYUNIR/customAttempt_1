/**
 * IDEMPOTENCY KEY BOUNDING (pure, zero-import — see tests/idempotency-key.test.ts)
 *
 * Stripe rejects idempotency keys longer than 255 characters with a 400. Every
 * charge site in this codebase interpolates a raw customer email into its key,
 * and `email` is an unbounded `text` column — so a long-but-legal address
 * produces an over-length key and the charge FAILS OUTRIGHT. This is not a
 * degraded-idempotency scenario; it is a customer who cannot check out.
 *
 * Confirmed against live Stripe test mode by scripts/verify-idempotency-replay.ts:
 *   "Idempotent key length is 272 characters long, which is outside accepted
 *    lengths. Idempotent Keys must be 1-255 characters long."
 *
 * Contract:
 *  - DETERMINISTIC. The same logical operation must produce the same key on a
 *    retry, or idempotency is worthless. No time, no randomness, no counters.
 *  - Keys already within the cap are returned BYTE-FOR-BYTE UNCHANGED, so the
 *    common case keeps its human-readable form in the Stripe dashboard and
 *    this change alters nothing for existing traffic.
 *  - Over-length keys keep as much readable prefix as fit, plus a digest of
 *    the WHOLE original key, so two different long keys stay distinct.
 *
 * The digest is a 64-bit FNV-1a pair rendered base36, deliberately NOT
 * node:crypto — this module stays zero-import. Node's crypto IS available and
 * widely used in this repo's Node-runtime routes (lib/admin-verify.ts,
 * app/api/admin/media/presign/route.ts), so availability is not the reason.
 * The reasons are: zero-import modules load directly under `node --test`
 * (which cannot resolve this repo's `@/` aliases), and they stay safe if ever
 * imported from an Edge-runtime path such as middleware.ts, where node:crypto
 * is unavailable — the same convention lib/csrf.ts and lib/cron-auth.ts follow.
 * This needs determinism and collision resistance, not cryptographic strength:
 * it is never a security boundary.
 */

export const STRIPE_IDEMPOTENCY_KEY_MAX = 255;

/** One 32-bit FNV-1a pass with a configurable offset basis. */
function fnv1a32(input: string, basis: number): number {
  let hash = basis >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff;
    // The UTF-16 high byte matters too — otherwise 'a' and a char sharing its
    // low byte would collide trivially.
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (input.charCodeAt(i) >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 64 bits of digest as base36 (two independent 32-bit FNV-1a passes). */
export function idempotencyDigest(input: string): string {
  const a = fnv1a32(input, 0x811c9dc5);
  const b = fnv1a32(input, 0x7fffffff);
  return `${a.toString(36)}${b.toString(36)}`;
}

/**
 * Return a key guaranteed to be within Stripe's length cap, deterministically.
 * Short keys pass through untouched.
 */
export function boundIdempotencyKey(key: string, max: number = STRIPE_IDEMPOTENCY_KEY_MAX): string {
  if (key.length <= max) return key;
  const suffix = `:${idempotencyDigest(key)}`;
  return `${key.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
}
