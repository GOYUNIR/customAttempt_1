/**
 * STRIPE IDEMPOTENCY REPLAY HARNESS (Phase A verification)
 *
 * Phase A added idempotency keys to four charge sites. Those keys are correct
 * by construction and by reading, but "Stripe actually honors them on retry"
 * is a claim about Stripe's live behavior, not about this repo's source. This
 * script proves it against real Stripe test-mode infrastructure.
 *
 *   npx tsx scripts/verify-idempotency-replay.ts
 *
 * Requires STRIPE_SECRET_KEY to be a *** TEST MODE *** key (sk_test_…).
 * The script hard-refuses live keys: it creates real PaymentIntents, and
 * against a live key that would be real money.
 *
 * Exits 0 only if every assertion passes; non-zero otherwise, so it can gate
 * a deploy the same way scripts/production-readiness-check.ts does.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type Stripe from 'stripe';
import { resolveStripeClient } from '../services/payment/factory';
import { boundIdempotencyKey, STRIPE_IDEMPOTENCY_KEY_MAX } from '../lib/idempotency-key';

// .env.local loader — Next.js auto-loads this, a bare tsx process doesn't.
// Same loader as scripts/production-readiness-check.ts (repo convention).
function loadDotEnvLocal(): void {
  const path = join(process.cwd(), '.env.local');
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvLocal();

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
const created: string[] = [];

function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}\n    ${detail}`);
}

/** A PaymentIntent body that is valid in test mode and cheap to create. */
function body(): Stripe.PaymentIntentCreateParams {
  return {
    amount: 1000,
    currency: 'usd',
    payment_method_types: ['card'],
    description: 'idempotency replay harness (safe to cancel)',
  };
}

async function createWithKey(stripe: Stripe, key: string): Promise<Stripe.PaymentIntent> {
  const pi = await stripe.paymentIntents.create(body(), { idempotencyKey: key });
  if (!created.includes(pi.id)) created.push(pi.id);
  return pi;
}

/**
 * The exact key SHAPES from the money path, kept in sync with:
 *   lib/auto-draw.ts:547, lib/draw.ts:105, lib/raffle.ts:246,
 *   app/api/checkout/direct/route.ts:176,
 *   app/api/admin/trigger-drop/route.ts:160 and :232
 * `nonce` keeps each harness run from colliding with the previous run's keys
 * (a key Stripe has already seen would trivially "pass" the replay test).
 */
function keyShapes(nonce: string, email: string) {
  const uuid = '3f1c9a0e-7d2b-4c65-9f83-2b7d4e5a6c10';
  return [
    { site: 'lib/auto-draw.ts', key: `autodraw:${uuid}:${nonce}-M:0:${email}` },
    { site: 'lib/draw.ts', key: `draw:${uuid}:${nonce}-M:${email}:cus_ABCDEFGHIJKLMN` },
    { site: 'lib/raffle.ts', key: `raffle-draw:${uuid}:${nonce}` },
    { site: 'checkout/direct', key: `direct:${email}:${uuid}:${nonce}-M:pm_1234567890abcdefghijkl:1` },
    { site: 'trigger-drop', key: `trigger-drop:${uuid}:${nonce}-M:${email}:1` },
    { site: 'trigger-drop-waitlist', key: `trigger-drop-waitlist:${uuid}:${nonce}-M:${email}:1` },
  ];
}

