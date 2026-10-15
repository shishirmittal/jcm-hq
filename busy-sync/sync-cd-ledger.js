// sync-cd-ledger.js
// Copies this financial year's ledger entries of every SIGNIFY account from Busy (SQL Server
// on JCM-Server) into Supabase (JCM-Busysql project, table cd_ledger), for the Signify Cash
// Discount page in JCM HQ (hq.jcmretails.com/#cash-discount).
//
// Which accounts: every ledger account (Master1, MasterType 2) whose name contains the
// word(s) in cd_settings.name_match ("signify") and not the word(s) in cd_settings.name_exclude
// ("prof" — the Professional-division accounts are outside the scheme). Change those words
// on the page, not here.
//
// One row per posting on such an account (Busy Tran2, RecType 1): purchase bills, payments,
// debit / credit notes, journals … Cancelled vouchers, orders, quotations and challans are
// left out. Busy is only READ; nothing in Busy changes.
//
// Every run rewrites the year's rows (upsert) and then removes rows of vouchers that have
// since been deleted or cancelled in Busy, so the table always matches Busy. Also keeps
// cd_accounts (the list of accounts found) and cd_settings.last_sync_at up to date.
//
//   node sync-cd-ledger.js           normal run
//   node sync-cd-ledger.js --check   read Busy, print what would be sent, write NOTHING
//
// Lives in D:\JCM-Supabase\files beside sync.js and uses the same .env and node_modules:
//   BUSY_SERVER, BUSY_DATABASE, BUSY_USER, BUSY_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Writes cd-ledger.log in the same folder. Needs supabase/cash-discount-setup.sql run once.
// Started by JCM Sync (jcm-sync.js, job `cd-ledger`, every 30 min).

require('dotenv').config();
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const CHECK = process.argv.includes('--check');
const LOG_FILE = path.join(__dirname, 'cd-ledger.log');
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) { /* logging must never stop the sync */ }
}

