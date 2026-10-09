# sync-purchases.js — deploy notes

Feeds the Purchase Summary page (hq.jcmretails.com/#purchases) and its WhatsApps.
Every run it copies this financial year's purchase bills (Busy voucher type 2) into the
JCM-Busysql Supabase project, then calls `POST https://hq.jcmretails.com/api/purchases`
`{ action: 'notify' }` with the Busy service key, and HQ sends:

- one WhatsApp per new purchase bill (to people ticked "Every bill"), and
- the evening summary once a day, after the time set on the page (people ticked "Evening summary").

Bills typed in more than 2 days before they reach HQ are never sent one by one (so a first
run or a long server outage cannot flood anyone). `--as-history` loads everything without
sending at all.

## What it reads from Busy

| Field | From |
|---|---|
| Bill no., bill date, party | `Tran1` (VchType 2, not cancelled), `Master1` |
| Entered at / by / computer | `CheckList` Type 2 Action 1, first row |
| Edits (count, last time, last user) | `CheckList` Type 2 Action 2 |
| Bill total (GST included) | party's posting on the bill: `Tran2` RecType 1, MasterCode1 = party; falls back to the last `CheckList.D3` |
| Item lines | `Tran2` RecType 2: `D1` qty, `D2` rate as typed (GST included), `D6` rate before GST, `Value3` amount before GST |

Line amount shown = qty × rate (GST included). If a bill has a discount, the items total can
be a little higher than the bill total; the page shows both.

## Tables (JCM-Busysql)

`purchase_vouchers`, `purchase_lines`, `purchase_notify_people`, `purchase_settings`,
`purchase_notify_log` — created by `supabase/purchases-setup.sql`. RLS on, no policies.

## Install / update on JCM-Server

1. Copy `sync-purchases.js` and `run-purchases.bat` into `D:\JCM-Supabase\files`, beside `sync.js`.
   Same `.env`, same `node_modules`. Needs Node.js 18 or newer for the WhatsApp step.
2. `cd /d D:\JCM-Supabase\files` then `node sync-purchases.js --check` — shows the 3 latest
   bills, writes nothing. Compare with Busy.
3. `node sync-purchases.js --as-history` — loads the year without sending any WhatsApp.
4. Task Scheduler task "JCM Purchases": `run-purchases.bat` every 15 minutes, all day,
   "Do not start a new instance".

## WhatsApp

Uses the same Whatshub360 settings as Red Alerts and Payment Follow-up (`WHATSHUB_SEND_URL`,
`WHATSHUB_VID` in Vercel). Numbers come from Manage Users (profiles.whatsapp).
