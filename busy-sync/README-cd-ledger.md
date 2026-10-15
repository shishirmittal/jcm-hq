# sync-cd-ledger.js — deploy notes

Feeds the **Signify Cash Discount** page (hq.jcmretails.com/#cash-discount, admins only).
Reads Busy only. Writes `cd_ledger`, `cd_accounts` and `cd_settings` in the JCM-Busysql Supabase project
(tables created 2026-10-15 by migration `cash_discount_setup`; copy in `supabase/cash-discount-setup.sql`).
Until it runs, the page opens but says the Signify ledger has not been copied yet.

## Steps (once)

1. **JCM-Server**: copy `sync-cd-ledger.js` into `D:\JCM-Supabase\files`, beside `sync.js`.
2. Command Prompt in that folder: `node sync-cd-ledger.js --check`.
   Writes nothing. Prints the Signify accounts it found and the last 12 entries of the busiest one —
   compare with that account's ledger in Busy (Dr / Cr on the same sides).
3. `node sync-cd-ledger.js` — the first real run.
4. Add the job to `jcm-sync.js` on the server (JOBS list, after the `ledger` line):
   ```js
   { id: 'cd-ledger', name: 'Signify ledger (Cash Discount)', args: ['sync-cd-ledger.js'], every: 30, timeout: 10 },
   ```
   then create an empty file `jcm-sync.restart` in the folder so JCM Sync restarts with the new job.
   It then shows on HQ → Admin → Sync status with a Run now button.

## What it does

- Finds every ledger account whose name has "signify" and not "prof" (words set in `cd_settings`; the page lets an admin change them).
- Copies every posting on those accounts this financial year (Tran2 RecType 1 joined to Tran1): purchase bills, payments, debit / credit notes, journals. Cancelled vouchers, orders, quotations and challans left out.
- Works out the debit side by itself (purchase bills credit the supplier).
- Each run saves everything again, then removes entries of vouchers deleted or cancelled in Busy.
- Opening balance at 1 April comes from `party_anchor_balance` (Busy's 31 March figure) unless an admin types one on the page.
- Log file: `cd-ledger.log`.
