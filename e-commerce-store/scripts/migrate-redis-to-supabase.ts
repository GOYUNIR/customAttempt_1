#!/usr/bin/env -S npx tsx
/**
 * scripts/migrate-redis-to-supabase.ts
 *
 * Idempotent CLI backfill: reads this store's legacy catalog/carts/orders
 * out of the configured StorageClient (lib/storage — whichever backend is
 * primary: Supabase KV, Upstash Redis, or Cloudflare KV), validates each
 * record against a Zod schema, and upserts it into the 00009 relational
 * Postgres tables under one tenant_id (lib/tenant-context.ts's
 * `ensureDefaultTenant()`, or `--tenant-id <uuid>` to target another one).
 *
 * SCOPE — this populates the tables; it does NOT flip any live route to
 * read from them (see lib/postgres-shadow-write.ts's header for exactly
 * why: this store's raffle/FCFS checkout logic has no representation in
 * the 00009 schema yet). Raffle-specific fields (checkoutMode, winnerTiers,
 * maxRaffleAllocationLimit) are preserved as opaque JSON in each row's
 * `metadata` column (migration 00011) rather than silently dropped.
 *
 * Idempotent: every write is a PostgREST upsert (`Prefer:
 * resolution=merge-duplicates` against each table's real unique
 * constraint), so re-running after a partial run or after new Redis data
 * arrives never creates duplicates — it converges.
 *
 * Usage:
 *   npx tsx scripts/migrate-redis-to-supabase.ts [--dry-run] [--tenant-id <uuid>] [--skip-carts] [--skip-orders]
 *
 *   --dry-run       Read + validate only; never writes to Postgres. Prints
 *                    exactly what would be upserted. Safe to run with no
 *                    Supabase credentials at all.
 *   --tenant-id     Target an existing tenant instead of the single-tenant
 *                    default (advanced / real multi-tenant deployments).
 *   --skip-carts    Skip the cart backfill.
 *   --skip-orders   Skip the order backfill.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createStorageClient } from '@/lib/storage';
import { loadProducts, safeParseRedisItem, USERS_KEY, ARCHIVE_LEDGER_KEY } from '@/lib/server-config';
import { STORED_CARTS_KEY } from '@/lib/redis-keys';
import { ensureDefaultTenant } from '@/lib/tenant-context';
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';

// ── .env.local loader (Next.js auto-loads this; a bare tsx process doesn't) ──
// Every module imported above only reads `process.env` lazily, INSIDE a
// function call (createStorageClient(), readSupabaseEnv(), …) — never at
// module-evaluation time — so it's safe to populate `process.env` here,
// after the imports resolve but before `main()` (below) actually calls any
// of them.
function loadDotEnvLocal(): void {
  const path = join(process.cwd(), '.env.local');
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvLocal();

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKIP_CARTS = args.includes('--skip-carts');
const SKIP_ORDERS = args.includes('--skip-orders');
const tenantIdArgIdx = args.indexOf('--tenant-id');
const tenantIdOverride = tenantIdArgIdx !== -1 ? args[tenantIdArgIdx + 1] : null;

// ── Zod schemas (validate before every write) ────────────────────────────────
const PriceCategorySchema = z.object({
  size: z.string().min(1),
  price: z.number().finite(),
  stripeId: z.string().optional(),
  sku: z.string().optional(),
  winnerTiers: z.union([z.string(), z.array(z.number())]).optional(),
  checkoutMode: z.string().optional(),
  maxRaffleAllocationLimit: z.number().optional(),
  // Sizes sharing this slug (across one or more products) draw from ONE
  // stock count (migration 00012's shared_inventory_pools) — see
  // lib/checkout-mode.ts / lib/server-config.ts's inventorySyncSlug.
  inventorySyncSlug: z.string().optional(),
});

const RedisProductSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  desc: z.string().optional(),
  description: z.string().optional(),
  priceCategories: z.array(PriceCategorySchema).default([]),
  isArchived: z.boolean().optional(),
  isActive: z.boolean().optional(),
  isUpcoming: z.boolean().optional(),
  totalInventory: z.number().optional(),
});
type RedisProduct = z.infer<typeof RedisProductSchema>;

/** RAFFLE / FCFS / WAITLIST — mirrors lib/checkout-mode.ts's own
 *  normalization (legacy `isRaffle` boolean, or an explicit string). */
function normalizeCheckoutMode(cat: z.infer<typeof PriceCategorySchema>): 'fcfs' | 'raffle' | 'waitlist' {
  const raw = String(cat.checkoutMode || '').trim().toLowerCase();
  if (raw === 'raffle' || raw === 'fcfs' || raw === 'waitlist') return raw;
  return 'fcfs';
}

