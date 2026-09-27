import { merchantSession, merchantJson, auditMerchant } from '@/lib/merchant-session';
import { createInvite, INVITE_TTL_DAYS } from '@/lib/staff-invites';
import { sendStaffInviteEmail } from '@/lib/email';
import { acceptInviteUrl } from '@/lib/staff-realms';
import { isValidEmail } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Invite a STAFF member to THIS store (owner only). The role is always
 * 'staff' and the store is always the session's: neither comes from the
 * request. The invite is accepted through the existing accept-invite flow.
 */
export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  if (gate.session.role !== 'owner') return merchantJson({ error: 'Only the store owner can invite staff.' }, 403);
  const limited = await rateLimitedResponse('merchant_staff_invite', request, 10, 3600);
  if (limited) return limited;
  const body = await request.json().catch(() => ({}));
  const email = String(body?.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) return merchantJson({ error: 'Enter a valid email address.' }, 400);
  const inv = await createInvite({ email, role: 'staff', tenantId: gate.session.tenantId, invitedByEmail: gate.session.email });
  if (!inv.ok) return merchantJson({ error: inv.message }, inv.reason === 'already_staff' || inv.reason === 'already_invited' ? 409 : 400);
  const sent = await sendStaffInviteEmail({
    to: email,
    role: 'staff',
    invitedBy: gate.session.email,
    acceptUrl: acceptInviteUrl('staff', inv.token, process.env.PLATFORM_ROOT_DOMAIN),
    expiresInDays: INVITE_TTL_DAYS,
    storeName: gate.session.tenantName,
  }).catch(() => ({ ok: false }));
  await auditMerchant(gate.session, request, 'STAFF_INVITED', email + ' invited as staff' + (sent.ok ? '' : ' (email not sent)'));
  return merchantJson({ invited: true, emailed: Boolean(sent.ok) }, 201);
}
