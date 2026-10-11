-- GSTR-2A Reconciliation (JCM HQ → #gst-recon) — run ONCE in the JCM-Busysql project
-- (jlkjjqnmhsgefpluemyz): Supabase → SQL Editor → New query → paste → Run.
-- Only ADDS new tables; nothing the old tools or the other JCM-Server scripts use is touched.
-- Safe to run again.
--
-- gst_2a_rows:       GSTR-2A data as pulled into Busy (GST → Misc. Utilities → Download GSTR
--                    JSON Data), one row per supplier invoice / note (Busy table GSTR2AInfo,
--                    summed over its tax-rate rows). Written by busy-sync/sync-gst.js.
-- gst_purchase_rows: Busy purchase vouchers (VchType 2) with their GST summary
--                    (VchGSTSumItemWise): party GSTIN, taxable, CGST / SGST / IGST, total.
-- gst_parties:       party master contacts with a GSTIN (mobile / WhatsApp / email) so the
--                    page can WhatsApp a supplier who has not filed.
-- gst_settings:      one row — last sync time and note.
-- gst_marks:         a reviewer's note on a row ("ignore", "done") so it drops out of the
--                    red list; keyed by month + bucket + row key.
-- gst_log:           every WhatsApp / email the page sent, with the result.
-- RLS on with no policies: the browser cannot read these; api/gst.js reads and writes
-- them with the service key after checking the HQ login.

create table if not exists gst_2a_rows (
  row_key            text primary key,   -- '<Busy database>|<GSTIN>|<tran type>|<invoice no.>'
  db_name            text not null,
  gstin              text not null,      -- supplier
  trade_name         text,
  tran_type          integer,            -- 1 = invoice, others = credit / debit note etc. (Busy's code)
  vch_no             text not null,      -- as filed by the supplier
  vch_date           date,               -- invoice date as filed
  inv_month          text,               -- 'YYYY-MM' of vch_date
  fy_month           integer,            -- Busy's Month (1 = April)
  fy_year            text,               -- '2026-2027'
  filed_period       text,               -- SupplierPrd, e.g. 'Aug-26' (the GSTR-1 it came in)
  supplier_filed_on  date,
  taxable            numeric,
  cgst               numeric,
  sgst               numeric,
  igst               numeric,
  cess               numeric,
  total              numeric,            -- taxable + taxes (Busy's TotalAmt is 0)
  rates              jsonb,              -- [{ rate, taxable, cgst, sgst, igst }]
  itc_avl            text,
  pulled_at          timestamptz,        -- when Busy downloaded it (Date1)
  synced_at          timestamptz not null default now()
);
create index if not exists gst_2a_rows_month_idx on gst_2a_rows (db_name, inv_month);
create index if not exists gst_2a_rows_gstin_idx on gst_2a_rows (gstin);
alter table gst_2a_rows enable row level security;

create table if not exists gst_purchase_rows (
  vch_key            text primary key,   -- '<Busy database>|<VchCode>'
  db_name            text not null,
  vch_code           integer not null,
  vch_no             text,
  vch_date           date,
  inv_month          text,               -- 'YYYY-MM' of vch_date
  party_code         text,
  party_name         text,
  gstin              text,               -- from the voucher's GST summary, else the party master
  series             text,
  taxable            numeric,
  cgst               numeric,
  sgst               numeric,
  igst               numeric,
  cess               numeric,
  total              numeric,            -- Tran1.VchAmtBaseCur (0 = FOC / scheme document)
  entered_by         text,
  entered_at         timestamptz,
  synced_at          timestamptz not null default now()
);
create index if not exists gst_purchase_rows_month_idx on gst_purchase_rows (db_name, inv_month);
create index if not exists gst_purchase_rows_gstin_idx on gst_purchase_rows (gstin);
alter table gst_purchase_rows enable row level security;

create table if not exists gst_parties (
  party_code   text primary key,         -- Master1.Code
  party_name   text,
  gstin        text,
  mobile       text,
  whatsapp     text,
  email        text,
  station      text,
  synced_at    timestamptz not null default now()
);
create index if not exists gst_parties_gstin_idx on gst_parties (gstin);
alter table gst_parties enable row level security;

create table if not exists gst_settings (
  id             integer primary key default 1 check (id = 1),
  last_sync_at   timestamptz,
  last_sync_note text,
  pulled_at      timestamptz             -- newest Busy 2A download seen
);
insert into gst_settings (id) values (1) on conflict (id) do nothing;
alter table gst_settings enable row level security;

create table if not exists gst_marks (
  month      text not null,              -- 'YYYY-MM'
  bucket     text not null,              -- missing_busy | not_in_2a | amount | docno | sequence | zero
  row_key    text not null,
  state      text not null,              -- ignored | done
  note       text,
  by_name    text,
  marked_at  timestamptz not null default now(),
  primary key (month, bucket, row_key)
);
alter table gst_marks enable row level security;

create table if not exists gst_log (
  id          bigserial primary key,
  month       text,
  kind        text not null,             -- party_reminder | admin_list
  channel     text not null,             -- whatsapp | email
  gstin       text,
  recipient   text,
  status      text not null,             -- sent | failed | no_number | not_set_up
  detail      text,
  by_name     text,
  sent_at     timestamptz not null default now()
);
create index if not exists gst_log_month_idx on gst_log (month, kind);
alter table gst_log enable row level security;

-- Storage bucket for the staff summary PDFs ("Send to staff" on the page). Public: the
-- WhatsApp template fetches the PDF by plain link. Names carry a timestamp, nothing secret.
insert into storage.buckets (id, name, public) values ('gst-reports', 'gst-reports', true)
on conflict (id) do update set public = true;
