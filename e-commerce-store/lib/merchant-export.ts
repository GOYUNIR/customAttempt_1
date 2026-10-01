/**
 * MERCHANT DATA EXPORT — a store's own products, orders (with lines) and
 * customers (with marketing consent), one page at a time.
 *
 * Every query is filtered by the tenant id from the merchant session; nothing
 * in the request can name a store. Large exports are never built in one
 * request: the dashboard asks for page after page (with a progress bar) and
 * assembles the file in the browser, so a big store cannot time a request out
 * and the server never holds the whole file.
 */
import { getDb } from '@/lib/db/client';
import { eq, inList } from '@/lib/db/query';
import { resolveMediaRef } from '@/lib/media-key';
import { consentLabel, type ExportDataset } from '@/lib/export-format';

/** Rows per page: policy data (`export.page_rows`), 500 when unset. */
export async function exportPageRows(): Promise<number> {
  try {
    const row = ((await getDb().select<any>('platform_policies', { where: { key: eq('export.page_rows') }, select: ['value'], limit: 1 })) as any[])[0];
    const n = Number(row?.value);
    return Number.isInteger(n) && n >= 10 && n <= 2000 ? n : 500;
  } catch { return 500; }
}

export const EXPORT_COLUMNS: Record<ExportDataset, string[]> = {
  products: ['product_id', 'name', 'slug', 'status', 'tagline', 'description', 'size', 'sku', 'price', 'currency', 'sale_type', 'stock_on_hand', 'photos', 'created_at'],
  orders: ['order_ref', 'created_at', 'customer_email', 'customer_name', 'shipping_address', 'payment_status', 'stage', 'item', 'size', 'quantity', 'unit_price', 'line_total', 'order_total', 'discount', 'tax', 'currency', 'our_fee', 'refunded', 'carrier', 'tracking_number', 'shipped_at'],
  customers: ['email', 'name', 'customer_since', 'marketing_consent', 'release_list', 'orders', 'total_spent'],
};

const amount = (cents: unknown) => ((Number(cents) || 0) / 100).toFixed(2);

