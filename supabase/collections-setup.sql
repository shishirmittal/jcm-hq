-- Payment Follow-up (JCM HQ → Collections) — run in the JCM-Busysql project
-- (jlkjjqnmhsgefpluemyz): Supabase → SQL Editor → New query → paste → Run.
-- Safe to run more than once. Only ADDS things; nothing the old tools or the
-- JCM-Server sync scripts use is renamed, dropped or changed.
--
--   collection_followups   one row per call / WhatsApp / note / reminder sent,
--                          the full history per party. RLS on with no
--                          policies: the browser cannot read it; api/collections.js
--                          reads and writes it with the service key after
--                          checking the HQ login.
--   collection_latest      view: each party's latest call / note (next follow-up date).
--   collections_ageing()   splits each party's balance over their newest debits
--                          (party_ledger; invoices if no ledger yet; newest taken
--                          as unpaid first) into 0-30 / 31-60 / 61-90 / 90+ days,
--                          plus overdue = unpaid on debits older than 20 days.
--   invoices_party_code_idx  speeds up the ageing lookup.

create table if not exists collection_followups (
  id               bigserial primary key,
  party_code       text not null,
  party_name       text,
  group_name       text,
  channel          text not null default 'call',   -- call | whatsapp | visit | note | reminder
  outcome          text,                           -- promised, paid, call_later, no_answer, ... / sent, failed for reminders
  remarks          text,
  promised_amount  numeric,
  promised_date    date,
  next_followup    date,
  balance_at_time  numeric,
  mobile           text,
  message          text,
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz not null default now()
);

create index if not exists collection_followups_party_idx on collection_followups (party_code, created_at desc);
create index if not exists collection_followups_next_idx on collection_followups (next_followup);
alter table collection_followups enable row level security;

create index if not exists invoices_party_code_idx on invoices (party_code, vch_date desc);

-- party_ledger is created by supabase/ledger-setup.sql; the same definition is
-- repeated here only so this file runs even if that one has not been run yet.
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
alter table party_ledger enable row level security;

drop function if exists collections_ageing(text[]);
drop function if exists collections_ageing(text[], integer);

create function collections_ageing(p_codes text[], p_grace integer default 20)
returns table (
  party_code text,
  balance numeric,
  last_bill_date date,
  oldest_unpaid_date date,
  d0_30 numeric,
  d31_60 numeric,
  d61_90 numeric,
  d90_plus numeric,
  older numeric,
  overdue numeric,
  source text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with today as (
    select (now() at time zone 'Asia/Kolkata')::date as d
  ),
  bal as (
    select pd.party_code,
           greatest(coalesce(max(pd.outstanding_balance), 0), 0) as balance,
           case when pd.party_code ~ '^\d+$' then pd.party_code::integer end as code_int,
           exists (select 1 from party_ledger l where l.party_code = pd.party_code) as has_ledger
    from party_dues pd
    where pd.party_code = any(p_codes)
    group by pd.party_code
  ),
  debits as (
    select b.party_code, l.vch_date, l.vch_code, l.sr_no, l.debit as amount
    from bal b
    join party_ledger l on l.party_code = b.party_code
    where b.has_ledger and l.debit > 0 and l.vch_date is not null
    union all
    select b.party_code, i.vch_date, i.vch_code, 0, i.total_amount
    from bal b
    join invoices i on i.party_code = b.code_int
    where not b.has_ledger and i.total_amount > 0
  ),
  running as (
    select d.party_code, d.vch_date, d.amount, b.balance,
           sum(d.amount) over (
             partition by d.party_code
             order by d.vch_date desc, d.vch_code desc, d.sr_no desc
             rows between unbounded preceding and current row
           ) as run
    from debits d join bal b on b.party_code = d.party_code
  ),
  alloc as (
    select party_code, vch_date,
           greatest(0, least(amount, balance - (run - amount))) as unpaid
    from running
  ),
  last_debit as (
    select party_code, max(vch_date) as last_bill_date from debits group by party_code
  )
  select b.party_code,
         b.balance,
         ld.last_bill_date,
         min(a.vch_date) filter (where a.unpaid > 0),
         coalesce(sum(a.unpaid) filter (where t.d - a.vch_date <= 30), 0),
         coalesce(sum(a.unpaid) filter (where t.d - a.vch_date between 31 and 60), 0),
         coalesce(sum(a.unpaid) filter (where t.d - a.vch_date between 61 and 90), 0),
         coalesce(sum(a.unpaid) filter (where t.d - a.vch_date > 90), 0),
         greatest(b.balance - coalesce(sum(a.unpaid), 0), 0),
         coalesce(sum(a.unpaid) filter (where t.d - a.vch_date > p_grace), 0)
           + greatest(b.balance - coalesce(sum(a.unpaid), 0), 0),
         case when b.has_ledger then 'ledger' else 'invoices' end
  from bal b
  cross join today t
  left join alloc a on a.party_code = b.party_code
  left join last_debit ld on ld.party_code = b.party_code
  group by b.party_code, b.balance, b.has_ledger, ld.last_bill_date;
$$;

-- Latest call / note per party (WhatsApp reminders left out, so a reminder
-- never wipes the next follow-up date a person set).
create or replace view collection_latest with (security_invoker = true) as
select distinct on (party_code)
       party_code, party_name, group_name, channel, outcome, remarks,
       promised_amount, promised_date, next_followup, created_by_name, created_at
from collection_followups
where channel <> 'reminder'
order by party_code, created_at desc, id desc;

-- Supabase hands new tables, views and functions to the browser roles by
-- default. Take that back: only the server (service_role) may use these.
revoke all on table collection_followups from anon, authenticated;
revoke all on table collection_latest from anon, authenticated;
revoke all on function collections_ageing(text[], integer) from public, anon, authenticated;
grant execute on function collections_ageing(text[], integer) to service_role;
revoke all on table party_ledger from anon, authenticated;
grant all on table collection_followups to service_role;
grant select on table collection_latest to service_role;
grant usage, select on sequence collection_followups_id_seq to service_role;

notify pgrst, 'reload schema';

-- Check: how many parties with dues have bills to work out ageing from.
select count(*) as parties_with_dues,
       count(*) filter (where a.last_bill_date is not null) as parties_with_bills,
       round(sum(a.balance)) as total_due,
       round(sum(a.older)) as due_older_than_synced_bills
from collections_ageing(array(
  select party_code from dues_segmented where due_type = 'Receivable' and outstanding_balance > 0
)) a;
