-- ---------------------------------------------------------------------------
-- Studio records: customers, jobs, leads, expenses, appointments, lifecycle.
--
-- These are the tables the app reads and writes. Until this file is applied
-- they do not exist, and the app silently falls back to browser localStorage
-- -- which means the records live only on one device and are lost when
-- browsing data is cleared.
--
-- The column list is taken from the actual records in data/seed.json plus the
-- TypeScript types in lib/data.ts, so a full record can round-trip. Guessing
-- a smaller set makes inserts fail with PGRST204 ("could not find the column")
-- and the app loses the write while looking like it succeeded.
--
-- IMPORTANT: schema.sql defines the same tables but with `using (true)`
-- policies. Those expose every customer's name, phone, email and address to
-- anyone holding the public anon key. Do NOT run schema.sql. This file is the
-- safe replacement: everything is gated on studio_members.
--
-- Run schema-auth.sql FIRST; this file needs public.studio_is_member().
-- ---------------------------------------------------------------------------

create table if not exists customers (
  id text primary key,
  customer_id text,
  customer_name text not null,
  phone_number text,
  email text,
  address text,
  source text,
  referred_by text,
  notes text,
  created_date timestamptz,
  updated_date timestamptz
);

create table if not exists jobs (
  id text primary key,
  job_id text,
  customer_id text,
  customer_name text not null,
  phone_number text,
  email text,
  job_details text,
  notes text,
  measurement_notes text,
  source text,
  status text,
  start_date date,
  delivery_date date,
  amount_to_charge numeric,
  deposit_paid numeric,
  balance_due numeric,
  tip_received numeric,
  payment_method text,
  time_spent_minutes integer,
  photo_url text,
  photo_urls jsonb,
  created_date timestamptz,
  updated_date timestamptz
);

create table if not exists leads (
  id text primary key,
  name text not null,
  phone_number text,
  email text,
  location text,
  source text,
  interested_in text,
  notes text,
  status text,
  created_date timestamptz,
  updated_date timestamptz
);

create table if not exists expenses (
  id text primary key,
  date date,
  note text,
  amount numeric,
  receipt_url text,
  category text,
  job_id text,
  created_date timestamptz,
  updated_date timestamptz
);

create table if not exists appointments (
  id text primary key,
  date date,
  time text,
  title text,
  notes text,
  linked_name text,
  linked_type text,
  linked_id text,
  status text,
  created_date timestamptz,
  updated_date timestamptz
);

create table if not exists customer_lifecycle (
  id text primary key,
  linked_name text,
  linked_type text,
  linked_id text,
  payment_method text,
  completed_steps jsonb,
  created_date timestamptz,
  updated_date timestamptz
);

-- Extra fields the real records carry. Added separately so an existing table
-- picks them up without a rebuild.
alter table customers add column if not exists is_sample boolean;
alter table customers add column if not exists created_by text;
alter table customers add column if not exists created_by_id text;

alter table jobs add column if not exists email text;
alter table jobs add column if not exists hem_length text;
alter table jobs add column if not exists inseam text;
alter table jobs add column if not exists bust text;
alter table jobs add column if not exists waist text;
alter table jobs add column if not exists sleeves text;
alter table jobs add column if not exists time_sessions jsonb;
alter table jobs add column if not exists is_sample boolean;
alter table jobs add column if not exists created_by text;
alter table jobs add column if not exists created_by_id text;

alter table leads add column if not exists is_sample boolean;
alter table leads add column if not exists created_by text;
alter table leads add column if not exists created_by_id text;

alter table expenses add column if not exists is_sample boolean;
alter table expenses add column if not exists created_by text;
alter table expenses add column if not exists created_by_id text;

alter table appointments add column if not exists is_sample boolean;
alter table appointments add column if not exists created_by text;
alter table appointments add column if not exists created_by_id text;

alter table customer_lifecycle add column if not exists is_sample boolean;
alter table customer_lifecycle add column if not exists created_by text;
alter table customer_lifecycle add column if not exists created_by_id text;

-- ---------------------------------------------------------------------------
-- Row level security. The studio's own records, so nothing is readable or
-- writable by anyone who is not on the member allowlist -- signed in or not.
-- ---------------------------------------------------------------------------

alter table customers enable row level security;
alter table jobs enable row level security;
alter table leads enable row level security;
alter table expenses enable row level security;
alter table appointments enable row level security;
alter table customer_lifecycle enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['customers', 'jobs', 'leads', 'expenses', 'appointments', 'customer_lifecycle'] loop
    execute format('drop policy if exists "studio members only" on %I', t);
    -- FOR ALL covers select, insert, update and delete in one policy. USING
    -- governs reading and matching rows to change; WITH CHECK governs what may
    -- be written, so a non-member cannot insert either.
    execute format(
      'create policy "studio members only" on %I for all to authenticated using (public.studio_is_member()) with check (public.studio_is_member())',
      t
    );
    -- Table privileges are separate from policies: without these, PostgREST
    -- returns "permission denied for table" before RLS is even consulted.
    execute format('revoke all on %I from anon', t);
    execute format('grant select, insert, update, delete on %I to authenticated', t);
  end loop;
end $$;
