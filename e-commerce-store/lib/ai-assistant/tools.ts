/**
 * AI ASSISTANT — tool implementations.
 *
 * Every tool receives ONLY `{ tenantId, actor }` as context (never the raw
 * request, never a tenant id parsed from the model's output or the user's
 * message) — that's what actually makes cross-tenant leakage structurally
 * impossible under prompt injection, not just a permission check. A tool
 * can misbehave in what it does WITHIN `tenantId`, but it cannot be tricked
 * into acting on a different one, because it was never given the means to.
 */

import { listProducts, createProduct } from '@/lib/products';
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';

/** The price list the assistant writes its discounts into. */
const AI_PRICE_LIST_NAME = 'AI Assistant Discounts';
import type { AssistantToolSpec, AssistantActorRole } from '@/lib/ai-assistant/guardrails';

export interface ToolContext {
  tenantId: string;
  actorRole: AssistantActorRole;
  actorEmail: string;
}

export type ToolResult = { ok: true; result: unknown } | { ok: false; error: string };

export interface AssistantTool extends AssistantToolSpec {
  /** JSON-Schema-ish parameter description, included verbatim in the
   *  system prompt so the model knows what shape to send — never used for
   *  runtime validation beyond what execute() itself checks. */
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ── Tool: create_volume_discount ─────────────────────────────────────────────
// "Create a 15% volume discount for Wholesale buyers" — creates (or reuses)
// a tenant-wide price list and adds a tiered entry for one variant.
const createVolumeDiscount: AssistantTool = {
  name: 'create_volume_discount',
  description:
    'Create a volume-discount tier: buyers who order at least `minQuantity` units of a product variant pay `discountPercent` % less than the base price. Creates (or reuses) a tenant-wide "AI Assistant Discounts" price list.',
  allowedRoles: ['super_admin', 'owner'],
  allowDuringImpersonation: false, // creates a real pricing change — same bar as provider-keys/domains
  parameters: {
    variantId: { type: 'string', description: 'The product_variants.id to discount', required: true },
    minQuantity: { type: 'number', description: 'Minimum quantity to qualify for the discount', required: true },
    discountPercent: { type: 'number', description: 'Discount percentage off the base price, 1-90', required: true },
  },
  async execute(args, ctx) {
    if (!getDb().configured) return { ok: false, error: 'Supabase is not configured.' };
    const variantId = String(args.variantId || '').trim();
    const minQuantity = Math.max(1, Math.floor(Number(args.minQuantity) || 0));
    const discountPercent = Number(args.discountPercent);
    if (!variantId) return { ok: false, error: 'variantId is required.' };
    if (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent > 90) {
      return { ok: false, error: 'discountPercent must be between 1 and 90.' };
    }

    const db = getDb();
    const variantRows = await db.select<{ id: string; price_cents: number }>('product_variants', {
      where: { id: eq(variantId), tenant_id: eq(ctx.tenantId) },
      select: ['id', 'price_cents'],
    });
    const variant = variantRows?.[0];
    if (!variant) return { ok: false, error: 'Variant not found for this store.' };

    const unitPriceCents = Math.round(Number(variant.price_cents) * (1 - discountPercent / 100));

    const listRows = await db.select<{ id: string }>('price_lists', {
      where: { tenant_id: eq(ctx.tenantId), name: eq(AI_PRICE_LIST_NAME) },
      select: ['id'],
      limit: 1,
    });
    let priceListId = listRows?.[0]?.id;
    if (!priceListId) {
      const created = await db.insert<{ id: string }>('price_lists', {
        tenant_id: ctx.tenantId,
        name: AI_PRICE_LIST_NAME,
        currency: 'usd',
        is_default: false,
      });
      priceListId = created[0].id;
    }

    const entry = await db.insert<{ id: string }>('price_list_entries', {
      tenant_id: ctx.tenantId,
      price_list_id: priceListId,
      variant_id: variantId,
      unit_price_cents: unitPriceCents,
      min_quantity: minQuantity,
    });

    return {
      ok: true,
      result: {
        priceListId,
        entryId: entry?.[0]?.id,
        variantId,
        minQuantity,
        discountPercent,
        unitPriceCents,
        basePriceCents: variant.price_cents,
      },
    };
  },
};

// ── Tool: audit_storefront_seo ───────────────────────────────────────────────
// Read-only — safe for any authenticated role, including impersonation.
const auditStorefrontSeo: AssistantTool = {
  name: 'audit_storefront_seo',
  description:
    'Read-only audit of the tenant\'s live/draft products for common SEO gaps: missing or too-short descriptions, missing slugs, duplicate slugs.',
  allowedRoles: ['super_admin', 'sales', 'owner', 'staff'],
  allowDuringImpersonation: true,
  parameters: {},
  async execute(_args, ctx) {
    if (!getDb().configured) return { ok: false, error: 'Supabase is not configured.' };
    const products = await listProducts(ctx.tenantId);
    const issues: Array<{ productId: string; name: string; issue: string }> = [];
    const slugCounts = new Map<string, number>();
    for (const p of products) {
      slugCounts.set(p.slug, (slugCounts.get(p.slug) || 0) + 1);
      if (!p.description || p.description.trim().length < 40) {
        issues.push({ productId: p.id, name: p.name, issue: 'Description is missing or under 40 characters — thin content hurts search ranking.' });
      }
      if (!p.slug) {
        issues.push({ productId: p.id, name: p.name, issue: 'No slug set.' });
      }
    }
    for (const [slug, count] of slugCounts) {
      if (count > 1) {
        issues.push({ productId: '', name: slug, issue: `Slug "${slug}" is used by ${count} products — duplicate slugs break canonical URLs.` });
      }
    }
    return { ok: true, result: { productsScanned: products.length, issues } };
  },
};

// ── Tool: import_products_csv ────────────────────────────────────────────────
// A minimal, safe first cut: accepts already-parsed rows (the CSV parsing
// itself happens client-side / in the calling route, never inside a tool a
// model's own output drives — parsing an attacker-influenced CSV inside a
// prompt-injection-reachable code path would be its own risk surface).
const importProductsCsv: AssistantTool = {
  name: 'import_products_csv',
  description: 'Bulk-create products from a list of {name, slug, description} rows (already parsed from CSV by the caller).',
  allowedRoles: ['super_admin', 'owner'],
  allowDuringImpersonation: false,
  parameters: {
    rows: { type: 'array', description: 'Array of {name, slug, description?} objects', required: true },
  },
  async execute(args, ctx) {
    if (!getDb().configured) return { ok: false, error: 'Supabase is not configured.' };
    const rows = Array.isArray(args.rows) ? args.rows : [];
    if (rows.length === 0) return { ok: false, error: 'No rows supplied.' };
    if (rows.length > 200) return { ok: false, error: 'Import capped at 200 rows per call — split into batches.' };
    const created: string[] = [];
    const failed: Array<{ row: unknown; error: string }> = [];
    for (const raw of rows) {
      const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const name = String(row.name || '').trim();
      const slug = String(row.slug || '').trim();
      if (!name || !slug) {
        failed.push({ row, error: 'name and slug are required.' });
        continue;
      }
      try {
        const product = await createProduct(ctx.tenantId, { name, slug, description: typeof row.description === 'string' ? row.description : undefined });
        created.push(product.id);
      } catch (err) {
        failed.push({ row, error: (err as Error)?.message || 'Unknown error' });
      }
    }
    return { ok: true, result: { createdCount: created.length, created, failed } };
  },
};

export const ASSISTANT_TOOLS: AssistantTool[] = [createVolumeDiscount, auditStorefrontSeo, importProductsCsv];
