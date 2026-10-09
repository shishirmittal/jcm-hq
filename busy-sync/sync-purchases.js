// sync-purchases.js
// Copies this financial year's purchase bills (Busy voucher type 2) into Supabase
// (JCM-Busysql project) for the Purchase Summary page in JCM HQ
// (hq.jcmretails.com/#purchases), then asks HQ to send the WhatsApps for any new bill.
//
// For each bill: party, bill no. and date, when it was typed into Busy and by whom
// (Busy's audit log, CheckList), how many times it was edited, the bill total, and
// every item line with quantity, rate (GST included, as typed) and amount.
//
// Only bills that changed since the last run are written, so it is quick to run
// every 15 minutes. A bill that disappears from Busy is marked deleted, never removed.
//
//   node sync-purchases.js                normal run
//   node sync-purchases.js --check        read Busy and show the 3 latest bills; writes nothing
//   node sync-purchases.js --as-history   first run: load everything WITHOUT sending WhatsApps
//
// Lives in D:\JCM-Supabase\files beside sync.js and uses the same .env and node_modules:
//   BUSY_SERVER (e.g. localhost,1433), BUSY_DATABASE, BUSY_USER, BUSY_PASSWORD,
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
// Optional: PURCHASES_HQ_URL (default https://hq.jcmretails.com).
// Writes purchases.log in the same folder.

require('dotenv').config();
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CHECK = process.argv.includes('--check');
const AS_HISTORY = process.argv.includes('--as-history');
const HQ_URL = (process.env.PURCHASES_HQ_URL || 'https://hq.jcmretails.com').replace(/\/+$/, '');
const PURCHASE = 2; // Busy voucher type: Purchase

const LOG_FILE = path.join(__dirname, 'purchases.log');
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) { /* logging must never stop the sync */ }
}

// Busy keeps one database per financial year (FY 2026-27 -> BusyComp0001_db12026).
// BUSY_DATABASE from .env wins, exactly like sync.js; this is only the fallback.
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

// Busy stores local (IST) times with no time zone.
const ist = (s) => (s ? `${s}+05:30` : null);
const r2 = (n) => (n == null || Number.isNaN(Number(n)) ? null : Math.round(Number(n) * 100) / 100);
const r3 = (n) => (n == null || Number.isNaN(Number(n)) ? null : Math.round(Number(n) * 1000) / 1000);
const txt = (s) => (s == null ? null : String(s).trim() || null);

// ---------- READ BUSY ----------
async function readBills(pool) {
  const r = await pool.request().query(`
    WITH entered AS (
      SELECT Code, UserName, ComputerName, ActionTime,
             ROW_NUMBER() OVER (PARTITION BY Code ORDER BY ActionTime) AS rn
      FROM CheckList WHERE Type = 2 AND Action = 1
    ),
    edits AS (
      SELECT Code, UserName, ActionTime,
             COUNT(*) OVER (PARTITION BY Code) AS n,
             ROW_NUMBER() OVER (PARTITION BY Code ORDER BY ActionTime DESC) AS rn
      FROM CheckList WHERE Type = 2 AND Action = 2
    ),
    lastsave AS (
      SELECT Code, D3, ROW_NUMBER() OVER (PARTITION BY Code ORDER BY ActionTime DESC, Action DESC) AS rn
      FROM CheckList WHERE Type = 2
    ),
    partyside AS (
      SELECT t2.VchCode, SUM(t2.Value1) AS Amt
      FROM Tran2 t2 JOIN Tran1 t1 ON t1.VchCode = t2.VchCode
      WHERE t1.VchType = ${PURCHASE} AND t2.RecType = 1 AND t2.MasterCode1 = t1.MasterCode1
      GROUP BY t2.VchCode
    )
    SELECT t1.VchCode, LTRIM(RTRIM(t1.VchNo)) AS VchNo,
           CONVERT(VARCHAR(10), t1.[Date], 23) AS BillDate,
           t1.MasterCode1 AS PartyCode, p.Name AS PartyName,
           ps.Amt AS PartyAmt, ls.D3 AS SavedAmt,
           e.UserName AS EnteredBy, e.ComputerName AS EnteredComputer,
           CONVERT(VARCHAR(19), e.ActionTime, 126) AS EnteredAt,
           ISNULL(ed.n, 0) AS EditCount, ed.UserName AS EditedBy,
           CONVERT(VARCHAR(19), ed.ActionTime, 126) AS EditedAt
    FROM Tran1 t1
    LEFT JOIN Master1 p ON p.Code = t1.MasterCode1
    LEFT JOIN partyside ps ON ps.VchCode = t1.VchCode
    LEFT JOIN lastsave ls ON ls.Code = t1.VchCode AND ls.rn = 1
    LEFT JOIN entered e ON e.Code = t1.VchCode AND e.rn = 1
    LEFT JOIN edits ed ON ed.Code = t1.VchCode AND ed.rn = 1
    WHERE t1.VchType = ${PURCHASE}
      AND ISNULL(t1.Cancelled, 0) = 0 AND ISNULL(t1.VchCancelled, 0) = 0`);
  return r.recordset;
}

