import path from 'path';

/**
 * Security headers on every response.
 *
 * ENFORCED (safe for every page): HSTS (HTTPS only, one year, all
 * subdomains), frame protection (no other site may embed us — frame-ancestors
 * + X-Frame-Options), nosniff, a referrer policy, camera/microphone off.
 *
 * REPORT-ONLY for now: the full content policy. Pages use inline scripts and
 * styles, Mapbox, Stripe's embedded onboarding and Turnstile; a wrong guess in
 * an ENFORCED policy would silently break checkout or the signup check. It is
 * reported first, then enforced once a browser pass shows no violations.
 * Turnstile is allowed explicitly (script + frame from challenges.cloudflare.com).
 */
const reportOnlyCsp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://js.stripe.com https://connect-js.stripe.com https://api.mapbox.com",
  "frame-src 'self' https://challenges.cloudflare.com https://js.stripe.com https://connect-js.stripe.com https://*.stripe.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.mapbox.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' https://challenges.cloudflare.com https://api.mapbox.com https://events.mapbox.com https://*.stripe.com https://*.supabase.co",
  "worker-src 'self' blob:",
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
				{ key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
				{ key: 'Content-Security-Policy-Report-Only', value: reportOnlyCsp },
				{ key: 'X-Content-Type-Options', value: 'nosniff' },
				{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
				{ key: 'Permissions-Policy', value: 'camera=(), microphone=(), payment=(self)' },
			],
		}];
	},
};

export default nextConfig;
