-- JCM CRM — schema additions for photo uploads + admin user management
-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query).
-- Safe to re-run: every statement is guarded with IF NOT EXISTS / OR REPLACE.

-- ============================================================
-- 1. Project photos (gallery)
-- ============================================================

create table if not exists project_photos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  url text not null,
  path text not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

-- If project_photos already existed from an earlier partial run, the
-- "create table if not exists" above was a no-op and any columns/foreign
-- key it was missing never got added. Patch those in here so PostgREST can
-- always find the projects <-> project_photos relationship.
alter table project_photos add column if not exists project_id uuid;
alter table project_photos add column if not exists url text;
alter table project_photos add column if not exists path text;
alter table project_photos add column if not exists created_at timestamptz not null default now();
alter table project_photos add column if not exists created_by uuid references auth.users(id);

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'project_photos'
      and constraint_type = 'FOREIGN KEY'
      and constraint_name = 'project_photos_project_id_fkey'
  ) then
    alter table project_photos
      add constraint project_photos_project_id_fkey
      foreign key (project_id) references projects(id) on delete cascade;
  end if;
end $$;

alter table project_photos enable row level security;

drop policy if exists "authenticated read photos" on project_photos;
create policy "authenticated read photos" on project_photos
  for select to authenticated using (true);

drop policy if exists "authenticated insert photos" on project_photos;
create policy "authenticated insert photos" on project_photos
  for insert to authenticated with check (true);

drop policy if exists "authenticated delete photos" on project_photos;
create policy "authenticated delete photos" on project_photos
  for delete to authenticated using (true);

-- Storage bucket for the actual image files
insert into storage.buckets (id, name, public)
values ('project-photos', 'project-photos', true)
on conflict (id) do nothing;

drop policy if exists "public read project photos" on storage.objects;
create policy "public read project photos" on storage.objects
  for select using (bucket_id = 'project-photos');

drop policy if exists "authenticated upload project photos" on storage.objects;
create policy "authenticated upload project photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'project-photos');

drop policy if exists "authenticated delete project photos" on storage.objects;
create policy "authenticated delete project photos" on storage.objects
  for delete to authenticated using (bucket_id = 'project-photos');

-- ============================================================
-- 2. Profiles + admin roles (for the admin user-management page)
-- ============================================================

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Same situation as project_photos above: profiles already existed from an
-- earlier partial run, so "create table if not exists" was a no-op and it
-- never got the role/active columns the admin page needs. Patch them in.
alter table profiles add column if not exists email text;
alter table profiles add column if not exists role text not null default 'staff';
alter table profiles add column if not exists active boolean not null default true;
alter table profiles add column if not exists created_at timestamptz not null default now();

-- Per-user tab permissions. Holds the NAV_CONFIG ids (src/nav-config.js) this
-- user may see; empty means nothing granted yet, never "everything" — the app
-- reads a null/missing value as an empty array on purpose, so the failure
-- direction is locked out rather than wide open. Admins ignore it entirely
-- and see every tab. Documented here because section 8's Payments policy
-- reads it; without this line a fresh run of this file fails on that policy.
alter table profiles add column if not exists allowed_tabs text[] not null default '{}'::text[];

-- The flag /api/admin-users gates on server-side with the service-role key.
-- Kept in sync with role = 'admin'; both exist because the server check and
-- every client check grew up reading different ones.
alter table profiles add column if not exists is_admin boolean not null default false;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'profiles' and constraint_name = 'profiles_role_check'
  ) then
    alter table profiles add constraint profiles_role_check check (role in ('admin', 'staff'));
  end if;
end $$;

alter table profiles enable row level security;

-- Every signed-in user can see the team list (needed for the admin page and
-- for the app to know its own role). Only admins can change role/active.
drop policy if exists "authenticated read profiles" on profiles;
create policy "authenticated read profiles" on profiles
  for select to authenticated using (true);

drop policy if exists "admins update profiles" on profiles;
create policy "admins update profiles" on profiles
  for update to authenticated
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'));

