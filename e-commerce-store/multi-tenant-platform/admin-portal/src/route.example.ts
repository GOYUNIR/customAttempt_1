/**
 * Admin Portal → "Save / Publish Changes" HTTP endpoint.
 *
 * Framework-agnostic: any runtime with a `Request → Response` handler can host
 * it. In Next.js App Router it works verbatim as `app/api/publish/route.ts`:
 *
 *   export const dynamic = 'force-dynamic';   // optional (Next.js only)
 *   export async function POST(request: Request): Promise<Response> { ... }
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_KV_NAMESPACE_ID, CLOUDFLARE_API_TOKEN,
 *   ADMIN_API_SECRET, CACHE_VERSION (must match the Worker's).
 */
import { publishSite, PublishError } from './publish.ts';
import { createAdminClient } from './supabase-admin.ts';
import type { PublishSiteInput } from '../../shared/types.ts';

const CACHE_VERSION = Number.parseInt(process.env.CACHE_VERSION ?? '1', 10) || 1;

export async function POST(request: Request): Promise<Response> {
  // 0) Authenticate the admin caller (replace with your portal's session guard).
  const authHeader = request.headers.get('authorization') ?? '';
  if (authHeader !== `Bearer ${process.env.ADMIN_API_SECRET ?? ''}`) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const input = (await request.json()) as PublishSiteInput;

  const admin = createAdminClient({
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  });

  const kv = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
    namespaceId: process.env.CLOUDFLARE_KV_NAMESPACE_ID ?? '',
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? '',
  };

  try {
    const result = await publishSite(admin, kv, input, CACHE_VERSION);
    return json(result, 200);
  } catch (error) {
    if (error instanceof PublishError) {
      return json({ error: error.message }, 500);
    }
    return json({ error: 'Publish failed' }, 500);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
