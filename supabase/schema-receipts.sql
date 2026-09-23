-- ---------------------------------------------------------------------------
-- Receipt images for expenses.
--
-- Receipts are financial documents, often with a name, address or card
-- details on them, so the bucket is PRIVATE. Nothing is readable without a
-- signed URL, and only studio members can create one.
--
-- The expense row stores the object path (e.g. "local-expense-123/1699.jpg")
-- in receipt_url, not a URL: signed URLs expire, so storing one would give a
-- link that works today and breaks next week.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

-- Storage has its own policies, separate from table RLS. Without these the
-- bucket exists but every upload and read is refused.
drop policy if exists "studio members read receipts" on storage.objects;
create policy "studio members read receipts" on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts' and public.studio_is_member());

drop policy if exists "studio members upload receipts" on storage.objects;
create policy "studio members upload receipts" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'receipts' and public.studio_is_member());

drop policy if exists "studio members replace receipts" on storage.objects;
create policy "studio members replace receipts" on storage.objects
  for update to authenticated
  using (bucket_id = 'receipts' and public.studio_is_member())
  with check (bucket_id = 'receipts' and public.studio_is_member());

drop policy if exists "studio members remove receipts" on storage.objects;
create policy "studio members remove receipts" on storage.objects
  for delete to authenticated
  using (bucket_id = 'receipts' and public.studio_is_member());
