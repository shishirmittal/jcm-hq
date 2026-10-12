// sync-invoices-live.js — the invoice portal's tables (invoices + invoice_items) refreshed every
// 5 minutes for invoices touched in Busy in the last LOOKBACK_HOURS (JCM HQ, 2026-10-12).
//
// The nightly sync.js still does the full year (and deletions). This only re-pulls invoices that
// were saved / edited recently (Busy's CheckList log), with the SAME queries and dummy-party
// resolution as sync.js, so the "Invoice PDF" WhatsApp button and the portal show a bill within
// minutes of billing instead of the next morning.
//
//   node sync-invoices-live.js           normal run
//   node sync-invoices-live.js --check   read Busy, print counts, write nothing
//
// JCM Sync job 'invoices-live'. Same .env as the other scripts.

require('dotenv').config();
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const CHECK = process.argv.includes('--check');
const LOOKBACK_HOURS = 48;

// Same as sync.js — keep in step with it.
const DUMMY_PARTY_CODES = [40355, 65494]; // Nexus Enterprises, Silver Electric House
const CONTROL_ACCOUNT_CODES = [4, 1100, 1115, 1116, 56680, 7398, 7501, 54463, 60016, 1];
const DUMMY_LIST = DUMMY_PARTY_CODES.join(',');
const EXCLUDE_LIST = [...DUMMY_PARTY_CODES, ...CONTROL_ACCOUNT_CODES].join(',');

const LOG_FILE = path.join(__dirname, 'invoices-live.log');
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
  if (value.includes(',')) { const [host, port] = value.split(','); return { server: host.trim(), port: parseInt(port.trim(), 10) }; }
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

// Only invoices with a CheckList entry (saved / edited / printed) in the window.
const RECENT = `
WITH Recent AS (
    SELECT DISTINCT Code AS VchCode FROM CheckList
    WHERE Type = 2 AND ActionTime >= DATEADD(HOUR, -${LOOKBACK_HOURS}, GETDATE())
),
ResolvedInvoices AS (
    SELECT t1.VchCode, t1.VchNo, t1.Date, t1.VchAmtBaseCur, t1.VchSalePurcAmt, t1.EInvIRN, t1.EInvAckNo,
           t1.EInvAckDate, t1.CreatedBy, t1.CreationTime,
           COALESCE(ov.MasterCode1, t1.MasterCode1) AS resolved_party_code
    FROM Tran1 t1
    JOIN Recent r ON r.VchCode = t1.VchCode
    OUTER APPLY (
        SELECT TOP 1 t2.MasterCode1 FROM Tran2 t2
        WHERE t2.VchCode = t1.VchCode AND t2.RecType = 1
          AND t1.MasterCode1 IN (${DUMMY_LIST}) AND t2.MasterCode1 NOT IN (${EXCLUDE_LIST})
    ) ov
    WHERE t1.VchType = 9 AND ISNULL(t1.Cancelled, 0) = 0 AND ISNULL(t1.VchCancelled, 0) = 0
)`;

const INVOICES_QUERY = `${RECENT}
SELECT ri.VchCode AS vch_code, LTRIM(ri.VchNo) AS vch_no, ri.Date AS invoice_date,
       ri.resolved_party_code AS party_code, ri.VchAmtBaseCur AS total_amount, ri.VchSalePurcAmt AS taxable_amount,
       ri.EInvIRN AS einvoice_irn, ri.EInvAckNo AS einvoice_ack_no, ri.EInvAckDate AS einvoice_ack_date,
       ri.CreatedBy AS created_by, ri.CreationTime AS created_at,
       bd.MobileNo AS customer_mobile, bd.PartyName AS customer_name, bd.GSTNo AS customer_gst_no,
       LTRIM(RTRIM(COALESCE(bd.Address1,'') + ' ' + COALESCE(bd.Address2,'') + ' ' + COALESCE(bd.Address3,'') + ' ' + COALESCE(bd.Address4,''))) AS customer_address,
       gst.PartyStateTinDigit AS place_of_supply_code,
       CASE WHEN gst.PartyStateTinDigit <> gst.BDStateTinDigit THEN 1 ELSE 0 END AS is_interstate,
       voi.Transport AS transport, voi.Station AS station, voi.VehicleNo AS vehicle_no, voi.GrNo AS gr_no, voi.Distance AS distance,
       challan.challan_refs
FROM ResolvedInvoices ri
LEFT JOIN BillingDet bd ON bd.VchCode = ri.VchCode
LEFT JOIN VchOtherInfo voi ON voi.VchCode = ri.VchCode
OUTER APPLY (SELECT TOP 1 g.PartyStateTinDigit, g.BDStateTinDigit FROM VchGSTSumItemWise g WHERE g.VchCode = ri.VchCode) gst
OUTER APPLY (
    SELECT STRING_AGG(x.ChallanNo, ', ') AS challan_refs
    FROM (SELECT DISTINCT RTRIM(LTRIM(t3.No)) AS ChallanNo FROM Tran3 t3 WHERE t3.VchCode = ri.VchCode AND LTRIM(t3.No) LIKE 'Challan%') x
) challan;`;

