import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { getDb } from '../lib/db/client.ts';
import { eq, inList } from '../lib/db/query.ts';

interface Captured { method: string; url: string; prefer: string; body: string }

/** Run fn against a fake PostgREST that records what it received. */
async function withFakePostgrest(fn: (captured: Captured[]) => Promise<void>): Promise<void> {
  const captured: Captured[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      captured.push({
        method: req.method || '',
        url: req.url || '',
        prefer: String(req.headers['prefer'] || ''),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test-key';
  try {
    await fn(captured);
  } finally {
    server.close();
  }
}

const pathOf = (c: Captured) => c.url;

test('select: renders a structured spec into a PostgREST GET', async () => {
  await withFakePostgrest(async (cap) => {
    await getDb().select('raffle_entries', {
      where: { tenant_id: eq('t1'), status: eq('winner') },
      select: ['id', 'email'],
      limit: 5,
    });
    assert.equal(cap[0].method, 'GET');
    assert.equal(pathOf(cap[0]), '/rest/v1/raffle_entries?tenant_id=eq.t1&status=eq.winner&select=id,email&limit=5');
  });
});

test('select: no spec means no query string at all', async () => {
  await withFakePostgrest(async (cap) => {
    await getDb().select('tenants');
    assert.equal(pathOf(cap[0]), '/rest/v1/tenants');
  });
});

test('insert: POSTs rows and asks for the representation back', async () => {
  await withFakePostgrest(async (cap) => {
    await getDb().insert('orders', { id: 'o1', total_cents: 100 });
    assert.equal(cap[0].method, 'POST');
    assert.equal(pathOf(cap[0]), '/rest/v1/orders');
    assert.match(cap[0].prefer, /return=representation/);
    assert.equal(JSON.parse(cap[0].body).id, 'o1');
  });
});

test('insert: onConflict produces an upsert with merge-duplicates', async () => {
  await withFakePostgrest(async (cap) => {
    await getDb().insert('inventory_levels', { variant_id: 'v1' }, { onConflict: 'tenant_id,variant_id' });
    assert.match(pathOf(cap[0]), /on_conflict=tenant_id,variant_id/);
    assert.match(cap[0].prefer, /resolution=merge-duplicates/);
  });
});

test('update: PATCHes only the matching rows', async () => {
  await withFakePostgrest(async (cap) => {
    await getDb().update('raffle_entries', { where: { id: inList(['a', 'b']) } }, { status: 'winner' });
    assert.equal(cap[1 - 1].method, 'PATCH');
    assert.equal(pathOf(cap[0]), '/rest/v1/raffle_entries?id=in.(a,b)');
    assert.equal(JSON.parse(cap[0].body).status, 'winner');
  });
});

test('remove: DELETEs only the matching rows', async () => {
  await withFakePostgrest(async (cap) => {
    await getDb().remove('carts', { where: { id: eq('c1') } });
    assert.equal(cap[0].method, 'DELETE');
    assert.equal(pathOf(cap[0]), '/rest/v1/carts?id=eq.c1');
  });
});

// ── The guardrails that matter ────────────────────────────────────────────

test('SAFETY: an unscoped update is refused, not sent', async () => {
  await withFakePostgrest(async (cap) => {
    await assert.rejects(() => getDb().update('orders', {}, { status: 'x' }), /Refusing unscoped update/);
    await assert.rejects(() => getDb().update('orders', { where: {} }, { status: 'x' }), /Refusing unscoped update/);
    assert.equal(cap.length, 0, 'nothing may reach the database');
  });
});

test('SAFETY: an unscoped delete is refused, not sent', async () => {
  await withFakePostgrest(async (cap) => {
    await assert.rejects(() => getDb().remove('orders', {}), /Refusing unscoped delete/);
    assert.equal(cap.length, 0, 'nothing may reach the database');
  });
});

test('SAFETY: a malformed table name is refused', async () => {
  await withFakePostgrest(async (cap) => {
    await assert.rejects(() => getDb().select('orders?select=*'), /Invalid table name/);
    await assert.rejects(() => getDb().select('orders/../users'), /Invalid table name/);
    assert.equal(cap.length, 0);
  });
});

test('a value containing PostgREST syntax cannot alter the query shape', async () => {
  await withFakePostgrest(async (cap) => {
    await getDb().select('users', { where: { email: eq('a,b@x.com') } });
    const url = pathOf(cap[0]);
    // One filter clause, with the comma encoded inside the value.
    assert.equal(url.split('&').length, 1, url);
    assert.match(url, /email=eq\./);
  });
});

test('insert: on_conflict separators stay literal, columns are encoded', async () => {
  await withFakePostgrest(async (cap) => {
    await getDb().insert('customers', { email: 'a@b.com' }, { onConflict: 'tenant_id,email' });
    // Byte-identical to the pre-port request; %2C here would be a needless diff.
    assert.equal(cap[0].url.split('?')[1], 'on_conflict=tenant_id,email');
    assert.match(cap[0].prefer, /return=representation/);
    assert.match(cap[0].prefer, /resolution=merge-duplicates/);
  });
});
