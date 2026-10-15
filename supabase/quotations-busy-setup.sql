-- Quotations from Busy (JCM HQ → #quotations → "From Busy" tab) — run ONCE in the JCM-Busysql
-- project (jlkjjqnmhsgefpluemyz): Supabase → SQL Editor → New query → paste → Run.
-- Only ADDS two tables; nothing the old tools or the other JCM-Server scripts use is touched.
-- Safe to run again.
--
-- busy_quotations / busy_quotation_lines: quotation vouchers (Busy VchType 26, series QT/…)
--   of this financial year, written every 10 minutes by busy-sync/sync-quotations.js (JCM Sync job
--   `quotations`). RLS on with no policies: the browser cannot read these; api/customers.js reads
--   them with the service key after checking the HQ login.

create table if not exists busy_quotations (
  vch_key        text primary key,            -- '<Busy database>|<VchCode>'
  db_name        text not null,
  vch_code       integer not null,
  vch_no         text,
  quote_date     date,
  party_code     text,
  party_name     text,                        -- ledger name (Master1)
  billed_name    text,                        -- BillingDet name on the voucher, if any
  mobile         text,                        -- BillingDet mobile, else the ledger's mobile / WhatsApp
  city           text,
  narration      text,
  quote_total    numeric,                     -- GST included
  taxable_total  numeric,
  item_count     integer not null default 0,
  total_qty      numeric,
  entered_at     timestamptz,
  entered_by     text,
  last_edited_at timestamptz,
  cancelled      boolean not null default false,
  signature      text,
  deleted_at     timestamptz,
  synced_at      timestamptz not null default now()
);
create index if not exists busy_quotations_date_idx on busy_quotations (quote_date desc);
create index if not exists busy_quotations_party_idx on busy_quotations (party_code);
alter table busy_quotations enable row level security;

create table if not exists busy_quotation_lines (
  vch_key         text not null references busy_quotations (vch_key) on delete cascade,
  sr_no           integer not null,
  item_code       text,
  item_name       text,
  qty             numeric,
  unit            text,
  list_rate       numeric,                    -- pre-tax, before discount
  discount_pct    numeric,
  rate_before_gst numeric,                    -- pre-tax, after discount
  gst_rate        numeric,
  tax_amount      numeric,
  rate            numeric,                    -- tax-paid rate (after discount, with GST)
  amount          numeric,                    -- GST included
  taxable         numeric,
  primary key (vch_key, sr_no)
);
alter table busy_quotation_lines enable row level security;
