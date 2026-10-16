-- Phone pop-up notifications (Firebase) — CRM project (cmtnzmfuasniicsdxyle).
-- Tokens of every phone with the JCM HQ app, a queue of things to announce (filled by triggers),
-- and a ping to HQ so the queue is sent within seconds. Sent by api/_push.js.
create extension if not exists pg_net with schema extensions;

create table if not exists public.push_tokens (
  token text primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  platform text default 'android',
  device text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_sent_at timestamptz,
  last_error text
);
create index if not exists push_tokens_profile on public.push_tokens(profile_id);
alter table public.push_tokens enable row level security;

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

-- One ping per statement. A failure never reaches the caller.
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

-- Tasks: filed to someone else, passed on, or sent back.
create or replace function public.push_on_task_history() returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    if new.action in ('filed', 'passed', 'sent_back') and new.to_user is not null
       and new.to_user is distinct from new.actor then
      insert into push_queue(kind, ref, data)
      values ('task', new.task_id::text, jsonb_build_object('action', new.action, 'actor', new.actor, 'to', new.to_user));
    end if;
  exception when others then null;
  end;
  return null;
end $$;
drop trigger if exists push_task_history on public.team_task_history;
create trigger push_task_history after insert on public.team_task_history for each row execute function public.push_on_task_history();

-- Orders reaching a stage someone has to act on.
create or replace function public.push_on_order() returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    if new.closed_at is null and new.stage in ('new', 'invoiced', 'checked', 'in_bay')
       and (tg_op = 'INSERT' or old.stage is distinct from new.stage)
       and not (new.stage = 'new' and new.hidden_until is not null and new.hidden_until > now()) then
      insert into push_queue(kind, ref, data) values ('order', new.id, jsonb_build_object('stage', new.stage));
    end if;
  exception when others then null;
  end;
  return null;
end $$;
drop trigger if exists push_order_stage on public.orders;
create trigger push_order_stage after insert or update of stage on public.orders for each row execute function public.push_on_order();

-- Dispatched without the LR photo.
create or replace function public.push_on_order_event() returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    if new.event = 'dispatched' and coalesce(new.payload->>'lr_photo', '') = '' then
      insert into push_queue(kind, ref, data) values ('order_no_lr', new.order_id, jsonb_build_object('by', new.profile_id));
    end if;
  exception when others then null;
  end;
  return null;
end $$;
drop trigger if exists push_order_event on public.order_events;
create trigger push_order_event after insert on public.order_events for each row execute function public.push_on_order_event();

revoke all on function public.push_ping(), public.push_on_task_history(), public.push_on_order(), public.push_on_order_event() from public, anon, authenticated;
