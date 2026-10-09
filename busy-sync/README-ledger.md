# sync-ledger.js — deploy notes

Feeds the **Ledger** section of the Customer Card (hq.jcmretails.com/#customers).
Reads Busy only. Writes one new table, `party_ledger`, in the JCM-Busysql Supabase project.
Until it runs, the Customer Card still works: it shows bills, outstanding and ageing, and says the ledger is not in HQ yet.

## Steps (once)

1. **Supabase** → JCM-Busysql project → SQL Editor → New query → paste `supabase/ledger-setup.sql` → Run.
2. **JCM-Server**: copy `sync-ledger.js` and `run-ledger.bat` into `D:\JCM-Supabase\files`, beside `sync.js`.
3. Command Prompt in that folder: `node sync-ledger.js --check`.
   This writes nothing. It prints:
   - how many entries it found, grouped by type;
   - the last 10 entries of your busiest customer.
   Compare those 10 entries with that customer's ledger in Busy. Debit and credit should be on the same sides.
4. If the entries match: `node sync-ledger.js` (the first real run).
5. Task Scheduler task "JCM Ledger": `run-ledger.bat` every 30 minutes, all day, "Do not start a new instance".

## What it does

- Copies every posting on a customer's account in this financial year's Busy database: sales, receipts, returns, credit/debit notes, journals and payments.
  - Source rows: Tran2 RecType 1, joined to Tran1.
  - Left out: cancelled vouchers, orders, quotations and challans.
- Works out the debit side by itself: on sales bills the customer is debited.
- Each run saves everything again, then removes entries of vouchers that were deleted or cancelled in Busy since the last run.
- If Busy returns nothing, it stops without changing Supabase.
- The Customer Card works out the running balance backwards from today's outstanding (`party_dues`).
- Log file: `ledger.log`, in the same folder.