-- Auto-create a profile row whenever someone signs up
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- Backfill profiles for any users who already existed before this script ran
insert into profiles (id, email)
select u.id, u.email from auth.users u
left join profiles p on p.id = u.id
where p.id is null;

-- Promote the first admin. Edit the email below if needed, then run just
-- this statement (safe to run again later for any other account too).
update profiles set role = 'admin' where email = 'jcmretails@gmail.com';

-- ============================================================
-- 3. Project form fields (architect, WhatsApp number, address, product stage)
-- ============================================================

alter table projects add column if not exists architect text;
alter table projects add column if not exists whatsapp text;
alter table projects add column if not exists address text;
alter table projects add column if not exists product_stages text[] default '{}';

-- The form no longer collects "Product Category" or "Estimated Value", so
-- if either column was ever declared NOT NULL, relax that or new inserts
-- (which won't send these fields) would fail.
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'projects' and column_name = 'project_type') then
    alter table projects alter column project_type drop not null;
  end if;
  if exists (select 1 from information_schema.columns where table_name = 'projects' and column_name = 'value') then
    alter table projects alter column value drop not null;
  end if;
end $$;

-- ============================================================
-- 4. Quotations (per-project quotation + follow-up tracking)
-- ============================================================

create table if not exists quotations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  stages text[] default '{}',
  quotation_date date not null default current_date,
  followup_days integer not null default 7,
  followup_date date,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

-- Same "already existed from an earlier partial run" safety net as above.
alter table quotations add column if not exists project_id uuid;
alter table quotations add column if not exists stages text[] default '{}';
alter table quotations add column if not exists quotation_date date default current_date;
alter table quotations add column if not exists followup_days integer default 7;
alter table quotations add column if not exists followup_date date;
alter table quotations add column if not exists created_at timestamptz not null default now();
alter table quotations add column if not exists created_by uuid references auth.users(id);

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'quotations'
      and constraint_type = 'FOREIGN KEY'
      and constraint_name = 'quotations_project_id_fkey'
  ) then
    alter table quotations
      add constraint quotations_project_id_fkey
      foreign key (project_id) references projects(id) on delete cascade;
  end if;
end $$;

alter table quotations enable row level security;

drop policy if exists "authenticated read quotations" on quotations;
create policy "authenticated read quotations" on quotations
  for select to authenticated using (true);

drop policy if exists "authenticated insert quotations" on quotations;
create policy "authenticated insert quotations" on quotations
  for insert to authenticated with check (true);

-- ============================================================
-- 5. Meetings (per-project scheduled meetings)
-- ============================================================

create table if not exists meetings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  meeting_date date not null,
  meeting_time time,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

alter table meetings add column if not exists project_id uuid;
alter table meetings add column if not exists meeting_date date;
alter table meetings add column if not exists meeting_time time;
alter table meetings add column if not exists notes text;
alter table meetings add column if not exists created_at timestamptz not null default now();
alter table meetings add column if not exists created_by uuid references auth.users(id);

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'meetings'
      and constraint_type = 'FOREIGN KEY'
      and constraint_name = 'meetings_project_id_fkey'
  ) then
    alter table meetings
      add constraint meetings_project_id_fkey
      foreign key (project_id) references projects(id) on delete cascade;
  end if;
end $$;

alter table meetings enable row level security;

drop policy if exists "authenticated read meetings" on meetings;
create policy "authenticated read meetings" on meetings
  for select to authenticated using (true);

drop policy if exists "authenticated insert meetings" on meetings;
create policy "authenticated insert meetings" on meetings
  for insert to authenticated with check (true);

-- ============================================================
-- 6. Profile self-service (name, phone, city)
-- ============================================================
-- The first-login "set up your profile" screen needs users to be able to
-- save their own name/phone/city. "name" is added here too even though it
-- wasn't in the original column list, because the welcome message and the
-- first-login gate both depend on it existing.

alter table profiles add column if not exists name text;
alter table profiles add column if not exists phone text;
alter table profiles add column if not exists city text;

