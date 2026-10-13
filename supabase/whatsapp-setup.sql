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

-- Inbox (2026-10-12): every message in / out through the number, and delivery statuses on the log.
create table if not exists wa_messages (
  id            bigserial primary key,
  number        text not null,
  direction     text not null,
  kind          text,
  text          text,
  payload       text,
  media_id      text,
  meta_id       text unique,
  profile_name  text,
  sent_by       text,
  status        text,
  error         text,
  delivered_at  timestamptz,
  read_at       timestamptz,
  seen_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists wa_messages_number_idx on wa_messages (number, created_at desc);
create index if not exists wa_messages_unseen_idx on wa_messages (direction, seen_at);
alter table wa_log add column if not exists delivered_at timestamptz;
alter table wa_log add column if not exists read_at timestamptz;
create index if not exists wa_log_meta_idx on wa_log (meta_id);
create index if not exists wa_log_to_idx on wa_log (to_number, created_at desc);
alter table wa_messages enable row level security;
revoke all on table wa_messages from anon, authenticated;
grant all on table wa_messages to service_role;
grant usage, select on sequence wa_messages_id_seq to service_role;
notify pgrst, 'reload schema';

-- Public bucket for PDFs that Meta fetches as a document header (quotations).
insert into storage.buckets (id, name, public) values ('wa-docs', 'wa-docs', true) on conflict (id) do nothing;

-- 2026-10-12: transaction messages go to the billed party (Busy Billing/Shipping Details); the ledger name is kept too.
alter table wa_outbox add column if not exists ledger_name text;
notify pgrst, 'reload schema';

-- 2026-10-13: edits / deletes after first save (busy-sync/sync-transactions.js) — run already.
alter table wa_outbox add column if not exists revision int not null default 0;  -- 1+ = corrected copy
alter table wa_outbox add column if not exists sent_amount numeric;              -- amount in the first message
alter table wa_outbox add column if not exists after_send text;                  -- 'changed' / 'deleted' after it went
alter table wa_outbox add column if not exists changed_at timestamptz;
