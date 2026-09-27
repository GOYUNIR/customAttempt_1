-- 00036: a person who appears in the audit log can be deleted.
--
-- 00009 added audit_logs.staff_id REFERENCES users(id) ON DELETE SET NULL.
-- But audit_logs is append-only (a trigger refuses every UPDATE), so deleting
-- any user referenced there fails with
--   "audit_logs is append-only — UPDATE is not permitted"
-- (found on production: a sales account that had started an impersonation
-- could not be removed). The audit row should keep the id it recorded, not
-- have it nulled, so the foreign key is dropped and the column kept.
--
-- Safe to re-run.

do $$
declare c text;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.audit_logs'::regclass
      and con.contype = 'f'
      and att.attname = 'staff_id'
  loop
    execute format('alter table public.audit_logs drop constraint %I', c);
  end loop;
end $$;
