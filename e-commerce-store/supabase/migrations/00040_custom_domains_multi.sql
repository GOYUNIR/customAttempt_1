-- 00040: custom domains, per store, capped by plan (STORE-ADDRESSES.md §B).
-- ADDITIVE ONLY: one new column on plans (filled for the three plans that
-- exist today), one new table. The old single-domain columns on tenants
-- (00010) are left in place, unused.
--
-- Caps are plan DATA (owner, 2026-09-30): Free 1, Growth 3, Scale unlimited
-- (null). Starter (unlisted) is treated like Free.

alter table public.plans add column if not exists custom_domain_limit int check (custom_domain_limit is null or custom_domain_limit >= 0);
update public.plans set custom_domain_limit = 1 where id in ('free', 'starter') and custom_domain_limit is null;
update public.plans set custom_domain_limit = 3 where id = 'growth' and custom_domain_limit is null;
-- scale: left null = unlimited.

-- One hostname belongs to exactly ONE store (primary key). A domain serves
-- only when Cloudflare reports it active AND the store proved ownership with
-- its own TXT token (ownership_verified_at): a dangling CNAME left behind by
-- a previous owner cannot be claimed by another store, because the new
-- claimer cannot publish the TXT record in someone else's DNS.
create table if not exists public.tenant_domains (
  hostname text primary key check (hostname = lower(hostname) and hostname <> ''),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  verify_token text not null,
  cloudflare_hostname_id text unique,
  status text not null default 'pending' check (status in ('pending', 'active', 'error')),
  ssl_status text not null default 'pending',
  ownership_verified_at timestamptz,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  checked_at timestamptz
);
create index if not exists tenant_domains_tenant_idx on public.tenant_domains (tenant_id);
create unique index if not exists tenant_domains_one_primary on public.tenant_domains (tenant_id) where is_primary;

alter table public.tenant_domains enable row level security;
revoke all on public.tenant_domains from anon, authenticated;
grant select, insert, update, delete on public.tenant_domains to service_role;
