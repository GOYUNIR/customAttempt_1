import { NextResponse } from 'next/server';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { getDb } from '@/lib/db/client';
import { createKvClient } from '@/lib/server-config';
import { appendAudit } from '@/app/api/admin/audit/route';
import {
  lookupInviteByToken,
  claimInvite,
  releaseClaim,
  linkAcceptedUser,
} from '@/lib/staff-invites';
import { createStaffAccount } from '@/lib/staff-accounts';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/accept-invite — the UNAUTHENTICATED half of staff onboarding.
 *
 *   GET  ?token=…                 — what this invite is for, without using it
 *   POST { token, password, … }   — create the account
 *
 * This endpoint is deliberately reachable with no session: the person using it
 * has no account yet, which is the entire point. The token IS the credential,
 * so everything else here follows from that:
 *
 *   - rate limited hard, because a token is the only thing standing between an
 *     attacker and a staff account with a role attached
 *   - the GET never reveals anything an attacker could not already infer from
 *     holding the token, and reveals nothing at all for a bad one
 *   - the role comes from the INVITE ROW, never from the request body. A
 *     client-supplied role here would be a free privilege escalation, and it is
 *     the first thing anyone would try
 */

/** What an invite is for — shown before the invitee commits to a password. */
export async function GET(request: Request) {
  try {
    const limited = await rateLimitedResponse('accept_invite_lookup', request, 30, 300);
    if (limited) return limited;
    if (!getDb().configured) {
      return NextResponse.json({ error: 'Invitations require Supabase.' }, { status: 503 });
    }

    const token = new URL(request.url).searchParams.get('token') || '';
    const result = await lookupInviteByToken(token);
    if (!result.ok) {
      // Each reason means something different to the holder: expired should be
      // re-requested, accepted means "you already have an account, sign in",
      // revoked means someone withdrew it deliberately. Collapsing them into
      // one message would leave a legitimate invitee with no idea what to do.
      const messages: Record<string, string> = {
        not_found: 'This invitation link is not valid.',
        expired: 'This invitation has expired. Ask for a new one.',
        accepted: 'This invitation has already been used. Try signing in instead.',
        revoked: 'This invitation was withdrawn.',
      };
      return NextResponse.json(
        { ok: false, reason: result.reason, error: messages[result.reason] || 'This invitation is not valid.' },
        { status: 410 },
      );
    }

    return NextResponse.json({
      ok: true,
      email: result.invite.email,
      role: result.invite.role,
      invitedBy: result.invite.invitedByEmail,
      expiresAt: result.invite.expiresAt,
    });
  } catch (err: any) {
    console.error('[accept-invite] lookup failed', err?.message || err);
    return NextResponse.json({ error: 'Could not read that invitation.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const limited = await rateLimitedResponse('accept_invite', request, 10, 300);
    if (limited) return limited;
    if (!getDb().configured) {
      return NextResponse.json({ error: 'Invitations require Supabase.' }, { status: 503 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const token = String(body?.token || '').trim();
    const password = String(body?.password || '');
    const fullName = String(body?.fullName || '').trim().slice(0, 200) || null;

    const result = await lookupInviteByToken(token);
    if (!result.ok) {
      return NextResponse.json(
        { error: 'This invitation is no longer valid.', reason: result.reason },
        { status: 410 },
      );
    }
    const invite = result.invite;

    // CLAIM FIRST. A conditional update that only succeeds while the invite is
    // still pending, so two simultaneous acceptances cannot both create an
    // account. Claiming after creation would let both pass the check above.
    if (!(await claimInvite(invite.id))) {
      return NextResponse.json(
        { error: 'This invitation has already been used.' },
        { status: 409 },
      );
    }

    // The ROLE comes from the invite row, never from the request.
    const created = await createStaffAccount({
      email: invite.email,
      password,
      role: invite.role,
      tenantId: invite.tenantId,
      fullName,
    });

    if (!created.ok) {
      // Give the invite back. Otherwise the invitee holds a token that reports
      // "already used" for an account that does not exist.
      await releaseClaim(invite.id);
      const status = created.reason === 'weak_password' ? 400
        : created.reason === 'email_exists' ? 409
        : created.reason === 'not_configured' ? 503
        : 500;
      return NextResponse.json({ error: created.message, reason: created.reason }, { status });
    }

    await linkAcceptedUser(invite.id, created.userId);

    const redis = createKvClient();
    if (redis) {
      await appendAudit(redis, {
        action: 'STAFF_INVITE_ACCEPTED',
        detail: `${invite.email} joined as ${invite.role}`,
        email: invite.email,
        tenantId: invite.tenantId,
      }, request).catch(() => {});
    }

    // No session is issued here. The invitee signs in through their realm's
    // normal login, which is what puts them through the same 2FA and device
    // checks as everyone else — an invitation should not be a way to skip the
    // sign-in path every other staff member goes through.
    return NextResponse.json({
      ok: true,
      email: created.email,
      role: invite.role,
      signInAt: invite.role === 'sales' || invite.role.startsWith('sales_') || invite.role === 'deal_desk'
        ? '/sales/login'
        : invite.role === 'super_admin' ? '/admin/login' : '/app/login',
    });
  } catch (err: any) {
    console.error('[accept-invite] accept failed', err?.message || err);
    return NextResponse.json({ error: 'Could not complete the invitation.' }, { status: 500 });
  }
}
