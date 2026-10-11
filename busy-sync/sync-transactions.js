// sync-transactions.js — queue a WhatsApp to the customer / supplier for every new Busy voucher
// (JCM HQ, 2026-10-12). Runs every 5 minutes from JCM Sync (job 'transactions').
//
// What it does
//   1. Reads vouchers typed into Busy in the last LOOKBACK_HOURS (CheckList Action 1 = first save):
//        9 Sales (invoice)  14 Receipt  18 Credit note  17 Debit note  19 Payment  2 Purchase  12 Sales order
//      with party name + mobile / WhatsApp no. (Master1 + MasterAddressInfo), amount and item count.
//   2. Writes each one ONCE to wa_outbox in Supabase (JCM-Busysql project; unique on db + vch_code).
//        Invoices wait until INVOICE_AT (20:30 India time) that day — one message after the material has
//        gone, so nobody rings up asking to change the bill (Shishir). Entered after 20:30 → next evening.
//        Everything else goes at the next run (send_after = now).
//      A voucher cancelled / deleted in Busy before its message went out is marked 'cancelled'.
//   3. Asks HQ to send what is due: POST https://hq.jcmretails.com/api/whatsapp { action: 'tick' } with the
//      Busy service key. HQ picks the Meta template per kind, sends, and marks each row sent / failed.
//
//   node sync-transactions.js            normal run
//   node sync-transactions.js --check    read Busy and print what would be queued; writes nothing
//   node sync-transactions.js --as-history   first run: queue everything as 'skipped' so old vouchers
//                                            never get a message
//
// Needs the same .env as the other scripts (BUSY_SERVER, BUSY_USER, BUSY_PASSWORD, SUPABASE_URL,
// SUPABASE_SERVICE_KEY) and the wa_outbox table (SQL in the HQ chat / docs/whatsapp-templates.md).

require('dotenv').config();
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const CHECK = process.argv.includes('--check');
const AS_HISTORY = process.argv.includes('--as-history');
const HQ_URL = (process.env.HQ_URL || 'https://hq.jcmretails.com').replace(/\/+$/, '');
const LOOKBACK_HOURS = 48;
const INVOICE_AT = process.env.INVOICE_WHATSAPP_AT || '20:30'; // India time

const KINDS = { 9: 'invoice', 14: 'receipt', 18: 'credit_note', 17: 'debit_note', 19: 'payment', 2: 'purchase', 12: 'order' };
const TYPES = Object.keys(KINDS).map(Number);

const LOG_FILE = path.join(__dirname, 'transactions.log');
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) { /* logging must never stop the sync */ }
}

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
const DB = SQL_CONFIG.database;

const txt = s => (s == null ? null : String(s).trim() || null);
const r2 = n => (n == null || Number.isNaN(Number(n)) ? null : Math.round(Number(n) * 100) / 100);
// Busy's CheckList times are India wall-clock times.
const ist = s => (s ? `${s}+05:30` : null);

