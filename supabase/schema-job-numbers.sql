-- ---------------------------------------------------------------------------
-- Job numbers are unique, guaranteed by the database.
--
-- They used to be built in the app as `JOB-${jobs.length + 1}`, which counts
-- rows rather than numbers. The studio's earlier jobs are not numbered 1..n,
-- so the first job added through the app took JOB-0058 -- already in use -- and
-- every job after it collided the same way. Five duplicates built up before
-- anyone noticed.
--
-- Reading the highest number in the app is better but still not a guarantee:
-- two people or two tabs adding a job at the same moment would both pick the
-- same number from the same stale list. So the database assigns it now, from a
-- real sequence, and a unique index makes a duplicate impossible.
--
-- The app inserts new jobs with job_id null and adopts whatever comes back.
-- ---------------------------------------------------------------------------

create sequence if not exists public.job_number_seq;

-- Continue above the highest number already in use, so existing jobs are not
-- stepped on. is_called = false means the next nextval returns exactly this.
select setval(
  'public.job_number_seq',
  coalesce((
    select max(nullif(regexp_replace(job_id, '[^0-9]', '', 'g'), '')::int)
    from jobs
    where job_id ~ '^JOB-[0-9]+$'
  ), 0) + 1,
  false
);

create or replace function public.assign_job_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only when the caller did not supply one, so importing an existing job
  -- keeps its original number.
  if new.job_id is null or btrim(new.job_id) = '' then
    new.job_id := 'JOB-' || lpad(nextval('public.job_number_seq')::text, 4, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_assign_number on jobs;
create trigger jobs_assign_number
  before insert on jobs
  for each row execute function public.assign_job_number();

-- The guarantee. Partial, so the seed rows and any legacy blanks are fine.
-- This will refuse to create if duplicates already exist, which is deliberate:
-- it should not be possible to add the constraint while the data is wrong.
create unique index if not exists jobs_job_id_key
  on jobs (job_id)
  where job_id is not null and btrim(job_id) <> '';
