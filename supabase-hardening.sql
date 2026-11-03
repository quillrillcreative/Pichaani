-- Pichani — Supabase backend audit (READ-ONLY)
-- Project: mnhdrwkmnnslhtbypjxw
--
-- Audited 2026-10-30. Result: backend already hardened, no changes needed:
--   * RLS enabled on albums, photos, profiles, storage_usage
--   * every policy scoped to the owner (user_id / id = auth.uid())
--   * bucket pichani-photos is private, 50 MiB limit, image MIME types only
--   * storage.objects policies (select/insert/update/delete) scoped to the
--     bucket and the user's own folder
--   * SECURITY DEFINER triggers: photos_quota_before_write,
--     photos_sync_usage_after_write, on_auth_user_created_pichani
--   * anon role has no grants on public tables (revoked)
--
-- Re-run these any time to confirm nothing has drifted.
-- Run each statement on its own; the SQL editor shows one result at a time.

-- 1. RLS on for every public table? (all rows must be true)
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p')
order by 1;

-- 2. All policies (public tables + storage.objects)
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' or (schemaname = 'storage' and tablename = 'objects')
order by schemaname, tablename, cmd;

-- 3. Bucket must be private with limits
select id, public, file_size_limit, allowed_mime_types
from storage.buckets where id = 'pichani-photos';

-- 4. Logged-out role must have NO grants (expect "No rows returned")
select table_name, privilege_type
from information_schema.role_table_grants
where grantee = 'anon' and table_schema = 'public';

-- 5. Storage policies scoped to bucket + user folder (expect 4 rows, all true)
select cmd,
  coalesce(with_check, qual) like '%pichani-photos%' as bucket_scoped,
  coalesce(with_check, qual) like '%foldername%auth.uid()%' as user_folder_scoped
from pg_policies
where schemaname = 'storage' and tablename = 'objects' and policyname ilike '%pichani%'
order by cmd;

-- 6. Triggers that enforce quota / keep usage in sync / create profiles
select c.relname as on_table, t.tgname, p.proname, p.prosecdef as security_definer
from pg_trigger t
join pg_proc p on p.oid = t.tgfoid
join pg_class c on c.oid = t.tgrelid
where not t.tgisinternal and c.relname in ('photos','users','albums')
order by 1, 2;