// 20:30 India time on the voucher's entry day, as an ISO instant; next day if already past.
function invoiceSendAfter(enteredIso) {
  const entered = new Date(enteredIso || Date.now());
  const [h, m] = INVOICE_AT.split(':').map(Number);
  const istMs = entered.getTime() + 5.5 * 3600e3;
  const day = new Date(istMs).toISOString().slice(0, 10);
  let at = new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`);
  if (at.getTime() <= entered.getTime()) at = new Date(at.getTime() + 86400e3);
  return at.toISOString();
}

async function readVouchers(pool) {
  const r = await pool.request().query(`
    WITH entered AS (
      SELECT Code, UserName, ActionTime,
             ROW_NUMBER() OVER (PARTITION BY Code ORDER BY ActionTime) AS rn
      FROM CheckList WHERE Type = 2 AND Action = 1
        AND ActionTime >= DATEADD(HOUR, -${LOOKBACK_HOURS}, GETDATE())
    ),
    partyside AS (
      SELECT t2.VchCode, SUM(ABS(t2.Value1)) AS Amt
      FROM Tran2 t2 JOIN Tran1 t1 ON t1.VchCode = t2.VchCode
      WHERE t1.VchType IN (${TYPES.join(',')}) AND t2.RecType = 1 AND t2.MasterCode1 = t1.MasterCode1
      GROUP BY t2.VchCode
    ),
    items AS (
      SELECT VchCode, COUNT(*) AS n FROM Tran2 WHERE RecType = 2 GROUP BY VchCode
    )
    SELECT t1.VchCode, t1.VchType, LTRIM(RTRIM(t1.VchNo)) AS VchNo,
           CONVERT(VARCHAR(10), t1.[Date], 23) AS VchDate,
           t1.MasterCode1 AS PartyCode, p.Name AS PartyName,
           a.Mobile, a.WhatsAppNo,
           ISNULL(ps.Amt, 0) AS Amount,
           ISNULL(i.n, 0) AS Items,
           ISNULL(t1.Cancelled, 0) AS Cancelled, ISNULL(t1.VchCancelled, 0) AS VchCancelled,
           e.UserName AS EnteredBy, CONVERT(VARCHAR(19), e.ActionTime, 126) AS EnteredAt
    FROM entered e
    JOIN Tran1 t1 ON t1.VchCode = e.Code
    LEFT JOIN Master1 p ON p.Code = t1.MasterCode1
    LEFT JOIN MasterAddressInfo a ON a.MasterCode = t1.MasterCode1
    LEFT JOIN partyside ps ON ps.VchCode = t1.VchCode
    LEFT JOIN items i ON i.VchCode = t1.VchCode
    WHERE e.rn = 1 AND t1.VchType IN (${TYPES.join(',')})`);
  return r.recordset;
}

function toRow(v) {
  const kind = KINDS[v.VchType];
  const enteredAt = ist(v.EnteredAt);
  const cancelled = Number(v.Cancelled) === 1 || Number(v.VchCancelled) === 1;
  return {
    db: DB,
    vch_code: Number(v.VchCode),
    kind,
    vch_no: txt(v.VchNo),
    vch_date: v.VchDate,
    party_code: String(v.PartyCode),
    party_name: txt(v.PartyName),
    mobile: txt(v.WhatsAppNo) || txt(v.Mobile),
    amount: r2(v.Amount),
    items: Number(v.Items) || 0,
    entered_by: txt(v.EnteredBy),
    entered_at: enteredAt,
    send_after: kind === 'invoice' ? invoiceSendAfter(enteredAt) : new Date().toISOString(),
    status: AS_HISTORY ? 'skipped' : cancelled ? 'cancelled' : 'queued',
    cancelled,
  };
}

async function main() {
  log(`start${CHECK ? ' (check only)' : ''}${AS_HISTORY ? ' (as history — nothing will be sent)' : ''} — ${DB}`);
  const pool = await sql.connect(SQL_CONFIG);
  const vouchers = await readVouchers(pool);
  await pool.close();
  const rows = vouchers.map(toRow);
  const by = {};
  for (const r of rows) by[r.kind] = (by[r.kind] || 0) + 1;
  log(`${rows.length} vouchers in the last ${LOOKBACK_HOURS} h: ${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  if (CHECK) {
    for (const r of rows.slice(0, 30)) console.log(`${r.kind} ${r.vch_no} ${r.vch_date} ${r.party_name} ₹${r.amount} → ${r.mobile || 'NO NUMBER'} after ${r.send_after}${r.cancelled ? ' CANCELLED' : ''}`);
    return;
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  // Safety: the very first run (empty outbox) loads everything as history, so vouchers typed in
  // before this was switched on never get a message — the same as --as-history.
  const probe = await supabase.from('wa_outbox').select('id', { count: 'exact', head: true });
  if (probe.error) { log(`wa_outbox not found — run the WhatsApp SQL in Supabase first (${probe.error.message})`); return; }
  const firstRun = (probe.count || 0) === 0;
  if (firstRun && !AS_HISTORY) { log('first run: outbox is empty — loading these vouchers as history, nothing will be sent'); for (const r of rows) r.status = 'skipped'; }

  // Only brand-new vouchers are inserted (ignoreDuplicates): a row already there keeps its status.
  let added = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200).map(({ cancelled, ...r }) => r);
    const { data, error } = await supabase.from('wa_outbox').upsert(part, { onConflict: 'db,vch_code', ignoreDuplicates: true }).select('vch_code');
    if (error) { log(`outbox write failed: ${error.message}`); return; }
    added += (data || []).length;
  }
  // Cancelled in Busy before the message went → never send it.
  const cancelledCodes = rows.filter(r => r.cancelled).map(r => r.vch_code);
  if (cancelledCodes.length) {
    const { error } = await supabase.from('wa_outbox').update({ status: 'cancelled' }).eq('db', DB).eq('status', 'queued').in('vch_code', cancelledCodes);
    if (error) log(`cancel mark failed: ${error.message}`);
  }
  log(`${added} new queued${cancelledCodes.length ? `, ${cancelledCodes.length} cancelled in Busy` : ''}`);
  if (AS_HISTORY || firstRun) return;

  // Ask HQ to send whatever is due now (it checks this key is the Busy service key).
  if (typeof fetch !== 'function') { log('send step skipped: this Node.js is too old to call HQ (needs Node 18+)'); return; }
  try {
    const res = await fetch(`${HQ_URL}/api/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` },
      body: JSON.stringify({ action: 'tick' }),
    });
    log(`HQ tick: ${res.status} ${(await res.text()).slice(0, 300)}`);
  } catch (err) {
    log(`HQ tick failed (will try again next run): ${err.message || err}`);
  }
}

main().catch(err => { log(`FAILED: ${err.message || err}`); process.exit(1); });
