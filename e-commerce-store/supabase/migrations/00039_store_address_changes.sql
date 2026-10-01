-- 00039: self-serve store addresses (STORE-ADDRESSES.md §A). ADDITIVE ONLY:
-- two new tables and one new function; no existing row or column changes.
--
-- A store may change its <slug>.<root> address. Its OLD address becomes an
-- alias for 90 days: it 301s to the new one and nobody else may take it.
-- When the 90 days end the name is released (no hoarding through changes).
-- Changes are capped per store (e.g. 3 per 30 days), counted from a log so
-- flipping between two names cannot dodge the cap.

create table if not exists public.tenant_slug_aliases (
  slug text primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists tenant_slug_aliases_tenant_idx on public.tenant_slug_aliases (tenant_id);

create table if not exists public.tenant_slug_changes (
  id bigserial primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  from_slug text not null,
  to_slug text not null,
  changed_at timestamptz not null default now()
);
create index if not exists tenant_slug_changes_tenant_idx on public.tenant_slug_changes (tenant_id, changed_at);

alter table public.tenant_slug_aliases enable row level security;
alter table public.tenant_slug_changes enable row level security;
revoke all on public.tenant_slug_aliases, public.tenant_slug_changes from anon, authenticated;
grant select, insert, update, delete on public.tenant_slug_aliases, public.tenant_slug_changes to service_role;
grant usage on sequence public.tenant_slug_changes_id_seq to service_role;

-- One change, all-or-nothing, serialized: the name check, the cap, the alias
-- for the old name and the new address land together or not at all. Name
-- RULES (format, reserved and lookalike names) are checked by the app first;
-- this decides only what the database must decide: taken, held, cap.
create or replace function public.change_store_slug(
  p_tenant uuid, p_new text, p_hold_days int, p_max_changes int, p_window_days int
) returns table (result text, old_slug text, new_slug text)
language plpgsql security definer set search_path = public as $$
declare
  v_old text;
  v_changes int;
begin
  perform pg_advisory_xact_lock(hashtext('change_store_slug'));
  delete from tenant_slug_aliases where expires_at <= now();  -- expired holds are released
  select t.slug into v_old from tenants t where t.id = p_tenant for update;
  if v_old is null then return query select 'unknown_store'::text, null::text, p_new; return; end if;
  if v_old = p_new then return query select 'unchanged'::text, v_old, p_new; return; end if;
  if exists (select 1 from tenants t where t.slug = p_new) then return query select 'taken'::text, v_old, p_new; return; end if;
  if exists (select 1 from tenant_slug_aliases a where a.slug = p_new and a.tenant_id <> p_tenant) then
    return query select 'held'::text, v_old, p_new; return;
  end if;
  select count(*) into v_changes from tenant_slug_changes c
    where c.tenant_id = p_tenant and c.changed_at > now() - make_interval(days => p_window_days);
  if v_changes >= p_max_changes then return query select 'limit'::text, v_old, p_new; return; end if;

  delete from tenant_slug_aliases a where a.slug = p_new and a.tenant_id = p_tenant;  -- taking back its own recent name
  insert into tenant_slug_aliases (slug, tenant_id, expires_at)
    values (v_old, p_tenant, now() + make_interval(days => p_hold_days))
    on conflict (slug) do update set tenant_id = excluded.tenant_id, created_at = now(), expires_at = excluded.expires_at;
  update tenants set slug = p_new, updated_at = now() where id = p_tenant;
  insert into tenant_slug_changes (tenant_id, from_slug, to_slug) values (p_tenant, v_old, p_new);
  return query select 'changed'::text, v_old, p_new;
end $$;

revoke all on function public.change_store_slug(uuid, text, int, int, int) from public, anon, authenticated;
grant execute on function public.change_store_slug(uuid, text, int, int, int) to service_role;
