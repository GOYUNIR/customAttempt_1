-- 00041: hands-off self-serve signup with abuse protection. ADDITIVE ONLY:
-- new tables, one new column on plans (filled for existing plans), two new
-- functions. No existing row changes meaning; the one data-changing path
-- (releasing an ABANDONED store's name) only runs inside claim_signup_name and
-- only for stores that never got going (see the rules below).

-- ── Policy as data (every window, limit and cap the signup path uses) ──────
create table if not exists public.platform_policies (
  key text primary key,
  value jsonb not null,
  description text not null default ''
);
insert into public.platform_policies (key, value, description) values
  ('signup.hold_hours', '48', 'A pending signup holds its store name this long, waiting for the email link.'),
  ('signup.owner_accept_days', '7', 'A verified store whose owner never set a password is abandoned after this.'),
  ('signup.activation_days', '14', 'A Free store with no payments AND no products is abandoned after this.'),
  ('signup.ip_soft_per_hour', '5', 'Signups per IP per hour before escalating waits begin (shared IPs: wait, not block).'),
  ('signup.ip_hard_per_day', '50', 'Signups per IP per day, hard.'),
  ('signup.email_per_day', '3', 'Signup attempts per email per day.'),
  ('signup.email_resend_cooldown_seconds', '60', 'Minimum wait between signup emails to one address (doubles each time).'),
  ('signup.domain_per_day', '20', 'Signups per email domain per day (not applied to the freemail list).'),
  ('signup.freemail_domains', '["gmail.com","googlemail.com","outlook.com","hotmail.com","live.com","msn.com","yahoo.com","icloud.com","me.com","mac.com","aol.com","proton.me","protonmail.com","gmx.com","gmx.de","web.de","yandex.com","mail.com","zoho.com","fastmail.com"]', 'Big shared providers: per-domain limit does not apply.'),
  ('signup.global_per_hour', '40', 'Circuit breaker: signups across the platform per hour.'),
  ('signup.global_per_day', '300', 'Circuit breaker: signups across the platform per day.'),
  ('signup.breaker_pause_minutes', '60', 'How long signup pauses itself when the breaker trips.'),
  ('signup.daily_email_cap', '200', 'Signup emails per day, all addresses.'),
  ('signup.email_headroom_reserve_percent', '20', 'Signup emails stop when less than this % of the monthly email allowance is left (kept for orders).'),
  ('signup.terms_version', '"2026-09-27-draft"', 'The platform terms version a signup accepts (draft pending legal review).')
on conflict (key) do nothing;

-- ── Disposable email domains (data; extend with inserts) ───────────────────
create table if not exists public.disposable_email_domains (domain text primary key check (domain = lower(domain)));
insert into public.disposable_email_domains (domain) values
  ('mailinator.com'),('guerrillamail.com'),('guerrillamail.net'),('guerrillamail.org'),('sharklasers.com'),('grr.la'),
  ('10minutemail.com'),('10minutemail.net'),('temp-mail.org'),('tempmail.com'),('tempmailo.com'),('tempmail.net'),('temp-mail.io'),
  ('yopmail.com'),('yopmail.net'),('yopmail.fr'),('trashmail.com'),('trashmail.de'),('trashmail.net'),('getnada.com'),('nada.email'),
  ('dispostable.com'),('maildrop.cc'),('mailnesia.com'),('mintemail.com'),('throwawaymail.com'),('fakeinbox.com'),('emailondeck.com'),
  ('mohmal.com'),('mailcatch.com'),('spamgourmet.com'),('mytemp.email'),('tempinbox.com'),('burnermail.io'),('33mail.com'),
  ('mailpoof.com'),('moakt.com'),('tempr.email'),('discard.email'),('mailsac.com'),('inboxkitten.com'),('emailfake.com'),
  ('fakemail.net'),('getairmail.com'),('anonaddy.me'),('spambox.us'),('spam4.me'),('mailtemp.info'),('tmail.ws'),('tmpmail.org'),
  ('tmpmail.net'),('mail.tm'),('mail.gw'),('linshiyouxiang.net'),('byom.de'),('wegwerfmail.de'),('einrot.com'),('cuvox.de'),
  ('armyspy.com'),('dayrep.com'),('fleckens.hu'),('gustr.com'),('jourrapide.com'),('rhyta.com'),('superrito.com'),('teleworm.us'),
  ('emltmp.com'),('tempmailaddress.com'),('mailbox52.ga'),('trbvm.com'),('xojxe.com'),('dropmail.me'),('10mail.org'),('vomoto.com'),
  ('harakirimail.com'),('mail-temp.com'),('tempemail.co'),('incognitomail.org'),('mvrht.net'),('nowmymail.com'),('owlymail.com'),
  ('pokemail.net'),('spamfree24.org'),('wh4f.org'),('zetmail.com'),('mailforspam.com'),('tempsky.com'),('instantemailaddress.com')
on conflict (domain) do nothing;

-- ── One owner's store cap is plan data ─────────────────────────────────────
alter table public.plans add column if not exists max_stores_per_owner int check (max_stores_per_owner is null or max_stores_per_owner >= 0);
update public.plans set max_stores_per_owner = 1 where id in ('free', 'starter') and max_stores_per_owner is null;
update public.plans set max_stores_per_owner = 3 where id = 'growth' and max_stores_per_owner is null;

-- ── Pending signups: a name is held ONLY while it is being activated ───────
create table if not exists public.merchant_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email)),
  store_name text not null,
  slug text not null,
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending', 'completed', 'expired', 'replaced')),
  terms_version text not null,
  terms_accepted_at timestamptz not null,
  ip text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_tenant_id uuid references public.tenants (id) on delete set null,
  completed_at timestamptz
);
create index if not exists merchant_signups_email_idx on public.merchant_signups (email, status);
create unique index if not exists merchant_signups_pending_slug on public.merchant_signups (slug) where status = 'pending';
alter table public.merchant_signups enable row level security;
revoke all on public.merchant_signups, public.platform_policies, public.disposable_email_domains from anon, authenticated;
grant select, insert, update on public.merchant_signups to service_role;
grant select on public.platform_policies, public.disposable_email_domains to service_role;

