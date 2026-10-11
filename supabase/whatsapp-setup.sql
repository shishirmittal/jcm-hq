-- JCM HQ — WhatsApp on Meta: log, switches, outbox, reminder scheduler (2026-10-12).
-- Run in the JCM-Busysql project (jlkjjqnmhsgefpluemyz): Supabase → SQL Editor → New query → Run.
-- Safe to run more than once. Only ADDS tables / columns.

create table if not exists wa_log (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  kind        text not null,
  template    text,
  to_number   text,
  ref         text,
  ref_name    text,
  sent_by     text,
  params      jsonb,
  status      text not null,
  error       text,
  meta_id     text
);
create index if not exists wa_log_created_idx on wa_log (created_at desc);
create index if not exists wa_log_kind_idx on wa_log (kind, created_at desc);

create table if not exists wa_settings (
  key         text primary key,
  value       text,
  updated_at  timestamptz not null default now()
);
insert into wa_settings (key, value) values ('orders_daily_at', '17:30') on conflict (key) do nothing;

create table if not exists wa_outbox (
  id          bigserial primary key,
  db          text not null,
  vch_code    bigint not null,
  kind        text not null,
  vch_no      text,
  vch_date    date,
  party_code  text,
  party_name  text,
  mobile      text,
  amount      numeric,
  items       integer,
  entered_by  text,
  entered_at  timestamptz,
  send_after  timestamptz not null default now(),
  status      text not null default 'queued',
  error       text,
  meta_id     text,
  sent_at     timestamptz,
  created_at  timestamptz not null default now(),
  unique (db, vch_code)
);
create index if not exists wa_outbox_due_idx on wa_outbox (status, send_after);

alter table collection_settings add column if not exists reminders_on boolean not null default false;
alter table collection_settings add column if not exists reminders_at text not null default '11:00';
alter table collection_settings add column if not exists reminders_tiers text not null default '20,40';
alter table collection_settings add column if not exists reminders_max integer not null default 150;
alter table collection_settings add column if not exists last_reminders date;
alter table collection_group_owners add column if not exists kind text not null default 'dealer';

alter table wa_log enable row level security;
alter table wa_settings enable row level security;
alter table wa_outbox enable row level security;
revoke all on table wa_log, wa_settings, wa_outbox from anon, authenticated;
grant all on table wa_log, wa_settings, wa_outbox to service_role;
grant usage, select on sequence wa_log_id_seq, wa_outbox_id_seq to service_role;

notify pgrst, 'reload schema';
select 'wa_log' as made, count(*) from wa_log
union all select 'wa_settings', count(*) from wa_settings
union all select 'wa_outbox', count(*) from wa_outbox;
