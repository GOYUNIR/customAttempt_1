import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { isValidEmail } from '@/lib/validation';
import { recordPlatformAudit } from '@/lib/platform-audit';
import { createInvite, INVITE_TTL_DAYS } from '@/lib/staff-invites';
import { sendStaffInviteEmail } from '@/lib/email';
import { acceptInviteUrl } from '@/lib/staff-realms';

export const dynamic = 'force-dynamic';

/**
 * /api/signup/merchant — self-serve store creation. The last piece of the
 * Shopify/Stripe onboarding comparison: until now a store could only be
 * provisioned by a platform admin, and even then it had no owner.
 *
 * WHY THIS SENDS AN INVITE INSTEAD OF SIGNING THE MERCHANT STRAIGHT IN.
 * The alternative — take a password here and create the account immediately —
 * is one click shorter, and it hands an `owner` role to an email address nobody
 * has proven control of. An owner can read customer records and change payment
 * settings, so "prove the inbox first" is the right trade for a role at that
 * tier. The link in the email IS the proof, and it reuses the invite path that
 * is already verified end to end rather than inventing a second way in.
 *
 * DISABLED BY DEFAULT. `ALLOW_MERCHANT_SIGNUP=true` opts a deployment in.
 * Public tenant creation on a single-brand store — which is what most
 * deployments of this codebase are — would let anyone create tenants on
 * somebody's live shop. That is a decision for the operator, not a default.
 */

function signupEnabled(): boolean {
  return String(process.env.ALLOW_MERCHANT_SIGNUP || '').trim().toLowerCase() === 'true';
}

/** A URL-safe slug from a store name, or '' when nothing usable survives. */
function slugify(input: string): string {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

/** Slugs that would collide with a portal host or a reserved surface. */
const RESERVED_SLUGS = new Set([
  'admin', 'app', 'sales', 'www', 'api', 'mail', 'media', 'static', 'assets',
  'status', 'help', 'support', 'docs', 'blog', 'shop', 'store', 'account',
]);

export async function GET() {
  // So a signup page can render "closed" honestly instead of failing on submit.
  return NextResponse.json({ enabled: signupEnabled() });
}

export async function POST(request: Request) {
  try {
    if (!signupEnabled()) {
      return NextResponse.json(
        { error: 'Self-serve signup is not enabled on this deployment.' },
        { status: 403 },
      );
    }
    if (!getDb().configured) {
      return NextResponse.json({ error: 'Signup requires Supabase.' }, { status: 503 });
    }

    // Public and unauthenticated, so it creates rows for anyone who asks —
    // limited tightly. Tenant spam is cheap to send and expensive to clean up.
    const limited = await rateLimitedResponse('merchant_signup', request, 5, 3600);
    if (limited) return limited;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const email = String(body?.email || '').trim().toLowerCase();
    const storeName = String(body?.storeName || '').trim().slice(0, 200);
    const requestedSlug = slugify(String(body?.slug || '') || storeName);

    if (!isValidEmail(email)) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
    }
    if (!storeName) {
      return NextResponse.json({ error: 'Enter a name for your store.' }, { status: 400 });
    }
    if (!requestedSlug) {
      return NextResponse.json(
        { error: 'That store name cannot be turned into a web address. Use letters and numbers.' },
        { status: 400 },
      );
    }
    if (RESERVED_SLUGS.has(requestedSlug)) {
      return NextResponse.json(
        { error: 'That address is reserved. Choose a different store name.' },
        { status: 409 },
      );
    }

    // Already staff somewhere? Then this is a person who should sign in, not a
    // new store owner — and creating a second identity for the same address
    // would break the one-account-per-email assumption the whole staff model
    // rests on.
    const existingStaff = (await getDb().select<{ id: string }>('users', {
      where: { email: eq(email) }, select: ['id'], limit: 1,
    })) as Array<{ id: string }>;
    if (existingStaff.length > 0) {
      return NextResponse.json(
        { error: 'An account already exists for that email. Sign in instead.' },
        { status: 409 },
      );
    }

    const existingSlug = (await getDb().select<{ id: string }>('tenants', {
      where: { slug: eq(requestedSlug) }, select: ['id'], limit: 1,
    })) as Array<{ id: string }>;
    if (existingSlug.length > 0) {
      return NextResponse.json(
        { error: 'That store address is already taken. Try another name.' },
        { status: 409 },
      );
    }

    const created = (await getDb().insert('tenants', {
      name: storeName,
      slug: requestedSlug,
      license_status: 'active',
    })) as Array<{ id: string; name: string; slug: string }>;
    if (!created?.[0]) {
      return NextResponse.json({ error: 'Could not create the store.' }, { status: 500 });
    }
    const tenant = created[0];

    const invite = await createInvite({
      email,
      role: 'owner',
      tenantId: tenant.id,
      invitedByEmail: 'self-signup',
    });
    if (!invite.ok) {
      // The tenant exists but has no owner. Reported honestly rather than
      // pretending the signup worked — and NOT rolled back, because a second
      // attempt would then hit the slug-taken check and strand the person
      // either way. An operator can invite the owner by hand.
      console.error('[merchant-signup] tenant ' + tenant.slug + ' created but owner invite failed: ' + invite.message);
      return NextResponse.json(
        { error: 'Your store was created but we could not send the invitation. Please contact support.', tenant },
        { status: 500 },
      );
    }

    // Absolute, staff-host URL — see acceptInviteUrl's doc for why getSiteUrl()
    // shipped a bare relative path here (DNS_PROBE_FINISHED_NXDOMAIN on click).
    const acceptUrl = acceptInviteUrl('owner', invite.token, process.env.PLATFORM_ROOT_DOMAIN);
    const sent = await sendStaffInviteEmail({
      to: email,
      role: 'owner',
      invitedBy: 'the ' + storeName + ' signup',
      acceptUrl,
      expiresInDays: INVITE_TTL_DAYS,
    });

    await recordPlatformAudit({
      action: 'merchant_self_signup',
      actor: email,
      tenantId: tenant.id,
      detail: { tenantId: tenant.id, slug: tenant.slug, storeName, emailed: sent.ok === true },
    });

    return NextResponse.json({
      ok: true,
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      // Deliberately vague about the token unless the email failed: the reply
      // to an unauthenticated request must not hand out a credential.
      emailed: sent.ok === true,
      message: sent.ok
        ? 'Check your email to finish setting up your store.'
        : 'Your store was created, but the confirmation email could not be sent. Contact support to finish setup.',
    });
  } catch (err: any) {
    console.error('[merchant-signup] failed', err?.message || err);
    return NextResponse.json({ error: 'Could not create your store.' }, { status: 500 });
  }
}