const CartItemSchema = z.object({
  productId: z.string().min(1),
  name: z.string().optional(),
  size: z.string().min(1),
  price: z.number().optional(),
  productType: z.string().optional(),
  checkoutMode: z.string().optional(),
});

const ArchiveRecordSchema = z.object({
  email: z.string().optional(),
  variant: z.string().min(1),
  size: z.string().min(1),
  type: z.string(),
  amountCents: z.number().optional(),
  orderRef: z.string().optional(),
  registeredAt: z.string().optional(),
  promoCode: z.string().optional(),
});

// ── Postgres upsert helpers ───────────────────────────────────────────────────
type Counts = { created: number; updated: number; skipped: number; errors: number };
function newCounts(): Counts {
  return { created: 0, updated: 0, skipped: 0, errors: 0 };
}

async function upsert(path: string, onConflict: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (DRY_RUN) return null;
  // `path` is historically "/table"; the port takes the bare table name.
  const table = path.replace(/^\//, '');
  const rows = await getDb().insert<Record<string, unknown>>(table, body, { onConflict });
  return rows?.[0] ?? null;
}

function statusFromLegacy(p: RedisProduct): 'draft' | 'live' | 'archived' {
  if (p.isArchived) return 'archived';
  if (p.isUpcoming) return 'draft';
  return 'live';
}

async function backfillProducts(
  redisProducts: Record<string, unknown>,
  tenantId: string,
): Promise<{ products: Counts; variants: Counts; inventory: Counts; slugToProductId: Map<string, string>; variantKeyToId: Map<string, string> }> {
  const products = newCounts();
  const variants = newCounts();
  const inventory = newCounts();
  const slugToProductId = new Map<string, string>();
  const variantKeyToId = new Map<string, string>(); // `${slug}::${size}` -> variant id

  for (const [key, raw] of Object.entries(redisProducts)) {
    const parsed = RedisProductSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(`[products] skipping ${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      products.skipped += 1;
      continue;
    }
    const p = parsed.data;
    console.log(`[products] ${DRY_RUN ? 'would upsert' : 'upserting'} product "${p.name}" (${p.slug})`);
    const productRow = await upsert(
      '/products',
      'tenant_id,slug',
      {
        tenant_id: tenantId,
        external_id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description || p.desc || null,
        status: statusFromLegacy(p),
        metadata: { legacyId: p.id },
      },
    );
    const productId = DRY_RUN ? `dry-run:${p.slug}` : (productRow?.id as string | undefined);
    if (!DRY_RUN && !productId) {
      products.errors += 1;
      continue;
    }
    products.created += 1;
    if (productId) slugToProductId.set(p.slug, productId);

    for (const cat of p.priceCategories) {
      const priceCents = Math.max(0, Math.round(Number(cat.price) * 100) || 0);
      const checkoutMode = normalizeCheckoutMode(cat);

      // Shared inventory pool: sizes carrying the SAME inventorySyncSlug
      // (possibly across different products) draw from one stock count —
      // upsert the pool row first so the variant can link to it.
      let sharedPoolId: string | undefined;
      if (cat.inventorySyncSlug && !DRY_RUN) {
        const poolRow = await upsert(
          '/shared_inventory_pools',
          'tenant_id,slug',
          { tenant_id: tenantId, slug: cat.inventorySyncSlug, quantity_available: 0, quantity_reserved: 0 },
        );
        sharedPoolId = poolRow?.id as string | undefined;
      }

      console.log(`  [variants] ${DRY_RUN ? 'would upsert' : 'upserting'} variant "${cat.size}" @ $${cat.price} (${checkoutMode}${cat.inventorySyncSlug ? `, pool:${cat.inventorySyncSlug}` : ''})`);
      const variantRow = await upsert(
        '/product_variants',
        'product_id,option_label',
        {
          tenant_id: tenantId,
          product_id: productId,
          sku: cat.sku || null,
          option_label: cat.size,
          price_cents: priceCents,
          currency: 'usd',
          checkout_mode: checkoutMode,
          shared_pool_id: sharedPoolId ?? null,
          metadata: {
            winnerTiers: cat.winnerTiers ?? null,
            maxRaffleAllocationLimit: cat.maxRaffleAllocationLimit ?? null,
            stripeId: cat.stripeId || null,
          },
        },
      );
      const variantId = DRY_RUN ? `dry-run:${p.slug}:${cat.size}` : (variantRow?.id as string | undefined);
      if (!DRY_RUN && !variantId) {
        variants.errors += 1;
        continue;
      }
      variants.created += 1;
      if (variantId) variantKeyToId.set(`${p.slug}::${cat.size}`, variantId);

      if (variantId && !DRY_RUN && !sharedPoolId) {
        // Only seed the variant's OWN inventory_levels row when it's not
        // pool-backed — a pool-backed variant's stock lives on the pool row
        // (already upserted above), never a duplicate per-variant count.
        const qty = Math.max(0, Math.floor(Number(p.totalInventory) || 0));
        await upsert(
          '/inventory_levels',
          'variant_id',
          { tenant_id: tenantId, variant_id: variantId, quantity_available: qty, quantity_reserved: 0 },
        );
        inventory.created += 1;
      }
    }
  }
  return { products, variants, inventory, slugToProductId, variantKeyToId };
}

async function findVariantForProductName(
  productName: string,
  size: string,
  redisProducts: Record<string, any>,
  variantKeyToId: Map<string, string>,
): Promise<string | null> {
  const match = Object.values(redisProducts).find((p: any) => p?.name === productName);
  if (!match) return null;
  const slug = String((match as any).slug || '');
  return variantKeyToId.get(`${slug}::${size}`) || null;
}

async function backfillCarts(
  storage: any,
  tenantId: string,
  redisProducts: Record<string, any>,
  variantKeyToId: Map<string, string>,
): Promise<{ carts: Counts; items: Counts }> {
  const carts = newCounts();
  const items = newCounts();
  const cartsHash = (await storage.hgetall(STORED_CARTS_KEY)) as Record<string, string> | null;
  const usersHash = (await storage.hgetall(USERS_KEY)) as Record<string, string> | null;
  const userIdToEmail = new Map<string, string>();
  for (const [id, raw] of Object.entries(usersHash || {})) {
    // Upstash REST auto-deserializes JSON values — `raw` can already be a
    // parsed object rather than a string, which a bare JSON.parse() throws
    // on (silently swallowed by a catch, which is exactly the bug that made
    // this function skip every cart during development — always go through
    // safeParseRedisItem(), the same helper every other reader in this
    // codebase uses for this exact reason).
    const u = safeParseRedisItem<any>(raw);
    if (u?.email) userIdToEmail.set(id, String(u.email).toLowerCase());
  }

  for (const [userId, raw] of Object.entries(cartsHash || {})) {
    const email = userIdToEmail.get(userId);
    if (!email) {
      console.warn(`[carts] skipping cart for unknown user ${userId}`);
      carts.skipped += 1;
      continue;
    }
    const rawItems = safeParseRedisItem<unknown[]>(raw);
    if (!rawItems) {
      carts.skipped += 1;
      continue;
    }
    console.log(`[carts] ${DRY_RUN ? 'would upsert' : 'upserting'} cart for ${email} (${Array.isArray(rawItems) ? rawItems.length : 0} items)`);
    let customerId: string | undefined;
    let cartId: string | undefined;
    if (!DRY_RUN) {
      const customerRow = await upsert('/customers', 'tenant_id,email', { tenant_id: tenantId, email });
      customerId = customerRow?.id as string | undefined;
      if (!customerId) {
        carts.errors += 1;
        continue;
      }
      const existingCart = await getDb().select<{ id: string }>('carts', {
        where: { tenant_id: eq(tenantId), customer_id: eq(customerId), status: eq('active') },
        select: ['id'],
        limit: 1,
      });
      if (Array.isArray(existingCart) && existingCart.length > 0) {
        cartId = existingCart[0].id;
      } else {
        const created = await getDb().insert<{ id: string }>('carts', {
          tenant_id: tenantId,
          customer_id: customerId,
          status: 'active',
        });
        cartId = created?.[0]?.id;
      }
      if (!cartId) {
        carts.errors += 1;
        continue;
      }
    }
    carts.created += 1;

    for (const rawItem of Array.isArray(rawItems) ? rawItems : []) {
      const parsedItem = CartItemSchema.safeParse(rawItem);
      if (!parsedItem.success) {
        items.skipped += 1;
        continue;
      }
      const item = parsedItem.data;
      const product = redisProducts[item.productId];
      const slug = product?.slug;
      const variantId = slug ? variantKeyToId.get(`${slug}::${item.size}`) : null;
      if (!variantId) {
        console.warn(`  [cart-items] skipping ${item.productId}/${item.size} — no matching variant (run the products backfill first)`);
        items.skipped += 1;
        continue;
      }
      if (!DRY_RUN && cartId) {
        await getDb().insert('cart_items', {
            tenant_id: tenantId,
            cart_id: cartId,
            variant_id: variantId,
            quantity: 1,
            unit_price_cents: Math.max(0, Math.round(Number(item.price || 0) * 100)),
        });
      }
      items.created += 1;
    }
  }
  return { carts, items };
}

async function backfillOrders(
  storage: any,
  tenantId: string,
  redisProducts: Record<string, any>,
  variantKeyToId: Map<string, string>,
): Promise<{ orders: Counts; lines: Counts }> {
  const orders = newCounts();
  const lines = newCounts();
  const rawRows = (await storage.lrange(ARCHIVE_LEDGER_KEY, 0, -1)) as string[];

  for (const raw of rawRows) {
    const parsedJson = safeParseRedisItem<unknown>(raw);
    if (!parsedJson) {
      orders.skipped += 1;
      continue;
    }
    const parsed = ArchiveRecordSchema.safeParse(parsedJson);
    if (!parsed.success || parsed.data.type !== 'WINNER_CHARGED') {
      orders.skipped += 1;
      continue;
    }
    const entry = parsed.data;
    const orderRef = entry.orderRef || `LEGACY-${entry.variant}-${entry.size}-${entry.registeredAt || Date.now()}`;
    const amountCents = Math.max(0, Math.round(Number(entry.amountCents) || 0));
    console.log(`[orders] ${DRY_RUN ? 'would upsert' : 'upserting'} order ${orderRef} (${entry.variant} / ${entry.size})`);

    let customerId: string | undefined;
    if (!DRY_RUN && entry.email) {
      const customerRow = await upsert('/customers', 'tenant_id,email', { tenant_id: tenantId, email: entry.email.toLowerCase() });
      customerId = customerRow?.id as string | undefined;
    }

    const orderRow = await upsert(
      '/orders',
      'tenant_id,order_ref',
      {
        tenant_id: tenantId,
        customer_id: customerId ?? null,
        order_ref: orderRef,
        status: 'confirmed',
        payment_status: 'paid',
        subtotal_cents: amountCents,
        total_cents: amountCents,
        currency: 'usd',
        metadata: { legacy: true, promoCode: entry.promoCode || null },
      },
    );
    const orderId = DRY_RUN ? null : (orderRow?.id as string | undefined);
    if (!DRY_RUN && !orderId) {
      orders.errors += 1;
      continue;
    }
    orders.created += 1;

    if (!DRY_RUN && orderId) {
      const variantId = await findVariantForProductName(entry.variant, entry.size, redisProducts, variantKeyToId);
      await getDb().insert('order_line_items', {
          tenant_id: tenantId,
          order_id: orderId,
          variant_id: variantId,
          quantity: 1,
          unit_price_cents: amountCents,
          line_total_cents: amountCents,
      });
      lines.created += 1;
    }
  }
  return { orders, lines };
}

function printCounts(label: string, c: Counts) {
  console.log(`  ${label}: ${c.created} upserted, ${c.skipped} skipped, ${c.errors} errors`);
}

async function main() {
  console.log(`\n=== Redis → Supabase backfill ${DRY_RUN ? '(DRY RUN — no writes)' : ''} ===\n`);

  const storage = createStorageClient();
  if (!storage) {
    console.error('No storage backend configured (STORAGE_PROVIDER / Redis / Supabase env vars). Nothing to read. Exiting.');
    process.exit(1);
  }

  if (!DRY_RUN && !getDb().configured) {
    console.error('SUPABASE_SERVICE_ROLE_KEY is not configured — cannot write. Re-run with --dry-run to validate without credentials, or set Supabase env vars.');
    process.exit(1);
  }

  const tenantId = tenantIdOverride || (DRY_RUN ? 'dry-run-tenant' : await ensureDefaultTenant());
  console.log(`Target tenant: ${tenantId}\n`);

  const redisProducts = await loadProducts(storage);
  console.log(`Found ${Object.keys(redisProducts).length} products in the legacy catalog.\n`);

  const { products, variants, inventory, variantKeyToId } = await backfillProducts(redisProducts, tenantId);
  console.log('\n--- Products ---');
  printCounts('products', products);
  printCounts('variants', variants);
  printCounts('inventory', inventory);

  if (!SKIP_CARTS) {
    const { carts, items } = await backfillCarts(storage, tenantId, redisProducts, variantKeyToId);
    console.log('\n--- Carts ---');
    printCounts('carts', carts);
    printCounts('cart items', items);
  }

  if (!SKIP_ORDERS) {
    const { orders, lines } = await backfillOrders(storage, tenantId, redisProducts, variantKeyToId);
    console.log('\n--- Orders ---');
    printCounts('orders', orders);
    printCounts('order lines', lines);
  }

  console.log(`\n=== Done${DRY_RUN ? ' (dry run — nothing was written)' : ''} ===\n`);
}

main().catch((err) => {
  console.error('Backfill failed:', err?.message || err);
  process.exit(1);
});
