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
--   collections_ageing()   splits each party's balance over their newest bills
--                          (newest bills are taken as unpaid first) into
--                          0-30 / 31-60 / 61-90 / 90+ days.
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

create or replace function collections_ageing(p_codes text[])
returns table (
  party_code text,
  balance numeric,
  last_bill_date date,
  oldest_unpaid_date date,
  d0_30 numeric,
  d31_60 numeric,
  d61_90 numeric,
  d90_plus numeric,
  older numeric
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
           case when pd.party_code ~ '^\d+$' then pd.party_code::integer end as code_int
    from party_dues pd
    where pd.party_code = any(p_codes)
    group by pd.party_code
  ),
  inv as (
    select b.party_code, b.balance, i.vch_date, i.total_amount,
           sum(i.total_amount) over (
             partition by b.party_code
             order by i.vch_date desc, i.vch_code desc
             rows between unbounded preceding and current row
           ) as running
    from bal b
    join invoices i on i.party_code = b.code_int
    where i.total_amount > 0
  ),
  alloc as (
    select party_code, vch_date,
           greatest(0, least(total_amount, balance - (running - total_amount))) as unpaid
    from inv
  ),
  last_bill as (
    select b.party_code, max(i.vch_date) as last_bill_date
    from bal b join invoices i on i.party_code = b.code_int
    group by b.party_code
  )
  select b.party_code,
         b.balance,
         lb.last_bill_date,
         min(a.vch_date) filter (where a.unpaid > 0),
         coalesce(sum(a.unpaid) filter (where t.d - a.vch_date <= 30), 0),
         coalesce(sum(a.unpaid) filter (where t.d - a.vch_date between 31 and 60), 0),
         coalesce(sum(a.unpaid) filter (where t.d - a.vch_date between 61 and 90), 0),
         coalesce(sum(a.unpaid) filter (where t.d - a.vch_date > 90), 0),
         greatest(b.balance - coalesce(sum(a.unpaid), 0), 0)
  from bal b
  cross join today t
  left join alloc a on a.party_code = b.party_code
  left join last_bill lb on lb.party_code = b.party_code
  group by b.party_code, b.balance, lb.last_bill_date;
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
revoke all on function collections_ageing(text[]) from public, anon, authenticated;
grant execute on function collections_ageing(text[]) to service_role;
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
