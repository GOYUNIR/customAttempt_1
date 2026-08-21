/**
 * Multi-tenant edge storefront — Cloudflare Worker entry point.
 *
 *   Fast path (cache first):  hostname → KV key `site_cache:v<N>:<siteKey>` →
 *                             compiled JSON → render HTML. No Supabase call.
 *   Slow path (cache miss):   hostname → Supabase (sites + site_settings +
 *                             active products) → compiled JSON → warm KV
 *                             (24h TTL) → render HTML.
 *
 * Cache invalidation happens in the Admin Portal via the Cloudflare API
 * (see multi-tenant-platform/admin-portal/src/publish.ts) or the Worker's own
 * POST /api/flush-cache route (see src/flush.ts).
 */
import { resolveSiteKey } from '../../shared/hostname.ts';
import { getCachedSite, setCachedSite, resolveCacheVersion } from './cache.ts';
import { createSupabaseClient, loadCompiledSite } from './supabase.ts';
import { renderSiteHtml, renderNotFoundHtml } from './render.ts';
import { FLUSH_CACHE_PATH, handleFlushCache } from './flush.ts';
import type { Env } from './env.ts';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/__health') {
      return jsonResponse({ ok: true, service: 'mtp-edge-storefront', time: new Date().toISOString() });
    }

    // Cache-invalidation hook (Admin Portal → POST { hostname } with bearer secret).
    if (url.pathname === FLUSH_CACHE_PATH) {
      return handleFlushCache(request, env);
    }

    const resolved = resolveSiteKey(url.hostname, env.PLATFORM_ROOT_DOMAIN);
    if (!resolved) {
      return htmlResponse(renderNotFoundHtml('This host is not a tenant of this platform.'), 404);
    }

    // FAST PATH — the compiled JSON is already in KV: parse + render instantly.
    const cached = await getCachedSite(env, resolved.siteKey);
    if (cached) {
      return htmlResponse(renderSiteHtml(cached, resolved.siteKey), 200);
    }

    // SLOW PATH — build from Supabase, warm KV for the next hit, then serve.
    const client = createSupabaseClient(env);
    const compiled = await loadCompiledSite(client, resolved, resolveCacheVersion(env));

    if (!compiled) {
      return htmlResponse(renderNotFoundHtml('This site is unpublished or does not exist yet.'), 404);
    }

    ctx.waitUntil(
      setCachedSite(env, resolved.siteKey, compiled).catch((error: unknown) => {
        console.error('KV cache write failed', error);
      }),
    );

    return htmlResponse(renderSiteHtml(compiled, resolved.siteKey), 200);
  },
} satisfies ExportedHandler<Env>;

function htmlResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The Worker is the edge; KV is the source. A small s-maxage keeps the
      // CDN layer fresh within seconds of an Admin Portal purge.
      'Cache-Control': 'public, max-age=0, s-maxage=10',
      'X-Edge': 'mtp-edge-storefront',
    },
  });
}

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