-- The existing "admins update profiles" policy only lets admins update
-- ANY row. Regular users need to update their OWN row (to save their
-- name/phone/city on first login), which that policy doesn't cover.
drop policy if exists "users update own profile" on profiles;
create policy "users update own profile" on profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Letting users update their own row is necessary for self-service profile
-- setup, but on its own it would also let a non-admin update their own
-- privilege columns directly via the API and self-promote. This trigger
-- silently reverts them to their previous value whenever the person making
-- the change isn't already an admin, so self-service profile edits
-- (name/phone/city) go through but privilege escalation doesn't.
--
-- is_admin and allowed_tabs were NOT on this list and needed to be:
--   is_admin      the column /api/admin-users trusts. A staff user could
--                 PATCH their own row to is_admin = true through the anon
--                 API and the trigger would let it stand, which is a
--                 straight route into the admin user-management endpoint.
--   allowed_tabs  self-granting a tab was only cosmetic while every
--                 sensitive page re-checked role, but section 8's Payments
--                 policy now reads this column, so a user who can write it
--                 can hand themselves the payment records. Widening that
--                 policy is only meaningful with this closed.
create or replace function prevent_role_escalation()
returns trigger
language plpgsql
security definer set search_path = public
as $
begin
  if not exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin') then
    new.role := old.role;
    new.active := old.active;
    new.is_admin := old.is_admin;
    new.allowed_tabs := old.allowed_tabs;
  end if;
  return new;
end;
$;

drop trigger if exists on_profile_update_guard on profiles;
create trigger on_profile_update_guard
  before update on profiles
  for each row execute procedure prevent_role_escalation();

-- ============================================================
-- 8. Payments & feedback (pay.jcmretails.com, surfaced on the Payments page)
-- ============================================================
-- Same two tables as pay.jcmretails.com's own sql/schema.sql — written to by
-- that project's /api/verify-payment and /api/submit-feedback serverless
-- functions using the service_role key. RLS here grants read access to the
-- people the CRM shows the Payments page to — see the policies below.

create table if not exists pay_payments (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  customer_mobile text not null,
  amount numeric(12,2) not null,
  currency text default 'INR',
  razorpay_order_id text,
  razorpay_payment_id text,
  status text not null default 'paid',
  created_at timestamptz not null default now()
);

create index if not exists pay_payments_mobile_idx on pay_payments (customer_mobile);
create index if not exists pay_payments_created_idx on pay_payments (created_at desc);

create table if not exists pay_feedback (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  customer_mobile text not null,
  rating smallint not null check (rating between 1 and 5),
  feedback_text text,
  created_at timestamptz not null default now()
);

create index if not exists pay_feedback_mobile_idx on pay_feedback (customer_mobile);
create index if not exists pay_feedback_created_idx on pay_feedback (created_at desc);

alter table pay_payments enable row level security;
alter table pay_feedback enable row level security;

-- Money received is sensitive, so this stays a deliberate grant rather than
-- anything an authenticated user gets by default. It just is no longer
-- "admins only": per-user tab permissions (profiles.allowed_tabs, section 2)
-- let an admin tick Payments for one staff member, and while these policies
-- keyed on role = 'admin' that tick was a lie — the page opened and returned
-- zero rows, so it read "No payments yet" rather than refusing. An empty
-- state that looks like real data is worse than a closed door. Whoever the
-- app shows the tab to is now whoever the rows are shown to.
--
-- Three ways in, and all three are deliberate:
--   is_admin          the flag /api/admin-users gates on server-side
--   role = 'admin'    the flag every client-side check in the app reads
--                     (kept in sync with is_admin — accepting either means a
--                     lag between them cannot lock an admin out)
--   allowed_tabs      an explicit, per-user grant of the Payments tab
--
-- SELECT only. Writes stay with the service_role calls from
-- pay.jcmretails.com; nothing here lets a CRM user create or alter a payment
-- record, only read one.
--
-- Every known policy name is dropped first so re-running this file leaves
-- exactly one policy per table. RLS policies are OR-ed, so a stale one left
-- in place does not narrow anything — it quietly widens it, and the policy
-- below would read like a limit it is not actually imposing.
--
-- pay_payments_access / pay_feedback_access were hand-made in the SQL Editor
-- and are dropped here for that reason. They were PERMISSIVE and FOR ALL,
-- carrying the same is_admin / allowed_tabs test as the policy below but
-- applying it to insert, update and delete as well as select. Granting the
-- Payments tab is meant to let someone look at what came in, not edit or
-- delete the record of a payment. With those gone and only a select policy
-- left, writes fall back to RLS's default deny for authenticated users —
-- there is no insert/update/delete policy on these tables, and that absence
-- is the protection, so do not add one.
--
-- Safe for the real write path: every insert into these tables comes from
-- JCM-Pay's /api/verify-payment and /api/submit-feedback, which send
-- SUPABASE_SERVICE_KEY, and service_role bypasses RLS rather than being
-- filtered by it — no policy here has ever been what let those writes
-- through. The CRM itself only ever selects from these tables.
drop policy if exists "admins read pay_payments" on pay_payments;
drop policy if exists "pay_payments_access" on pay_payments;
drop policy if exists "payments tab reads pay_payments" on pay_payments;
create policy "payments tab reads pay_payments" on pay_payments
  for select to authenticated
  using (exists (
    select 1 from profiles p
    where p.id = auth.uid()
      and (
        coalesce(p.is_admin, false)
        or p.role = 'admin'
        or 'payments' = any(coalesce(p.allowed_tabs, '{}'::text[]))
      )
  ));

