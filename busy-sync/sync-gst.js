// sync-gst.js
// Copies the data the GSTR-2A Reconciliation page in JCM HQ (hq.jcmretails.com/#gst-recon)
// needs from Busy into Supabase (JCM-Busysql project):
//
//   GSTR2AInfo          → gst_2a_rows        the 2A data Busy downloaded through its GSP
//                                           (GST → Misc. Utilities → Download GSTR JSON Data),
//                                           one row per supplier invoice / note
//   Tran1 + VchGSTSumItemWise → gst_purchase_rows   every purchase voucher (VchType 2) and every
//                                           Registered Expense journal (VchType 16) with its
//                                           GST summary: party GSTIN, taxable, CGST/SGST/IGST
//   Master1 + MasterAddressInfo → gst_parties   contacts (mobile / WhatsApp / email) of parties
//                                           that have a GSTIN, for supplier reminders
//
// HQ does the matching itself (api/gst.js); this only keeps the raw data fresh. Every run
// rewrites the whole year for the current Busy database (a few thousand rows, seconds).
// Nothing here presses Busy's download button — someone still does that in Busy each month.
//
//   node sync-gst.js            normal run
//   node sync-gst.js --check    read Busy and print counts + 3 sample rows; writes nothing
//
// Lives in D:\JCM-Supabase\files beside sync.js and uses the same .env and node_modules:
//   BUSY_SERVER (e.g. localhost,1433), BUSY_DATABASE, BUSY_USER, BUSY_PASSWORD,
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
// Writes gst.log in the same folder. Needs supabase/gst-setup.sql run once.

require('dotenv').config();
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const CHECK = process.argv.includes('--check');
const PURCHASE = 2; // Busy voucher type: Purchase
const EXPENSE_JOURNAL = 16; // Busy voucher type: Journal — carries Registered Expense (B2B) bills
const JCM_GSTIN = '23AAPFJ0607D1ZT';

const LOG_FILE = path.join(__dirname, 'gst.log');
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) { /* logging must never stop the sync */ }
}

// Busy keeps one database per financial year (FY 2026-27 -> BusyComp0001_db12026).
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
const r2 = (n) => (n == null || Number.isNaN(Number(n)) ? 0 : Math.round(Number(n) * 100) / 100);
const txt = (s) => (s == null ? null : String(s).trim() || null);
const monthOf = (d) => (d ? String(d).slice(0, 7) : null);
// A date that is really "empty" in Busy (1900-01-01 / 1899-12-30).
const realDate = (d) => (d && d > '1901-01-01' ? d : null);

// ---------- READ BUSY ----------
async function read2A(pool) {
  const r = await pool.request().query(`
    SELECT RecType, TranType, [Month], [Year], GSTIN, TradeName,
           LTRIM(RTRIM(VchNo)) AS VchNo, CONVERT(VARCHAR(10), [Date], 23) AS VchDate,
           TaxableAmt, Rate, CGST, SGST, IGST, CessAmt, ITCAvl,
           CONVERT(VARCHAR(10), SupplierFilDate, 23) AS FiledOn, SupplierPrd,
           CONVERT(VARCHAR(19), Date1, 126) AS PulledAt
    FROM GSTR2AInfo
    WHERE ISNULL(GSTIN, '') <> ''`);
  return r.recordset;
}

