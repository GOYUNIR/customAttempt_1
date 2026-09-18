-- 00026 — let a tenant actually be deleted.
--
-- THE CONFLICT, between two earlier migrations that were each correct alone:
--
--   00001  audit_logs.tenant_id uuid references public.tenants (id)
--                                                     ON DELETE SET NULL
--   00008  a trigger that blocks UPDATE on audit_logs unconditionally,
--          service-role key included, because the audit trail is append-only
--
-- `ON DELETE SET NULL` is implemented as an UPDATE. So deleting a tenant asks
-- the database to modify audit_logs, which the append-only trigger refuses, and
-- the whole DELETE fails:
--
--   DELETE /tenants?id=eq.… -> 400
--   {"code":"P0001","message":"audit_logs is append-only — UPDATE is not permitted"}
--
-- CONSEQUENCE: once a tenant has a single audit row it can NEVER be deleted.
-- Every tenant has one — `merchant_self_signup` and `tenant_created` both write
-- one at creation — so tenant deletion was broken for every tenant that has
-- ever existed. Found by trying it: a test store created through the live
-- self-serve signup could not be removed afterwards.
--
-- That also blocks a GDPR/CCPA erasure request at the tenant level, and leaves
-- a cancelled merchant's tenant row in place permanently.
--
-- THE FIX: drop the foreign key, keep the column.
--
-- An FK that MUTATES an immutable table on delete is the wrong constraint for
-- an append-only log. And nulling the tenant is not even the behaviour you
-- want: an audit entry records what happened to a tenant, so the id belongs in
-- the row whether or not that tenant still exists. Keeping the raw uuid makes
-- the trail MORE complete after a deletion, not less — "tenant X was deleted"
-- is exactly the kind of event an auditor comes looking for, and it is useless
-- if the row that records it has had its tenant_id wiped.
--
-- What is deliberately NOT done: weakening the append-only trigger. It was
-- verified to hold against the service-role key (see ARCHITECTURE.md), and
-- that guarantee is worth more than an FK.
--
-- `target_tenant_id` (00009) gets the same treatment for the same reason.

alter table public.audit_logs
  drop constraint if exists audit_logs_tenant_id_fkey;

alter table public.audit_logs
  drop constraint if exists audit_logs_target_tenant_id_fkey;

comment on column public.audit_logs.tenant_id is
  'The tenant this action was scoped to. Intentionally NOT a foreign key: ON DELETE SET NULL is an UPDATE, which 00008''s append-only trigger refuses, so the FK made every audited tenant undeletable. The id is retained after a tenant is deleted — an audit trail should still say which tenant it was.';
comment on column public.audit_logs.target_tenant_id is
  'The tenant a staff impersonation session was acting on. Not a foreign key, for the same reason as tenant_id — see that column''s comment.';
