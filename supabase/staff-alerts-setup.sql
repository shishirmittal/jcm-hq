-- Staff alerts (2026-10-15, HQ Requests) — ALREADY APPLIED to the JCM-Busysql project
-- (jlkjjqnmhsgefpluemyz) as migration staff_alerts_setup. Kept for the record; safe to run again.
--
-- 1. Email Purchase Summary: per brand (sender row) the HQ people + extra numbers who get each
--    invoice that arrives by email, as a WhatsApp with the PDF (template staff_purchase_pdf).
-- 2. Item-group invoice alerts: when a SALES invoice holds an item from a chosen Busy item group
--    (or any group under it), the chosen people + extra numbers get the invoice PDF on WhatsApp
--    (template staff_invoice_copy) — installation / warranty registration.
-- Sent from api/_staff-alerts.js on every WhatsApp tick (every 5 min). RLS on, no policies.

alter table email_bill_senders add column if not exists notify_profiles uuid[] not null default '{}';
alter table email_bill_senders add column if not exists notify_numbers jsonb not null default '[]';  -- [{name, number}]
alter table email_bills add column if not exists notify_note text;

create table if not exists item_alert_rules (
  id            bigserial primary key,
  group_code    integer,
  group_path    text not null unique,         -- item_groups.full_path, e.g. 'Appliances > Chimneys & Cooktops'
  profile_ids   uuid[] not null default '{}', -- HQ people (CRM profiles.id → profiles.whatsapp)
  extra_numbers jsonb not null default '[]',  -- [{name, number}] people who are not HQ staff
  note          text,
  enabled       boolean not null default true,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_by    text,
  updated_at    timestamptz not null default now()
);
alter table item_alert_rules enable row level security;

create table if not exists item_alert_log (
  id          bigserial primary key,
  rule_id     bigint references item_alert_rules (id) on delete cascade,
  vch_no      text not null,
  vch_date    date,
  party_name  text,
  mobile      text,
  group_path  text,
  lines       text,
  status      text not null default 'pending',  -- pending | sent | partly | failed | expired | no_one
  error       text,
  recipients  integer not null default 0,
  sent        integer not null default 0,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  unique (rule_id, vch_no)
);
create index if not exists item_alert_log_created_idx on item_alert_log (created_at desc);
alter table item_alert_log enable row level security;

-- wa_outbox invoice rows already looked at for item-group alerts.
alter table wa_outbox add column if not exists item_alert_at timestamptz;
