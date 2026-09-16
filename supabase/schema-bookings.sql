-- Booking requests created by the public /book page.
-- Run AFTER schema.sql. Safe to re-run.
--
-- Design note: this table is reachable from a public page, so anon is
-- given INSERT only, scoped to the unconfirmed state. Availability is
-- exposed through a SECURITY DEFINER function that returns booked slot
-- times and nothing else, so the public page can never read a
-- customer's name, phone or email.

create table if not exists booking_requests (
  id text primary key,
  slot_date date not null,
  slot_time text not null,
  kind text not null default 'Drop off',
  customer_name text not null,
  phone_number text,
  email text,
  location text,
  notes text,
  status text not null default 'Requested',
  created_date timestamptz not null default now()
);

-- One active booking per slot, enforced in the database rather than in
-- the client, so two customers racing for the same slot cannot both win.
-- Declined/cancelled rows drop out of the index and free the slot.
create unique index if not exists booking_requests_active_slot
  on booking_requests (slot_date, slot_time)
  where status in ('Requested', 'Confirmed');

create index if not exists booking_requests_date_idx
  on booking_requests (slot_date);

-- Added after the first release; harmless if the column already exists.
alter table booking_requests add column if not exists location text;

alter table booking_requests enable row level security;

-- There is deliberately NO select policy for anon on this table: it holds
-- customer contact details and sits behind a public URL.
drop policy if exists "anon request booking" on booking_requests;
create policy "anon request booking" on booking_requests
  for insert to anon
  with check (status = 'Requested');

-- Taken slots only. SECURITY DEFINER lets it read the table while anon
-- cannot, and the return type carries no personal data.
create or replace function public.booked_slots(from_date date, to_date date)
returns table (slot_date date, slot_time text)
language sql
security definer
set search_path = public
stable
as $$
  select b.slot_date, b.slot_time
  from booking_requests b
  where b.status in ('Requested', 'Confirmed')
    and b.slot_date >= from_date
    and b.slot_date <= to_date;
$$;

revoke all on function public.booked_slots(date, date) from public;
grant execute on function public.booked_slots(date, date) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Studio side: reading and answering requests.
--
-- The studio app is a public URL with no login, so it cannot hold a
-- service-role key. Instead the owner sets a passphrase once (see the bottom
-- of this file) and the app passes it to these SECURITY DEFINER functions.
-- booking_requests itself is never readable by anon, so without the
-- passphrase the requests are unreadable.
-- ---------------------------------------------------------------------------

create table if not exists studio_settings (
  key text primary key,
  value text not null
);

alter table studio_settings enable row level security;
-- Intentionally no policies: anon can neither read nor write this table.
-- It is reachable only from the SECURITY DEFINER functions below.

create or replace function public.studio_claim(pass text)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (select 1 from studio_settings where key = 'studio_key' and value = pass);
$$;

create or replace function public.studio_bookings(pass text)
returns setof booking_requests
language sql security definer set search_path = public stable
as $$
  select b.* from booking_requests b
  where exists (select 1 from studio_settings where key = 'studio_key' and value = pass)
  order by b.slot_date asc, b.slot_time asc;
$$;

create or replace function public.studio_set_booking_status(pass text, booking_id text, new_status text)
returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from studio_settings where key = 'studio_key' and value = pass) then
    return false;
  end if;
  if new_status not in ('Requested', 'Confirmed', 'Declined') then
    return false;
  end if;
  update booking_requests set status = new_status where id = booking_id;
  return found;
end;
$$;

revoke all on function public.studio_claim(text) from public;
revoke all on function public.studio_bookings(text) from public;
revoke all on function public.studio_set_booking_status(text, text, text) from public;
grant execute on function public.studio_claim(text) to anon, authenticated;
grant execute on function public.studio_bookings(text) to anon, authenticated;
grant execute on function public.studio_set_booking_status(text, text, text) to anon, authenticated;

-- Run this once, replacing the passphrase with a long random string.
-- Pick something you can type on a phone, e.g. 4-5 random words.
--
-- insert into studio_settings (key, value)
-- values ('studio_key', 'change-me-to-a-long-random-passphrase')
-- on conflict (key) do update set value = excluded.value;

-- ---------------------------------------------------------------------------
-- Editable booking hours.
--
-- The public page must read these, so the table is world-readable. Nothing
-- in it is sensitive — it is opening hours. Writing requires the studio
-- passphrase set above.
-- ---------------------------------------------------------------------------

create table if not exists booking_settings (
  id text primary key,
  slot_minutes integer not null default 30,
  open_time text not null default '09:00',
  close_time text not null default '17:00',
  open_days integer[] not null default '{2,3,4,5,6}',
  lead_hours integer not null default 12,
  horizon_days integer not null default 60,
  allow_same_day boolean not null default false,
  updated_date timestamptz not null default now()
);

insert into booking_settings (id) values ('default') on conflict (id) do nothing;

alter table booking_settings enable row level security;

drop policy if exists "public read booking settings" on booking_settings;
create policy "public read booking settings" on booking_settings
  for select using (true);

-- Writes are gated on the same passphrase as the bookings list. Only the
-- fields present in the patch are changed.
create or replace function public.studio_save_booking_settings(pass text, patch jsonb)
returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from studio_settings where key = 'studio_key' and value = pass) then
    return false;
  end if;
  if (patch->>'open_time') !~ '^[0-2][0-9]:[0-5][0-9]$' or (patch->>'close_time') !~ '^[0-2][0-9]:[0-5][0-9]$' then
    return false;
  end if;
  update booking_settings set
    slot_minutes = coalesce((patch->>'slot_minutes')::int, slot_minutes),
    open_time = coalesce(patch->>'open_time', open_time),
    close_time = coalesce(patch->>'close_time', close_time),
    open_days = case when patch ? 'open_days'
      then (select coalesce(array_agg(value::int order by value::int), '{}')
            from jsonb_array_elements_text(patch->'open_days'))
      else open_days end,
    lead_hours = coalesce((patch->>'lead_hours')::int, lead_hours),
    horizon_days = coalesce((patch->>'horizon_days')::int, horizon_days),
    allow_same_day = coalesce((patch->>'allow_same_day')::boolean, allow_same_day),
    updated_date = now()
  where id = 'default';
  return found;
end;
$$;

revoke all on function public.studio_save_booking_settings(text, jsonb) from public;
grant execute on function public.studio_save_booking_settings(text, jsonb) to anon, authenticated;
