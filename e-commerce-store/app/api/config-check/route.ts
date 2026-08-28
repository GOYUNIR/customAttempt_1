import { NextResponse } from 'next/server';
import { supabaseConfigured } from '@/services/config/supabase-client';
import { EmailFactory } from '@/services/email/factory';

export const dynamic = 'force-dynamic';

/**
 * /api/config-check — the safe hydration endpoint for the admin login + setup
 * views.
 *
 * Front-end views must NEVER read naked server-side environment variables
 * (process.env.X on the client returns `undefined`, which is what previously
 * collapsed into 400 "Bad Request" payload mismatches). Instead the UI calls
 * this route, which resolves the Cloudflare runtime bindings SERVER-SIDE and
 * returns ONLY presence booleans — never key values.
 */
export async function GET() {
  let emailProviderConfigured = false;
  try {
    // Same resolution the email senders use (persisted provider + legacy env
    // bindings like RESEND_API_KEY / POSTMARK_API_KEY / SENDGRID_API_KEY).
    emailProviderConfigured = Boolean(await EmailFactory.getDriver({ force: true }));
  } catch {
    emailProviderConfigured = false;
  }

  return NextResponse.json({
    ok: true,
    supabaseConfigured: supabaseConfigured(),
    emailProviderConfigured,
    // When no email provider is configured the 6-digit two-step code cannot be
    // delivered, so the login controller grants access on password alone.
    twoStepEnabled: emailProviderConfigured,
  });
}
