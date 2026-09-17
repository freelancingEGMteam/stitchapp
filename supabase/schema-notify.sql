-- ---------------------------------------------------------------------------
-- Email the studio when a new drop-off or pick-up request arrives.
--
-- The notification is fired from the database rather than from the booking
-- page, so it cannot be lost by a browser tab closing mid-request, and it
-- covers a booking made any other way too.
--
-- pg_net posts the row to the app's /api/notify endpoint, which sends the
-- email over Gmail SMTP. The post is queued and asynchronous, so a slow or
-- failing endpoint never delays or blocks the customer's booking.
--
-- Configuration lives in studio_settings, not in this file, so the values are
-- not committed:
--
--   notify_url     https://<your-app>/api/notify
--   notify_secret  a long random shared secret, matching NOTIFY_SECRET on the
--                  server
--
-- With either unset, the trigger does nothing at all and bookings still work.
-- ---------------------------------------------------------------------------

create extension if not exists pg_net;

create or replace function public.notify_new_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  endpoint text;
  secret text;
begin
  select value into endpoint from studio_settings where key = 'notify_url';
  select value into secret from studio_settings where key = 'notify_secret';

  -- Not configured yet: never let a missing setting block a real booking.
  if endpoint is null or secret is null or endpoint = '' then
    return new;
  end if;

  perform net.http_post(
    url := endpoint,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-notify-secret', secret
    ),
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'booking_requests',
      'record', to_jsonb(new)
    ),
    timeout_milliseconds := 8000
  );

  return new;
end;
$$;

drop trigger if exists booking_requests_notify on booking_requests;
create trigger booking_requests_notify
  after insert on booking_requests
  for each row execute function public.notify_new_booking();

-- The function runs as the owner; nobody else needs to call it directly.
revoke all on function public.notify_new_booking() from public;
