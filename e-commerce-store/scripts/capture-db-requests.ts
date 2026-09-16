/**
 * DB REQUEST CAPTURE — migration equivalence harness (Phase D4).
 *
 * Exercises real business-logic functions against a fake PostgREST and records
 * every HTTP request they emit: method, path, query, body, Prefer header.
 *
 *   npx tsx scripts/capture-db-requests.ts <out.json>
 *
 * Run it BEFORE migrating a module to capture a baseline, again after, and
 * diff. If the two are identical, the migration changed how the query is
 * EXPRESSED without changing what is SENT — which is the only property a
 * static test can actually establish for this kind of refactor.
 *
 * No real network, no real database, no Stripe: the fake server answers with
 * fixtures, and with no payment provider configured resolveStripeClient()
 * returns null, so charge paths short-circuit before touching a vendor.
 */
import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';

interface Recorded {
  label: string;
  method: string;
  path: string;
  prefer: string;
  body: unknown;
}

const recorded: Recorded[] = [];
let currentLabel = 'unlabelled';

/** Fixtures keyed by the table being addressed, so callers can proceed. */
function fixtureFor(method: string, path: string): unknown {
  const table = (path.split('/rest/v1/')[1] || '').split('?')[0];
  if (method === 'GET') {
    switch (table) {
      case 'raffle_entries':
        return [
          { id: 'entry-1', email: 'a@example.com', status: 'pending', payment_method_ref: 'pm_1', quantity: 1 },
          { id: 'entry-2', email: 'b@example.com', status: 'pending', payment_method_ref: 'pm_2', quantity: 1 },
          { id: 'entry-3', email: 'c@example.com', status: 'pending', payment_method_ref: null, quantity: 1 },
        ];
      case 'product_variants':
        return [{ id: 'variant-1', product_id: 'prod-1', price_cents: 5000, size: 'M', tenant_id: 'tenant-1' }];
      case 'shared_inventory_pools':
        return [{ id: 'pool-1', slug: 'pool-slug', remaining: 10, total: 25 }];
      case 'drop_draws':
        return [{ id: 'draw-1', variant_id: 'variant-1', winner_count: 2 }];
      case 'waitlist_entries':
        return [];
      case 'tenants':
        return [{ id: 'tenant-1', slug: 'acme' }];
      default:
        return [];
    }
  }
  if (method === 'POST') {
    if (table === 'drop_draws') return [{ id: 'draw-1', variant_id: 'variant-1' }];
    if (table === 'raffle_entries') return [{ id: 'entry-new', status: 'pending' }];
    return [{ id: 'created-1' }];
  }
  if (method === 'PATCH') {
    if (table === 'shared_inventory_pools') return [{ id: 'pool-1', remaining: 9 }];
    return [{ id: 'updated-1' }];
  }
  return [];
}

async function startFake(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        /* keep raw */
      }
      recorded.push({
        label: currentLabel,
        method: req.method || '',
        path: req.url || '',
        prefer: String(req.headers['prefer'] || ''),
        body,
      });
      const payload = fixtureFor(req.method || 'GET', req.url || '');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as { port: number }).port };
}

/** Run one labelled scenario; swallow errors so a throw still records requests. */
async function scenario(label: string, fn: () => Promise<unknown>): Promise<void> {
  currentLabel = label;
  try {
    await fn();
  } catch (err) {
    recorded.push({
      label,
      method: '(threw)',
      path: String((err as Error).message).slice(0, 160),
      prefer: '',
      body: null,
    });
  }
}

