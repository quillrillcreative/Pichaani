-- Pichani — profile photos (avatars)
-- Run in the Supabase SQL editor for project mnhdrwkmnnslhtbypjxw.
-- Run the whole file once. It only adds things and is safe to re-run.
--
-- Design:
--   * a separate PRIVATE bucket "avatars" (never public)
--   * one file per user at <user_id>/avatar, replaced on each change
--   * each user can only read/write their own folder
--   * the file path is stored in profiles.avatar_path

-- 1. Private bucket: images only, 5 MiB limit
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

-- 2. Storage policies: own folder only
drop policy if exists "avatars_select_own" on storage.objects;
create policy "avatars_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "avatars_insert_own" on storage.objects;
create policy "avatars_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "avatars_update_own" on storage.objects;
create policy "avatars_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "avatars_delete_own" on storage.objects;
create policy "avatars_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- 3. Where the photo path is recorded
alter table public.profiles add column if not exists avatar_path text;

-- 4. Check (should return 4 rows, all true for bucket_scoped and user_folder_scoped)
select cmd,
  coalesce(with_check, qual) like '%''avatars''%' as bucket_scoped,
  coalesce(with_check, qual) like '%foldername%auth.uid()%' as user_folder_scoped
from pg_policies
where schemaname = 'storage' and tablename = 'objects' and policyname like 'avatars_%'
order by cmd;
