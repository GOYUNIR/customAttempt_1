import { merchantSession, endMerchantSession } from '@/lib/merchant-session';

export const dynamic = 'force-dynamic';

/** Sign out of the merchant dashboard: this session is deleted server-side. */
export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  return endMerchantSession(request);
}