const ITEMS_QUERY = `${RECENT}
SELECT t2.VchCode AS vch_code, LTRIM(t1.VchNo) AS vch_no, t2.MasterCode1 AS item_code, m.Name AS item_name,
       ABS(t2.D1) AS qty, t2.D2 AS rate, ABS(t2.Value3) AS taxable_amount, t2.D11 AS tax_amount, t2.D9 AS discount_percent,
       gst.HSNCode AS hsn_code, gst.TaxRate + gst.TaxRate1 AS gst_rate,
       ROW_NUMBER() OVER (PARTITION BY LTRIM(t1.VchNo) ORDER BY (SELECT NULL)) AS line_no
FROM Tran2 t2
INNER JOIN Tran1 t1 ON t1.VchCode = t2.VchCode
INNER JOIN ResolvedInvoices ri ON ri.VchCode = t1.VchCode
LEFT JOIN Master1 m ON m.Code = t2.MasterCode1 AND m.MasterType = 6
OUTER APPLY (
    SELECT TOP 1 g.HSNCode, g.TaxRate, g.TaxRate1 FROM VchGSTSumItemWise g
    WHERE g.VchCode = t2.VchCode AND g.ItemCode = t2.MasterCode1 AND ROUND(g.TaxableAmt, 2) = ROUND(ABS(t2.Value3), 2)
) gst
WHERE t1.VchType = 9 AND t2.RecType IN (2, 7);`;

const CUSTOMERS_QUERY = `${RECENT}
SELECT DISTINCT m.Code AS party_code, m.Name AS name, a.Mobile AS mobile, a.WhatsAppNo AS whatsapp_no
FROM ResolvedInvoices ri
INNER JOIN Master1 m ON m.Code = ri.resolved_party_code AND m.MasterType = 2
LEFT JOIN MasterAddressInfo a ON a.MasterCode = m.Code;`;

async function main() {
  log(`start${CHECK ? ' (check only)' : ''} — ${SQL_CONFIG.database}`);
  const pool = await sql.connect(SQL_CONFIG);
  const [inv, items, cust] = await Promise.all([pool.request().query(INVOICES_QUERY), pool.request().query(ITEMS_QUERY), pool.request().query(CUSTOMERS_QUERY)]);
  await pool.close();
  const now = new Date().toISOString();
  const invoices = inv.recordset.map(r => ({
    vch_code: r.vch_code, vch_no: r.vch_no, vch_date: r.invoice_date.toISOString().split('T')[0], party_code: r.party_code,
    total_amount: r.total_amount, taxable_amount: r.taxable_amount,
    customer_mobile: r.customer_mobile ? r.customer_mobile.trim() : null, customer_name: r.customer_name ? r.customer_name.trim() : null,
    customer_gst_no: r.customer_gst_no ? r.customer_gst_no.trim() : null, customer_address: r.customer_address || null,
    place_of_supply_code: r.place_of_supply_code || null, is_interstate: r.is_interstate === 1,
    transport: r.transport || null, station: r.station || null, vehicle_no: r.vehicle_no || null, gr_no: r.gr_no || null, distance: r.distance || null,
    einvoice_irn: r.einvoice_irn || null, einvoice_ack_no: r.einvoice_ack_no || null, einvoice_ack_date: r.einvoice_ack_date ? r.einvoice_ack_date.toISOString() : null,
    created_by: r.created_by || null, created_at: r.created_at ? r.created_at.toISOString() : null, challan_refs: r.challan_refs || null,
    last_synced_at: now,
  }));
  const lines = items.recordset.map(r => ({
    vch_code: r.vch_code, vch_no: r.vch_no, line_no: r.line_no, item_code: r.item_code, item_name: r.item_name, qty: r.qty, rate: r.rate,
    taxable_amount: r.taxable_amount, tax_amount: r.tax_amount, discount_percent: r.discount_percent, hsn_code: r.hsn_code || null, gst_rate: r.gst_rate,
  }));
  log(`${invoices.length} invoices touched in the last ${LOOKBACK_HOURS} h, ${lines.length} lines`);
  if (CHECK || !invoices.length) return;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  // Customers first — invoices.party_code points at customers, and a brand-new party is not there yet.
  const customers = cust.recordset.map(r => ({ party_code: r.party_code, name: r.name, mobile: r.mobile ? r.mobile.trim() : null, whatsapp_no: r.whatsapp_no ? r.whatsapp_no.trim() : null, last_synced_at: now }));
  for (let i = 0; i < customers.length; i += 500) {
    const { error } = await supabase.from('customers').upsert(customers.slice(i, i + 500), { onConflict: 'party_code' });
    if (error) throw new Error(`customers upsert: ${error.message}`);
  }
  for (let i = 0; i < invoices.length; i += 500) {
    const { error } = await supabase.from('invoices').upsert(invoices.slice(i, i + 500), { onConflict: 'vch_no' });
    if (error) throw new Error(`invoices upsert: ${error.message}`);
  }
  const vchNos = [...new Set(lines.map(l => l.vch_no))];
  for (let i = 0; i < vchNos.length; i += 200) {
    const { error } = await supabase.from('invoice_items').delete().in('vch_no', vchNos.slice(i, i + 200));
    if (error) throw new Error(`invoice_items delete: ${error.message}`);
  }
  for (let i = 0; i < lines.length; i += 500) {
    const { error } = await supabase.from('invoice_items').insert(lines.slice(i, i + 500));
    if (error) throw new Error(`invoice_items insert: ${error.message}`);
  }
  log(`written: ${customers.length} customers, ${invoices.length} invoices, ${lines.length} lines`);
}

main().catch(err => { log(`FAILED: ${err.message || err}`); process.exit(1); });
