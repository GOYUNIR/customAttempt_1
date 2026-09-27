import { merchantSession, merchantJson, auditMerchant } from '@/lib/merchant-session';
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { validateMerchantSettings } from '@/lib/merchant-settings-input';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { stampLegalUpdated } from '@/lib/legal-config';

export const dynamic = 'force-dynamic';

async function readConfig(tenantId: string): Promise<Record<string, any>> {
  const row = ((await getDb().select<any>('tenant_store_config', { where: { tenant_id: eq(tenantId) }, select: ['config'], limit: 1 })) as any[])[0];
  return (row?.config || {}) as Record<string, any>;
}

/** The signed-in merchant's store name, homepage text and policies. */
export async function GET(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const c = await readConfig(gate.session.tenantId);
  return merchantJson({
    brandName: String(c.branding?.brandName || ''),
    hero: { eyebrow: String(c.heroContent?.eyebrow || ''), headline: String(c.heroContent?.headline || ''), body: String(c.heroContent?.body || '') },
    legal: {
      companyName: String(c.legal?.companyName || ''), supportEmail: String(c.legal?.supportEmail || ''),
      terms: String(c.legal?.terms || ''), privacy: String(c.legal?.privacy || ''), shipping: String(c.legal?.shipping || ''),
    },
  });
}

/**
 * Save them into THIS store's config row. Only these keys change; every other
 * key in the row is kept. The row is keyed by the store (primary key), so no
 * write here can reach another store's row.
 */
export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const limited = await rateLimitedResponse('merchant_settings', request, 20, 60);
  if (limited) return limited;
  const check = validateMerchantSettings(await request.json().catch(() => null));
  if (!check.ok) return merchantJson({ error: check.error }, 400);
  const v = check.value;
  const tenantId = gate.session.tenantId;
  const current = await readConfig(tenantId);
  const hero = { ...(current.heroContent || {}), eyebrow: v.hero.eyebrow, headline: v.hero.headline, body: v.hero.body,
    showEyebrow: Boolean(v.hero.eyebrow), showBody: Boolean(v.hero.body) };
  const next = {
    ...current,
    branding: { ...(current.branding || {}), brandName: v.brandName },
    heroContent: hero,
    legal: stampLegalUpdated(current.legal, { ...(current.legal || {}), ...v.legal }),
  };
  await getDb().insert('tenant_store_config', { tenant_id: tenantId, config: next, updated_at: new Date().toISOString() }, { onConflict: 'tenant_id', returning: 'minimal' } as any);
  await auditMerchant(gate.session, request, 'SETTINGS_SAVED', 'store name, homepage text, policies');
  return merchantJson({ saved: true });
}
