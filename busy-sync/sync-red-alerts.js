// sync-red-alerts.js
// Reads Busy (SQL Server on JCM-Server) and adds new Red Alerts to Supabase (JCM-Busysql project),
// shown on the Red Alerts page in JCM HQ (hq.jcmretails.com/#red-alerts).
//
// What it looks for (alert_type in brackets):
//   1. Deletions (deleted_item / deleted_account / deleted_voucher / deleted_other)
//        every row of Busy's DeletedInfo, with who, when, which computer and the voucher amount.
//   2. ₹0 billing on sales invoices (VchType 9, product lines, amount Value3 = 0):
//        zero_rate  quantity sold but nothing charged
//        zero_qty   a line with quantity 0
//      Items on the gift list (red_alert_skip_items) are skipped.
//   3. Below purchase cost (below_cost): a sales line whose price per piece before GST
//        (|Value3| / |qty|) is lower than the item's average purchase cost this financial
//        year (total Value3 / total qty over purchase bills, VchType 2). Both sides exclude GST.
//        Parties on red_alert_skip_parties (billed below cost on purpose) are skipped for this check only.
//   4. Bill edits (modified / old_bill_edited): every "modified" entry in Busy's audit log
//        (CheckList Type 2, Action 2) with who, when, which computer, the amount and quantity
//        before and after, and whether the bill had already been printed (Tran12).
//        An edit to a sales-side bill made BACKDATE_DAYS or more after its own date is old_bill_edited.
//   5. Backdated entry (backdated): a sales-side bill (sales, sales return, credit note, sales challan)
//        typed in BACKDATE_DAYS or more after the date it carries (CheckList Action 1 time vs Tran1.Date).
//   Quotations, sales orders and purchase orders are drafts by nature, so edits and backdating on
//   them are not flagged.
//
// Safe to run as often as you like: every alert has a unique key, so nothing is added twice,
// and an alert someone has already reviewed is never touched again.
//
//   node sync-red-alerts.js                normal run: anything new arrives as 'new'
//   node sync-red-alerts.js --as-history   load everything found as already reviewed ('ok')
//
// Lives in D:\JCM-Supabase\files beside sync.js and uses the same .env and node_modules:
//   BUSY_SERVER (e.g. localhost,1433), BUSY_DATABASE, BUSY_USER, BUSY_PASSWORD,
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
// Writes red-alerts.log in the same folder.

require('dotenv').config();
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const BACKDATE_DAYS = 2;              // "typed in / edited this many days after the bill date" counts as backdated
const DRAFT_VCH_TYPES = [12, 13, 26]; // sales order, purchase order, quotation: not checked for edits/backdating
// Backdating only matters on the sales side: purchase bills carry the supplier's date and receipts,
// payments and journals are routinely typed in later from statements. Edits to other bills still show
// as plain 'modified'.
const SALES_SIDE_VCH_TYPES = [9, 3, 18, 11]; // sales invoice, sales return, credit note, sales challan
const AS_HISTORY = process.argv.includes('--as-history');

const LOG_FILE = path.join(__dirname, 'red-alerts.log');
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) { /* logging must never stop the sync */ }
}

// Busy keeps one database per financial year (FY 2026-27 -> BusyComp0001_db12026).
// BUSY_DATABASE from .env wins, exactly like sync.js; this is only the fallback.
function currentBusyDb() {
  const now = new Date();
  const fyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1; // April = month 3
  return `BusyComp0001_db1${fyStart}`;
}

function parseServer(raw) {
  const value = String(raw || 'localhost');
  if (value.includes(',')) {
    const [host, port] = value.split(',');
    return { server: host.trim(), port: parseInt(port.trim(), 10) };
  }
  return { server: value.trim() };
}

const CONFIG = {
  sql: {
    ...parseServer(process.env.BUSY_SERVER),
    database: process.env.BUSY_DATABASE || currentBusyDb(),
    user: process.env.BUSY_USER,
    password: process.env.BUSY_PASSWORD,
    options: { trustServerCertificate: true, enableArithAbort: true },
    requestTimeout: 300000,
  },
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_KEY,
};
const DB = CONFIG.sql.database;

