-- Purchase Summary (JCM HQ → #purchases) — run ONCE in the JCM-Busysql project
-- (jlkjjqnmhsgefpluemyz): Supabase → SQL Editor → New query → paste → Run.
-- Only ADDS new tables; nothing the old tools or the other JCM-Server scripts use is touched.
-- Safe to run again.
--
-- purchase_vouchers / purchase_lines: purchase bills (Busy VchType 2) of this financial
--   year, written every 15 minutes by busy-sync/sync-purchases.js on JCM-Server.
-- purchase_notify_people: HQ users who get the WhatsApp (number = profiles.whatsapp in
--   the CRM project, set in Manage Users).
-- purchase_settings: one row — on/off switches, evening summary time, last sync time.
-- purchase_notify_log: every WhatsApp tried, with the result.
-- RLS on with no policies: the browser cannot read these; api/purchases.js reads and
-- writes them with the service key after checking the HQ login.

create table if not exists purchase_vouchers (
  vch_key           text primary key,          -- '<Busy database>|<VchCode>'
  db_name           text not null,
  vch_code          integer not null,
  vch_no            text,
  bill_date         date,
  party_code        text,
  party_name        text,
  bill_total        numeric,                   -- party's side of the bill, GST included
  items_total       numeric,                   -- sum of qty × rate (GST included)
  taxable_total     numeric,                   -- sum of line amounts before GST
  item_count        integer not null default 0,
  total_qty         numeric,
  entered_at        timestamptz,               -- first save in Busy (audit log)
  entered_by        text,                      -- Busy login
  entered_computer  text,
  edit_count        integer not null default 0,
  last_edited_at    timestamptz,
  last_edited_by    text,
  signature         text,                      -- changes when anything on the bill changes
  deleted_at        timestamptz,               -- gone from Busy
  notify_state      text not null default 'pending',  -- pending | sending | sent | failed | not_set_up | no_recipients | skipped
  notified_at       timestamptz,
  synced_at         timestamptz not null default now()
);
create index if not exists purchase_vouchers_entered_idx on purchase_vouchers (entered_at desc);
create index if not exists purchase_vouchers_bill_date_idx on purchase_vouchers (bill_date desc);
create index if not exists purchase_vouchers_notify_idx on purchase_vouchers (notify_state) where notify_state in ('pending', 'sending');
alter table purchase_vouchers enable row level security;

create table if not exists purchase_lines (
  vch_key          text not null references purchase_vouchers (vch_key) on delete cascade,
  sr_no            integer not null,
  item_code        text,
  item_name        text,
  qty              numeric,
  rate             numeric,                    -- as typed in Busy, GST included
  rate_before_gst  numeric,
  amount           numeric,                    -- qty × rate (GST included)
  taxable          numeric,                    -- line amount before GST
  primary key (vch_key, sr_no)
);
alter table purchase_lines enable row level security;

create table if not exists purchase_notify_people (
  hq_user_id  uuid primary key,                -- profiles.id in the CRM project
  instant     boolean not null default true,   -- a WhatsApp for every new purchase bill
  daily       boolean not null default true,   -- the evening summary
  added_by    text,
  added_at    timestamptz not null default now()
);
alter table purchase_notify_people enable row level security;

create table if not exists purchase_settings (
  id                 integer primary key default 1 check (id = 1),
  instant_on         boolean not null default true,
  daily_on           boolean not null default true,
  summary_time       text not null default '19:30',  -- IST, HH:MM
  last_summary_date  date,
  last_sync_at       timestamptz,
  last_sync_note     text
);
insert into purchase_settings (id) values (1) on conflict (id) do nothing;
alter table purchase_settings enable row level security;

create table if not exists purchase_notify_log (
  id            bigserial primary key,
  kind          text not null,                 -- instant | daily | test
  vch_key       text,
  summary_date  date,
  hq_user_id    uuid,
  name          text,
  mobile        text,
  status        text,                          -- sent | failed | no_number | not_set_up
  created_at    timestamptz not null default now()
);
create index if not exists purchase_notify_log_vch_idx on purchase_notify_log (vch_key);
alter table purchase_notify_log enable row level security;
