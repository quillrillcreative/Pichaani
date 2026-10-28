-- Pichani — Supabase hardening for project mnhdrwkmnnslhtbypjxw
-- Run in the Supabase SQL editor. Run SECTION 1 first and read the output
-- before running anything else; sections 2-4 change your project.

-- ======================================================================
-- SECTION 1 — AUDIT (read-only)
-- ======================================================================

-- 1a. Is RLS on for every public table? (every row should be true)
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p')
order by 1;

-- 1b. Every policy that applies to your data (public tables + storage.objects)
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' or (schemaname = 'storage' and tablename = 'objects')
order by schemaname, tablename, cmd;

-- 1c. Bucket must be private (public = false)
select id, public, file_size_limit, allowed_mime_types
from storage.buckets where id = 'pichani-photos';

-- 1d. Is storage_usage a view (relkind 'v') or a table? Views bypass RLS
--     unless security_invoker is on.
select c.relname, c.relkind, c.reloptions
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'storage_usage';

-- 1e. What can the anonymous (logged-out) role touch? Expect nothing useful.
select table_name, privilege_type
from information_schema.role_table_grants
where grantee = 'anon' and table_schema = 'public'
order by 1, 2;

-- ======================================================================
-- SECTION 2 — Bucket limits (server-side; the browser checks are only UX)
-- ======================================================================
update storage.buckets
set public = false,
    file_size_limit = 52428800,  -- 50 MiB, matches MAX_FILE_BYTES in script.js
    allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif',
                               'image/heic','image/heif','image/avif']
where id = 'pichani-photos';

-- ======================================================================
-- SECTION 3 — storage_usage must respect each user's RLS
-- (only acts if it is a view; does nothing if it is a table)
-- ======================================================================
do $$
begin
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'storage_usage' and c.relkind = 'v'
  ) then
    execute 'alter view public.storage_usage set (security_invoker = on)';
  end if;
end $$;

-- ======================================================================
-- SECTION 4 — Delete policies (needed by the new "Delete" button)
-- Skip if the audit in 1b already shows DELETE policies for both tables.
-- ======================================================================
do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'photos'
                   and policyname = 'photos_delete_own') then
    create policy "photos_delete_own" on public.photos
      for delete to authenticated
      using (user_id = (select auth.uid()));
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'pichani_photos_delete_own') then
    create policy "pichani_photos_delete_own" on storage.objects
      for delete to authenticated
      using (bucket_id = 'pichani-photos'
             and (storage.foldername(name))[1] = (select auth.uid())::text);
  end if;
end $$;

-- ======================================================================
-- OPTIONAL — defence in depth: remove logged-out access entirely
-- (uncomment after confirming nothing public is meant to be readable)
-- ======================================================================
-- revoke all on public.photos, public.albums from anon;
-- revoke all on public.storage_usage from anon;
