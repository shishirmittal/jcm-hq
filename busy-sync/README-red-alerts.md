# sync-red-alerts.js — deploy notes

Feeds the Red Alerts page (hq.jcmretails.com/#red-alerts). Every run it reads
Busy and adds any new alerts to the JCM-Busysql Supabase project:

| alert_type | What | From |
|---|---|---|
| deleted_voucher / deleted_item / deleted_account / deleted_other | anything deleted, with who, when, computer, voucher amount | `DeletedInfo` |
| zero_rate | sales line with a quantity but ₹0 amount | `Tran2` VchType 9, RecType 2, Value3 = 0 |
| zero_qty | sales line with quantity 0 | same |
| below_cost | sales line priced (before GST, abs(Value3) / abs(qty)) below the item's average purchase cost this FY (SUM Value3 / SUM qty over purchase bills, VchType 2) | `Tran2` |
| modified | every bill edit, with amount and quantity before → after, and whether it was already printed | `CheckList` Type 2 Action 2, `Tran12` print log |
| old_bill_edited | an edit made 2+ days after the bill's own date | same |
| backdated | a bill typed in 2+ days after the date it carries | `CheckList` Action 1 time vs `Tran1.Date` |

Gift items (`red_alert_skip_items`) are skipped by the ₹0 checks. Quotations,
sales orders and purchase orders are not checked for edits or backdating.

## What we learned about Busy's tables (Oct 2026)

- `CheckList` is Busy's audit log: `Type` 1 = master, 2 = voucher; `Action` 1 = added, 2 = modified;
  `Code` = VchCode / master code; `ActionTime`, `UserName`, `ComputerName`; for vouchers `D1` = total
  qty and `D3` = bill amount at that save. About 38k rows for FY 2026-27.
- `Tran1.CreatedBy / ModifiedBy / ModificationTime` are empty and `CreationTime` holds only a time of
  day — use `CheckList` instead. `Tran1.Stamp` = number of saves.
- `Tran12` = print log (VchCode, Date with time, UserName, NoOfCopies).
- `atSyncLog` = e-invoice / GST upload log, not an edit log.
- Purchase and sales lines share a layout: rate typed GST-inclusive in `D2`, `D6` = rate before GST,
  `Value3` = line amount before GST.
- Voucher types: 2 Purchase, 3 Sales return, 4 Material receipt, 8 Stock journal, 9 Sales,
  10 Purchase challan, 11 Sales challan, 12 Sales order, 13 Purchase order, 14 Receipt, 15 Contra,
  16 Journal, 17 Debit note, 18 Credit note, 19 Payment, 26 Quotation, 61 Physical stock.

## Tables (JCM-Busysql)

`red_alerts`, `red_alert_skip_items`, `busy_user_names` — RLS on, no policies; only the service key
(this script, and `api/red-alerts.js` in HQ) can read or write them. Columns for "Ask for
explanation": red_alerts.asked_user_id / asked_name / asked_by / asked_at / question / task_id /
whatsapp_status / reply / replied_at; busy_user_names.hq_user_id / whatsapp.

## Install / update on JCM-Server

1. Copy `sync-red-alerts.js` and `run-red-alerts.bat` into `D:\JCM-Supabase\files`, beside `sync.js`.
   Same `.env` (`BUSY_SERVER`, `BUSY_DATABASE`, `BUSY_USER`, `BUSY_PASSWORD`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_KEY`), same `node_modules`.
2. Test once by hand: `cd /d D:\JCM-Supabase\files` then `node sync-red-alerts.js`.
   `node sync-red-alerts.js --as-history` loads everything found as already reviewed instead.
3. Task Scheduler task "JCM Red Alerts": `run-red-alerts.bat` every 15 minutes, all day,
   "Do not start a new instance".

## WhatsApp (Ask for explanation)

Optional. In Vercel (project jcm-hq) set `WHATSHUB_SEND_URL` = the Whatshub360 send link with
`{vid}`, `{mobile}` (10 digits; write `91{mobile}` if the country code is needed) and `{msg}` in place
of the values, and `WHATSHUB_VID` = the key. Until then questions go to the Task Board only.
