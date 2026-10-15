// sync-quotations.js (2026-10-15)
// Copies this financial year's QUOTATION vouchers (Busy voucher type 26, series QT/2627/…) into
// Supabase (JCM-Busysql project) for the "From Busy" tab on JCM HQ → Quotations, so a quotation
// typed in Busy can be viewed in HQ, opened as a PDF and sent to the customer on WhatsApp.
//
// For each quotation: party (ledger name + the Billing Details name/mobile on the voucher, if any),
// date, narration, total, and every item line with qty, rate, discount, GST and amount — the same
// line fields the purchase sync reads, so the figures match Busy.
//
// Only quotations that changed since the last run are written (fingerprint), so it is quick every
// 10 minutes. A quotation that disappears from Busy is marked deleted, never removed.
//
//   node sync-quotations.js            normal run
//   node sync-quotations.js --check    read Busy and show the 3 latest quotations; writes nothing
//
// Lives in D:\JCM-Supabase\files beside sync.js and uses the same .env and node_modules:
//   BUSY_SERVER, BUSY_DATABASE, BUSY_USER, BUSY_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Optional: QUOTATION_VCH_TYPE (default 26 — found 2026-10-15: 316 vouchers numbered QT/2627/…).
// Run by the JCM Sync runner (jcm-sync.js, job `quotations`). Writes quotations.log in the folder.

require('dotenv').config();
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CHECK = process.argv.includes('--check');
const QUOTE = parseInt(process.env.QUOTATION_VCH_TYPE || '26', 10);

const LOG_FILE = path.join(__dirname, 'quotations.log');
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

const ist = (s) => (s ? `${s}+05:30` : null);
const r2 = (n) => (n == null || Number.isNaN(Number(n)) ? null : Math.round(Number(n) * 100) / 100);
const r3 = (n) => (n == null || Number.isNaN(Number(n)) ? null : Math.round(Number(n) * 1000) / 1000);
const txt = (s) => (s == null ? null : String(s).trim() || null);

// ---------- READ BUSY ----------
async function readQuotes(pool) {
  const r = await pool.request().query(`
    WITH entered AS (
      SELECT Code, UserName, ActionTime, ROW_NUMBER() OVER (PARTITION BY Code ORDER BY ActionTime) AS rn
      FROM CheckList WHERE Type = ${QUOTE} AND Action = 1
    ),
    edits AS (
      SELECT Code, ActionTime, ROW_NUMBER() OVER (PARTITION BY Code ORDER BY ActionTime DESC) AS rn
      FROM CheckList WHERE Type = ${QUOTE} AND Action = 2
    ),
    lastsave AS (
      SELECT Code, D3, ROW_NUMBER() OVER (PARTITION BY Code ORDER BY ActionTime DESC, Action DESC) AS rn
      FROM CheckList WHERE Type = ${QUOTE}
    ),
    partyside AS (
      SELECT t2.VchCode, SUM(ABS(t2.Value1)) AS Amt
      FROM Tran2 t2 JOIN Tran1 t1 ON t1.VchCode = t2.VchCode
      WHERE t1.VchType = ${QUOTE} AND t2.RecType = 1 AND t2.MasterCode1 = t1.MasterCode1
      GROUP BY t2.VchCode
    )
    SELECT t1.VchCode, LTRIM(RTRIM(t1.VchNo)) AS VchNo,
           CONVERT(VARCHAR(10), t1.[Date], 23) AS QuoteDate,
           t1.MasterCode1 AS PartyCode, p.Name AS PartyName,
           a.Mobile, a.WhatsAppNo, a.Station AS City,
           bd.PartyName AS BilledName, bd.MobileNo AS BilledMobile,
           t1.Narration,
           ps.Amt AS PartyAmt, ls.D3 AS SavedAmt,
           ISNULL(t1.Cancelled, 0) AS Cancelled, ISNULL(t1.VchCancelled, 0) AS VchCancelled,
           e.UserName AS EnteredBy, CONVERT(VARCHAR(19), e.ActionTime, 126) AS EnteredAt,
           CONVERT(VARCHAR(19), ed.ActionTime, 126) AS EditedAt
    FROM Tran1 t1
    LEFT JOIN Master1 p ON p.Code = t1.MasterCode1
    LEFT JOIN MasterAddressInfo a ON a.MasterCode = t1.MasterCode1
    OUTER APPLY (SELECT TOP 1 PartyName, MobileNo FROM BillingDet WHERE VchCode = t1.VchCode) bd
    LEFT JOIN partyside ps ON ps.VchCode = t1.VchCode
    LEFT JOIN lastsave ls ON ls.Code = t1.VchCode AND ls.rn = 1
    LEFT JOIN entered e ON e.Code = t1.VchCode AND e.rn = 1
    LEFT JOIN edits ed ON ed.Code = t1.VchCode AND ed.rn = 1
    WHERE t1.VchType = ${QUOTE}`);
  return r.recordset;
}

