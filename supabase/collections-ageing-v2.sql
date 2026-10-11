-- Payment Follow-up — ageing v2 (2026-10-11). Run in the JCM-Busysql project
-- (jlkjjqnmhsgefpluemyz): Supabase → SQL Editor → New query → paste → Run.
-- Safe to run more than once. Also folded into collections-setup.sql.
--
-- What changed from v1:
--   • Ageing now comes from party_ledger (sync-ledger.js, every 30 minutes):
--     every debit on the account (sales bills, debit notes, journals …) with
--     its date, so today's bill counts as today's credit within half an hour.
--     invoices (nightly) is used only for a party with no ledger rows yet.
--   • New column overdue = what is still unpaid on debits older than p_grace
--     days (default 20), plus anything from before this year's entries.
--     Payment Follow-up shows only parties with something overdue by default.
--   • Same name, and p_codes alone still works, so the Customer Card
--     (api/customers.js) keeps working unchanged.

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

revoke all on function collections_ageing(text[], integer) from public, anon, authenticated;
grant execute on function collections_ageing(text[], integer) to service_role;
revoke all on table party_ledger from anon, authenticated;

notify pgrst, 'reload schema';

-- Check: how many parties with dues use the ledger, and how much is over 20 days.
select count(*) as parties_with_dues,
       count(*) filter (where a.source = 'ledger') as using_ledger,
       count(*) filter (where a.overdue > 0) as with_overdue,
       round(sum(a.balance)) as total_due,
       round(sum(a.overdue)) as overdue_over_20_days,
       (select max(synced_at)::text from party_ledger) as ledger_last_synced
from collections_ageing(array(
  select party_code from dues_segmented where due_type = 'Receivable' and outstanding_balance > 0
)) a;
