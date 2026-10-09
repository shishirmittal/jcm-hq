-- Customer Card ledger (JCM HQ → #customers) — run ONCE in the JCM-Busysql project
-- (jlkjjqnmhsgefpluemyz): Supabase → SQL Editor → New query → paste → Run.
-- Only ADDS a new table; nothing the old tools or the JCM-Server scripts use is touched.
--
-- party_ledger: this financial year's postings on each customer's account, written by
-- busy-sync/sync-ledger.js on JCM-Server. RLS on with no policies: the browser cannot
-- read it; api/customers.js reads it with the service key after checking the HQ login.

create table if not exists party_ledger (
  party_code     text    not null,
  vch_code       integer not null,
  sr_no          integer not null default 0,
  vch_type       integer,
  vch_type_name  text,
  vch_no         text,
  vch_date       date,
  debit          numeric not null default 0,
  credit         numeric not null default 0,
  synced_at      timestamptz not null default now(),
  primary key (party_code, vch_code, sr_no)
);
create index if not exists party_ledger_party_date_idx on party_ledger (party_code, vch_date desc, vch_code desc);
create index if not exists party_ledger_synced_idx on party_ledger (synced_at);
alter table party_ledger enable row level security;
