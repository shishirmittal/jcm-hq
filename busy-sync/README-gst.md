# sync-gst.js — deploy notes

Feeds the GSTR-2A Reconciliation page (hq.jcmretails.com/#gst-recon, GST section, admins).
Once a month — the 5th at 06:00 (JCM Sync job `gst`, `monthlyOn`), or "Run now" on HQ → Admin → Sync status — it copies, for the current Busy database:

| Busy | Supabase (JCM-Busysql) | What |
|---|---|---|
| `GSTR2AInfo` (one row per tax rate) | `gst_2a_rows` (one row per invoice / note) | the 2A data Busy downloaded: supplier GSTIN, invoice no. and date, taxable, CGST/SGST/IGST, which GSTR-1 it came in (`filed_period`), when the supplier filed, when Busy pulled it (`pulled_at`) |
| `Tran1` VchType 2 + `VchGSTSumItemWise` | `gst_purchase_rows` | every purchase voucher with party GSTIN, taxable, CGST/SGST/IGST (IGST = TaxAmt where TaxRate1 is 0), total (`VchAmtBaseCur`; 0 = FOC / scheme document) |
| `Master1` type 2 + `MasterAddressInfo` | `gst_parties` | mobile / WhatsApp / email of parties that have a GSTIN |

The matching (missing in Busy, not in 2A, amount mismatch, doc-no mismatch, sequence, ₹0)
is done by HQ (`api/gst.js`), not here. **Busy's own download button is not pressed by
anything** — someone opens Busy → GST → Miscellaneous Utilities → Download GSTR JSON Data
each month (around the 14th); the page shows when the newest download happened.

## Install on JCM-Server

1. Run `supabase/gst-setup.sql` once in the JCM-Busysql project (SQL Editor).
2. Copy `sync-gst.js` into `D:\JCM-Supabase\files` (same `.env`, same `node_modules`).
3. `cd /d D:\JCM-Supabase\files` then `node sync-gst.js --check` — prints counts and 3 sample
   rows, writes nothing.
4. Copy the new `jcm-sync.js` (it has the `gst` job) and restart JCM Sync (or run
   `node jcm-sync.js --once gst` to load everything now). Status: HQ → Admin → Sync status.

## WhatsApp sent by the page

Through JCM's own Meta WhatsApp Cloud API (api/_wa-cloud.js, number +91 91091 05999).
Business-started messages must be approved templates, so two **Utility** templates are needed
in WhatsApp Manager (names overridable with GST_TPL_SUPPLIER / GST_TPL_STAFF, language
GST_TPL_LANG, default `en`):

1. `gstr1_filing_reminder` → the supplier's `WhatsAppNo` / `Mobile` from Busy.
   Header: **Image** (sample: any 1200×628 PNG; live = `https://hq.jcmretails.com/api/gst?banner=2026-08`,
   the "GST MISMATCH / AUGUST 2026" banner drawn by api/_gst-report.js).
   Body (line breaks as shown; {{3}} is a one-line numbered list — Meta forbids line breaks inside a value):
   ```
   Namaste, {{1}},

   This is J.C. Mittal & Sons, Ratlam (GSTIN 23AAPFJ0607D1ZT).
   Our GSTR-2A for {{2}} does not show the following invoice(s) of yours:

   {{3}}

   Please check your GSTR-1 and file or amend it so that we can claim the input tax credit. Thank you.

   Awaiting your reply in the next 3 working days on this.
   ```
2. `gst_mismatch_summary` → chosen HQ people (`profiles.whatsapp`), from "Send to staff".
   Header: **Document** (PDF; live = the summary PDF saved in Supabase Storage bucket
   `gst-reports`, public, created by supabase/gst-setup.sql).
   Body: `{{1}} has sent the GSTR-2A mismatch summary for {{2}} — see the attached PDF. Please go through every item and clear all of them within 2 days, by {{3}}. Reply here if anything is unclear.`

Template parameters cannot contain line breaks, so invoice lists are one line, "; " separated,
cut at about 900 characters ("and N more"). Every send is logged in `gst_log`.
