# sync-gst.js — deploy notes

Feeds the GSTR-2A Reconciliation page (hq.jcmretails.com/#gst-recon, GST section, admins).
Every 30 minutes (JCM Sync job `gst`) it copies, for the current Busy database:

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

## WhatsApp / email sent by the page

Sent through JCM's own Meta WhatsApp Cloud API (api/_wa-cloud.js, number +91 91091 05999).
Business-started messages must be approved templates, so two Utility templates are needed in
WhatsApp Manager (names overridable with GST_TPL_SUPPLIER / GST_TPL_ADMIN, language GST_TPL_LANG, default en):

- `gstr1_filing_reminder` → the supplier's `WhatsAppNo` / `Mobile` from Busy.
  Body: `Namaste {{1}}, This is J.C. Mittal & Sons, Ratlam (GSTIN {{4}}). Our GSTR-2A for {{2}} does not show the following invoice(s) of yours: {{3}}. Please check your GSTR-1 and file or amend it so that we can claim the input tax credit. Thank you.`
- `gst_missing_in_busy` → every admin's `profiles.whatsapp`.
  Body: `JCM HQ — GSTR-2A {{1}}: {{2}} invoice(s) in the GST portal are NOT entered in Busy (total {{3}}). Please get these bills to the accountant: {{4}}` + URL button "Open in HQ" → https://hq.jcmretails.com/#gst-recon

Template parameters cannot contain line breaks, so invoice lists are one line, "; " separated,
cut at about 900 characters ("and N more"). The admin list also goes by email when
`RESEND_API_KEY` is set (to every admin's `profiles.email` plus `GST_REPORT_EMAIL`; sender
`GST_EMAIL_FROM`, default `JCM HQ <onboarding@resend.dev>`).