export async function exportPage(tenantId: string, dataset: ExportDataset, page: number, size: number): Promise<{ rows: Array<Record<string, any>>; more: boolean; nested?: Array<Record<string, any>> }> {
  const db = getDb();
  const window = { limit: size + 1, offset: page * size };
  const order = [{ column: 'created_at', ascending: true }, { column: 'id', ascending: true }];

  if (dataset === 'products') {
    const vs = (await db.select<any>('product_variants', {
      where: { tenant_id: eq(tenantId) }, order, ...window,
      select: ['id', 'option_label', 'sku', 'price_cents', 'currency', 'created_at',
        { relation: 'products', columns: ['external_id', 'name', 'slug', 'status', 'tagline', 'description', 'checkout_mode', 'media_gallery', 'tenant_id'] },
        { relation: 'inventory_levels', columns: ['quantity_available'] }] as any,
    })) as any[];
    const more = vs.length > size;
    const rows = vs.slice(0, size)
      // Belt and braces: the variant's own tenant filter decides, and its product must agree.
      .filter((v) => v.products && v.products.tenant_id === tenantId)
      .map((v) => ({
        product_id: v.products.external_id, name: v.products.name, slug: v.products.slug, status: v.products.status,
        tagline: v.products.tagline || '', description: v.products.description || '', size: v.option_label, sku: v.sku || '',
        price: amount(v.price_cents), currency: v.currency, sale_type: String(v.products.checkout_mode || 'fcfs') === 'raffle' ? 'raffle' : 'instant',
        stock_on_hand: Array.isArray(v.inventory_levels) && v.inventory_levels[0] ? v.inventory_levels[0].quantity_available : '',
        photos: (Array.isArray(v.products.media_gallery) ? v.products.media_gallery : []).map((m: any) => resolveMediaRef(m?.url)).filter(Boolean).join(' '),
        created_at: v.created_at,
      }));
    return { rows, more };
  }

  if (dataset === 'orders') {
    const os = (await db.select<any>('orders', {
      where: { tenant_id: eq(tenantId) }, order, ...window,
      select: ['id', 'order_ref', 'created_at', 'payment_status', 'status', 'subtotal_cents', 'discount_cents', 'tax_cents', 'total_cents', 'currency', 'platform_fee_cents', 'refunded_cents', 'metadata',
        { relation: 'customers', columns: ['email', 'full_name'] }] as any,
    })) as any[];
    const more = os.length > size;
    const page0 = os.slice(0, size);
    const ids = page0.map((o) => String(o.id));
    const [items, fulfil] = ids.length === 0 ? [[], []] : await Promise.all([
      db.select<any>('order_line_items', { where: { tenant_id: eq(tenantId), order_id: inList(ids) }, select: ['order_id', 'quantity', 'unit_price_cents', 'line_total_cents', { relation: 'product_variants', columns: ['option_label', { relation: 'products', columns: ['name'] }] }] as any, limit: 10000 }) as Promise<any[]>,
      db.select<any>('order_fulfilments', { where: { tenant_id: eq(tenantId), order_id: inList(ids) }, select: ['order_id', 'carrier', 'tracking_number', 'shipped_at'], limit: 10000 }) as Promise<any[]>,
    ]);
    const shipped = new Map((fulfil as any[]).map((f) => [String(f.order_id), f]));
    const rows: Array<Record<string, any>> = [];
    const nested: Array<Record<string, any>> = [];
    for (const o of page0) {
      const f = shipped.get(String(o.id));
      const head = {
        order_ref: o.order_ref, created_at: o.created_at, customer_email: o.customers?.email || '', customer_name: o.customers?.full_name || '',
        shipping_address: o.metadata?.shippingAddress || '', payment_status: o.payment_status,
        stage: o.payment_status === 'refunded' ? 'refunded' : f ? 'shipped' : (o.payment_status === 'paid' || o.payment_status === 'partially_refunded') ? 'to_ship' : 'unpaid',
        order_total: amount(o.total_cents), discount: amount(o.discount_cents), tax: amount(o.tax_cents), currency: o.currency,
        our_fee: amount(o.platform_fee_cents), refunded: amount(o.refunded_cents), carrier: f?.carrier || '', tracking_number: f?.tracking_number || '', shipped_at: f?.shipped_at || '',
      };
      const meta: any[] = Array.isArray(o.metadata?.lines) ? o.metadata.lines : [{ productName: o.metadata?.productName, size: o.metadata?.size }];
      const mine = (items as any[]).filter((it) => String(it.order_id) === String(o.id));
      const lines = (mine.length ? mine : [null]).map((it, i) => ({
        item: it?.product_variants?.products?.name || meta[i]?.productName || 'Item',
        size: it?.product_variants?.option_label || meta[i]?.size || '',
        quantity: it ? Number(it.quantity) : 1,
        unit_price: amount(it ? it.unit_price_cents : o.total_cents),
        line_total: amount(it ? it.line_total_cents : o.total_cents),
      }));
      for (const l of lines) rows.push({ ...head, ...l });
      nested.push({ ...head, lines });
    }
    return { rows, more, nested };
  }

  // customers
  const cs = (await db.select<any>('customers', {
    where: { tenant_id: eq(tenantId) }, order, ...window,
    select: ['id', 'email', 'full_name', 'created_at', 'email_opt_in'],
  })) as any[];
  const more = cs.length > size;
  const page0 = cs.slice(0, size);
  const emails = page0.map((c) => String(c.email).toLowerCase());
  const ids = page0.map((c) => String(c.id));
  const [lists, orders] = page0.length === 0 ? [[], []] : await Promise.all([
    db.select<any>('alert_subscribers', { where: { tenant_id: eq(tenantId), email: inList(emails) }, select: ['email', 'status'], limit: 10000 }) as Promise<any[]>,
    db.select<any>('orders', { where: { tenant_id: eq(tenantId), customer_id: inList(ids), payment_status: inList(['paid', 'partially_refunded']) }, select: ['customer_id', 'total_cents', 'refunded_cents'], limit: 10000 }) as Promise<any[]>,
  ]);
  const list = new Map((lists as any[]).map((l) => [String(l.email).toLowerCase(), l.status]));
  const rows = page0.map((c) => {
    const mine = (orders as any[]).filter((o) => String(o.customer_id) === String(c.id));
    return {
      email: c.email, name: c.full_name || '', customer_since: c.created_at,
      marketing_consent: consentLabel(c.email_opt_in),
      release_list: list.get(String(c.email).toLowerCase()) === 'active' ? 'subscribed' : list.has(String(c.email).toLowerCase()) ? 'unsubscribed' : 'not_on_list',
      orders: mine.length,
      total_spent: amount(mine.reduce((s, o) => s + (Number(o.total_cents) || 0) - (Number(o.refunded_cents) || 0), 0)),
    };
  });
  return { rows, more };
}
