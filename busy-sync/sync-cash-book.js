// sync-cash-book.js
// Fast copy of the counter cash account's entries (Cash (Retail), Busy code from
// cash_settings.account_code in Supabase) for the Cash Drawer page in JCM HQ
// (hq.jcmretails.com/#cash-drawer). Runs every 5 minutes from JCM Sync (job 'cash-book').
//
// The full customer ledger (sync-ledger.js) runs only every 30 minutes and takes ~4 minutes,
// so a cash receipt typed in Busy could take 35 minutes to show at the counter. This reads
// only the cash account, only the last 3 days, and writes the same rows into the same table
// (party_ledger, same key party_code + vch_code + sr_no, same Dr/Cr rule) — the two scripts
// never disagree, they just arrive at different speeds. Busy is only READ.
//
//   node sync-cash-book.js           normal run
//   node sync-cash-book.js --check   read Busy, print what would be sent, write NOTHING
//
// Lives in D:\JCM-Supabase\files beside sync-ledger.js, same .env and node_modules.

require('dotenv').config();
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');

const CHECK = process.argv.includes('--check');
const DAYS_BACK = 2; // today + 2 earlier days (catches a back-dated entry or one made after midnight)

const VOUCHER_TYPES = {
  2: 'Purchase', 3: 'Sales return', 9: 'Sales', 14: 'Receipt', 15: 'Contra', 16: 'Journal',
  17: 'Debit note', 18: 'Credit note', 19: 'Payment',
};
const SKIP_TYPES = [4, 8, 10, 11, 12, 13, 26, 61];

function log(message) { console.log(`[${new Date().toISOString()}] ${message}`); }
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
  requestTimeout: 60000,
};
const istDay = (offsetDays = 0) => new Date(Date.now() + 5.5 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);

async function main() {
  const started = new Date().toISOString();
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: s, error: sErr } = await supabase.from('cash_settings').select('account_code').eq('id', 1).maybeSingle();
  if (sErr) throw new Error(`reading cash_settings: ${sErr.message}`);
  const code = Number(s?.account_code || 56680);
  const from = istDay(-DAYS_BACK), to = istDay(0);

  const pool = await sql.connect(SQL_CONFIG);
  const req = pool.request();
  req.input('code', sql.Int, code);
  req.input('from', sql.VarChar(10), from);
  req.input('to', sql.VarChar(10), to);
  const r = await req.query(`
    SELECT t2.VchCode, t2.SrNo, t2.Value1 AS Amount,
           t1.VchType, t1.VchNo, CONVERT(VARCHAR(10), t1.[Date], 23) AS VchDate
    FROM Tran2 t2
    JOIN Tran1 t1 ON t1.VchCode = t2.VchCode
    WHERE t2.RecType = 1 AND t2.MasterCode1 = @code
      AND t1.[Date] >= @from AND t1.[Date] < DATEADD(day, 1, CAST(@to AS date))
      AND ISNULL(t1.Cancelled, 0) = 0 AND ISNULL(t1.VchCancelled, 0) = 0
      AND t1.VchType NOT IN (${SKIP_TYPES.join(',')})`);
  // Which way round Busy stores Dr / Cr — a cash sale debits the cash account. Decided over the
  // whole year so a day with no sales still gets it right.
  const sign = await pool.request().input('code', sql.Int, code).query(`
    SELECT SUM(t2.Value1) AS S FROM Tran2 t2 JOIN Tran1 t1 ON t1.VchCode = t2.VchCode
    WHERE t2.RecType = 1 AND t2.MasterCode1 = @code AND t1.VchType = 9
      AND ISNULL(t1.Cancelled, 0) = 0 AND ISNULL(t1.VchCancelled, 0) = 0`);
  await pool.close();
  const drPositive = Number(sign.recordset[0]?.S || 0) >= 0;

  const out = r.recordset.filter(x => Number(x.Amount)).map(x => {
    const v = Number(x.Amount) * (drPositive ? 1 : -1);
    return {
      party_code: String(code), vch_code: x.VchCode, sr_no: x.SrNo ?? 0,
      vch_type: x.VchType, vch_type_name: VOUCHER_TYPES[x.VchType] || `Voucher type ${x.VchType}`,
      vch_no: x.VchNo ? String(x.VchNo).trim() : null, vch_date: x.VchDate,
      debit: v > 0 ? Math.round(v * 100) / 100 : 0, credit: v < 0 ? Math.round(-v * 100) / 100 : 0,
      synced_at: started,
    };
  });
  const inSum = out.reduce((s, x) => s + x.debit, 0), outSum = out.reduce((s, x) => s + x.credit, 0);
  log(`account ${code}, ${from} to ${to}: ${out.length} entries, in ${Math.round(inSum)}, out ${Math.round(outSum)}`);

  if (CHECK) {
    for (const x of out.sort((a, b) => a.vch_date.localeCompare(b.vch_date) || a.vch_code - b.vch_code)) {
      log(`  ${x.vch_date} ${x.vch_type_name.padEnd(12)} ${String(x.vch_no || '').padEnd(18)} in ${x.debit} out ${x.credit}`);
    }
    log('check done — nothing was written');
    return;
  }

  if (out.length) {
    const { error } = await supabase.from('party_ledger').upsert(out, { onConflict: 'party_code,vch_code,sr_no' });
    if (error) throw new Error(`writing party_ledger: ${error.message}`);
  }
  // Entries in these days that are no longer in Busy (deleted, cancelled, moved to another account / date).
  const { error: delErr, count } = await supabase.from('party_ledger').delete({ count: 'exact' })
    .eq('party_code', String(code)).gte('vch_date', from).lte('vch_date', to).lt('synced_at', started);
  if (delErr) throw new Error(`removing old rows: ${delErr.message}`);
  console.log(`done — ${out.length} cash entries (${from} to ${to}) saved, ${count || 0} removed`);
}

main().catch(err => { log(`FAILED: ${err.message}`); process.exit(1); });
