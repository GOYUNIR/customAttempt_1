-- 00024 — staff invites, and making public.users the real identity table.
--
-- WHY THIS EXISTS. There is currently no way to create a second staff account.
-- The only staff identity the platform can produce is the single master
-- super-admin the Setup Wizard creates, plus a shared env Basic-Auth password.
-- The eight RBAC roles from 00015 are fully enforced by lib/admin-actor.ts and
-- completely unassignable, because nothing ever inserts a row to assign them
-- to. That blocks staff onboarding, sales reps (so the sales portal has no
-- account that can use it) and tenant owner provisioning, all at once.
--
-- TWO THINGS HAPPEN HERE, in this order, and the order matters.
--
-- 1. public.users is BACKFILLED from public.profiles.
--
--    These two tables overlap: both key off auth.users(id), both carry email,
--    tenant_id, is_super_admin and (since 00015) a role with a CHECK. The auth
--    path reads `profiles`; the admin Role Management screen reads `users`.
--    Nothing has ever kept them in sync, and `users` has never had a single
--    row — so that screen lists an empty table.
--
--    `users` is now the authoritative staff identity table. It is the shape
--    00009 intended (explicit FK to auth.users, tenant_id, full_name), and the
--    invite flow below points at it.
--
--    The backfill runs FIRST because the sign-in path is about to read `users`
--    instead of `profiles`. If the master super-admin has no row there, nobody
--    can sign in to anything. That is the one failure this migration must not
--    cause, so the copy happens in the same transaction as the table that
--    depends on it, rather than in a script somebody can forget to run.
--
--    Idempotent: ON CONFLICT DO NOTHING, so re-running never clobbers a role
--    that has since been changed through the admin UI.
--
-- 2. public.staff_invites is created.
--
-- THE TOKEN IS NEVER STORED. Only its SHA-256 hash is. The token itself exists
-- in exactly one place — the link in the invitation email. A leaked database
-- dump therefore cannot be used to accept an invite and mint a staff account
-- with a role attached. This is the same reasoning as password hashing, and it
-- matters more here: an invite row IS a grant of privilege.

-- ── 1. Backfill the identity table ───────────────────────────────────────────
insert into public.users (id, tenant_id, email, is_super_admin, role)
select
  p.id,
  p.tenant_id,
  p.email,
  coalesce(p.is_super_admin, false),
  -- profiles.role is nullable and is NULL for the wizard-created master
  -- account (it sets is_super_admin instead). Derive rather than import a
  -- NULL that would leave the account roleless in the table that now decides
  -- what it may do.
  coalesce(
    p.role,
    case when coalesce(p.is_super_admin, false) then 'super_admin' else 'staff' end
  )
from public.profiles p
where p.email is not null
on conflict (id) do nothing;

-- ── 2. Invites ───────────────────────────────────────────────────────────────
create table if not exists public.staff_invites (
  id uuid primary key default gen_random_uuid(),

  -- Which tenant the invitee will belong to. NULL means a platform-level
  -- invite (a super_admin or platform staff member who is not scoped to one
  -- store), which is a real case and not a missing value.
  tenant_id uuid references public.tenants (id) on delete cascade,

  email text not null,

  -- 00015's role set MINUS 'customer'. A staff invite must never be able to
  -- mint a customer role: customers are created by storefront signup, they
  -- have no business arriving through a staff invitation, and allowing it here
  -- would make this table a second, weaker path into the customer tier.
  role text not null
    check (role in ('super_admin', 'sales', 'sales_rep', 'sales_admin', 'deal_desk', 'owner', 'staff')),

  -- SHA-256 of the invite token, hex. Never the token. See the header.
  token_hash text not null unique,

  -- Who sent it. Kept as an EMAIL rather than an FK to users: the audit trail
  -- (public.audit_logs.actor) identifies people by email across every auth
  -- path, including the legacy env Basic-Auth operator who has no row in any
  -- table. An FK would make "who invited this person" unanswerable for exactly
  -- the operators most likely to be doing the inviting during bootstrap.
  invited_by_email text not null,
  invited_by_user_id uuid references public.users (id) on delete set null,

  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_user_id uuid references public.users (id) on delete set null,
  revoked_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- An invite cannot be both accepted and revoked. Without this, a revoke
  -- racing an acceptance could leave a row claiming both, and the acceptance
  -- check would have to guess which won.
  constraint staff_invites_not_both_states
    check (accepted_at is null or revoked_at is null)
);

-- At most ONE live invite per address per tenant. Partial, so that revoking or
-- accepting an invite frees the address to be invited again — which is the
-- behaviour a person expects after they revoke a mistake.
--
-- coalesce on tenant_id because NULL never equals NULL in a unique index, so a
-- plain (tenant_id, email) unique would let unlimited duplicate PLATFORM-level
-- invites through while correctly blocking tenant-scoped ones.
create unique index if not exists staff_invites_one_pending_per_email
  on public.staff_invites (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), email)
  where accepted_at is null and revoked_at is null;

-- The admin screen lists "pending invites for this tenant, newest first".
create index if not exists staff_invites_tenant_created_idx
  on public.staff_invites (tenant_id, created_at desc);

-- Acceptance looks up strictly by token hash; the unique constraint above
-- already indexes it, so no second index is created for that path.

drop trigger if exists staff_invites_set_updated_at on public.staff_invites;
create trigger staff_invites_set_updated_at before update on public.staff_invites
  for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Same admin-tier shape as the rest of this schema. This one holds pending
-- grants of privilege, so exposure would be worse than for most tables: a
-- readable invite row tells an attacker which addresses are about to become
-- staff and with what role.
alter table public.staff_invites enable row level security;

drop policy if exists "staff_invites_all" on public.staff_invites;
create policy "staff_invites_all" on public.staff_invites
  for all
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

comment on table public.staff_invites is
  'Pending staff invitations. One live invite per email per tenant (partial unique index). The token is stored ONLY as a SHA-256 hash — an invite row is a grant of privilege, so a database dump must not be usable to accept one.';
comment on column public.staff_invites.tenant_id is
  'NULL means a platform-level invite (not scoped to one store), which is a real case rather than a missing value.';
comment on column public.staff_invites.role is
  '00015 role set minus customer: customers are created by storefront signup and must never arrive through a staff invitation.';
comment on column public.staff_invites.invited_by_email is
  'Email rather than a user FK, so the legacy env Basic-Auth operator — who has no row in any identity table and is the most likely inviter during bootstrap — is still attributable.';
