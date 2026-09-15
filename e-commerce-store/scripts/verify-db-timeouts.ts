/**
 * DB TIMEOUT / RETRY VERIFICATION (Phase B item 6).
 *
 * Exercises the real supabaseRestFetch against local HTTP servers that hang,
 * fail transiently, or fail persistently — proving the policy in
 * lib/db-timeout-policy.ts actually takes effect at the chokepoint, rather
 * than only being unit-tested in isolation.
 *
 *   npm run verify:db-timeouts
 *
 * This cannot live in tests/ because the module chain uses `@/` path aliases,
 * which `node --test` cannot resolve (see DEPLOYMENT.md). The pure policy
 * itself IS unit-tested, in tests/db-timeout-policy.test.ts.
 *
 * No network access and no credentials required — every server is local.
 */
import { createServer, type Server } from 'node:http';

let fail = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `\n     ${detail}` : ''}`);
};

async function serve(handler: (n: number, res: any) => void): Promise<{ server: Server; port: number; count: () => number }> {
  let n = 0;
  const server = createServer((_req, res) => { n++; handler(n, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as any).port, count: () => n };
}

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-test-key';
  process.env.SUPABASE_TIMEOUT_MS_INTERACTIVE = '600';
  process.env.SUPABASE_TIMEOUT_MS_BACKGROUND = '1200';
  const { supabaseRestFetch } = await import('../services/config/supabase-client');

  console.log('\nDB timeout / retry verification (all servers local)\n' + '='.repeat(58));

  {
    const s = await serve(() => { /* never responds */ });
    process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${s.port}`;
    const t0 = Date.now();
    let msg = '';
    try { await supabaseRestFetch('/hang', { key: 'k' }); } catch (e) { msg = (e as Error).message; }
    const elapsed = Date.now() - t0;
    s.server.close();
    check('hung server aborts at the configured timeout', /timed out after 600ms/.test(msg), msg.slice(0, 130));
    check('total time stays bounded across attempts', elapsed < 4000, `${elapsed}ms`);
  }

  {
    const s = await serve((n, res) => {
      if (n < 3) { res.writeHead(503).end('unavailable'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('[{"ok":true}]');
    });
    process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${s.port}`;
    const out = await supabaseRestFetch('/flaky', { key: 'k' });
    s.server.close();
    check('GET retries a transient 503 and then succeeds', JSON.stringify(out) === '[{"ok":true}]', JSON.stringify(out));
    check('GET made exactly 3 attempts', s.count() === 3, `${s.count()} requests`);
  }

  {
    const s = await serve((_n, res) => res.writeHead(503).end('unavailable'));
    process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${s.port}`;
    let threw = false;
    try { await supabaseRestFetch('/orders', { key: 'k', method: 'POST', body: { a: 1 } }); } catch { threw = true; }
    s.server.close();
    check('a failing POST throws', threw, '');
    check('SAFETY: POST made EXACTLY 1 attempt — no duplicate write', s.count() === 1, `${s.count()} request(s)`);
  }

  {
    const s = await serve(() => { /* hang */ });
    process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${s.port}`;
    let msg = '';
    try { await supabaseRestFetch('/hang', { key: 'k', tier: 'background' }); } catch (e) { msg = (e as Error).message; }
    s.server.close();
    check('background tier uses its own longer budget', /timed out after 1200ms/.test(msg) && /background tier/.test(msg), msg.slice(0, 130));
  }

  console.log('='.repeat(58));
  console.log(fail === 0 ? 'DB TIMEOUT/RETRY VERIFIED — 7/7\n' : `${fail} failure(s)\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('Harness crashed:', err); process.exit(1); });
