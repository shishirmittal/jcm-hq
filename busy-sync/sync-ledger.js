// sync-ledger.js
// Copies this financial year's ledger entries of every customer from Busy (SQL Server on
// JCM-Server) into Supabase (JCM-Busysql project, table party_ledger), for the Ledger
// section of the Customer Card in JCM HQ (hq.jcmretails.com/#customers).
//
// One row per posting on a customer's account (Busy Tran2, RecType 1): sales bills,
// receipts, credit / debit notes, journals, sales returns … Cancelled vouchers, orders,
// quotations and challans are left out. Busy is only READ; nothing in Busy changes.
//
// Every run rewrites the year's rows (upsert) and then removes rows of vouchers that
// have since been deleted or cancelled in Busy, so the table always matches Busy.
//
//   node sync-ledger.js           normal run
//   node sync-ledger.js --check   read Busy, print what would be sent, write NOTHING
//
// Lives in D:\JCM-Supabase\files beside sync.js and uses the same .env and node_modules:
//   BUSY_SERVER, BUSY_DATABASE, BUSY_USER, BUSY_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Writes ledger.log in the same folder. Needs supabase/ledger-setup.sql run once.

require('dotenv').config();
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const CHECK = process.argv.includes('--check');
const LOG_FILE = path.join(__dirname, 'ledger.log');
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) { /* logging must never stop the sync */ }
}

// Same names as sync-red-alerts.js.
const VOUCHER_TYPES = {
  2: 'Purchase', 3: 'Sales return', 9: 'Sales', 14: 'Receipt', 15: 'Contra', 16: 'Journal',
  17: 'Debit note', 18: 'Credit note', 19: 'Payment',
};
// Drafts and stock-only vouchers never post to an account.
const SKIP_TYPES = [4, 8, 10, 11, 12, 13, 26, 61];

function currentBusyDb() {
  const now = new Date();
  const fyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
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
const SQL_CONFIG = {
  ...parseServer(process.env.BUSY_SERVER),
  database: process.env.BUSY_DATABASE || currentBusyDb(),
  user: process.env.BUSY_USER,
  password: process.env.BUSY_PASSWORD,
  options: { trustServerCertificate: true, enableArithAbort: true },
  requestTimeout: 300000,
};

async function customerCodes(supabase) {
  const codes = new Set();
  for (let from = 0; from < 200000; from += 1000) {
    const { data, error } = await supabase.from('customers').select('party_code').range(from, from + 999);
    if (error) throw new Error(`reading customers: ${error.message}`);
    for (const r of data) if (r.party_code != null) codes.add(Number(r.party_code));
    if (data.length < 1000) break;
  }
  return codes;
}

async function main() {
  const started = new Date().toISOString();
  log(`start${CHECK ? ' (check only, nothing is written)' : ''} — database ${SQL_CONFIG.database}`);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const codes = await customerCodes(supabase);
  log(`${codes.size} customers in Supabase`);

  const pool = await sql.connect(SQL_CONFIG);
  const r = await pool.request().query(`
    SELECT t2.VchCode, t2.SrNo, t2.MasterCode1 AS Party, t2.Value1 AS Amount,
           t1.VchType, t1.VchNo, CONVERT(VARCHAR(10), t1.[Date], 23) AS VchDate
    FROM Tran2 t2
    JOIN Tran1 t1 ON t1.VchCode = t2.VchCode
    WHERE t2.RecType = 1
      AND ISNULL(t1.Cancelled, 0) = 0 AND ISNULL(t1.VchCancelled, 0) = 0
      AND t1.VchType NOT IN (${SKIP_TYPES.join(',')})`);
  await pool.close();
  const rows = r.recordset.filter(x => codes.has(Number(x.Party)) && Number(x.Amount));
  log(`${r.recordset.length} account postings read, ${rows.length} on customer accounts`);

  // Which way round Busy stores Dr / Cr: on a sales bill the customer is debited.
  const salesSum = rows.filter(x => x.VchType === 9).reduce((s, x) => s + Number(x.Amount), 0);
  const drPositive = salesSum >= 0;
  log(`sales bills on customer accounts add up to ${Math.round(salesSum)} → debit is ${drPositive ? 'positive' : 'negative'} in Busy`);

  const out = rows.map(x => {
    const v = Number(x.Amount) * (drPositive ? 1 : -1);
    return {
      party_code: String(x.Party), vch_code: x.VchCode, sr_no: x.SrNo ?? 0,
      vch_type: x.VchType, vch_type_name: VOUCHER_TYPES[x.VchType] || `Voucher type ${x.VchType}`,
      vch_no: x.VchNo ? String(x.VchNo).trim() : null, vch_date: x.VchDate,
      debit: v > 0 ? Math.round(v * 100) / 100 : 0, credit: v < 0 ? Math.round(-v * 100) / 100 : 0,
      synced_at: started,
    };
  });

  const byType = {};
  for (const x of out) byType[x.vch_type_name] = (byType[x.vch_type_name] || 0) + 1;
  log(`entries by type: ${Object.entries(byType).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);

  if (!out.length) {
    log('nothing read from Busy — stopping without changing Supabase');
    return;
  }

  if (CHECK) {
    const counts = {};
    for (const x of out) counts[x.party_code] = (counts[x.party_code] || 0) + 1;
    const busiest = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (busiest) {
      const mine = out.filter(x => x.party_code === busiest).sort((a, b) => a.vch_date.localeCompare(b.vch_date));
      const net = mine.reduce((s, x) => s + x.debit - x.credit, 0);
      log(`sample — customer code ${busiest}, ${mine.length} entries, this year's debits minus credits ${Math.round(net)}; last 10:`);
      for (const x of mine.slice(-10)) log(`  ${x.vch_date}  ${x.vch_type_name.padEnd(12)} ${String(x.vch_no || '').padEnd(14)} Dr ${String(x.debit).padStart(10)}  Cr ${String(x.credit).padStart(10)}`);
    }
    log('check done — nothing was written');
    return;
  }

  for (let i = 0; i < out.length; i += 1000) {
    const { error } = await supabase.from('party_ledger').upsert(out.slice(i, i + 1000), { onConflict: 'party_code,vch_code,sr_no' });
    if (error) throw new Error(`writing party_ledger: ${error.message}`);
  }
  // Vouchers deleted or cancelled in Busy since the last run.
  const { error: delErr, count } = await supabase.from('party_ledger').delete({ count: 'exact' }).lt('synced_at', started);
  if (delErr) throw new Error(`removing old rows: ${delErr.message}`);
  log(`done — ${out.length} entries saved, ${count || 0} old entries removed`);
}

main().catch(err => { log(`FAILED: ${err.message}`); process.exit(1); });
