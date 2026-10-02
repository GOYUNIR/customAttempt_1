import path from 'path';

/**
 * Security headers on every response.
 *
 * ENFORCED (safe for every page): HSTS (HTTPS only, one year, all
 * subdomains), frame protection (no other site may embed us — frame-ancestors
 * + X-Frame-Options), nosniff, a referrer policy, camera/microphone off.
 *
 * CONTENT POLICY, in two parts (CSP-PLAN in RELEASE-PLAN.md):
 * - ENFORCED: the directives a browser pass over every surface showed no
 *   violation for (scripts/csp-scan.ts, 2026-10-02): frames (Turnstile,
 *   Stripe), photos and media, fonts, no plugins, no <base> hijack.
 * - REPORT-ONLY: the full policy, scripts, styles and connections included.
 *   A wrong guess there would silently break checkout, Mapbox or the signup
 *   check, so those wait for their own clean pass (Turnstile and Stripe's
 *   embedded onboarding need signup on / a new Connect account to exercise).
 * Turnstile is allowed explicitly (script + frame from challenges.cloudflare.com).
 */
const FRAMES = "frame-src 'self' https://challenges.cloudflare.com https://js.stripe.com https://connect-js.stripe.com https://*.stripe.com";
const FONTS = "font-src 'self' data: https://fonts.gstatic.com";
const IMAGES = "img-src 'self' data: blob: https:";
const MEDIA = "media-src 'self' blob: https:";
const enforcedCsp = [
  "frame-ancestors 'self'",
  FRAMES, FONTS, IMAGES, MEDIA,
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');
const reportOnlyCsp = [
  "default-src 'self'",
  // static.cloudflareinsights.com: Cloudflare Web Analytics' beacon (the only
  // violation the 2026-10-02 scan found, on every page).
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://js.stripe.com https://connect-js.stripe.com https://api.mapbox.com https://static.cloudflareinsights.com",
  FRAMES,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.mapbox.com",
  FONTS, IMAGES, MEDIA,
  "connect-src 'self' https://challenges.cloudflare.com https://api.mapbox.com https://events.mapbox.com https://*.stripe.com https://*.supabase.co https://cloudflareinsights.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
].join('; ');

const nextConfig = {
	turbopack: {
		root: path.resolve(__dirname),
	},
	async headers() {
		return [{
			source: '/:path*',
			headers: [
				{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
				{ key: 'X-Frame-Options', value: 'SAMEORIGIN' },
				{ key: 'Content-Security-Policy', value: enforcedCsp },
				{ key: 'Content-Security-Policy-Report-Only', value: reportOnlyCsp },
				{ key: 'X-Content-Type-Options', value: 'nosniff' },
				{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
				{ key: 'Permissions-Policy', value: 'camera=(), microphone=(), payment=(self)' },
			],
		}];
	},
};

export default nextConfig;