async function readLines(pool) {
  const r = await pool.request().query(`
    SELECT t2.VchCode, t2.SrNo, t2.MasterCode1 AS ItemCode, m.Name AS ItemName,
           t2.D1 AS Qty, t2.D2 AS Rate, t2.D6 AS RateBeforeGst, t2.Value3 AS Taxable
    FROM Tran2 t2
    JOIN Tran1 t1 ON t1.VchCode = t2.VchCode
    LEFT JOIN Master1 m ON m.Code = t2.MasterCode1
    WHERE t1.VchType = ${PURCHASE} AND t2.RecType = 2
      AND ISNULL(t1.Cancelled, 0) = 0 AND ISNULL(t1.VchCancelled, 0) = 0
    ORDER BY t2.VchCode, t2.SrNo`);
  return r.recordset;
}

function buildRows(bills, lines) {
  const linesBy = new Map();
  for (const l of lines) {
    const key = `${DB}|${l.VchCode}`;
    if (!linesBy.has(key)) linesBy.set(key, []);
    const qty = Math.abs(Number(l.Qty || 0));
    const rate = Math.abs(Number(l.Rate || 0));
    linesBy.get(key).push({
      vch_key: key,
      sr_no: l.SrNo,
      item_code: l.ItemCode == null ? null : String(l.ItemCode),
      item_name: txt(l.ItemName),
      qty: r3(qty),
      rate: r2(rate),
      rate_before_gst: r2(Math.abs(Number(l.RateBeforeGst || 0))),
      amount: r2(qty * rate),
      taxable: r2(Math.abs(Number(l.Taxable || 0))),
    });
  }

  return bills.map((b) => {
    const key = `${DB}|${b.VchCode}`;
    const ls = linesBy.get(key) || [];
    const partyAmt = b.PartyAmt == null ? 0 : Math.abs(Number(b.PartyAmt));
    const header = {
      vch_key: key,
      db_name: DB,
      vch_code: b.VchCode,
      vch_no: txt(b.VchNo),
      bill_date: b.BillDate || null,
      party_code: b.PartyCode == null ? null : String(b.PartyCode),
      party_name: txt(b.PartyName),
      bill_total: r2(partyAmt >= 0.01 ? partyAmt : Math.abs(Number(b.SavedAmt || 0))),
      items_total: r2(ls.reduce((s, l) => s + (l.amount || 0), 0)),
      taxable_total: r2(ls.reduce((s, l) => s + (l.taxable || 0), 0)),
      item_count: ls.length,
      total_qty: r3(ls.reduce((s, l) => s + (l.qty || 0), 0)),
      entered_at: ist(b.EnteredAt),
      entered_by: txt(b.EnteredBy),
      entered_computer: txt(b.EnteredComputer),
      edit_count: b.EditCount || 0,
      last_edited_at: ist(b.EditedAt),
      last_edited_by: txt(b.EditedBy),
      deleted_at: null,
    };
    const signature = crypto.createHash('md5').update(JSON.stringify([header, ls])).digest('hex');
    return { header: { ...header, signature }, lines: ls };
  });
}

// ---------- SUPABASE ----------
async function existingBills(supabase) {
  const map = new Map();
  for (let from = 0; from < 500000; from += 1000) {
    const { data, error } = await supabase.from('purchase_vouchers')
      .select('vch_key, signature, deleted_at').eq('db_name', DB).range(from, from + 999);
    if (error) throw new Error(`reading purchase_vouchers: ${error.message}`);
    for (const r of data) map.set(r.vch_key, r);
    if (data.length < 1000) break;
  }
  return map;
}

async function inBatches(list, size, fn) {
  for (let i = 0; i < list.length; i += size) await fn(list.slice(i, i + size));
}