drop policy if exists "admins read pay_feedback" on pay_feedback;
drop policy if exists "pay_feedback_access" on pay_feedback;
drop policy if exists "payments tab reads pay_feedback" on pay_feedback;
create policy "payments tab reads pay_feedback" on pay_feedback
  for select to authenticated
  using (exists (
    select 1 from profiles p
    where p.id = auth.uid()
      and (
        coalesce(p.is_admin, false)
        or p.role = 'admin'
        or 'payments' = any(coalesce(p.allowed_tabs, '{}'::text[]))
      )
  ));

-- ============================================================
-- 9. Quotation form: default-locked items + bucket isolation
-- ============================================================
-- default_locked / default_discount drive the quotation form's "this item is
-- always sold at one fixed discount" behaviour: a row for such an item is added
-- already locked, carrying default_discount instead of the bucket's shared
-- discount, so the first bucket sync can't drag it onto the range's number
-- before the rep has looked at it. The rep can still unlock the row by hand,
-- after which it behaves like any other row — this only sets the STARTING state.
-- The form reads both columns defensively, so it keeps working unchanged until
-- they're actually populated.
alter table generic_items add column if not exists default_locked boolean not null default false;
alter table generic_items add column if not exists default_discount numeric;

-- generic_items.bucket is the whole scope of Colour/Discount sync in the
-- quotation form: a change on one row only ever reaches other rows in the SAME
-- bucket. It used to be limited to the two modular values below; the form now
-- creates a sync group for whatever value it finds here, so a product family
-- that isn't modular plates/accessories at all can be given its own bucket and
-- will then sync strictly within itself.
--
--   'plates'       modular cover plates       ┐ these two, and only these two,
--   'accessories'  switches, sockets, fans …  ┘ also share a Model with each other
--   anything else  its own fully isolated group
--
-- This is the fix for an MCB/DB range (Tripper and the like) sitting in
-- 'accessories': a discount typed on an MCB was being applied to every switch
-- and socket on the quotation, because they were all in one bucket. Moving them
-- to their own bucket is a data change, not a code one — e.g.:
--
--   update generic_items set bucket = 'mcb'
--    where name ilike '%mcb%' or name ilike '%rccb%' or name ilike '%isolator%'
--       or name ilike '%distribution board%';
--
-- Check what you have first, and adjust the predicate to your own naming:
--   select bucket, count(*), min(name), max(name) from generic_items group by bucket;
--   select id, name, bucket from generic_items where bucket = 'accessories' order by name;

-- ============================================================
-- 10. Refresh PostgREST's schema cache
-- ============================================================
-- Table/constraint changes made via the SQL Editor don't always show up in
-- the API immediately. This tells PostgREST to reload right away instead of
-- waiting for its next automatic refresh.
notify pgrst, 'reload schema';
