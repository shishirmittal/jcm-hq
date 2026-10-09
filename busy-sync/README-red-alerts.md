# sync-red-alerts.js — deploy notes

Feeds the Red Alerts page (hq.jcmretails.com/#red-alerts). Every run it reads
Busy and adds any new alerts to the JCM-Busysql Supabase project:

- **Deletions**: every row of Busy's `DeletedInfo` (items, accounts, vouchers,
  groups, units), with who deleted it (`DeletedBy`), when, which computer and
  the voucher amount.
- **₹0 billing**: every sales-invoice product line (`Tran2`, `VchType` 9,
  `RecType` 2) whose amount `Value3` is 0, including quantity-0 lines, except
  items on the gift list (`red_alert_skip_items`).

Each alert has a unique `alert_key`, so a run never adds the same alert twice
and never touches one someone has already marked Seen / OK.

The very first run (empty `red_alerts`) loads everything already in this
financial year as history, marked OK, so the page starts clean.

## Tables (JCM-Busysql → SQL Editor, already created 2026-10-10)

`red_alerts`, `red_alert_skip_items`, `busy_user_names`. All three have RLS on
and no policies: only the service key (this script, and `api/red-alerts.js`
in HQ) can read or write them.

## Install on JCM-Server

1. Copy `sync-red-alerts.js` and `run-red-alerts.bat` into `D:\JCM-Supabase\files`,
   beside `sync.js`. Same `.env` (`BUSY_SERVER`, `BUSY_DATABASE`, `BUSY_USER`,
   `BUSY_PASSWORD`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`), same `node_modules`.
2. Test once by hand:
   ```
   cd /d D:\JCM-Supabase\files
   node sync-red-alerts.js
   ```
   It prints one line and appends it to `red-alerts.log`.
3. Task Scheduler: run `run-red-alerts.bat` every 15 minutes, all day, with
   **"Do not start a new instance"** if one is already running.

## Busy type numbers seen in DeletedInfo

`Type` 1 = master, 2 = voucher. Masters (`VchMastType`): 1 account group,
2 account, 5 item group, 6 item, 8 unit. Vouchers: 2 purchase, 3 sales return,
9 sales invoice, 14 receipt, 15 contra, 16 unknown (many with blank numbers),
19 payment, 26 quotation.