async function readPurchases(pool) {
  const r = await pool.request().query(`
    WITH gstsum AS (
      SELECT VchCode,
             SUM(TaxableAmt) AS Taxable,
             SUM(CASE WHEN TaxRate1 > 0 THEN TaxAmt  ELSE 0 END) AS CGST,
             SUM(CASE WHEN TaxRate1 > 0 THEN TaxAmt1 ELSE 0 END) AS SGST,
             SUM(CASE WHEN TaxRate1 = 0 THEN TaxAmt  ELSE 0 END) AS IGST,
             SUM(ISNULL(ACessAmt, 0) + ISNULL(StateCessAmt, 0)) AS Cess,
             MAX(GSTIN) AS GSTIN
      FROM VchGSTSumItemWise WHERE VchType = ${PURCHASE}
      GROUP BY VchCode
    ),
    entered AS (
      SELECT Code, UserName, ActionTime,
             ROW_NUMBER() OVER (PARTITION BY Code ORDER BY ActionTime) AS rn
      FROM CheckList WHERE Type = 2 AND Action = 1
    )
    SELECT t1.VchCode, LTRIM(RTRIM(t1.VchNo)) AS VchNo,
           CONVERT(VARCHAR(10), t1.[Date], 23) AS VchDate,
           t1.MasterCode1 AS PartyCode, p.Name AS PartyName, s.Name AS Series,
           t1.VchAmtBaseCur AS Total,
           g.Taxable, g.CGST, g.SGST, g.IGST, g.Cess,
           ISNULL(NULLIF(LTRIM(RTRIM(g.GSTIN)), ''), LTRIM(RTRIM(a.GSTNo))) AS GSTIN,
           e.UserName AS EnteredBy, CONVERT(VARCHAR(19), e.ActionTime, 126) AS EnteredAt
    FROM Tran1 t1
    LEFT JOIN Master1 p ON p.Code = t1.MasterCode1
    LEFT JOIN Master1 s ON s.Code = t1.VchSeriesCode
    LEFT JOIN MasterAddressInfo a ON a.MasterCode = t1.MasterCode1
    LEFT JOIN gstsum g ON g.VchCode = t1.VchCode
    LEFT JOIN entered e ON e.Code = t1.VchCode AND e.rn = 1
    WHERE t1.VchType = ${PURCHASE}
      AND ISNULL(t1.Cancelled, 0) = 0 AND ISNULL(t1.VchCancelled, 0) = 0`);

  // Registered Expense (B2B) bills are booked as journals (VchType 16) with GST details, e.g.
  // a printing/stationery bill. They are inward supplies too, so they must match their 2A row.
  // The supplier's invoice no., party and amounts sit on the GST summary rows, not on Tran1.
  const j = await pool.request().query(`
    WITH gstsum AS (
      SELECT VchCode,
             MAX(LTRIM(RTRIM(VchNo))) AS VchNo, MAX(VchDate) AS VchDate, MAX(PartyCode) AS PartyCode,
             SUM(TaxableAmt) AS Taxable,
             SUM(CASE WHEN TaxRate1 > 0 THEN TaxAmt  ELSE 0 END) AS CGST,
             SUM(CASE WHEN TaxRate1 > 0 THEN TaxAmt1 ELSE 0 END) AS SGST,
             SUM(CASE WHEN TaxRate1 = 0 THEN TaxAmt  ELSE 0 END) AS IGST,
             SUM(ISNULL(ACessAmt, 0) + ISNULL(StateCessAmt, 0)) AS Cess,
             MAX(GSTIN) AS GSTIN
      FROM VchGSTSumItemWise WHERE VchType = ${EXPENSE_JOURNAL}
      GROUP BY VchCode
    ),
    entered AS (
      SELECT Code, UserName, ActionTime,
             ROW_NUMBER() OVER (PARTITION BY Code ORDER BY ActionTime) AS rn
      FROM CheckList WHERE Type = 2 AND Action = 1
    )
    SELECT g.VchCode, g.VchNo, CONVERT(VARCHAR(10), g.VchDate, 23) AS VchDate,
           g.PartyCode, p.Name AS PartyName, 'Registered Expense (journal)' AS Series,
           g.Taxable + g.CGST + g.SGST + g.IGST + g.Cess AS Total,
           g.Taxable, g.CGST, g.SGST, g.IGST, g.Cess,
           ISNULL(NULLIF(LTRIM(RTRIM(g.GSTIN)), ''), LTRIM(RTRIM(a.GSTNo))) AS GSTIN,
           e.UserName AS EnteredBy, CONVERT(VARCHAR(19), e.ActionTime, 126) AS EnteredAt
    FROM gstsum g
    JOIN Tran1 t1 ON t1.VchCode = g.VchCode
    LEFT JOIN Master1 p ON p.Code = g.PartyCode
    LEFT JOIN MasterAddressInfo a ON a.MasterCode = g.PartyCode
    LEFT JOIN entered e ON e.Code = g.VchCode AND e.rn = 1
    WHERE ISNULL(t1.Cancelled, 0) = 0 AND ISNULL(t1.VchCancelled, 0) = 0
      AND ISNULL(g.VchNo, '') <> ''`);
  return [...r.recordset, ...j.recordset.filter((x) => x.GSTIN && x.GSTIN !== JCM_GSTIN)];
}

