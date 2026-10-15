-- Signify Cash Discount (JCM HQ → #cash-discount) — JCM-Busysql project (jlkjjqnmhsgefpluemyz).
-- Applied 2026-10-15 as migration cash_discount_setup (this file is the copy in the repo).
-- Only ADDS tables; nothing the old tools or the JCM-Server scripts use is touched.
--
-- cd_ledger   : this financial year's postings on every Signify account (bills, payments,
--               notes …), written every 30 min by busy-sync/sync-cd-ledger.js on JCM-Server.
--               Same shape as party_ledger plus the account name.
-- cd_accounts : the accounts the sync found (name has "signify", not "prof") — the page lets
--               an admin untick one, or type the opening balance at 1 April when Busy's
--               31 March figure (party_anchor_balance) is missing or wrong.
-- cd_settings : one row — scheme start, slabs, name match words, last sync time.
-- RLS on with no policies: the browser cannot read them; api/purchases.js (actions cd-*)
-- reads with the service key after checking the HQ login (admins only).

create table if not exists cd_ledger (
  party_code     text    not null,
  vch_code       integer not null,
  sr_no          integer not null default 0,
  party_name     text,
  vch_type       integer,
  vch_type_name  text,
  vch_no         text,
  vch_date       date,
  debit          numeric not null default 0,
  credit         numeric not null default 0,
  synced_at      timestamptz not null default now(),
  primary key (party_code, vch_code, sr_no)
);
create index if not exists cd_ledger_party_date_idx on cd_ledger (party_code, vch_date, vch_code);
alter table cd_ledger enable row level security;

create table if not exists cd_accounts (
  party_code       text primary key,
  party_name       text not null,
  included         boolean not null default true,
  opening_balance  numeric,            -- payable at 1 April (positive = we owe them); null = use party_anchor_balance
  opening_note     text,
  last_synced_at   timestamptz
);
alter table cd_accounts enable row level security;

create table if not exists cd_settings (
  id              integer primary key default 1,
  name_match      text    not null default 'signify',
  name_exclude    text    not null default 'prof',
  scheme_from     date    not null default '2026-08-01',
  slab_a_days     integer not null default 5,
  slab_a_pct      numeric not null default 1.5,
  slab_b_days     integer not null default 10,
  slab_b_pct      numeric not null default 1.0,
  count_notes     boolean not null default false,  -- treat debit notes (returns, credits from Signify) as payments in FIFO
  last_sync_at    timestamptz,
  last_sync_note  text
);
alter table cd_settings enable row level security;
insert into cd_settings (id) values (1) on conflict (id) do nothing;

-- Added 2026-10-15 (migration cash_discount_email): the "Send to Signify" button —
-- who gets the claim by email (edited on the page), the fixed CC, the signature, and a log.
alter table cd_settings add column if not exists email_to text[] not null default '{}';
alter table cd_settings add column if not exists email_cc text not null default 'jc.mittal@hotmail.com';
alter table cd_settings add column if not exists email_signature text not null default E'Partner\nDilip Mittal';
create table if not exists cd_email_log (
  id          bigserial primary key,
  sent_at     timestamptz not null default now(),
  sent_by     text,
  from_date   date,
  to_date     date,
  to_emails   text[],
  cc_emails   text[],
  subject     text,
  total_cd    numeric,
  invoices    integer,
  status      text,
  detail      text
);
alter table cd_email_log enable row level security;

-- Added 2026-10-15 (migration cash_discount_pooling): FIFO runs per POOL of accounts joined by
-- journal transfers (lighting bills are moved into TR / MP and paid from there); 'per_account' = old way.
alter table cd_settings add column if not exists fifo_mode text not null default 'auto';
update cd_settings set name_exclude = 'prof, tds' where id = 1 and name_exclude = 'prof';
update cd_accounts set included = false
 where party_name ilike '%tds%' or party_name ilike '%note a/c%' or upper(trim(party_name)) = 'SIGNIFY';

-- Added 2026-10-15 (migration cash_discount_match_mode): 'amount' = each payment is matched to the
-- bills it was made for (how JCM pays, Dilip's working); 'fifo' = Signify's rule (oldest bill first).
alter table cd_settings add column if not exists match_mode text not null default 'amount';
update cd_settings set count_notes = false where id = 1;