// Same names as sync-ledger.js / sync-red-alerts.js.
const VOUCHER_TYPES = {
  2: 'Purchase', 3: 'Sales return', 5: 'Purchase return', 9: 'Sales', 14: 'Receipt', 15: 'Contra', 16: 'Journal',
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

const words = s => String(s || '').split(/[,\s]+/).map(w => w.trim().toLowerCase()).filter(Boolean);

async function main() {
  const started = new Date().toISOString();
  log(`start${CHECK ? ' (check only, nothing is written)' : ''} — database ${SQL_CONFIG.database}`);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: settingsRow, error: sErr } = await supabase.from('cd_settings').select('*').eq('id', 1).maybeSingle();
  if (sErr) throw new Error(`reading cd_settings: ${sErr.message} — is supabase/cash-discount-setup.sql run?`);
  const include = words(settingsRow?.name_match || 'signify');
  const exclude = words(settingsRow?.name_exclude || 'prof');
  log(`accounts whose name has: ${include.join(' or ')}${exclude.length ? ` — and not: ${exclude.join(', ')}` : ''}`);

  const pool = await sql.connect(SQL_CONFIG);
  const m = await pool.request().query(`SELECT Code, Name FROM Master1 WHERE MasterType = 2`);
  const accounts = m.recordset.filter(a => {
    const n = String(a.Name || '').toLowerCase();
    return include.some(w => n.includes(w)) && !exclude.some(w => n.includes(w));
  });
  const names = new Map(accounts.map(a => [Number(a.Code), String(a.Name).trim()]));
  log(`${names.size} accounts match`);
  for (const [c, n] of names) log(`  ${c}  ${n}`);
  if (!names.size) { await pool.close(); log('no matching account — stopping without changing Supabase'); return; }

  const codeList = [...names.keys()].join(',');
  const r = await pool.request().query(`
    SELECT t2.VchCode, t2.SrNo, t2.MasterCode1 AS Party, t2.Value1 AS Amount,
           t1.VchType, t1.VchNo, CONVERT(VARCHAR(10), t1.[Date], 23) AS VchDate
    FROM Tran2 t2
    JOIN Tran1 t1 ON t1.VchCode = t2.VchCode
    WHERE t2.RecType = 1
      AND t2.MasterCode1 IN (${codeList})
      AND ISNULL(t1.Cancelled, 0) = 0 AND ISNULL(t1.VchCancelled, 0) = 0
      AND t1.VchType NOT IN (${SKIP_TYPES.join(',')})`);
  await pool.close();
  const rows = r.recordset.filter(x => Number(x.Amount));
  log(`${rows.length} postings read`);

  // Which way round Busy stores Dr / Cr: on a purchase bill the supplier is CREDITED, so
  // if purchases add up to a negative number, debit is the positive side (same answer
  // sync-ledger.js gets from sales bills). No purchases → assume debit positive.
  const purSum = rows.filter(x => x.VchType === 2).reduce((s, x) => s + Number(x.Amount), 0);
  const drPositive = purSum <= 0;
  log(`purchase bills add up to ${Math.round(purSum)} → debit is ${drPositive ? 'positive' : 'negative'} in Busy`);

  const out = rows.map(x => {
    const v = Number(x.Amount) * (drPositive ? 1 : -1);
    return {
      party_code: String(x.Party), party_name: names.get(Number(x.Party)) || null,
      vch_code: x.VchCode, sr_no: x.SrNo ?? 0,
      vch_type: x.VchType, vch_type_name: VOUCHER_TYPES[x.VchType] || `Voucher type ${x.VchType}`,
      vch_no: x.VchNo ? String(x.VchNo).trim() : null, vch_date: x.VchDate,
      debit: v > 0 ? Math.round(v * 100) / 100 : 0, credit: v < 0 ? Math.round(-v * 100) / 100 : 0,
      synced_at: started,
    };
  });

  const byType = {};
  for (const x of out) byType[x.vch_type_name] = (byType[x.vch_type_name] || 0) + 1;
  log(`entries by type: ${Object.entries(byType).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);

  if (CHECK) {
    const counts = {};
    for (const x of out) counts[x.party_code] = (counts[x.party_code] || 0) + 1;
    const busiest = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (busiest) {
      const mine = out.filter(x => x.party_code === busiest).sort((a, b) => a.vch_date.localeCompare(b.vch_date) || a.vch_code - b.vch_code);
      const dr = mine.reduce((s, x) => s + x.debit, 0), cr = mine.reduce((s, x) => s + x.credit, 0);
      log('');
      log(`=== most entries: ${names.get(Number(busiest))} — Busy code ${busiest} ===`);
      log(`${mine.length} entries this year · total Dr ${Math.round(dr)} · total Cr ${Math.round(cr)} · Cr minus Dr (payable) ${Math.round(cr - dr)}`);
      log('last 12:');
      for (const x of mine.slice(-12)) log(`  ${x.vch_date}  ${x.vch_type_name.padEnd(14)} ${String(x.vch_no || '').padEnd(18)} Dr ${String(x.debit).padStart(10)}  Cr ${String(x.credit).padStart(10)}`);
    }
    log('');
    log('check done — nothing was written');
    return;
  }

  // Account list (keeps included / opening_balance an admin typed on the page).
  const accRows = [...names].map(([code, name]) => ({ party_code: String(code), party_name: name, last_synced_at: started }));
  const { error: accErr } = await supabase.from('cd_accounts').upsert(accRows, { onConflict: 'party_code' });
  if (accErr) throw new Error(`writing cd_accounts: ${accErr.message}`);

  for (let i = 0; i < out.length; i += 1000) {
    const { error } = await supabase.from('cd_ledger').upsert(out.slice(i, i + 1000), { onConflict: 'party_code,vch_code,sr_no' });
    if (error) throw new Error(`writing cd_ledger: ${error.message}`);
  }
  // Vouchers deleted or cancelled in Busy since the last run (and accounts no longer matching).
  const { error: delErr, count } = await supabase.from('cd_ledger').delete({ count: 'exact' }).lt('synced_at', started);
  if (delErr) throw new Error(`removing old rows: ${delErr.message}`);
  const note = `${out.length} entries on ${names.size} accounts`;
  await supabase.from('cd_settings').update({ last_sync_at: started, last_sync_note: note }).eq('id', 1);
  log(`done — ${note} saved, ${count || 0} old entries removed`);
}

main().catch(err => { log(`FAILED: ${err.message}`); process.exit(1); });