async function main() {
  const rawKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!rawKey) {
    console.error('STRIPE_SECRET_KEY is not set. Set a TEST-MODE key (sk_test_…) and re-run.');
    process.exit(2);
  }
  if (!rawKey.startsWith('sk_test_')) {
    console.error(
      'REFUSING TO RUN: STRIPE_SECRET_KEY is not a test-mode key (expected sk_test_…).\n' +
        'This harness creates real PaymentIntents. Against a live key that is real money.\n' +
        'Point STRIPE_SECRET_KEY at your Stripe *test* key and re-run.',
    );
    process.exit(2);
  }

  const stripe = await resolveStripeClient();
  if (!stripe) {
    console.error('resolveStripeClient() returned null — payment provider is not configured.');
    process.exit(2);
  }

  const nonce = `h${Date.now().toString(36)}`;
  console.log(`\nStripe idempotency replay — test mode, run nonce ${nonce}\n${'='.repeat(60)}`);

  // ── 1. The core claim: the SAME key replayed returns the SAME intent ──────
  const replayKey = `replay-core:${nonce}`;
  try {
    const first = await createWithKey(stripe, replayKey);
    const second = await createWithKey(stripe, replayKey);
    record(
      'Replayed key is deduped by Stripe',
      first.id === second.id,
      first.id === second.id
        ? `both calls returned ${first.id} — Stripe replayed the original response, no second charge`
        : `DIFFERENT intents: ${first.id} vs ${second.id} — idempotency NOT honored (double-charge risk)`,
    );
  } catch (err) {
    record('Replayed key is deduped by Stripe', false, `threw: ${(err as Error).message}`);
  }

  // ── 2. Control: a DIFFERENT key must produce a different intent ──────────
  try {
    const other = await createWithKey(stripe, `replay-control:${nonce}`);
    const ok = !created.slice(0, 1).includes(other.id);
    record(
      'Control — a different key creates a NEW intent',
      ok,
      ok ? `distinct intent ${other.id} (proves test 1 was real dedupe, not a no-op)` : 'unexpectedly deduped',
    );
  } catch (err) {
    record('Control — a different key creates a NEW intent', false, `threw: ${(err as Error).message}`);
  }

  // ── 3. Every real key SHAPE is accepted and deduped ──────────────────────
  const normalEmail = `replay+${nonce}@example.com`;
  for (const { site, key } of keyShapes(nonce, normalEmail)) {
    try {
      const a = await createWithKey(stripe, key);
      const b = await createWithKey(stripe, key);
      record(
        `Key shape accepted + deduped — ${site}`,
        a.id === b.id,
        a.id === b.id ? `${key.length} chars, replay returned ${a.id}` : `NOT deduped: ${a.id} vs ${b.id}`,
      );
    } catch (err) {
      record(`Key shape accepted + deduped — ${site}`, false, `Stripe rejected (${key.length} chars): ${(err as Error).message}`);
    }
  }

  // ── 4. The length ceiling, and the fix for it. Stripe caps keys at 255
  // chars; every shape above interpolates a raw email, an unbounded `text`
  // column. 4a proves the hazard is real against live Stripe. 4b proves
  // lib/idempotency-key.ts's bounding actually resolves it — same long input,
  // now accepted AND still deduped.
  const longEmail = `${'a'.repeat(200)}@example.com`; // legal, under the RFC 254 cap
  const longRaw = keyShapes(nonce, longEmail)[0].key;

  try {
    await createWithKey(stripe, longRaw);
    record(
      '4a. Unbounded long-email key is rejected by Stripe',
      false,
      `expected a 400 for a ${longRaw.length}-char key, but Stripe ACCEPTED it — re-check the cap`,
    );
  } catch (err) {
    const msg = (err as Error).message;
    const isLengthError = /length/i.test(msg);
    record(
      '4a. Unbounded long-email key is rejected by Stripe',
      isLengthError,
      isLengthError
        ? `confirmed: ${longRaw.length} chars rejected — "${msg.slice(0, 80)}…" (this is why bounding exists)`
        : `rejected, but not for length: ${msg}`,
    );
  }

  const longBounded = boundIdempotencyKey(longRaw);
  try {
    const a = await createWithKey(stripe, longBounded);
    const b = await createWithKey(stripe, longBounded);
    const ok = a.id === b.id && longBounded.length <= STRIPE_IDEMPOTENCY_KEY_MAX;
    record(
      '4b. Bounded long-email key is accepted AND deduped',
      ok,
      ok
        ? `bounded ${longRaw.length} -> ${longBounded.length} chars; replay returned ${a.id} — long-address customers can be charged idempotently`
        : `bounded to ${longBounded.length} chars but dedupe failed: ${a.id} vs ${b.id}`,
    );
  } catch (err) {
    record('4b. Bounded long-email key is accepted AND deduped', false, `Stripe rejected the BOUNDED key (${longBounded.length} chars): ${(err as Error).message}`);
  }

  // ── Cleanup: cancel everything this run created ──────────────────────────
  let cancelled = 0;
  for (const id of created) {
    try {
      await stripe.paymentIntents.cancel(id);
      cancelled++;
    } catch {
      /* already cancelled or not cancellable — harmless in test mode */
    }
  }
  console.log(`\nCleanup: cancelled ${cancelled}/${created.length} test PaymentIntents.`);

  const failed = results.filter((r) => !r.ok);
  console.log('='.repeat(60));
  if (failed.length === 0) {
    console.log(`✔ Idempotency replay PASSED — ${results.length}/${results.length} assertions.\n`);
    process.exit(0);
  }
  console.log(`✖ Idempotency replay FAILED — ${failed.length} of ${results.length} assertions:\n`);
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  console.log('');
  process.exit(1);
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(1);
});
