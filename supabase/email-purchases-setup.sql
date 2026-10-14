-- Email Purchase Summary (JCM HQ → #email-purchases) — ALREADY APPLIED to the JCM-Busysql
-- project (jlkjjqnmhsgefpluemyz) on 2026-10-15 as migration email_purchases_setup.
-- Kept here for the record; safe to run again.
--
-- Brand invoices that arrive by email (Gmail jcmretails@gmail.com), read every 15 min by
-- busy-sync/sync-email-purchases.js on JCM-Server, which asks Claude to pull the invoice
-- details out of the PDF / mail body. RLS on, no policies: only the service key reads these.

create table if not exists email_bill_senders (
  id          bigserial primary key,
  match       text not null unique,          -- an address or a domain, lower case
  brand       text,
  enabled     boolean not null default true,
  note        text,
  added_by    text,
  added_at    timestamptz not null default now()
);
alter table email_bill_senders enable row level security;

create table if not exists email_scan_mails (
  message_id   text primary key,             -- the mail's Message-ID header
  uid          bigint,
  sender       text,
  subject      text,
  received_at  timestamptz,
  status       text not null,                -- done | no_invoice | failed | skipped
  note         text,
  bills        integer not null default 0,
  scanned_at   timestamptz not null default now()
);
create index if not exists email_scan_mails_received_idx on email_scan_mails (received_at desc);
alter table email_scan_mails enable row level security;

create table if not exists email_bills (
  id               bigserial primary key,
  message_id       text not null references email_scan_mails (message_id) on delete cascade,
  seq              integer not null default 1,
  sender           text,
  subject          text,
  received_at      timestamptz,
  doc_kind         text not null default 'invoice',   -- invoice | credit_note | debit_note
  supplier_name    text,
  supplier_gstin   text,
  brand            text,
  invoice_no       text,
  invoice_date     date,
  buyer_name       text,
  taxable_total    numeric,
  tax_total        numeric,
  bill_total       numeric,
  item_count       integer not null default 0,
  total_qty        numeric,
  source           text,                              -- pdf | body
  attachment_name  text,
  attachment_path  text,                              -- Storage bucket email-bills
  model            text,
  extract_note     text,
  raw_json         jsonb,
  notify_state     text not null default 'pending',
  notified_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (message_id, seq)
);
create index if not exists email_bills_received_idx on email_bills (received_at desc);
create index if not exists email_bills_invoice_date_idx on email_bills (invoice_date desc);
create index if not exists email_bills_supplier_inv_idx on email_bills (supplier_name, invoice_no);
alter table email_bills enable row level security;

create table if not exists email_bill_lines (
  bill_id     bigint not null references email_bills (id) on delete cascade,
  sr_no       integer not null,
  item_name   text,
  hsn         text,
  qty         numeric,
  unit        text,
  rate        numeric,            -- per unit before GST
  gst_rate    numeric,
  tax_amount  numeric,
  amount      numeric,            -- line value before GST
  primary key (bill_id, sr_no)
);
alter table email_bill_lines enable row level security;

create table if not exists email_bill_settings (
  id                 integer primary key default 1 check (id = 1),
  instant_on         boolean not null default false,
  daily_on           boolean not null default false,
  summary_time       text not null default '19:30',
  last_summary_date  date,
  last_sync_at       timestamptz,
  last_sync_note     text,
  scan_from          date not null default '2026-10-01'
);
insert into email_bill_settings (id) values (1) on conflict (id) do nothing;
alter table email_bill_settings enable row level security;

insert into storage.buckets (id, name, public) values ('email-bills', 'email-bills', false) on conflict (id) do nothing;
