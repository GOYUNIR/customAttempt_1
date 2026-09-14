/**
 * PRODUCTS (Postgres-backed) — `public.products` / `public.product_variants`
 * (supabase/migrations/00009_commerce_b2b_core.sql). See lib/inventory.ts's
 * header for the storage-split rationale.
 *
 * NOT wired into any live route yet — see the session's summary. The
 * existing storefront still reads the Redis-backed `store:products` catalog
 * exclusively; this module exists so the B2B engine (which already needs
 * real `product_variants` rows for pricing/quotes — see
 * app/api/admin/b2b/quotes) has a real way to create and query them.
 */

import { supabaseServiceConfigured, readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';

/** The store's real selling modes — first-class since migration 00012
 *  (previously only captured as opaque `metadata`). */
export type CheckoutMode = 'fcfs' | 'raffle' | 'waitlist';

export type ProductVariant = {
  id: string;
  productId: string;
  sku: string | null;
  optionLabel: string;
  priceCents: number;
  currency: string;
  checkoutMode: CheckoutMode;
  /** Set when this variant draws its stock from a shared pool
   *  (public.shared_inventory_pools) instead of its own inventory_levels
   *  row — see lib/raffle.ts's `decrementSharedPool`. */
  sharedPoolId: string | null;
};

export type Product = {
  id: string;
  tenantId: string;
  externalId: string | null;
  name: string;
  slug: string;
  description: string | null;
  status: 'draft' | 'live' | 'archived';
};

function assertSupabase(): void {
  if (!supabaseServiceConfigured()) {
    throw new Error('Postgres products require Supabase (SUPABASE_SERVICE_ROLE_KEY).');
  }
}

function toProduct(row: Record<string, unknown>): Product {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    externalId: (row.external_id as string) ?? null,
    name: String(row.name),
    slug: String(row.slug),
    description: (row.description as string) ?? null,
    status: (row.status as Product['status']) || 'draft',
  };
}

function toVariant(row: Record<string, unknown>): ProductVariant {
  const mode = String(row.checkout_mode || 'fcfs');
  return {
    id: String(row.id),
    productId: String(row.product_id),
    sku: (row.sku as string) ?? null,
    optionLabel: String(row.option_label || 'Standard'),
    priceCents: Number(row.price_cents) || 0,
    currency: String(row.currency || 'usd'),
    checkoutMode: (mode === 'raffle' || mode === 'waitlist' ? mode : 'fcfs') as CheckoutMode,
    sharedPoolId: (row.shared_pool_id as string) ?? null,
  };
}

export async function listProducts(tenantId: string, opts: { status?: Product['status'] } = {}): Promise<Product[]> {
  assertSupabase();
  const { serviceRoleKey } = readSupabaseEnv();
  let path = `/products?tenant_id=eq.${encodeURIComponent(tenantId)}&select=*&order=created_at.desc`;
  if (opts.status) path += `&status=eq.${encodeURIComponent(opts.status)}`;
  const rows = (await supabaseRestFetch(path, { key: serviceRoleKey })) as Array<Record<string, unknown>>;
  return (rows || []).map(toProduct);
}

export async function getProductBySlug(tenantId: string, slug: string): Promise<Product | null> {
  assertSupabase();
  const { serviceRoleKey } = readSupabaseEnv();
  const rows = (await supabaseRestFetch(
    `/products?tenant_id=eq.${encodeURIComponent(tenantId)}&slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`,
    { key: serviceRoleKey },
  )) as Array<Record<string, unknown>>;
  return rows?.[0] ? toProduct(rows[0]) : null;
}

export async function createProduct(
  tenantId: string,
  input: { name: string; slug: string; description?: string; externalId?: string; status?: Product['status'] },
): Promise<Product> {
  assertSupabase();
  const { serviceRoleKey } = readSupabaseEnv();
  const rows = (await supabaseRestFetch('/products', {
    key: serviceRoleKey,
    method: 'POST',
    body: {
      tenant_id: tenantId,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      external_id: input.externalId ?? null,
      status: input.status || 'draft',
    },
    prefer: 'return=representation',
  })) as Array<Record<string, unknown>>;
  return toProduct(rows[0]);
}

export async function listVariants(tenantId: string, productId: string): Promise<ProductVariant[]> {
  assertSupabase();
  const { serviceRoleKey } = readSupabaseEnv();
  const rows = (await supabaseRestFetch(
    `/product_variants?tenant_id=eq.${encodeURIComponent(tenantId)}&product_id=eq.${encodeURIComponent(productId)}&select=*`,
    { key: serviceRoleKey },
  )) as Array<Record<string, unknown>>;
  return (rows || []).map(toVariant);
}

export async function createVariant(
  tenantId: string,
  productId: string,
  input: {
    sku?: string;
    optionLabel?: string;
    priceCents: number;
    currency?: string;
    checkoutMode?: CheckoutMode;
    sharedPoolId?: string | null;
  },
): Promise<ProductVariant> {
  assertSupabase();
  if (!Number.isFinite(input.priceCents) || input.priceCents < 0) {
    throw new Error('priceCents must be a non-negative number.');
  }
  const { serviceRoleKey } = readSupabaseEnv();
  const rows = (await supabaseRestFetch('/product_variants', {
    key: serviceRoleKey,
    method: 'POST',
    body: {
      tenant_id: tenantId,
      product_id: productId,
      sku: input.sku ?? null,
      option_label: input.optionLabel || 'Standard',
      price_cents: Math.round(input.priceCents),
      currency: input.currency || 'usd',
      checkout_mode: input.checkoutMode || 'fcfs',
      shared_pool_id: input.sharedPoolId ?? null,
    },
    prefer: 'return=representation',
  })) as Array<Record<string, unknown>>;
  return toVariant(rows[0]);
}

export async function updateProductStatus(tenantId: string, productId: string, status: Product['status']): Promise<void> {
  assertSupabase();
  const { serviceRoleKey } = readSupabaseEnv();
  await supabaseRestFetch(
    `/products?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(productId)}`,
    { key: serviceRoleKey, method: 'PATCH', body: { status } },
  );
}
