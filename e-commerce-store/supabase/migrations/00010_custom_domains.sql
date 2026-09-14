-- =============================================================================
-- 00010_custom_domains.sql — Cloudflare for SaaS custom-hostname state.
--
-- tenants.custom_domain already exists (00003) as the hostname a merchant
-- wants to map. This adds the fields Cloudflare's Custom Hostnames API
-- (/zones/:zone_id/custom_hostnames) actually returns, so the admin domain
-- panel (lib/cloudflare-saas.ts) can show real DNS/SSL verification status
-- without re-polling Cloudflare on every page load.
--
-- Idempotent — safe to re-run. Apply with `supabase db push` or:
--   psql "$DATABASE_URL" -f 00010_custom_domains.sql
-- =============================================================================

alter table public.tenants
  add column if not exists cloudflare_hostname_id text;

alter table public.tenants
  add column if not exists domain_status text
  check (domain_status in ('unconfigured', 'pending', 'active', 'error'))
  default 'unconfigured';

alter table public.tenants
  add column if not exists ssl_status text
  check (ssl_status in ('unconfigured', 'pending_validation', 'pending_issuance', 'active', 'error'))
  default 'unconfigured';

alter table public.tenants
  add column if not exists domain_verification jsonb not null default '{}'::jsonb;

alter table public.tenants
  add column if not exists domain_checked_at timestamptz;

create index if not exists tenants_domain_status_idx on public.tenants (domain_status);