async function readLines(pool) {
  // Quotations are not stock vouchers, so the item rows may be RecType 4 (like Sales Orders) or
  // RecType 2 (like invoices) depending on the Busy version — both are read; per voucher the
  // RecType that has rows wins (4 first).
  const r = await pool.request().query(`
    SELECT t2.VchCode, t2.RecType, t2.SrNo, t2.MasterCode1 AS ItemCode, m.Name AS ItemName,
           t2.Value1 AS Qty1, t2.D1 AS QtyD1, t2.D2 AS Rate, t2.Value3 AS Taxable,
           t2.D9 AS DiscountPct, t2.D11 AS TaxAmount, t2.D5 AS LineAmt,
           gst.TaxRate + gst.TaxRate1 AS GstRate
    FROM Tran2 t2
    JOIN Tran1 t1 ON t1.VchCode = t2.VchCode
    LEFT JOIN Master1 m ON m.Code = t2.MasterCode1
    OUTER APPLY (
      SELECT TOP 1 g.TaxRate, g.TaxRate1 FROM VchGSTSumItemWise g
      WHERE g.VchCode = t2.VchCode AND g.ItemCode = t2.MasterCode1 AND ROUND(g.TaxableAmt, 2) = ROUND(ABS(t2.Value3), 2)
    ) gst
    WHERE t1.VchType = ${QUOTE} AND t2.RecType IN (2, 4) AND m.MasterType = 6
    ORDER BY t2.VchCode, t2.RecType, t2.SrNo`);
  return r.recordset;
}

function buildRows(quotes, lines) {
  // Per voucher: keep the RecType with item rows (4 preferred, else 2).
  const byVch = new Map();
  for (const l of lines) {
    const v = byVch.get(l.VchCode) || (byVch.set(l.VchCode, new Map()), byVch.get(l.VchCode));
    const arr = v.get(l.RecType) || (v.set(l.RecType, []), v.get(l.RecType));
    arr.push(l);
  }
  const linesBy = new Map();
  for (const [vch, byType] of byVch) {
    const rows = byType.get(4) || byType.get(2) || [];
    const key = `${DB}|${vch}`;
    linesBy.set(key, rows.map((l) => {
      const qty = Math.abs(Number(l.Qty1 || l.QtyD1 || 0));
      let taxable = Math.abs(Number(l.Taxable || 0));
      let gstRate = l.GstRate == null ? null : Number(l.GstRate);
      let tax = Math.abs(Number(l.TaxAmount || 0));
      const lineAmt = Math.abs(Number(l.LineAmt || 0));
      if (!taxable && lineAmt) taxable = tax ? lineAmt - tax : lineAmt;
      if (gstRate == null && tax && taxable) gstRate = Math.round((tax / taxable) * 1000) / 10;
      if (!tax && gstRate) tax = taxable * gstRate / 100;
      const disc = Math.abs(Number(l.DiscountPct || 0));
      const net = qty ? taxable / qty : 0;
      const list = disc > 0 && disc < 100 ? net / (1 - disc / 100) : net;
      const amount = taxable + tax;
      return {
        vch_key: key, sr_no: l.SrNo,
        item_code: l.ItemCode == null ? null : String(l.ItemCode),
        item_name: txt(l.ItemName), unit: 'Pcs',
        qty: r3(qty), list_rate: r2(list), discount_pct: r2(disc), rate_before_gst: r2(net),
        gst_rate: gstRate == null ? null : r2(gstRate), tax_amount: r2(tax),
        rate: r2(qty ? amount / qty : 0), amount: r2(amount), taxable: r2(taxable),
      };
    }));
  }

  return quotes.map((q) => {
    const key = `${DB}|${q.VchCode}`;
    const ls = linesBy.get(key) || [];
    const itemsTotal = ls.reduce((s, l) => s + (l.amount || 0), 0);
    const partyAmt = q.PartyAmt == null ? 0 : Math.abs(Number(q.PartyAmt));
    const saved = Math.abs(Number(q.SavedAmt || 0));
    const header = {
      vch_key: key, db_name: DB, vch_code: q.VchCode, vch_no: txt(q.VchNo), quote_date: q.QuoteDate || null,
      party_code: q.PartyCode == null ? null : String(q.PartyCode),
      party_name: txt(q.PartyName), billed_name: txt(q.BilledName),
      mobile: txt(q.BilledMobile) || txt(q.WhatsAppNo) || txt(q.Mobile),
      city: txt(q.City), narration: txt(q.Narration),
      quote_total: r2(partyAmt >= 0.01 ? partyAmt : saved >= 0.01 ? saved : itemsTotal),
      taxable_total: r2(ls.reduce((s, l) => s + (l.taxable || 0), 0)),
      item_count: ls.length, total_qty: r3(ls.reduce((s, l) => s + (l.qty || 0), 0)),
      entered_at: ist(q.EnteredAt), entered_by: txt(q.EnteredBy), last_edited_at: ist(q.EditedAt),
      cancelled: !!(q.Cancelled || q.VchCancelled),
      deleted_at: null,
    };
    const signature = crypto.createHash('md5').update(JSON.stringify([header, ls])).digest('hex');
    return { header: { ...header, signature }, lines: ls };
  });
}

