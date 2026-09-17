-- Studio sign-in.
--
-- Replaces the shared passphrase with Supabase Auth. Run AFTER
-- schema-bookings.sql. Safe to re-run.
--
-- IMPORTANT: Supabase lets anyone create an account, so "is signed in" on
-- its own is NOT enough — anyone could sign up and read every customer.
-- Access is therefore limited to the addresses listed in studio_members.

create table if not exists studio_members (
  email text primary key,
  created_date timestamptz not null default now()
);

alter table studio_members enable row level security;
-- No policies and no grants: this table is reachable only from the
-- SECURITY DEFINER helper below, so it cannot be read or edited by a client.

-- The allowlist. Only these addresses can read bookings or change hours.
-- This is the single source of truth for who has access: add or remove
-- people by editing this list and re-running this file.
insert into studio_members (email) values
  ('rachel.valencas@gmail.com'),
  ('rachelannseamstress@gmail.com'),
  ('matiasvalencas@gmail.com')
  on conflict (email) do nothing;

-- True only when the signed-in user's email is on the list.
create or replace function public.studio_is_member()
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from studio_members m
    where lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ---------------------------------------------------------------------------
-- Replace the passphrase-gated functions.
--
-- The old ones took a `pass` argument. Postgres would happily keep both as
-- overloads, which would leave the passphrase route open, so drop them.
-- ---------------------------------------------------------------------------

drop function if exists public.studio_claim(text);
drop function if exists public.studio_bookings(text);
drop function if exists public.studio_set_booking_status(text, text, text);
drop function if exists public.studio_save_booking_settings(text, jsonb);

-- The passphrase is no longer used for anything.
delete from studio_settings where key = 'studio_key';

create or replace function public.studio_bookings()
returns setof booking_requests
language sql security definer set search_path = public stable
as $$
  select b.* from booking_requests b
  where public.studio_is_member()
  order by b.slot_date asc, b.slot_time asc;
$$;

create or replace function public.studio_set_booking_status(booking_id text, new_status text)
returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  if not public.studio_is_member() then return false; end if;
  if new_status not in ('Requested', 'Confirmed', 'Declined') then return false; end if;
  update booking_requests set status = new_status where id = booking_id;
  return found;
end;
$$;

create or replace function public.studio_save_booking_settings(patch jsonb)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  entry jsonb;
begin
  if not public.studio_is_member() then return false; end if;

  -- day_hours, when supplied, must be a full week of null-or-window entries.
  if patch ? 'day_hours' then
    if jsonb_typeof(patch->'day_hours') <> 'array' or jsonb_array_length(patch->'day_hours') <> 7 then
      return false;
    end if;
    for entry in select * from jsonb_array_elements(patch->'day_hours') loop
      if entry <> 'null'::jsonb then
        if jsonb_typeof(entry) <> 'object'
          or (entry->>'open') !~ '^[0-2][0-9]:[0-5][0-9]$'
          or (entry->>'close') !~ '^[0-2][0-9]:[0-5][0-9]$'
          or (entry->>'close') <= (entry->>'open') then
          return false;
        end if;
      end if;
    end loop;
  end if;

  update booking_settings set
    slot_minutes = coalesce((patch->>'slot_minutes')::int, slot_minutes),
    day_hours = coalesce(patch->'day_hours', day_hours),
    lead_hours = coalesce((patch->>'lead_hours')::int, lead_hours),
    horizon_days = coalesce((patch->>'horizon_days')::int, horizon_days),
    allow_same_day = coalesce((patch->>'allow_same_day')::boolean, allow_same_day),
    updated_date = now()
  where id = 'default';
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Policies and grants for signed-in studio members.
-- ---------------------------------------------------------------------------

drop policy if exists "studio read bookings" on booking_requests;
create policy "studio read bookings" on booking_requests
  for select to authenticated using (public.studio_is_member());

drop policy if exists "studio update bookings" on booking_requests;
create policy "studio update bookings" on booking_requests
  for update to authenticated using (public.studio_is_member())
  with check (public.studio_is_member());

grant select, update on table public.booking_requests to authenticated;

revoke all on function public.studio_is_member() from public;
revoke all on function public.studio_bookings() from public;
revoke all on function public.studio_set_booking_status(text, text) from public;
revoke all on function public.studio_save_booking_settings(jsonb) from public;
grant execute on function public.studio_is_member() to authenticated;
grant execute on function public.studio_bookings() to authenticated;
grant execute on function public.studio_set_booking_status(text, text) to authenticated;
grant execute on function public.studio_save_booking_settings(jsonb) to authenticated;