// ---------- LABELS ----------
const MASTER_TYPES = {
  1: 'Account group', 2: 'Account', 5: 'Item group', 6: 'Item', 8: 'Unit',
};
const VOUCHER_TYPES = {
  2: 'Purchase', 3: 'Sales return', 4: 'Material receipt', 8: 'Stock journal', 9: 'Sales invoice',
  10: 'Purchase challan', 11: 'Sales challan', 12: 'Sales order', 13: 'Purchase order', 14: 'Receipt',
  15: 'Contra', 16: 'Journal', 17: 'Debit note', 18: 'Credit note', 19: 'Payment', 26: 'Quotation',
  61: 'Physical stock',
};
const vchLabel = (t) => VOUCHER_TYPES[t] || `Voucher type ${t}`;

// Busy stores local (IST) times with no time zone. Turn "2026-10-08T00:02:24" into a proper IST time.
const ist = (s) => (s ? `${s}+05:30` : null);
const user = (u) => (u == null ? null : String(u).trim() || null);
const round2 = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);
const vchTitle = (no, code) => (no && String(no).trim()) || `Bill #${code}`;

// Who first saved each bill, from Busy's audit log. Used by the bill-line checks so a ₹0 or
// below-cost line says who billed it. Built once per run as a SQL fragment.
const CREATOR_CTE = `
  creator AS (
    SELECT Code, UserName, ComputerName, ActionTime,
           ROW_NUMBER() OVER (PARTITION BY Code ORDER BY ActionTime) AS rn
    FROM CheckList WHERE Type = 2 AND Action = 1
  )`;

// ---------- 1. DELETIONS ----------
async function readDeletions(pool) {
  const r = await pool.request().query(`
    SELECT Type, VchMastType, [Identity] AS Ident, DeletedBy,
           CONVERT(VARCHAR(19), DeletionTime, 126) AS DeletedAt,
           OrgVchAmtBaseCur, ModVchAmtBaseCur, ComputerName,
           -- Several deletions can share the same name/number and the same second
           -- (e.g. blank-numbered vouchers removed together). Number them so each
           -- one gets its own alert; the first keeps the plain key.
           ROW_NUMBER() OVER (PARTITION BY Type, VchMastType, [Identity], CONVERT(VARCHAR(19), DeletionTime, 126)
                              ORDER BY OrgVchAmtBaseCur, ModVchAmtBaseCur, ComputerName, DeletedBy) AS Occurrence
    FROM DeletedInfo`);

  return r.recordset.map((d) => {
    const isVoucher = d.Type === 2;
    let alertType, title, subtitle, details;

    if (isVoucher) {
      const [series, vchNo, vchDate] = String(d.Ident || '').split('\u00FF'); // Busy separates with 'ÿ'
      alertType = 'deleted_voucher';
      subtitle = vchLabel(d.VchMastType);
      title = (vchNo && vchNo.trim()) || `(no number) ${series || ''}`.trim();
      details = { series, vch_no: vchNo, vch_date: vchDate, vch_type: d.VchMastType,
                  original_amount: d.OrgVchAmtBaseCur, final_amount: d.ModVchAmtBaseCur };
    } else {
      alertType = d.VchMastType === 6 ? 'deleted_item'
                : d.VchMastType === 2 ? 'deleted_account'
                : 'deleted_other';
      subtitle = MASTER_TYPES[d.VchMastType] || `Master type ${d.VchMastType}`;
      title = String(d.Ident || '').trim();
      details = { master_type: d.VchMastType };
    }

    return {
      alert_key: `del|${d.Type}|${d.VchMastType}|${d.Ident}|${d.DeletedAt}${d.Occurrence > 1 ? `|${d.Occurrence}` : ''}`,
      alert_type: alertType,
      happened_at: ist(d.DeletedAt),
      title,
      subtitle,
      amount: isVoucher ? d.ModVchAmtBaseCur : null,
      qty: null,
      busy_user: user(d.DeletedBy),
      computer_name: d.ComputerName,
      details,
    };
  });
}

