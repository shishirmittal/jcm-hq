# Email Purchase Summary — sync-email-purchases.js

Brand invoices that arrive by email (Gmail jcmretails@gmail.com) → Supabase (Busy project) →
JCM HQ page **#email-purchases** (Purchase & Stock → Email Purchases).

## What it does every 15 minutes (JCM Sync job `email-purchases`)
1. Logs into Gmail over IMAP (app password in `.env`: `GMAIL_USER`, `GMAIL_APP_PASSWORD`),
   lists mails since the last run (2-day overlap; first run from `email_bill_settings.scan_from`).
2. Keeps mails from `email_bill_senders` (editable in HQ → Email Purchases → Brands & mails).
   Subjects that are plainly not invoices (despatch details, order acknowledgements, sales/purchase
   orders, ageing) are skipped by `SKIP_SUBJECT`.
3. Sends the PDF attachments + mail text to Claude (`ANTHROPIC_API_KEY` in `.env`, model
   `claude-sonnet-5-5`, tool `record_documents`) → invoices / credit notes / debit notes with
   items (qty, pre-GST rate, GST %, amount) and totals.
4. Writes `email_scan_mails` (one row per mail, status done / no_invoice / skipped / failed —
   failed mails are read again next run), `email_bills` + `email_bill_lines`, and the PDF to the
   private Storage bucket `email-bills`. Duplicates = same brand + same document number.
   `received_at` = when the mail came in (for brand turnaround later).

## Commands (Command Prompt, `cd /d D:\JCM-Supabase\files`)
- `node sync-email-purchases.js --check --days 14` — list what it would read; writes nothing.
- `node sync-email-purchases.js --as-history --limit 100 --days 16` — first load (no WhatsApps).
- `node sync-email-purchases.js` — normal run (what JCM Sync does).
- Needs `npm install imapflow mailparser` once (done 2026-10-15).

## Not built yet
- WhatsApp per new invoice mail + evening summary (notify_state is kept 'pending' for it).
- Hotmail account (only one or two brands send there).
- Excel attachments are not opened (L&K's list is read from the mail table instead).
