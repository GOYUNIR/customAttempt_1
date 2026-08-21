import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createStorageClient } from '@/lib/storage';
import { ADMIN_DEVICES_KEY } from '@/lib/redis-keys';
import { isPlatformConfiguredEdge, supabaseEnvReady } from '@/services/config/edge';


const ADMIN_USER = process.env.ADMIN_BASIC_AUTH_USERNAME || 'admin';
const ADMIN_PASSWORD = resolveAdminPassword();

/**
 * Edge-safe resolution of the admin password. Mirrors `getAdminPassword()` in
 * lib/server-config.ts: in production the value MUST come from
 * ADMIN_BASIC_AUTH_PASSWORD; outside production the documented local dev
 * fallback is allowed so the admin portal stays usable on a fresh clone.
 *
 * This is inlined here (instead of importing from lib/server-config.ts)
 * because this file compiles to the EDGE runtime on Cloudflare Workers, and
 * lib/server-config.ts pulls in Node-only modules (`stripe`, `crypto`,
 * Resend) that are unavailable in the V8 / workerd environment.
 */
function resolveAdminPassword(): string {
  const configured = process.env.ADMIN_BASIC_AUTH_PASSWORD;
  if (configured) return configured;
  if (process.env.NODE_ENV !== 'production') return 'goyunir-admin-dev';
  return '';
}

/**
 * Constant-time string comparison that works in the middleware (Edge) runtime
 * where Node's crypto.timingSafeEqual is unavailable. Length is compared first
 * (the same information timingSafeEqual leaks), then every byte is XORed
 * together so a timing attacker can never learn the password one character at
 * a time.
 */
function timingSafeStringEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * These endpoints ARE the two-step verification flow, so they are reachable
 * with Basic Auth alone. Every OTHER /api/admin request additionally requires
 * a valid device cookie (issued by verify-confirm after an emailed code).
 */
const TWO_FA_EXEMPT = [
  '/api/admin/verify-start',
  '/api/admin/verify-send',
  '/api/admin/verify-confirm',
  '/api/admin/verify-status',
];

function verifyBasicAuth(authorization: string | null) {
  if (!authorization?.startsWith('Basic ')) return false;
  const encoded = authorization.slice(6);
  let decoded = '';
  try {
    decoded = atob(encoded);
  } catch {
    return false;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);
  return timingSafeStringEq(user, ADMIN_USER) && timingSafeStringEq(pass, ADMIN_PASSWORD);
}
/**
 * Edge-safe minimal JSON parse for Redis values. Mirrors
 * `safeParseRedisItem()` in lib/server-config.ts ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Upstash REST Redis
 * auto-deserializes JSON, so stored values can arrive as ALREADY-PARSED
 * objects (`String(object)` would be `"[object Object]"`).
 */
function parseStoredValue(item: unknown): unknown {
  if (item == null) return null;
  if (typeof item === 'object') return item;
  if (typeof item === 'string') {
    try {
      return JSON.parse(item);
    } catch {
      return null;
    }
  }
  return null;
}

/** Extract the device token from the request's Cookie header. Mirrors
 *  `adminDeviceTokenFromRequest()` in lib/admin-verify.ts (inlined here ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the
 *  Edge runtime cannot import that module because it pulls in Node `crypto`). */
function adminDeviceTokenFromRequest(request: NextRequest): string {
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)goyunir_admin_device=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

/** Whether a device token is currently valid. Mirrors `isAdminDeviceValid()`
 *  in lib/admin-verify.ts ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â inlined edge-safe (no `crypto`, no `email`, no
 *  Stripe). Lazy expiry: an expired token is removed the first time it is
 *  checked so `admin:devices` self-cleans. */
