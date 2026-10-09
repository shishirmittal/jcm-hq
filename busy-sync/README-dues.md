# Dues sync (party_dues) — JCM-Server

HQ's Payment Follow-up (#payment-followup) shows `party_dues.outstanding_balance` from the
JCM-Busysql project. That table is written by `sync-dues-final.js` in `D:\JCM-Supabase\files`
(Outstanding = anchor balance 31-03-2026 − this FY's movements). It had stopped on 23 Aug 2026
because it was never scheduled and it reads `BUSY_SQL_PASSWORD`, which is not in `.env`.

Files here (copy beside `sync-dues-final.js`):
- `dues-env.js` — loads `.env`, copies `BUSY_PASSWORD` → `BUSY_SQL_PASSWORD`, `BUSY_USER` → `BUSY_SQL_USER`.
- `run-dues.bat` — `node -r ./dues-env.js sync-dues-final.js`.

Task Scheduler task "JCM Dues": `run-dues.bat` every 30 minutes, all day, "Do not start a new instance".

Note: the script has the Busy database name fixed (`BusyComp0001_db12026`); it needs changing at the
start of the next financial year.
