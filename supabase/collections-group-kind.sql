-- Payment Follow-up — Dealer / Retail type for each account group (2026-10-12).
-- Run in the JCM-Busysql project (jlkjjqnmhsgefpluemyz): Supabase → SQL Editor →
-- New query → paste → Run. Safe to run more than once. Only ADDS a column.
-- 'dealer' (default) = reminders show total outstanding + overdue.
-- 'retail' = reminders show one amount due (always fully overdue).
alter table collection_group_owners add column if not exists kind text not null default 'dealer';
notify pgrst, 'reload schema';
select kind, count(*) from collection_group_owners group by kind;