// ---------- 2 + 3. SALES LINES: ₹0 BILLING AND BELOW PURCHASE COST ----------
async function readSalesLines(pool, skipNames, skipCostParties) {
  const r = await pool.request().query(`
    WITH ${CREATOR_CTE},
    cost AS (
      SELECT MasterCode1 AS ItemCode,
             SUM(Value3) / NULLIF(SUM(D1), 0) AS AvgCost,
             SUM(D1) AS PurchasedQty
      FROM Tran2
      WHERE VchType = 2 AND RecType = 2 AND D1 > 0 AND Value3 > 0
      GROUP BY MasterCode1
    )
    SELECT t2.VchCode, t2.SrNo, LTRIM(RTRIM(t2.VchNo)) AS VchNo,
           CONVERT(VARCHAR(10), t2.Date, 126) AS BillDate,
           t2.MasterCode1 AS ItemCode, m.Name AS ItemName,
           t2.D1 AS Qty, t2.D2 AS Rate, t2.Value3 AS Amount,
           p.Name AS PartyName,
           c.UserName AS CreatedBy, c.ComputerName,
           CONVERT(VARCHAR(19), c.ActionTime, 126) AS CreatedAt,
           k.AvgCost, k.PurchasedQty,
           CASE WHEN ABS(t2.Value3) < 0.01 THEN 'zero'
                ELSE 'below' END AS Kind
    FROM Tran2 t2
    JOIN Tran1 t1 ON t1.VchCode = t2.VchCode
    LEFT JOIN Master1 m ON m.Code = t2.MasterCode1
    LEFT JOIN Master1 p ON p.Code = t1.MasterCode1
    LEFT JOIN creator c ON c.Code = t2.VchCode AND c.rn = 1
    LEFT JOIN cost k ON k.ItemCode = t2.MasterCode1
    WHERE t2.VchType = 9 AND t2.RecType = 2
      AND (
        ABS(t2.Value3) < 0.01
        -- NULLIF, not just the D1 <> 0 test: SQL Server may evaluate the division first.
        OR (t2.D1 <> 0 AND k.AvgCost IS NOT NULL
            AND ABS(t2.Value3) / NULLIF(ABS(t2.D1), 0) < k.AvgCost - 0.005)
      )`);

  const skip = new Set(skipNames.map((n) => n.trim().toLowerCase()));
  // Parties billed below cost on purpose (red_alert_skip_parties): only the below-cost check is skipped.
  const skipParty = new Set(skipCostParties.map((n) => n.trim().toLowerCase()));
  const zero = [];
  const below = [];

  for (const z of r.recordset) {
    const base = {
      happened_at: ist(z.CreatedAt) || ist(`${z.BillDate}T00:00:00`),
      title: z.VchNo,
      subtitle: z.ItemName,
      busy_user: user(z.CreatedBy),
      computer_name: z.ComputerName || null,
    };
    const common = {
      vch_code: z.VchCode, line_no: z.SrNo, item_code: z.ItemCode, party: z.PartyName || null,
      bill_date: z.BillDate, rate: z.Rate, qty_raw: z.Qty,
    };

    if (z.Kind === 'zero') {
      if (skip.has(String(z.ItemName || '').trim().toLowerCase())) continue;
      const qty0 = Math.abs(Number(z.Qty || 0)) < 0.0001;
      zero.push({
        ...base,
        // VchCode restarts in each financial-year database, so the database name is part of the key.
        alert_key: `zero|${DB}|${z.VchCode}|${z.SrNo}`,
        alert_type: qty0 ? 'zero_qty' : 'zero_rate',
        amount: 0,
        qty: z.Qty == null ? null : Math.abs(z.Qty),
        details: common,
      });
    } else {
      if (skipParty.has(String(z.PartyName || '').trim().toLowerCase())) continue;
      const qty = Math.abs(Number(z.Qty));
      const saleUnit = Math.abs(Number(z.Amount)) / qty;
      const cost = Number(z.AvgCost);
      below.push({
        ...base,
        alert_key: `below|${DB}|${z.VchCode}|${z.SrNo}`,
        alert_type: 'below_cost',
        amount: round2(Math.abs(z.Amount)),
        qty,
        details: {
          ...common,
          sale_unit: round2(saleUnit),
          avg_cost: round2(cost),
          loss: round2((cost - saleUnit) * qty),
          below_pct: round2(((cost - saleUnit) / cost) * 100),
          purchased_qty: z.PurchasedQty,
        },
      });
    }
  }
  return { zero, below };
}

