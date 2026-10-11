-- JCM Sync (one runner for every Busy → Supabase job on JCM-Server) — run ONCE in the
-- JCM-Busysql project (jlkjjqnmhsgefpluemyz): Supabase → SQL Editor → New query → paste → Run.
-- Only ADDS two tables; nothing the old tools or the sync scripts use is touched.
--
-- sync_jobs       one row per job: timetable, last run, ok / failed, last message,
--                 run_requested_at (the "Run now" button on HQ's Sync status page).
-- sync_job_runs   every run (kept 14 days) with the last lines of the script's output.
-- Both have RLS on with no policies: only busy-sync/jcm-sync.js and api/sync-status.js
-- (service key) can read or write them.

create table if not exists sync_jobs (
  job_id            text primary key,
  name              text,
  schedule          text,
  sort_order        integer,
  every_minutes     numeric,
  daily_at          text,
  running           boolean not null default false,
  last_started_at   timestamptz,
  last_finished_at  timestamptz,
  last_ok           boolean,
  last_ok_at        timestamptz,
  last_exit         integer,
  last_message      text,
  last_duration_ms  integer,
  run_requested_at  timestamptz,
  run_requested_by  text,
  runner_seen_at    timestamptz
);
alter table sync_jobs enable row level security;

create table if not exists sync_job_runs (
  id           bigserial primary key,
  job_id       text not null,
  started_at   timestamptz not null,
  finished_at  timestamptz,
  ok           boolean,
  exit_code    integer,
  message      text,
  reason       text,
  output       text
);
create index if not exists sync_job_runs_job_idx on sync_job_runs (job_id, started_at desc);
alter table sync_job_runs enable row level security;
