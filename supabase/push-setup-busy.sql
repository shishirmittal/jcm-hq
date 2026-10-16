-- Phone pop-up notifications (Firebase) — Busy-data project (jlkjjqnmhsgefpluemyz).
-- Queue filled by triggers here, sent by HQ (api/_push.js).
create extension if not exists pg_net with schema extensions;

create table if not exists public.push_queue (
  id bigserial primary key,
  kind text not null,
  ref text,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  result text
);
create index if not exists push_queue_pending on public.push_queue(created_at) where status = 'pending';
alter table public.push_queue enable row level security;

create or replace function public.push_ping() returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    perform net.http_post(
      url := 'https://hq.jcmretails.com/api/sync-status',
      body := jsonb_build_object('action', 'push-drain'),
      headers := jsonb_build_object('Content-Type', 'application/json'),
      timeout_milliseconds := 5000);
  exception when others then null;
  end;
  return null;
end $$;
drop trigger if exists push_queue_ping on public.push_queue;
create trigger push_queue_ping after insert on public.push_queue for each statement execute function public.push_ping();

-- A customer wrote on WhatsApp (button taps are answered automatically, so they are left out).
create or replace function public.push_on_wa_message() returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    if new.direction = 'in' and coalesce(new.kind, '') not in ('button', 'interactive', 'reaction', 'status') then
      insert into push_queue(kind, ref, data) values ('wa_in', new.number, jsonb_build_object('id', new.id));
    end if;
  exception when others then null;
  end;
  return null;
end $$;
drop trigger if exists push_wa_message on public.wa_messages;
create trigger push_wa_message after insert on public.wa_messages for each row execute function public.push_on_wa_message();

-- Red alerts: new ones, and a staff reply to an admin's question.
create or replace function public.push_on_red_alert() returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    if tg_op = 'INSERT' then
      insert into push_queue(kind, ref, data) values ('red_alert', new.id::text, '{}'::jsonb);
    elsif old.reply is null and new.reply is not null then
      insert into push_queue(kind, ref, data) values ('red_alert_reply', new.id::text, '{}'::jsonb);
    end if;
  exception when others then null;
  end;
  return null;
end $$;
drop trigger if exists push_red_alert on public.red_alerts;
create trigger push_red_alert after insert or update of reply on public.red_alerts for each row execute function public.push_on_red_alert();

revoke all on function public.push_ping(), public.push_on_wa_message(), public.push_on_red_alert() from public, anon, authenticated;