async function main() {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: tsx scripts/capture-db-requests.ts <out.json>');
    process.exit(2);
  }

  const { server, port } = await startFake();
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-capture-key';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-capture-key';
  // No payment provider -> resolveStripeClient() returns null, so charge paths
  // short-circuit. Capture is about DB requests, not Stripe.
  delete process.env.STRIPE_SECRET_KEY;

  const raffle = await import('../lib/raffle');

  await scenario('createRaffleEntry', () =>
    raffle.createRaffleEntry({
      tenantId: 'tenant-1',
      variantId: 'variant-1',
      email: 'buyer@example.com',
      paymentMethodRef: 'pm_test',
      quantity: 1,
    } as Parameters<typeof raffle.createRaffleEntry>[0]),
  );
  // winnerCount === the 3 fixture entries, so the winner SET is deterministic
  // (selection is random; that logic is unit-tested separately in
  // tests/raffle-draw.test.ts and is not what this harness is proving).
  await scenario('executeDraw', () => raffle.executeDraw('tenant-1', 'variant-1', 3));
  await scenario('findPendingEntryId', () => raffle.findPendingEntryId('tenant-1', 'variant-1', 'a@example.com'));
  await scenario('markRaffleEntryOutcome:charged', () => raffle.markRaffleEntryOutcome('tenant-1', 'entry-1', 'charged'));
  await scenario('markRaffleEntryOutcome:declined', () => raffle.markRaffleEntryOutcome('tenant-1', 'entry-2', 'declined'));
  await scenario('executeDrawWithCharging', () => raffle.executeDrawWithCharging('tenant-1', 'variant-1', 3));
  await scenario('decrementSharedPool', () => raffle.decrementSharedPool('tenant-1', 'pool-slug', 1));
  await scenario('decrementSharedPoolById', () => raffle.decrementSharedPoolById('tenant-1', 'pool-1', 1));
  await scenario('restockSharedPoolById', () => raffle.restockSharedPoolById('tenant-1', 'pool-1', 1));
  await scenario('addToWaitlist', () => raffle.addToWaitlist('tenant-1', 'variant-1', 'wait@example.com'));

  server.close();

  // Normalise noise that is unrelated to how a query is EXPRESSED:
  //  - timestamps (decided_at, created_at, …) move every run
  //  - the order of ids inside in.(...) reflects shuffle order, not request shape
  const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
  const sortInList = (path: string): string =>
    path.replace(/in\.\(([^)]*)\)/g, (_m, ids: string) => 'in.(' + ids.split(',').sort().join(',') + ')');
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(ISO, '<TS>');
    if (Array.isArray(value)) {
      const mapped = value.map(scrub);
      // Arrays of primitives are sorted: a winner-id list reflects shuffle
      // order, not request shape. CAVEAT: this also hides a genuine ordering
      // change, so any migration that intends to reorder a payload array must
      // be reviewed by reading, not by this diff alone.
      const allPrimitive = mapped.every((v) => typeof v === 'string' || typeof v === 'number');
      return allPrimitive ? [...mapped].sort() : mapped;
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrub(v)]));
    }
    return value;
  };
  // Within a scenario, sort requests by their content.
  //
  // The charge loop iterates WINNERS, whose order comes from the shuffle, so
  // the per-entry markRaffleEntryOutcome PATCHes arrive in a random sequence.
  // The SET is deterministic; the order is not.
  //
  // CAVEAT, same as the array sorting below: this also hides a genuine
  // reordering of requests within a scenario. A migration that intends to
  // change the ORDER of database calls must be reviewed by reading, not by
  // this diff. It does not hide a request appearing, vanishing or changing.
  const sortWithinLabel = (rows: typeof recorded): typeof recorded => {
    const out: typeof recorded = [];
    let i = 0;
    while (i < rows.length) {
      let j = i;
      while (j < rows.length && rows[j].label === rows[i].label) j++;
      const group = rows.slice(i, j);
      group.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      out.push(...group);
      i = j;
    }
    return out;
  };

  const normalised = sortWithinLabel(recorded).map((r) => ({
    ...r,
    path: sortInList(String(scrub(r.path))),
    body: scrub(r.body),
  }));

  writeFileSync(out, JSON.stringify(normalised, null, 2));
  console.log(`captured ${recorded.length} request(s) -> ${out}`);
  for (const r of normalised) {
    console.log(`  [${r.label}] ${r.method} ${r.path}`);
  }
}

main().catch((err) => {
  console.error('capture failed:', err);
  process.exit(1);
});