async function readParties(pool) {
  const r = await pool.request().query(`
    SELECT m.Code, m.Name, LTRIM(RTRIM(a.GSTNo)) AS GSTNo, a.Mobile, a.WhatsAppNo, a.Email, a.Station
    FROM Master1 m
    JOIN MasterAddressInfo a ON a.MasterCode = m.Code
    WHERE m.MasterType = 2 AND ISNULL(a.GSTNo, '') <> ''`);
  return r.recordset;
}

// ---------- SHAPE ----------
// Busy's Month is the FY month (1 = April). Calendar month from the invoice date is what
// the page works with; fy_month / fy_year are kept for reference.
function build2A(rows) {
  const by = new Map();
  for (const x of rows) {
    const vchNo = txt(x.VchNo) || '';
    const key = `${DB}|${txt(x.GSTIN)}|${x.TranType ?? 0}|${vchNo}`;
    let row = by.get(key);
    if (!row) {
      const d = realDate(x.VchDate);
      row = {
        row_key: key, db_name: DB, gstin: txt(x.GSTIN), trade_name: txt(x.TradeName),
        tran_type: x.TranType ?? null, vch_no: vchNo, vch_date: d, inv_month: monthOf(d),
        fy_month: x.Month ?? null, fy_year: txt(x.Year), filed_period: txt(x.SupplierPrd),
        supplier_filed_on: realDate(x.FiledOn),
        taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0, rates: [],
        itc_avl: txt(x.ITCAvl), pulled_at: ist(x.PulledAt),
      };
      by.set(key, row);
    }
    const tax = { rate: Number(x.Rate || 0), taxable: r2(x.TaxableAmt), cgst: r2(x.CGST), sgst: r2(x.SGST), igst: r2(x.IGST) };
    row.rates.push(tax);
    row.taxable = r2(row.taxable + tax.taxable);
    row.cgst = r2(row.cgst + tax.cgst);
    row.sgst = r2(row.sgst + tax.sgst);
    row.igst = r2(row.igst + tax.igst);
    row.cess = r2(row.cess + r2(x.CessAmt));
    row.total = r2(row.taxable + row.cgst + row.sgst + row.igst + row.cess);
    if (!row.trade_name && txt(x.TradeName)) row.trade_name = txt(x.TradeName);
    if (x.PulledAt && (!row.pulled_at || ist(x.PulledAt) > row.pulled_at)) row.pulled_at = ist(x.PulledAt);
  }
  return [...by.values()];
}

function buildPurchases(rows) {
  return rows.map((b) => {
    const d = realDate(b.VchDate);
    return {
      vch_key: `${DB}|${b.VchCode}`, db_name: DB, vch_code: b.VchCode,
      vch_no: txt(b.VchNo), vch_date: d, inv_month: monthOf(d),
      party_code: b.PartyCode == null ? null : String(b.PartyCode), party_name: txt(b.PartyName),
      gstin: txt(b.GSTIN), series: txt(b.Series),
      taxable: r2(b.Taxable), cgst: r2(b.CGST), sgst: r2(b.SGST), igst: r2(b.IGST), cess: r2(b.Cess),
      total: r2(b.Total), entered_by: txt(b.EnteredBy), entered_at: ist(b.EnteredAt),
    };
  });
}