// ---------- 4 + 5. BILL EDITS AND BACKDATED ENTRIES (Busy's audit log) ----------
async function readAudit(pool) {
  const drafts = DRAFT_VCH_TYPES.join(',');
  const r = await pool.request().query(`
    WITH log AS (
      SELECT Code, Action, UserName, ComputerName, ActionTime, D1 AS Qty, D3 AS Amount,
             LAG(D1) OVER (PARTITION BY Code ORDER BY ActionTime, Action) AS PrevQty,
             LAG(D3) OVER (PARTITION BY Code ORDER BY ActionTime, Action) AS PrevAmount,
             ROW_NUMBER() OVER (PARTITION BY Code, Action ORDER BY ActionTime) AS NthOfAction,
             ROW_NUMBER() OVER (PARTITION BY Code, CONVERT(VARCHAR(19), ActionTime, 126), Action
                                ORDER BY D3, D1, UserName) AS Occurrence
      FROM CheckList WHERE Type = 2
    ),
    printed AS (
      SELECT VchCode, MIN(Date) AS FirstPrint FROM Tran12 GROUP BY VchCode
    )
    SELECT l.Code, l.Action, l.UserName, l.ComputerName,
           CONVERT(VARCHAR(19), l.ActionTime, 126) AS ActionAt,
           l.Qty, l.Amount, l.PrevQty, l.PrevAmount, l.NthOfAction, l.Occurrence,
           t1.VchType, LTRIM(RTRIM(t1.VchNo)) AS VchNo,
           CONVERT(VARCHAR(10), t1.Date, 126) AS BillDate,
           DATEDIFF(day, t1.Date, l.ActionTime) AS DaysAfterBill,
           p.Name AS PartyName,
           CONVERT(VARCHAR(19), pr.FirstPrint, 126) AS FirstPrintAt,
           CASE WHEN pr.FirstPrint IS NOT NULL AND pr.FirstPrint < l.ActionTime THEN 1 ELSE 0 END AS AfterPrint
    FROM log l
    LEFT JOIN Tran1 t1 ON t1.VchCode = l.Code
    LEFT JOIN Master1 p ON p.Code = t1.MasterCode1
    LEFT JOIN printed pr ON pr.VchCode = l.Code
    WHERE (t1.VchType IS NULL OR t1.VchType NOT IN (${drafts}))
      AND (
        l.Action = 2
        OR (l.Action = 1 AND l.NthOfAction = 1 AND t1.Date IS NOT NULL
            AND t1.VchType IN (${SALES_SIDE_VCH_TYPES.join(',')})
            AND DATEDIFF(day, t1.Date, l.ActionTime) >= ${BACKDATE_DAYS})
      )`);

  const out = [];
  for (const a of r.recordset) {
    const title = vchTitle(a.VchNo, a.Code);
    const subtitle = a.VchType ? vchLabel(a.VchType) : 'Bill (since deleted)';
    const common = {
      vch_code: a.Code, vch_type: a.VchType, party: a.PartyName || null, bill_date: a.BillDate,
      days_after_bill: a.DaysAfterBill,
    };

    if (a.Action === 1) {
      out.push({
        alert_key: `back|${DB}|${a.Code}`,
        alert_type: 'backdated',
        happened_at: ist(a.ActionAt),
        title, subtitle,
        amount: round2(a.Amount),
        qty: a.Qty,
        busy_user: user(a.UserName),
        computer_name: a.ComputerName,
        details: common,
      });
      continue;
    }

    const amountChanged = a.PrevAmount != null && Math.abs(Number(a.Amount) - Number(a.PrevAmount)) >= 0.01;
    const qtyChanged = a.PrevQty != null && Math.abs(Number(a.Qty) - Number(a.PrevQty)) >= 0.0001;
    const old = a.DaysAfterBill != null && a.DaysAfterBill >= BACKDATE_DAYS && SALES_SIDE_VCH_TYPES.includes(a.VchType);
    out.push({
      alert_key: `mod|${DB}|${a.Code}|${a.ActionAt}${a.Occurrence > 1 ? `|${a.Occurrence}` : ''}`,
      alert_type: old ? 'old_bill_edited' : 'modified',
      happened_at: ist(a.ActionAt),
      title, subtitle,
      amount: round2(a.Amount),
      qty: a.Qty,
      busy_user: user(a.UserName),
      computer_name: a.ComputerName,
      details: {
        ...common,
        amount_before: round2(a.PrevAmount),
        qty_before: a.PrevQty,
        changed: amountChanged || qtyChanged,
        amount_changed: amountChanged,
        qty_changed: qtyChanged,
        after_print: a.AfterPrint === 1,
        first_print: a.FirstPrintAt,
        edit_no: a.NthOfAction,
      },
    });
  }
  return out;
}

