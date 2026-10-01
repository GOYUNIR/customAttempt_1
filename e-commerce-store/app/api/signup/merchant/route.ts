import { NextResponse } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { isValidEmail } from '@/lib/validation';
import { recordPlatformAudit } from '@/lib/platform-audit';
import { merchantSignupOpen } from '@/lib/env';
import { parseLegacyHosts } from '@/lib/storefront-host';
import { checkStoreAddress } from '@/lib/store-address';
import { verifyTurnstile } from '@/lib/turnstile';
import { guardSignupAttempt, isDisposableEmail, signupEmailAllowed, noteSignupEmailSent, signupIp, signupPolicy } from '@/lib/signup-guard';
import { readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';
import { sendSignupVerifyEmail, sendSignupExistingAccountEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

/**
 * /api/signup/merchant — hands-off self-serve store creation.
 *
 * Step 1 (this POST) only RESERVES the store name and emails a link; nothing
 * is created until the email is proven (step 2, ./complete). Abuse protection
 * comes first, in order:
 *   ALLOW_MERCHANT_SIGNUP   the instant kill switch
 *   Turnstile               verified server-side, fail closed (lib/turnstile)
 *   input rules             terms accepted; reserved and lookalike names
 *                           refused (the store-address rules); no disposable email
 *   throttles               per IP (escalating), per email, per domain, global
 *   email budget            resend cooldown; signup mail may use only its share
 *                           of the daily email limit, then "try again tomorrow"
 * NO ENUMERATION: for a valid request the reply is the same whether the email
 * is new, already has an account (it gets a "you already have an account"
 * email instead), or was silently throttled. Only a taken store name, a
 * disposable address or visible throttling get their own message.
 */
const SAME_REPLY = { ok: true, message: 'Check your email: we sent a link to open your store. It can take a minute to arrive.' };
// Signup's share of today's email is used up (the rest is kept for sign-in
// codes and orders). A calm pause, not an error; the same for everyone, so it
// says nothing about any one address.
const FULL_TODAY = { ok: false, full: true, message: 'Lots of new stores opened today, so we have paused signups until tomorrow. Please come back then: your store name is not held, so check it again when you return.' };
const root = () => String(process.env.PLATFORM_ROOT_DOMAIN || '').trim().toLowerCase();
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status });

export async function GET() {
  return NextResponse.json({ enabled: merchantSignupOpen(), siteKey: process.env.TURNSTILE_SITE_KEY || null });
}

export async function POST(request: Request) {
  try {
    if (!merchantSignupOpen()) return fail(403, 'Self-serve signup is not open right now.');
    if (!getDb().configured || !root()) return fail(503, 'Signup is unavailable right now. Please try again shortly.');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const ip = signupIp(request);

    const human = await verifyTurnstile({ token: String(body?.turnstileToken || ''), ip });
    if (!human.ok) {
      return human.reason === 'unavailable'
        ? fail(503, 'We could not check that you are a person right now. Please try again in a moment.')
        : fail(400, 'Please complete the check that you are a person, then try again.', { code: 'TURNSTILE' });
    }

    const email = String(body?.email || '').trim().toLowerCase();
    const storeName = String(body?.storeName || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!isValidEmail(email)) return fail(400, 'Enter a valid email address.');
    if (!storeName) return fail(400, 'Enter a name for your store.');
    if (body?.acceptTerms !== true) return fail(400, 'Please accept the terms to continue.');
    // The web address comes from the name ("Salt & Cedar Co." → salt-cedar-co):
    // accents folded, anything else becomes a hyphen; then the address rules.
    const fromName = String(body?.slug || storeName).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    const address = checkStoreAddress(fromName, { legacyHosts: parseLegacyHosts(process.env.STOREFRONT_LEGACY_HOSTS, root()), rootDomain: root() });
    if (!address.ok) return fail(400, address.reason, { field: 'storeName' });
    if (await isDisposableEmail(email)) return fail(400, 'Please use a permanent email address: we send your store\'s orders and sign-in codes there.');

    const guard = await guardSignupAttempt({ ip, email });
    if (!guard.ok) return NextResponse.json({ error: guard.message }, { status: guard.status, headers: guard.retryAfterSeconds ? { 'retry-after': String(guard.retryAfterSeconds) } : {} });
    if (guard.quiet) { console.warn('[signup] quiet drop (' + guard.why + ') for a request from ' + ip); return NextResponse.json(SAME_REPLY); }

    // Resend cooldown BEFORE reserving: a cooldown must not replace (and so
    // void) the link already sent.
    const allowed = await signupEmailAllowed(email);
    if (!allowed.ok) return allowed.why === 'full' ? NextResponse.json(FULL_TODAY) : NextResponse.json(SAME_REPLY);

    const existing = ((await getDb().select<any>('users', { where: { email: eq(email) }, select: ['id'], limit: 1 })) as any[]).length > 0;
    if (existing) {
      // Counted whether or not it was delivered: a flaky provider must not
      // turn the cooldown and the daily cap into unlimited retries.
      await noteSignupEmailSent(email);
      const sent = await sendSignupExistingAccountEmail({ to: email, signInUrl: 'https://app.' + root() + '/app/login' });
      if (!sent.ok) console.error('[signup] existing-account email failed');
      // The share filled between the check and the send: same pause for both
      // branches, so it still says nothing about the address.
      return NextResponse.json(sent.limited ? FULL_TODAY : SAME_REPLY);
    }

    const policy = await signupPolicy();
    const token = randomBytes(32).toString('hex');
    const rows = (await supabaseRestFetch('/rpc/claim_signup_name', {
      key: readSupabaseEnv().serviceRoleKey, method: 'POST', prefer: 'return=representation',
      body: {
        p_email: email, p_store_name: storeName, p_slug: address.slug, p_token_hash: createHash('sha256').update(token).digest('hex'),
        p_terms_version: String(policy.termsVersion), p_ip: ip, p_hold_hours: policy.holdHours,
        p_accept_days: policy.ownerAcceptDays, p_activation_days: policy.activationDays,
      },
    })) as any[];
    const r = Array.isArray(rows) ? rows[0] : rows;
    if (r?.result === 'taken') return fail(409, 'That store name is taken. Try another.', { field: 'storeName', slug: address.slug });
    if (r?.result !== 'claimed') return fail(500, 'Your store could not be started. Please try again.');

    const url = 'https://' + root() + '/api/signup/merchant/complete?token=' + token;
    await noteSignupEmailSent(email);  // counted even if delivery fails (see above)
    const sent = await sendSignupVerifyEmail({ to: email, storeName, url, holdHours: policy.holdHours });
    if (!sent.ok) console.error('[signup] verify email failed for signup ' + r.signup_id);
    await recordPlatformAudit({ action: 'merchant_signup_started', actor: email, detail: { slug: address.slug, signupId: r.signup_id, ip, emailed: sent.ok === true, termsVersion: policy.termsVersion } });
    return NextResponse.json(sent.limited ? FULL_TODAY : SAME_REPLY);
  } catch (err: any) {
    console.error('[merchant-signup] failed', err?.message || err);
    return fail(500, 'Your store could not be started. Please try again.');
  }
}