-- Is this store ABANDONED? Never the original store; only a Free store; and
-- either nobody ever became its owner within accept_days, or after
-- activation_days it still has no payments and no products. Such a store has
-- no customers, no orders and no money: suspending it orphans nothing.
create or replace function public.store_is_abandoned(p_tenant uuid, p_accept_days int, p_activation_days int)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select t.id <> '00000000-0000-0000-0000-00000000000d'
       and coalesce(t.plan_id, 'free') = 'free'
       and t.license_status = 'active'
       and (
         (t.created_at < now() - make_interval(days => p_accept_days)
           and not exists (select 1 from users u where u.tenant_id = t.id and u.role = 'owner'))
         or
         (t.created_at < now() - make_interval(days => p_activation_days)
           and not coalesce(t.connect_charges_enabled, false)
           and not exists (select 1 from products p where p.tenant_id = t.id))
       )
    from tenants t where t.id = p_tenant), false)
$$;

-- Reserve a store name for a pending signup, all-or-nothing and serialized
-- with address changes (same advisory lock as change_store_slug). Releases,
-- on the way, only what has lapsed: expired pending signups, and an
-- ABANDONED store holding exactly this name (suspended, name tombstoned).
create or replace function public.claim_signup_name(
  p_email text, p_store_name text, p_slug text, p_token_hash text, p_terms_version text, p_ip text,
  p_hold_hours int, p_accept_days int, p_activation_days int
) returns table (result text, signup_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('change_store_slug'));
  update merchant_signups set status = 'expired' where status = 'pending' and expires_at <= now();
  delete from tenant_slug_aliases where expires_at <= now();
  -- A new request from the same email replaces its earlier pending one (and its name).
  update merchant_signups set status = 'replaced' where status = 'pending' and email = p_email;

  select id into v_tenant from tenants where slug = p_slug;
  if v_tenant is not null then
    if store_is_abandoned(v_tenant, p_accept_days, p_activation_days) then
      update tenants set license_status = 'expired', slug = 'x--' || replace(id::text, '-', ''), updated_at = now() where id = v_tenant;
    else
      return query select 'taken'::text, null::uuid; return;
    end if;
  end if;
  if exists (select 1 from tenant_slug_aliases a where a.slug = p_slug) then return query select 'taken'::text, null::uuid; return; end if;
  if exists (select 1 from merchant_signups s where s.slug = p_slug and s.status = 'pending') then return query select 'taken'::text, null::uuid; return; end if;

  insert into merchant_signups (email, store_name, slug, token_hash, terms_version, terms_accepted_at, ip, expires_at)
    values (p_email, p_store_name, p_slug, p_token_hash, p_terms_version, now(), p_ip, now() + make_interval(hours => p_hold_hours))
    returning id into v_id;
  return query select 'claimed'::text, v_id;
end $$;

-- The email link was opened: turn the pending signup into a store (Free).
-- The caller then invites the verified email as its owner.
create or replace function public.complete_signup(p_token_hash text)
returns table (result text, tenant_id uuid, email text, slug text, store_name text)
language plpgsql security definer set search_path = public as $$
declare
  s merchant_signups%rowtype;
  v_tenant uuid;
begin
  perform pg_advisory_xact_lock(hashtext('change_store_slug'));
  select * into s from merchant_signups m where m.token_hash = p_token_hash for update;
  if s.id is null then return query select 'invalid'::text, null::uuid, null::text, null::text, null::text; return; end if;
  if s.status = 'completed' then return query select 'already'::text, s.completed_tenant_id, s.email, s.slug, s.store_name; return; end if;
  if s.status <> 'pending' or s.expires_at <= now() then
    update merchant_signups set status = 'expired' where id = s.id and status = 'pending';
    return query select 'expired'::text, null::uuid, s.email, s.slug, s.store_name; return;
  end if;
  if exists (select 1 from users u where u.email = s.email) then
    update merchant_signups set status = 'expired' where id = s.id;
    return query select 'has_account'::text, null::uuid, s.email, s.slug, s.store_name; return;
  end if;
  if exists (select 1 from tenants t where t.slug = s.slug) then
    update merchant_signups set status = 'expired' where id = s.id;
    return query select 'taken'::text, null::uuid, s.email, s.slug, s.store_name; return;
  end if;
  insert into tenants (name, slug, license_status, plan_id) values (s.store_name, s.slug, 'active', 'free') returning id into v_tenant;
  update merchant_signups set status = 'completed', completed_tenant_id = v_tenant, completed_at = now() where id = s.id;
  return query select 'created'::text, v_tenant, s.email, s.slug, s.store_name;
end $$;

revoke all on function public.store_is_abandoned(uuid, int, int) from public, anon, authenticated;
revoke all on function public.claim_signup_name(text, text, text, text, text, text, int, int, int) from public, anon, authenticated;
revoke all on function public.complete_signup(text) from public, anon, authenticated;
grant execute on function public.store_is_abandoned(uuid, int, int) to service_role;
grant execute on function public.claim_signup_name(text, text, text, text, text, text, int, int, int) to service_role;
grant execute on function public.complete_signup(text) to service_role;