async function adminDeviceValid(redis: any, token: string): Promise<boolean> {
  if (!token) return false;
  const raw = await redis.hget(ADMIN_DEVICES_KEY, token).catch(() => null);
  if (!raw) return false;
  const parsed = parseStoredValue(raw) as { email?: string; createdAt?: number; expiresAt?: number } | null;
  if (!parsed) return false;
  if (Number(parsed.expiresAt) > 0 && Date.now() > Number(parsed.expiresAt)) {
    try {
      await redis.hdel(ADMIN_DEVICES_KEY, token);
    } catch {
      /* best-effort */
    }
    return false;
  }
  return Boolean(parsed.email || parsed.createdAt);
}
export async function middleware(request: NextRequest) {

  const pathname = request.nextUrl.pathname;

  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
    // ── Setup Wizard gate ────────────────────────────────────────────────────
    // When the Supabase-backed global_platform_settings row has is_configured =
    // false (or doesn't exist yet), the standard admin login is BLOCKED and the
    // browser is forced to /admin/setup. The setup endpoints are opened so the
    // wizard can run BEFORE any Basic-Auth password exists. Once configured the
    // gate flips off and the legacy Basic Auth + 2FA gates below take over.
    const isSetupPath =
      pathname === '/admin/setup' ||
      pathname.startsWith('/admin/setup') ||
      pathname === '/api/admin/setup' ||
      pathname.startsWith('/api/admin/setup');

    if (supabaseEnvReady()) {
      let configured: boolean | null = null;
      try {
        configured = await isPlatformConfiguredEdge();
      } catch {
        configured = null;
      }

      if (configured === false) {
        if (isSetupPath) {
          return NextResponse.next(); // wizard page + API are open pre-config
        }
        if (pathname.startsWith('/api/admin')) {
          return NextResponse.json(
            { error: 'PLATFORM_NOT_CONFIGURED', redirect: '/admin/setup' },
            { status: 423, headers: { 'Cache-Control': 'no-store' } },
          );
        }
        const url = request.nextUrl.clone();
        url.pathname = '/admin/setup';
        url.search = '';
        return NextResponse.redirect(url);
      }

      if (configured === true && isSetupPath) {
        if (pathname.startsWith('/api/admin')) {
          // Configured: the setup API goes back under the normal admin gates.
        } else {
          // Wizard already ran — never show it again; go to the portal.
          const url = request.nextUrl.clone();
          url.pathname = '/admin';
          url.search = '';
          return NextResponse.redirect(url);
        }
      }
      // configured === null → Supabase env present but gate unreachable: keep
      // legacy env-based admin behavior (never lock the portal).
    }
  }

  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
    if (!ADMIN_USER || !ADMIN_PASSWORD) {
      return new NextResponse('Admin not configured', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Admin Portal"' },
      });
    }

    // Gate 1 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â HTTP Basic Auth on EVERY admin path (page + all APIs). There is
    // no password-in-query bypass anymore: the audit / export / self-test
    // routes used to be reachable with `?password=ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦`, which leaks the password
    // into server logs, browser history and Referer headers.
    const authHeader = request.headers.get('authorization');
    if (!verifyBasicAuth(authHeader)) {
      return new NextResponse('Authentication required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Admin Portal"' },
      });
    }

    // Gate 2 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â two-step email verification. The /admin page itself and the
    // verify-* endpoints are exempt so the operator can reach the 2FA screen;
    // everything else requires a valid device cookie from a verified browser.
    const isPage = pathname === '/admin' || pathname === '/admin/';
    const isVerifyEndpoint = TWO_FA_EXEMPT.some((p) => pathname === p);
    if (!isPage && !isVerifyEndpoint) {
      const token = adminDeviceTokenFromRequest(request);
      const redis = createStorageClient();
      let verified = false;
      if (redis) {
        try {
          verified = await adminDeviceValid(redis, token);
        } catch {
          verified = false;
        }
      } else {
        // No storage configured ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â nothing to protect, never lock the portal.
        verified = true;
      }
      if (!verified) {
        return new NextResponse(JSON.stringify({ error: 'ADMIN_2FA_REQUIRED' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};
