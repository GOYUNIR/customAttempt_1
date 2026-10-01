import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { getDb } from '@/lib/db/client';
import { eq, isNull } from '@/lib/db/query';
import { merchantSignupOpen } from '@/lib/env';
import { createInvite } from '@/lib/staff-invites';
import { acceptInviteUrl } from '@/lib/staff-realms';
import { recordPlatformAudit } from '@/lib/platform-audit';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';

export const dynamic = 'force-dynamic';

/**
 * The signup email's link: the inbox is proven, so the store is created (Free)
 * and the person goes straight to "choose a password" (the owner invite path,
 * already proven end to end). Safe to open twice: some mail services open
 * links to scan them, so a reused link issues a fresh owner invite instead of
 * failing, and never creates a second store. Every other outcome lands on an
 * honest page with a way forward.
 */
const root = () => String(process.env.PLATFORM_ROOT_DOMAIN || '').trim().toLowerCase();
const status = (state: string) => NextResponse.redirect('https://' + root() + '/platform/signup-status?state=' + state, 303);

export async function GET(request: Request) {
  const limited = await rateLimitedResponse('merchant_signup_complete', request, 30, 600);
  if (limited) return limited;
  if (!merchantSignupOpen()) return status('paused');
  const token = String(new URL(request.url).searchParams.get('token') || '');
  if (!/^[0-9a-f]{64}$/.test(token)) return status('invalid');

  const rows = (await supabaseRestFetch('/rpc/complete_signup', {
    key: readSupabaseEnv().serviceRoleKey, method: 'POST', prefer: 'return=representation',
    body: { p_token_hash: createHash('sha256').update(token).digest('hex') },
  })) as any[];
  const r = Array.isArray(rows) ? rows[0] : rows;
  if (!r || !['created', 'already'].includes(r.result)) return status(String(r?.result || 'invalid'));

  const db = getDb();
  const hasOwner = ((await db.select<any>('users', { where: { tenant_id: eq(r.tenant_id), role: eq('owner') }, select: ['id'], limit: 1 })) as any[]).length > 0;
  if (hasOwner) return NextResponse.redirect('https://app.' + root() + '/app/login', 303);

  // A fresh owner invite each time the link is opened before a password is set
  // (an earlier unaccepted one is revoked, so only the newest works).
  await db.update('staff_invites', { where: { tenant_id: eq(r.tenant_id), role: eq('owner'), accepted_at: isNull(), revoked_at: isNull() } }, { revoked_at: new Date().toISOString() }, { returning: 'minimal' } as any).catch(() => null);
  const invite = await createInvite({ email: r.email, role: 'owner', tenantId: r.tenant_id, invitedByEmail: 'self-signup' });
  if (!invite.ok) {
    console.error('[signup-complete] owner invite failed for tenant ' + r.tenant_id + ': ' + invite.message);
    return status('error');
  }
  if (r.result === 'created') {
    await recordPlatformAudit({ action: 'merchant_signup_completed', actor: r.email, tenantId: r.tenant_id, detail: { slug: r.slug } });
  }
  return NextResponse.redirect(acceptInviteUrl('owner', invite.token, root()), 303);
}
