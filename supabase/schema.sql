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

alter table customers enable row level security;
alter table jobs enable row level security;
alter table leads enable row level security;
alter table expenses enable row level security;
alter table appointments enable row level security;
alter table customer_lifecycle enable row level security;

create policy "public read customers" on customers for select using (true);
create policy "public read jobs" on jobs for select using (true);
create policy "public read leads" on leads for select using (true);
create policy "public read expenses" on expenses for select using (true);
create policy "public read appointments" on appointments for select using (true);
create policy "public read lifecycle" on customer_lifecycle for select using (true);

create policy "anon insert customers" on customers for insert with check (true);
create policy "anon insert jobs" on jobs for insert with check (true);
create policy "anon update customers" on customers for update using (true) with check (true);
create policy "anon update jobs" on jobs for update using (true) with check (true);
create policy "anon update leads" on leads for update using (true) with check (true);
create policy "anon update expenses" on expenses for update using (true) with check (true);
create policy "anon update appointments" on appointments for update using (true) with check (true);
create policy "anon update lifecycle" on customer_lifecycle for update using (true) with check (true);
