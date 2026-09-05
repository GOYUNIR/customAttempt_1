import { NextResponse } from 'next/server';
import {
  createRedisClient,
  loadProducts,
  PRODUCTS_KEY,
} from '@/lib/server-config';
import { adminAuthorized } from '@/lib/admin-verify';
import {
  normalizeProductStatus,
  legacyBooleansFromStatus,
  statusFromLegacy,
} from '@/lib/product-status';
import { bindInventoryPoolToCategories, resolveInventoryPoolId } from '@/lib/inventory-pool';
import { normalizeCategories } from '@/lib/storefront-config';
import { filterProducts } from '@/lib/product-query';
import { appendAudit } from '@/app/api/admin/audit/route';

/**
 * High-volume batch operations + CSV export for the Products panel.
 *
 *   POST /api/admin/products/batch   — batch mutations over a set of product ids
 *     - action: 'setStatus'        { status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED' }
 *     - action: 'setCategory'      { category, mode: 'add' | 'remove' | 'set' }
 *     - action: 'setInventorySync' { inventorySyncSlug, size? }
 *
 *   GET  /api/admin/products/batch?export=csv[&ids=…][&search=…][&status=…]
 *        — stream a CSV of the (filtered) catalog.
 */

export const dynamic = 'force-dynamic';

function csvCell(value: unknown): string {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function saveProductRecord(redis: any, product: any) {
  await redis.hset(PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
}

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const body = await request.json().catch(() => ({}));
    const password = String(body?.password || '');
    if (!(await adminAuthorized(request, password))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const action = String(body?.action || '');
    const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [];
    if (ids.length === 0) return NextResponse.json({ error: 'No products selected' }, { status: 400 });

    const all = await loadProducts(redis);
    const targets = ids.map((id: string) => all[id]).filter(Boolean);
    if (targets.length === 0) return NextResponse.json({ error: 'No matching products found' }, { status: 404 });

    let updated = 0;

    if (action === 'setStatus') {
      const raw = String(body?.status || '').trim().toUpperCase();
      if (raw !== 'DRAFT' && raw !== 'ACTIVE' && raw !== 'UPCOMING' && raw !== 'ARCHIVED') {
        return NextResponse.json({ error: 'status must be DRAFT, ACTIVE, UPCOMING or ARCHIVED' }, { status: 400 });
      }
      const finalStatus = normalizeProductStatus(raw);
      for (const product of targets) {
        const legacy = legacyBooleansFromStatus(finalStatus);
        product.status = finalStatus;
        product.isActive = legacy.isActive;
        product.isArchived = legacy.isArchived;
        product.isUpcoming = legacy.isUpcoming;
        product.updatedAt = new Date().toISOString();
        await saveProductRecord(redis, product);
        updated += 1;
      }
      await appendAudit(redis, { action: 'PRODUCTS_BATCH_STATUS', detail: `${updated} → ${finalStatus}`, actor: 'admin' });
    } else if (action === 'setCategory') {
      const category = String(body?.category || '').trim();
      const mode = String(body?.mode || 'add');
      if (!category) return NextResponse.json({ error: 'category is required' }, { status: 400 });
      for (const product of targets) {
        let cats = normalizeCategories(product.categories);
        const key = category.toLowerCase();
        if (mode === 'set') {
          cats = [category];
        } else if (mode === 'remove') {
          cats = cats.filter((c: string) => c.toLowerCase() !== key);
        } else if (!cats.some((c: string) => c.toLowerCase() === key)) {
          cats.push(category);
        }
        product.categories = cats;
        product.updatedAt = new Date().toISOString();
        await saveProductRecord(redis, product);
        updated += 1;
      }
      await appendAudit(redis, { action: 'PRODUCTS_BATCH_CATEGORY', detail: `${updated} · ${mode} ${category}`, actor: 'admin' });
    } else if (action === 'setInventorySync') {
      const slug = String(body?.inventorySyncSlug || '').trim();
      const size = String(body?.size || '').trim().toLowerCase();
      for (const product of targets) {
        const cats = Array.isArray(product.priceCategories) ? product.priceCategories : [];
        const next = cats.map((c: any) => {
          if (size && String(c?.size || '').trim().toLowerCase() !== size) return c;
          return { ...c, inventorySyncSlug: slug };
        });
        product.priceCategories = bindInventoryPoolToCategories(next);
        product.updatedAt = new Date().toISOString();
        await saveProductRecord(redis, product);
        updated += 1;
      }
      await appendAudit(redis, { action: 'PRODUCTS_BATCH_INVENTORY_SYNC', detail: `${updated} · ${slug || '(cleared)'}`, actor: 'admin' });
    } else {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }

    return NextResponse.json({ success: true, updated });
  } catch (err: any) {
    console.error('[products/batch] Error:', err);
    return NextResponse.json({ error: err.message || 'Batch operation failed' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const url = new URL(request.url);
    if (url.searchParams.get('export') !== 'csv') {
      return NextResponse.json({ error: 'Use ?export=csv' }, { status: 400 });
    }

    const all = await loadProducts(redis);
    let products = Object.values(all);

    const idsParam = url.searchParams.get('ids');
    if (idsParam) {
      const ids = new Set(idsParam.split(',').map((s) => s.trim()).filter(Boolean));
      products = products.filter((p: any) => ids.has(String(p?.id)));
    } else {
      products = filterProducts(products, {
        search: url.searchParams.get('search') || '',
        status: url.searchParams.get('status') || '',
        category: url.searchParams.get('category') || '',
        checkoutMode: url.searchParams.get('checkoutMode') || '',
      });
    }

    const header = [
      'id', 'name', 'slug', 'status', 'categories', 'totalInventory',
      'size', 'price', 'stripeId', 'checkoutMode', 'inventorySyncSlug', 'inventoryPoolId',
    ];
    const rows: string[] = [header.join(',')];
    for (const p of products as any[]) {
      const cats = Array.isArray(p.priceCategories) ? p.priceCategories : [];
      const base = [
        p.id, p.name, p.slug, statusFromLegacy(p), normalizeCategories(p.categories).join(';'), p.totalInventory || 0,
      ];
      if (cats.length === 0) {
        rows.push([...base, '', '', '', '', '', ''].map(csvCell).join(','));
      } else {
        for (const c of cats) {
          rows.push([
            ...base,
            c?.size || '', c?.price ?? '', c?.stripeId || '', c?.checkoutMode || '', c?.inventorySyncSlug || '', resolveInventoryPoolId(p, c?.size),
          ].map(csvCell).join(','));
        }
      }
    }

    const csv = rows.join('\r\n');
    return new Response(`\uFEFF${csv}`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="products-${Date.now()}.csv"`,
      },
    });
  } catch (err: any) {
    console.error('[products/batch] CSV error:', err);
    return NextResponse.json({ error: err.message || 'CSV export failed' }, { status: 500 });
  }
}