// ---------- SUPABASE ----------
async function existingQuotes(supabase) {
  const map = new Map();
  for (let from = 0; from < 500000; from += 1000) {
    const { data, error } = await supabase.from('busy_quotations').select('vch_key, signature, deleted_at').eq('db_name', DB).range(from, from + 999);
    if (error) throw new Error(`reading busy_quotations: ${error.message}`);
    for (const r of data) map.set(r.vch_key, r);
    if (data.length < 1000) break;
  }
  return map;
}
async function inBatches(list, size, fn) { for (let i = 0; i < list.length; i += size) await fn(list.slice(i, i + size)); }

async function main() {
  const started = new Date().toISOString();
  const pool = await sql.connect(SQL_CONFIG);
  let quotes, lines;
  try { quotes = await readQuotes(pool); lines = await readLines(pool); } finally { await pool.close(); }
  const rows = buildRows(quotes, lines);

  if (CHECK) {
    log(`CHECK ONLY — database ${DB}: ${rows.length} quotations (type ${QUOTE}), ${lines.length} item lines. Nothing written.`);
    const latest = [...rows].sort((a, b) => String(b.header.quote_date || '').localeCompare(String(a.header.quote_date || ''))).slice(0, 3);
    for (const { header: h, lines: ls } of latest) {
      console.log(`\n${h.party_name} (${h.billed_name || '-'} / ${h.mobile || 'no mobile'}) | ${h.vch_no} dated ${h.quote_date} | total ${h.quote_total} | ${h.item_count} items${h.cancelled ? ' | CANCELLED' : ''}`);
      for (const l of ls) console.log(`   ${l.item_name} | ${l.qty} ${l.unit} | rate ${l.rate} | GST ${l.gst_rate}% | amount ${l.amount}`);
    }
    return;
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const existing = await existingQuotes(supabase);
  const touched = rows.filter((r) => { const old = existing.get(r.header.vch_key); return !old || old.signature !== r.header.signature || old.deleted_at; });
  const seen = new Set(rows.map((r) => r.header.vch_key));
  const gone = [...existing.values()].filter((e) => !seen.has(e.vch_key) && !e.deleted_at).map((e) => e.vch_key);
  if (!rows.length && existing.size) throw new Error('Busy returned no quotations — stopping without changing Supabase');

  const stamp = { synced_at: started };
  await inBatches(touched, 200, async (batch) => {
    const heads = batch.map((r) => ({ ...r.header, ...stamp, signature: null }));
    let w = await supabase.from('busy_quotations').upsert(heads, { onConflict: 'vch_key' });
    if (w.error) throw new Error(`saving quotations: ${w.error.message}`);
    const keys = batch.map((r) => r.header.vch_key);
    const del = await supabase.from('busy_quotation_lines').delete().in('vch_key', keys);
    if (del.error) throw new Error(`clearing item lines: ${del.error.message}`);
    const ls = batch.flatMap((r) => r.lines);
    for (let i = 0; i < ls.length; i += 1000) {
      const ins = await supabase.from('busy_quotation_lines').insert(ls.slice(i, i + 1000));
      if (ins.error) throw new Error(`saving item lines: ${ins.error.message}`);
    }
    w = await supabase.from('busy_quotations').upsert(batch.map((r) => ({ ...r.header, ...stamp })), { onConflict: 'vch_key' });
    if (w.error) throw new Error(`saving fingerprints: ${w.error.message}`);
  });
  await inBatches(gone, 300, async (keys) => {
    const { error } = await supabase.from('busy_quotations').update({ deleted_at: started }).in('vch_key', keys);
    if (error) throw new Error(`marking deleted quotations: ${error.message}`);
  });
  log(`${rows.length} quotations in ${DB}; written ${touched.length}, deleted ${gone.length}`);
}

main().catch((err) => { log(`ERROR: ${err.message}`); process.exit(1); });