// ---------- MAIN ----------
async function main() {
  const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);
  const pool = await sql.connect(CONFIG.sql);

  try {
    const { data: skipRows, error: skipErr } = await supabase
      .from('red_alert_skip_items').select('item_name');
    if (skipErr) throw skipErr;
    // Optional table: if it has not been created yet, nothing is skipped.
    const { data: partyRows, error: partyErr } = await supabase
      .from('red_alert_skip_parties').select('party_name');
    if (partyErr) log(`note: red_alert_skip_parties not readable (${partyErr.message}) - no parties skipped`);

    const { count: before, error: cntErr } = await supabase
      .from('red_alerts').select('id', { count: 'exact', head: true });
    if (cntErr) throw cntErr;

    const deletions = await readDeletions(pool);
    const { zero, below } = await readSalesLines(pool, (skipRows || []).map((s) => s.item_name),
      (partyRows || []).map((p) => p.party_name));
    const audit = await readAudit(pool);
    let rows = [...deletions, ...zero, ...below, ...audit];

    if (AS_HISTORY) {
      rows = rows.map((r) => ({
        ...r, status: 'ok', reviewed_by: 'setup', reviewed_at: new Date().toISOString(),
        review_note: 'History - loaded as already reviewed',
      }));
    }

    // Insert in batches; existing alerts (same alert_key) are skipped, never overwritten
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await supabase
        .from('red_alerts')
        .upsert(batch, { onConflict: 'alert_key', ignoreDuplicates: true });
      if (error) throw error;
    }

    const { count: after } = await supabase
      .from('red_alerts').select('id', { count: 'exact', head: true });
    const added = (after || 0) - (before || 0);

    const n = (t) => audit.filter((a) => a.alert_type === t).length;
    log(`DB ${DB} | deleted ${deletions.length}, zero-rate ${zero.filter((z) => z.alert_type === 'zero_rate').length}, ` +
      `zero-qty ${zero.filter((z) => z.alert_type === 'zero_qty').length}, below-cost ${below.length}, ` +
      `edited ${n('modified')}, old-bill-edited ${n('old_bill_edited')}, backdated ${n('backdated')} | ` +
      `checked ${rows.length}, NEW alerts added: ${added}${AS_HISTORY ? ' (as history)' : ''}`);
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  log(`FAILED: ${err.message || err}`);
  process.exit(1);
});
