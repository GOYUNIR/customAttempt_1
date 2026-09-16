/**
 * Exercises lib/cloudflare-saas.ts's tenant-domain PATCH (Phase D4.2).
 *
 *   npm run verify:cloudflare-sync
 *
 * This path was migrated to the DbClient port but could not be request-verified
 * with the other files: syncTenantDomainStatus returns early unless Cloudflare
 * is configured, which it is not in this environment, so the PATCH never fired
 * and the migration rested on reading + typecheck alone.
 *
 * Here the Cloudflare API is stubbed at the fetch layer (no network, no token)
 * and Supabase points at a local fake, so the PATCH actually executes and its
 * request can be compared to the pre-migration literal.
 *
 * Cannot live in tests/: the module chain uses `@/` path aliases, which
 * `node --test` does not resolve.
 */
import { createServer, type Server } from 'node:http';

interface Seen { method: string; url: string; prefer: string; body: string }

async function main() {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      seen.push({
        method: req.method || '',
        url: req.url || '',
        prefer: req.headers['prefer'] === undefined ? '(absent)' : String(req.headers['prefer']),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;

  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  process.env.CLOUDFLARE_API_TOKEN = 'cf-test-token';
  process.env.CLOUDFLARE_ZONE_ID = 'zone-test-id';

  // Stub ONLY the Cloudflare API; everything else (the Supabase PATCH) goes to
  // the local fake above.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes('api.cloudflare.com')) {
      return new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              id: 'cf-hostname-1',
              hostname: 'shop.example.com',
              status: 'active',
              ssl: { status: 'active' },
              ownership_verification: {},
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return realFetch(input as never, init);
  }) as typeof fetch;

  const { syncTenantDomainStatus } = await import('../lib/cloudflare-saas');
  const result = await syncTenantDomainStatus('tenant-42', 'shop.example.com');

  globalThis.fetch = realFetch;
  server.close();

  console.log(`\nCloudflare domain-sync PATCH verification\n${'='.repeat(52)}`);
  console.log(`sync result ok: ${result.ok}`);
  for (const s of seen) console.log(`  ${s.method} ${s.url}   Prefer: ${s.prefer}`);

  // Pre-migration literal:
  //   supabaseRestFetch(`/tenants?id=eq.${encodeURIComponent(tenantId)}`,
  //                     { key, method: 'PATCH', body }) — and no prefer, so
  //   supabaseRestFetch sent NO Prefer header for a PATCH.
  const expectedUrl = `/rest/v1/tenants?id=eq.${encodeURIComponent('tenant-42')}`;
  const patch = seen.find((s) => s.method === 'PATCH');

  const checks: Array<[string, boolean, string]> = [
    ['a PATCH was actually issued', Boolean(patch), patch ? 'yes' : 'NONE — the path still did not execute'],
    ['URL matches the pre-migration literal', patch?.url === expectedUrl, `${patch?.url} vs ${expectedUrl}`],
    ['no Prefer header, as before the migration', patch?.prefer === '(absent)', String(patch?.prefer)],
    ['body carries the domain fields', Boolean(patch && /custom_domain/.test(patch.body)), patch?.body?.slice(0, 80) || ''],
  ];
  let fail = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}\n     ${detail}`);
  }
  console.log('='.repeat(52));
  console.log(fail === 0 ? 'CLOUDFLARE PATCH VERIFIED — 4/4\n' : `${fail} failure(s)\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('harness crashed:', err); process.exit(1); });