async function main() {
  const started = new Date().toISOString();
  const pool = await sql.connect(SQL_CONFIG);
  let bills, lines;
  try {
    bills = await readBills(pool);
    lines = await readLines(pool);
  } finally {
    await pool.close();
  }
  const rows = buildRows(bills, lines);

  if (CHECK) {
    log(`CHECK ONLY — database ${DB}: ${rows.length} purchase bills, ${lines.length} item lines. Nothing written.`);
    const latest = [...rows].sort((a, b) => String(b.header.entered_at || '').localeCompare(String(a.header.entered_at || ''))).slice(0, 3);
    for (const { header: h, lines: ls } of latest) {
      console.log(`\n${h.party_name} | bill ${h.vch_no} dated ${h.bill_date} | entered ${h.entered_at} by ${h.entered_by} | edits ${h.edit_count} | bill total ${h.bill_total} | items total ${h.items_total}`);
      for (const l of ls) console.log(`   ${l.item_name} | qty ${l.qty} | rate ${l.rate} | amount ${l.amount}`);
    }
    return;
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const existing = await existingBills(supabase);

  const fresh = [];   // never seen before: inserted with a notify state
  const changed = []; // seen before, something on it changed (notify state left alone)
  for (const r of rows) {
    const old = existing.get(r.header.vch_key);
    if (!old) fresh.push(r);
    else if (old.signature !== r.header.signature || old.deleted_at) changed.push(r);
  }
  const seen = new Set(rows.map((r) => r.header.vch_key));
  const gone = [...existing.values()].filter((e) => !seen.has(e.vch_key) && !e.deleted_at).map((e) => e.vch_key);

  // Safety: if Busy suddenly returns nothing, do not mark the whole year deleted.
  if (!rows.length && existing.size) throw new Error('Busy returned no purchase bills — stopping without changing Supabase');

  const stamp = { synced_at: started };
  await inBatches(fresh, 300, async (batch) => {
    const payload = batch.map((r) => ({
      ...r.header, ...stamp, signature: null, // set below, once the item lines are saved
      notify_state: AS_HISTORY ? 'skipped' : 'pending',
    }));
    const { error } = await supabase.from('purchase_vouchers').upsert(payload, { onConflict: 'vch_key' });
    if (error) throw new Error(`saving new bills: ${error.message}`);
  });
  await inBatches(changed, 300, async (batch) => {
    const payload = batch.map((r) => ({ ...r.header, ...stamp, signature: null }));
    const { error } = await supabase.from('purchase_vouchers').upsert(payload, { onConflict: 'vch_key' });
    if (error) throw new Error(`saving changed bills: ${error.message}`);
  });

  // Item lines: replace them for every bill written this run.
  const touched = [...fresh, ...changed];
  await inBatches(touched, 200, async (batch) => {
    const keys = batch.map((r) => r.header.vch_key);
    const del = await supabase.from('purchase_lines').delete().in('vch_key', keys);
    if (del.error) throw new Error(`clearing item lines: ${del.error.message}`);
    const ls = batch.flatMap((r) => r.lines);
    for (let i = 0; i < ls.length; i += 1000) {
      const { error } = await supabase.from('purchase_lines').insert(ls.slice(i, i + 1000));
      if (error) throw new Error(`saving item lines: ${error.message}`);
    }
    // Only now is the bill complete: store its fingerprint so the next run skips it.
    // If anything above failed, the empty fingerprint makes the next run redo it.
    // Full row (not just the fingerprint): an upsert with missing required columns is refused.
    const sigs = batch.map((r) => ({ ...r.header, ...stamp }));
    const { error: sigErr } = await supabase.from('purchase_vouchers').upsert(sigs, { onConflict: 'vch_key' });
    if (sigErr) throw new Error(`saving fingerprints: ${sigErr.message}`);
  });

  await inBatches(gone, 300, async (keys) => {
    const { error } = await supabase.from('purchase_vouchers').update({ deleted_at: started }).in('vch_key', keys);
    if (error) throw new Error(`marking deleted bills: ${error.message}`);
  });

  const note = `${rows.length} bills in ${DB}; new ${fresh.length}, changed ${changed.length}, deleted ${gone.length}${AS_HISTORY ? ' (loaded as history, no WhatsApp)' : ''}`;
  await supabase.from('purchase_settings').upsert({ id: 1, last_sync_at: new Date().toISOString(), last_sync_note: note }, { onConflict: 'id' });
  log(note);

  // Ask HQ to send the WhatsApps (new bills, and the evening summary when it is due).
  // HQ checks this key is the Busy project's service key before doing anything.
  if (AS_HISTORY) return;
  if (typeof fetch !== 'function') { log('WhatsApp step skipped: this Node.js is too old to call HQ (needs Node 18 or newer)'); return; }
  try {
    const res = await fetch(`${HQ_URL}/api/purchases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` },
      body: JSON.stringify({ action: 'notify' }),
    });
    const text = (await res.text()).slice(0, 300);
    log(`HQ notify: ${res.status} ${text}`);
  } catch (err) {
    log(`HQ notify failed (will try again next run): ${err.message || err}`);
  }
}

main().catch((err) => {
  log(`FAILED: ${err.message || err}`);
  process.exit(1);
});
