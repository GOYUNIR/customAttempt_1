import { merchantSession, merchantJson, auditMerchant } from '@/lib/merchant-session';
import { loadProducts } from '@/lib/server-config';
import { writeProductToPostgres } from '@/lib/catalog-write';
import { validateMerchantProduct } from '@/lib/merchant-product-input';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

function publicShape(p: any) {
  return {
    id: String(p.id),
    name: String(p.name || ''),
    slug: String(p.slug || ''),
    tagline: String(p.tagline || ''),
    description: String(p.desc || p.description || ''),
    images: Array.isArray(p.images) ? p.images : [],
    isActive: p.isActive === true,
    isUpcoming: p.isUpcoming === true,
    releaseEndsAt: String(p.releaseEndsAt || ''),
    maxPerEmail: Number(p.maxPerEmail || 1),
    sizes: (p.priceCategories || []).map((c: any) => ({
      size: String(c.size),
      price: Number(c.price),
      mode: String(c.checkoutMode || p.checkoutMode || 'FCFS').toUpperCase(),
      stock: c.liveStock === undefined || c.liveStock === null ? null : Number(c.liveStock),
      winners: c.winnerTiers ? Number(String(c.winnerTiers).split(',')[0]) || null : null,
    })),
  };
}

/** The signed-in merchant's catalog. */
export async function GET(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const products = await loadProducts(null, { tenantId: gate.session.tenantId });
  return merchantJson({ products: Object.values(products).map(publicShape) });
}

/**
 * Create a product, or edit one of THIS store's products. The store comes from
 * the session; a new product's id is made here; an edit must name a product
 * already in this store's catalog. Starting stock is set on create only:
 * changing stock later belongs to the stock-set + reservation-holds design
 * (STRATEGY §9), not to a product edit.
 */
export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const limited = await rateLimitedResponse('merchant_products', request, 30, 60);
  if (limited) return limited;
  const body = await request.json().catch(() => null);
  const check = validateMerchantProduct(body, { mediaBase: process.env.MEDIA_S3_PUBLIC_BASE_URL });
  if (!check.ok) return merchantJson({ error: check.error }, 400);
  const input = check.value;
  const tenantId = gate.session.tenantId;

  const existing = await loadProducts(null, { tenantId });
  let id = input.id;
  if (id) {
    const current = existing[id];
    // Only a product of THIS store; anything else is simply unknown here.
    if (!current) return merchantJson({ error: 'Unknown product.' }, 404);
    if (String(current.slug) !== input.slug) return merchantJson({ error: 'The web address cannot be changed after creation.' }, 409);
  } else {
    if (Object.values(existing).some((p: any) => String(p.slug) === input.slug)) {
      return merchantJson({ error: 'Another product already uses that web address.' }, 409);
    }
    id = 'p_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  }

  const raffle = input.sizes.some((s) => s.mode === 'RAFFLE');
  const result = await writeProductToPostgres(tenantId, {
    id,
    name: input.name,
    slug: input.slug,
    tagline: input.tagline,
    desc: input.description,
    isActive: input.isActive,
    isArchived: false,
    isUpcoming: input.isUpcoming,
    checkoutMode: raffle ? 'RAFFLE' : 'FCFS',
    productType: raffle ? 'raffle' : 'fcfs',
    isRaffle: raffle,
    maxPerEmail: input.maxPerEmail,
    maxPerCart: input.maxPerEmail,
    releaseEndsAt: input.releaseEndsAt,
    totalInventory: input.sizes.reduce((sum, s) => sum + (s.stock || 0), 0),
    // Create-if-missing in catalog-write: never overwrites live stock.
    inventoryPerSize: Object.fromEntries(input.sizes.map((s) => [s.size, s.stock || 0])),
    priceCategories: input.sizes.map((s) => ({ size: s.size, price: s.price, checkoutMode: s.mode, ...(s.winners ? { winnerTiers: String(s.winners) } : {}) })),
    // Photos: the ones sent, else the product's current ones (an edit that
    // does not touch photos must not wipe them), else none.
    notes: [], images: input.images ?? (input.id && Array.isArray((existing as any)[id!]?.images) ? (existing as any)[id!].images : []), categories: [],
  });
  if (!result.ok) {
    console.error('[merchant/products] write failed for ' + tenantId + ': ' + result.error);
    return merchantJson({ error: 'The product could not be saved. Try again.' }, 500);
  }
  await auditMerchant(gate.session, request, input.id ? 'PRODUCT_UPDATED' : 'PRODUCT_CREATED', input.name + ' (' + id + ')');
  const after = await loadProducts(null, { tenantId });
  return merchantJson({ product: after[id] ? publicShape(after[id]) : { id } }, input.id ? 200 : 201);
}
