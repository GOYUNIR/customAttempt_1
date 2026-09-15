/**
 * ADAPTERS / EDGE — a framework-agnostic `(Request) => Promise<Response>`
 * handler contract, built on the standard Fetch API.
 *
 * 94 of 95 `app/api/**\/route.ts` handlers already take a plain `Request`
 * (only `app/api/store/config/route.ts` still uses `NextRequest`), so the
 * request side is already portable; responses go through `NextResponse`
 * everywhere, which is the one Next.js-specific seam. `EdgeHandler` and the
 * helpers below describe the portable shape (usable under Cloudflare
 * Workers, Vercel Edge, Lambda@Edge, or a plain Node fetch server) so a
 * future edge-router rewrite has a contract to migrate route handlers onto
 * incrementally, one at a time, without a flag day.
 *
 * NOT adding Hono as a dependency here: nothing in this codebase exercises
 * it yet (migrating live routes off `NextResponse` is edge-router-scale
 * work, deliberately out of scope for this pass — see DEPLOYMENT.md's
 * "Known Gaps / Roadmap"), and an unused dependency is the kind of
 * premature abstraction worth avoiding. A Hono (or any other) runtime can
 * implement `EdgeHandler` later without this contract changing.
 */

export type EdgeHandler = (request: Request) => Promise<Response> | Response;

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
}

export function errorResponse(message: string, status = 400, init?: ResponseInit): Response {
  return jsonResponse({ error: message }, { ...init, status });
}
