import { NextResponse } from 'next/server';
import { adminAuthorized, resolveAdminActor } from '@/lib/admin-verify';
import { actorHasSalesAccess } from '@/lib/admin-actor';
import { resolveActingTenantId } from '@/lib/tenant-context';
import { resolveUnitPriceCents, quoteSubtotalCents, type PriceListEntry, type QuoteLineInput } from '@/lib/b2b/pricing';
import { getDb } from '@/lib/db/client';
import { eq, inList, isNull } from '@/lib/db/query';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { appendAudit } from '@/app/api/admin/audit/route';
import { createKvClient } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/b2b/quotes — the first real, end-to-end B2B engine endpoint
 * (supabase/migrations/00009_commerce_b2b_core.sql + lib/b2b/pricing.ts).
 *
 *   GET  ?companyId=<uuid>       — list a company's quotes.
 *   POST { companyId, lines: [{ variantId, quantity }], notes? }
 *        — create a draft quote, pricing each line against the company's
 *          contract price list (falling back to the tenant's default list,
 *          then the catalog base price — see resolveUnitPriceCents).
 *
 * Scoped by admin session, NOT a buyer's own login: this app's customer
 * auth (app/api/auth/*) is a separate Redis-backed session system with no
 * link to Supabase Auth / company_members yet (see lib/tenant-context.ts's
 * header for the same gap noted on the tenant-resolution side) — a
 * self-service "buyer requests a quote" flow needs that link built first.
 * This endpoint is the sales-rep/tenant-owner side of the workflow, which
 * already has real, tested auth to build on.
 */
export async function POST(request: Request) {
  try {
    const limited = await rateLimitedResponse('b2b_quote_create', request, 20, 60);
    if (limited) return limited;

    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!getDb().configured) {
      return NextResponse.json({ error: 'The B2B engine requires Supabase.' }, { status: 503 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }
    const companyId = String(body?.companyId || '').trim();
    const rawLines = Array.isArray(body?.lines) ? (body.lines as unknown[]) : [];
    const notes = typeof body?.notes === 'string' ? body.notes.slice(0, 2000) : null;
    if (!companyId || rawLines.length === 0) {
      return NextResponse.json({ error: 'companyId and at least one line are required.' }, { status: 400 });
    }
    const requestedLines = rawLines
      .map((l) => {
        const line = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
        return {
          variantId: String(line.variantId || '').trim(),
          quantity: Math.max(1, Math.floor(Number(line.quantity) || 0)),
        };
      })
      .filter((l) => l.variantId && l.quantity > 0);
    if (requestedLines.length === 0) {
      return NextResponse.json({ error: 'No valid lines supplied.' }, { status: 400 });
    }

    const actor = await resolveAdminActor(request);
    if (!actorHasSalesAccess(actor)) {
      return NextResponse.json({ error: 'Sales Hub access required.' }, { status: 403 });
    }
    const tenantId = await resolveActingTenantId(actor);

    const companies = (await getDb()
      .select<{ id: string }>('companies', {
        where: { id: eq(companyId), tenant_id: eq(tenantId) },
        select: ['id'],
      })
      .catch(() => null)) as Array<{ id: string }> | null;
    if (!Array.isArray(companies) || companies.length === 0) {
      return NextResponse.json({ error: 'Company not found for this tenant.' }, { status: 404 });
    }

    const variantIds = requestedLines.map((l) => l.variantId);
    const variants = (await getDb()
      .select<{ id: string; price_cents: number }>('product_variants', {
        where: { id: inList(variantIds), tenant_id: eq(tenantId) },
        select: ['id', 'price_cents'],
      })
      .catch(() => null)) as Array<{ id: string; price_cents: number }> | null;
    const basePriceByVariant = new Map((variants || []).map((v) => [v.id, Number(v.price_cents) || 0]));
    const missingVariant = requestedLines.find((l) => !basePriceByVariant.has(l.variantId));
    if (missingVariant) {
      return NextResponse.json({ error: `Unknown variant: ${missingVariant.variantId}` }, { status: 400 });
    }

    // Resolve the applicable price list: company-specific first, else the
    // tenant's default list, else none (base price for every line).
    const companyLists = (await getDb()
      .select<{ id: string }>('price_lists', {
        where: { company_id: eq(companyId), tenant_id: eq(tenantId) },
        select: ['id'],
        limit: 1,
      })
      .catch(() => null)) as Array<{ id: string }> | null;
    let priceListId = Array.isArray(companyLists) && companyLists.length > 0 ? companyLists[0].id : null;
    if (!priceListId) {
      const defaultLists = (await getDb()
        .select<{ id: string }>('price_lists', {
          where: { tenant_id: eq(tenantId), company_id: isNull(), is_default: eq(true) },
          select: ['id'],
          limit: 1,
        })
        .catch(() => null)) as Array<{ id: string }> | null;
      priceListId = Array.isArray(defaultLists) && defaultLists.length > 0 ? defaultLists[0].id : null;
    }
    let entries: PriceListEntry[] = [];
    if (priceListId) {
      const rows = (await getDb()
        .select<{ variant_id: string; unit_price_cents: number; min_quantity: number }>('price_list_entries', {
          where: { price_list_id: eq(priceListId), variant_id: inList(variantIds) },
          select: ['variant_id', 'unit_price_cents', 'min_quantity'],
        })
        .catch(() => null)) as Array<{ variant_id: string; unit_price_cents: number; min_quantity: number }> | null;
      entries = (rows || []).map((r) => ({
        variantId: r.variant_id,
        unitPriceCents: Number(r.unit_price_cents) || 0,
        minQuantity: Number(r.min_quantity) || 1,
      }));
    }

    const quoteLines: QuoteLineInput[] = requestedLines.map((l) => {
      const basePriceCents = basePriceByVariant.get(l.variantId) || 0;
      const originalPriceCents = resolveUnitPriceCents(entries, l.variantId, l.quantity, basePriceCents);
      return { variantId: l.variantId, quantity: l.quantity, originalPriceCents };
    });
    const subtotalCents = quoteSubtotalCents(quoteLines);

    const quoteRows = await getDb().insert('quotes', {
        tenant_id: tenantId,
        company_id: companyId,
        status: 'draft',
        currency: 'usd',
        subtotal_cents: subtotalCents,
        notes,
    }) as Array<{ id: string }>;
    const quoteId = quoteRows?.[0]?.id;
    if (!quoteId) {
      return NextResponse.json({ error: 'Could not create quote.' }, { status: 500 });
    }

    await getDb().insert('quote_line_items', quoteLines.map((l) => ({
        tenant_id: tenantId,
        quote_id: quoteId,
        variant_id: l.variantId,
        quantity: l.quantity,
        original_price_cents: l.originalPriceCents,
    })));

    const redis = createKvClient();
    if (redis) {
      await appendAudit(
        redis,
        {
          action: 'B2B_QUOTE_CREATED',
          detail: `Quote ${quoteId} for company ${companyId} — ${quoteLines.length} line(s), $${(subtotalCents / 100).toFixed(2)}`,
          actor: actor?.email || 'admin',
          tenantId,
        },
        request,
      );
    }

    return NextResponse.json({
      ok: true,
      quote: { id: quoteId, companyId, tenantId, status: 'draft', subtotalCents, lines: quoteLines },
    });
  } catch (err: any) {
    console.error('[b2b/quotes] create failed', err?.message || err);
    return NextResponse.json({ error: 'Could not create quote.' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!getDb().configured) {
      return NextResponse.json({ error: 'The B2B engine requires Supabase.' }, { status: 503 });
    }

    const url = new URL(request.url);
    const companyId = String(url.searchParams.get('companyId') || '').trim();
    if (!companyId) {
      return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
    }

    const actor = await resolveAdminActor(request);
    if (!actorHasSalesAccess(actor)) {
      return NextResponse.json({ error: 'Sales Hub access required.' }, { status: 403 });
    }
    const tenantId = await resolveActingTenantId(actor);

    const quotes = await getDb()
      .select('quotes', {
        where: { company_id: eq(companyId), tenant_id: eq(tenantId) },
        select: ['id', 'status', 'currency', 'subtotal_cents', 'notes', 'created_at', 'expires_at'],
        order: { column: 'created_at', ascending: false },
      })
      .catch(() => []);

    return NextResponse.json({ ok: true, quotes: quotes ?? [] });
  } catch (err: any) {
    console.error('[b2b/quotes] list failed', err?.message || err);
    return NextResponse.json({ error: 'Could not list quotes.' }, { status: 500 });
  }
}
