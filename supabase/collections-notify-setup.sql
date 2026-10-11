-- Payment Follow-up — who calls which group, daily WhatsApp / tasks (2026-10-11).
-- Run in the JCM-Busysql project (jlkjjqnmhsgefpluemyz): Supabase → SQL Editor →
-- New query → paste → Run. Safe to run more than once. Only ADDS tables.
--
--   collection_group_owners  Busy account group → the HQ person who follows it up
--                            (profiles.id in the CRM project; people themselves
--                            live only in Manage Users).
--   collection_settings      one row: default person for unassigned groups,
--                            morning / evening times, last run dates.
--   collection_daily_tasks   the Task Board task made for each person each day,
--                            so it is made once and ticked done when all are called.
-- All three: RLS on, no policies — only api/collections.js (service key) uses them.

create table if not exists collection_group_owners (
  group_name   text primary key,
  hq_user_id   uuid,
  updated_by   text,
  updated_at   timestamptz not null default now()
);

create table if not exists collection_settings (
  id             integer primary key default 1 check (id = 1),
  default_owner  uuid,
  morning_at     text not null default '10:00',
  evening_at     text not null default '19:00',
  last_morning   date,
  last_evening   date,
  updated_at     timestamptz not null default now()
);
insert into collection_settings (id) values (1) on conflict (id) do nothing;

create table if not exists collection_daily_tasks (
  day          date not null,
  hq_user_id   uuid not null,
  task_id      text,
  due_count    integer,
  whatsapp     text,
  created_at   timestamptz not null default now(),
  primary key (day, hq_user_id)
);

alter table collection_group_owners enable row level security;
alter table collection_settings enable row level security;
alter table collection_daily_tasks enable row level security;
revoke all on table collection_group_owners from anon, authenticated;
revoke all on table collection_settings from anon, authenticated;
revoke all on table collection_daily_tasks from anon, authenticated;
grant all on table collection_group_owners to service_role;
grant all on table collection_settings to service_role;
grant all on table collection_daily_tasks to service_role;

notify pgrst, 'reload schema';

select 'collection_group_owners' as made, count(*) from collection_group_owners
union all select 'collection_settings', count(*) from collection_settings
union all select 'collection_daily_tasks', count(*) from collection_daily_tasks;
