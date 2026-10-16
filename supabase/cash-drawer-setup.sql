-- Cash Drawer (#cash-drawer, src/cash-drawer.js, api/_cash-drawer.js) — Busy-data project.
-- The counter's daily cash register: A (opening) + B (cash in) = C (cash out) + D (counted).
-- B and C come partly from Busy (party_ledger rows of the cash account, debit = in, credit = out)
-- and partly from what is typed on the page (cash_entries). All tables closed to the browser
-- (RLS on, no policies); everything goes through /api/purchases actions cash-*.
-- Applied as migration cash_drawer_setup (2026-10-16).

create table if not exists cash_settings (
  id int primary key default 1 check (id = 1),
  account_code text not null default '56680',      -- Busy ledger Cash (Retail)
  account_name text not null default 'Cash (Retail)',
  print_at text not null default '20:00',           -- IST, time the "count the drawer" banner shows
  start_day date,                                    -- first day the register was kept here
  updated_at timestamptz default now()
);
insert into cash_settings (id) values (1) on conflict do nothing;

create table if not exists cash_categories (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('in', 'out')),
  label text not null,
  emoji text,
  needs_note boolean not null default false,
  sort int not null default 100,
  active boolean not null default true,
  created_at timestamptz default now()
);

create table if not exists cash_entries (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  kind text not null check (kind in ('in', 'out')),
  category_id bigint references cash_categories(id),
  category_label text not null,
  amount numeric(12,2) not null check (amount > 0),
  note text,
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by_name text,
  delete_reason text
);
create index if not exists cash_entries_day on cash_entries (day);

create table if not exists cash_days (
  day date primary key,
  opening numeric(12,2),            -- typed opening (first day, or a correction); null = carried from the day before
  opening_note text,
  counted numeric(12,2),            -- D: cash actually counted in the drawer at night
  denominations jsonb,              -- {"500": 12, "200": 4, ..., "coins": 35}
  expected numeric(12,2),           -- A + B - C when the day was closed
  difference numeric(12,2),         -- counted - expected (minus = short)
  summary jsonb,                    -- A, B, C pieces as they were at closing
  close_note text,
  closed_by_name text,
  closed_at timestamptz,
  printed_at timestamptz,
  updated_at timestamptz default now()
);

alter table cash_settings enable row level security;
alter table cash_categories enable row level security;
alter table cash_entries enable row level security;
alter table cash_days enable row level security;

insert into cash_categories (kind, label, emoji, needs_note, sort)
select * from (values
  ('out', 'Transfer to Admin Office', '🏢', false, 10),
  ('out', 'COD Parcel', '📦', false, 20),
  ('out', 'Transport Bill', '🚚', false, 30),
  ('out', 'Chartered Bus', '🚌', false, 40),
  ('out', 'Auto Freight', '🛺', false, 50),
  ('out', 'Tea / Snacks / Cold Drinks', '☕', false, 60),
  ('out', 'Other Payment', '✏️', true, 900),
  ('in',  'Other Cash In', '➕', true, 900)
) v(kind, label, emoji, needs_note, sort)
where not exists (select 1 from cash_categories);
