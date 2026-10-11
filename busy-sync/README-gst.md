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

Supplier reminders ("you have not filed invoice …") go to the party's `WhatsAppNo` / `Mobile`
in Busy through Whatshub360 (`WHATSHUB_SEND_URL` / `WHATSHUB_VID` in Vercel, same as the
other modules). The "missing in Busy" list goes to every admin's `profiles.whatsapp` and, when
`RESEND_API_KEY` is set, by email to every admin's `profiles.email` (plus `GST_REPORT_EMAIL` if
set; sender `GST_EMAIL_FROM`, default `JCM HQ <onboarding@resend.dev>`).
