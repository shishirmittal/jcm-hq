// sync-red-alerts.js
// Reads Busy (SQL Server on JCM-Server) and adds new Red Alerts to Supabase (JCM-Busysql project),
// shown on the Red Alerts page in JCM HQ (hq.jcmretails.com/#red-alerts).
//   1. Deletions   -> from DeletedInfo (items, accounts, vouchers, everything Busy logs)
//   2. Zero billing -> sales invoice lines (VchType 9, RecType 2) whose amount (Value3) is 0,
//      except items listed in red_alert_skip_items. Lines with quantity 0 ARE included.
//
// Safe to run as often as you like: every alert has a unique key, so nothing is added twice,
// and an alert someone has already marked Seen/OK is never touched again.
// FIRST RUN: if red_alerts is empty, everything already in Busy for this financial year is
// loaded as "history" (status 'ok') so the page starts clean. From the second run on,
// anything new arrives with status 'new'.
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
    requestTimeout: 120000,
  },
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_KEY,
};

// ---------- LABELS ----------
const MASTER_TYPES = {
  1: 'Account group', 2: 'Account', 5: 'Item group', 6: 'Item', 8: 'Unit',
};
const VOUCHER_TYPES = {
  2: 'Purchase', 3: 'Sales return', 9: 'Sales invoice', 14: 'Receipt',
  15: 'Contra', 16: 'Voucher type 16', 19: 'Payment', 26: 'Quotation',
};

// Busy stores local (IST) times with no time zone. Turn "2026-10-08T00:02:24" into a proper IST time.
const ist = (s) => (s ? `${s}+05:30` : null);

// ---------- 1. DELETIONS ----------
async function readDeletions(pool) {
  const r = await pool.request().query(`
    SELECT Type, VchMastType, [Identity] AS Ident, DeletedBy,
           CONVERT(VARCHAR(19), DeletionTime, 126) AS DeletedAt,
           OrgVchAmtBaseCur, ModVchAmtBaseCur, ComputerName
    FROM DeletedInfo`);

  return r.recordset.map((d) => {
    const isVoucher = d.Type === 2;
    let alertType, title, subtitle, details;

    if (isVoucher) {
      const [series, vchNo, vchDate] = String(d.Ident || '').split('\u00FF'); // Busy separates with 'ÿ'
      alertType = 'deleted_voucher';
      subtitle = VOUCHER_TYPES[d.VchMastType] || `Voucher type ${d.VchMastType}`;
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
      alert_key: `del|${d.Type}|${d.VchMastType}|${d.Ident}|${d.DeletedAt}`,
      alert_type: alertType,
      happened_at: ist(d.DeletedAt),
      title,
      subtitle,
      amount: isVoucher ? d.ModVchAmtBaseCur : null,
      qty: null,
      busy_user: d.DeletedBy == null ? null : String(d.DeletedBy).trim(),
      computer_name: d.ComputerName,
      details,
    };
  });
}

// ---------- 2. ZERO BILLING ----------
async function readZeroBilling(pool, skipNames) {
  const r = await pool.request().query(`
    SELECT t2.VchCode, t2.SrNo, LTRIM(RTRIM(t2.VchNo)) AS VchNo,
           CONVERT(VARCHAR(10), t2.Date, 126) AS BillDate,
           t2.MasterCode1 AS ItemCode, m.Name AS ItemName,
           t2.D1 AS Qty, t2.D2 AS Rate, t2.Value3 AS Amount
    FROM Tran2 t2
    LEFT JOIN Master1 m ON m.Code = t2.MasterCode1
    WHERE t2.VchType = 9 AND t2.RecType = 2 AND ABS(t2.Value3) < 0.01`);

  const skip = new Set(skipNames.map((n) => n.trim().toLowerCase()));

  return r.recordset
    .filter((z) => !skip.has(String(z.ItemName || '').trim().toLowerCase()))
    .map((z) => ({
      // VchCode restarts in each financial-year database, so the database name is part of the key.
      alert_key: `zero|${CONFIG.sql.database}|${z.VchCode}|${z.SrNo}`,
      alert_type: 'zero_billing',
      happened_at: ist(`${z.BillDate}T00:00:00`),
      title: z.VchNo,
      subtitle: z.ItemName,
      amount: 0,
      qty: z.Qty == null ? null : Math.abs(z.Qty),
      busy_user: null,
      computer_name: null,
      details: { vch_code: z.VchCode, line_no: z.SrNo, item_code: z.ItemCode,
                 rate: z.Rate, qty_raw: z.Qty },
    }));
}

// ---------- MAIN ----------
async function main() {
  const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);
  const pool = await sql.connect(CONFIG.sql);

  try {
    // Gift / skip list
    const { data: skipRows, error: skipErr } = await supabase
      .from('red_alert_skip_items').select('item_name');
    if (skipErr) throw skipErr;

    // First run? (table empty -> load everything as history)
    const { count, error: cntErr } = await supabase
      .from('red_alerts').select('id', { count: 'exact', head: true });
    if (cntErr) throw cntErr;
    const firstRun = count === 0;

    const deletions = await readDeletions(pool);
    const zeros = await readZeroBilling(pool, (skipRows || []).map((s) => s.item_name));
    let rows = [...deletions, ...zeros];

    if (firstRun) {
      rows = rows.map((r) => ({
        ...r, status: 'ok', reviewed_by: 'setup', reviewed_at: new Date().toISOString(),
        review_note: 'History - happened before Red Alerts went live',
      }));
    }

    // Insert in batches; existing alerts (same alert_key) are skipped, never overwritten
    let sent = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await supabase
        .from('red_alerts')
        .upsert(batch, { onConflict: 'alert_key', ignoreDuplicates: true });
      if (error) throw error;
      sent += batch.length;
    }

    const { count: after } = await supabase
      .from('red_alerts').select('id', { count: 'exact', head: true });
    const added = (after || 0) - (count || 0);

    log(`DB ${CONFIG.sql.database} | ` +
      `deletions found: ${deletions.length}, zero-value lines found: ${zeros.length}, ` +
      `checked: ${sent}, NEW alerts added: ${added}${firstRun ? ' (first run - loaded as history)' : ''}`);
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  log(`FAILED: ${err.message || err}`);
  process.exit(1);
});