function buildParties(rows) {
  return rows.map((p) => ({
    party_code: String(p.Code), party_name: txt(p.Name), gstin: txt(p.GSTNo),
    mobile: txt(p.Mobile), whatsapp: txt(p.WhatsAppNo), email: txt(p.Email), station: txt(p.Station),
  }));
}

// ---------- SUPABASE ----------
async function inBatches(list, size, fn) {
  for (let i = 0; i < list.length; i += size) await fn(list.slice(i, i + size));
}

async function main() {
  const started = new Date().toISOString();
  const pool = await sql.connect(SQL_CONFIG);
  let raw2a, rawPur, rawParties;
  try {
    raw2a = await read2A(pool);
    rawPur = await readPurchases(pool);
    rawParties = await readParties(pool);
  } finally {
    await pool.close();
  }
  const rows2a = build2A(raw2a);
  const rowsPur = buildPurchases(rawPur);
  const parties = buildParties(rawParties);
  const pulledAt = rows2a.reduce((m, r) => (r.pulled_at && r.pulled_at > m ? r.pulled_at : m), '') || null;

  if (CHECK) {
    log(`CHECK ONLY — database ${DB}: ${raw2a.length} 2A tax rows → ${rows2a.length} invoices/notes; ${rowsPur.length} purchase vouchers; ${parties.length} parties with GSTIN. Newest 2A download in Busy: ${pulledAt || 'none'}. Nothing written.`);
    for (const r of rows2a.slice(0, 3)) console.log('2A ', r.gstin, r.trade_name, r.vch_no, r.vch_date, 'taxable', r.taxable, 'tax', r2(r.cgst + r.sgst + r.igst), 'filed', r.filed_period);
    for (const r of rowsPur.slice(-3)) console.log('BUSY', r.gstin, r.party_name, r.vch_no, r.vch_date, 'taxable', r.taxable, 'tax', r2(r.cgst + r.sgst + r.igst), 'total', r.total);
    return;
  }

  // Safety: an empty read must never wipe Supabase.
  if (!rowsPur.length) throw new Error('Busy returned no purchase vouchers — stopping without changing Supabase');

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const stamp = { synced_at: started };

  await inBatches(rows2a, 500, async (batch) => {
    const { error } = await supabase.from('gst_2a_rows').upsert(batch.map((r) => ({ ...r, ...stamp })), { onConflict: 'row_key' });
    if (error) throw new Error(`saving 2A rows: ${error.message}`);
  });
  await inBatches(rowsPur, 500, async (batch) => {
    const { error } = await supabase.from('gst_purchase_rows').upsert(batch.map((r) => ({ ...r, ...stamp })), { onConflict: 'vch_key' });
    if (error) throw new Error(`saving purchase rows: ${error.message}`);
  });
  await inBatches(parties, 500, async (batch) => {
    const { error } = await supabase.from('gst_parties').upsert(batch.map((r) => ({ ...r, ...stamp })), { onConflict: 'party_code' });
    if (error) throw new Error(`saving parties: ${error.message}`);
  });

  // Rows of this database that Busy no longer has (deleted voucher, 2A re-download) go away.
  for (const table of ['gst_2a_rows', 'gst_purchase_rows']) {
    const { error } = await supabase.from(table).delete().eq('db_name', DB).lt('synced_at', started);
    if (error) throw new Error(`removing old rows from ${table}: ${error.message}`);
  }

  const note = `${rows2a.length} 2A rows, ${rowsPur.length} purchase vouchers, ${parties.length} parties (${DB})`;
  const { error } = await supabase.from('gst_settings').upsert({ id: 1, last_sync_at: started, last_sync_note: note, pulled_at: pulledAt }, { onConflict: 'id' });
  if (error) throw new Error(`saving settings: ${error.message}`);
  log(`done: ${note}; newest 2A download in Busy ${pulledAt || 'none'}`);
}

main().catch((err) => {
  log(`FAILED: ${err.message}`);
  process.exit(1);
});
