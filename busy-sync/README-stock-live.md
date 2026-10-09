# sync-stock-live.js — deploy notes

Refreshes only the stock columns on `items`, every 10 minutes during business
hours. The nightly `sync.js` is unchanged and still owns everything else:
names, prices, categories, sales history, invoices, customers, and the
`stock_source` label.

## 1. Run this SQL in Supabase (JCM-Busysql project → SQL Editor)

```sql
-- Lets the stock job's log rows be told apart from the nightly's. The default
-- means every row already in the table counts as 'nightly', which is what
-- they are, so nothing that reads this table has to change at the same time.
alter table sync_log add column if not exists job text not null default 'nightly';
```

## 2. Run this SQL in SQL Server Management Studio, on JCM-Server

Only if you want the stock query to stay cheap — see "The index" below.

```sql
-- Covering index for the stock lookup: seeks straight to godown 201, returns
-- rows already ordered by item and date (so no sort), and carries D1/D3/D4
-- with it (so no lookups back into the table).
CREATE NONCLUSTERED INDEX IX_DailySum_Godown_Item_Date
    ON DailySum (MasterCode2, MasterCode1, [Date] DESC)
    INCLUDE (D1, D3, D4);
```

Reversible at any time with:

```sql
DROP INDEX IX_DailySum_Godown_Item_Date ON DailySum;
```

## 3. Copy the files

Put `sync-stock-live.js` and `run-stock-live.bat` in `D:\JCM-Supabase\files`,
beside `sync.js`. They use the same `.env` and the same `node_modules`, so
there is nothing else to install.

The script runs from that folder, not from this repo — so a change made here
does nothing until `sync-stock-live.js` is copied over again. Copying it is
the whole of an update; there is no build step and no package to reinstall.

## 4. Test it once by hand

```
cd /d D:\JCM-Supabase\files
node sync-stock-live.js
```

It writes `sync-stock-live.log` in the same folder. The first run updates
every item whose stock has moved since the last nightly; later runs usually
write only a handful.

## 5. Schedule it

See the step-by-step Task Scheduler instructions in the chat. The two settings
that matter: **"Do not start a new instance"** if one is already running, and a
repeat window that covers business hours only.

## Useful queries

Which tiebreaker column the script found (it logs this on every run). If it
reports no identity column, this says what the table actually has:

```sql
SELECT c.name, t.name AS type, c.is_identity, c.is_nullable
FROM sys.columns c
JOIN sys.types t ON t.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID('DailySum')
ORDER BY c.column_id;
```

How big DailySum actually is, and how much of it is godown 201:

```sql
SELECT COUNT(*) AS all_rows,
       SUM(CASE WHEN MasterCode2 = 201 THEN 1 ELSE 0 END) AS godown_201_rows
FROM DailySum;
```
