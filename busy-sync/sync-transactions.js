// sync-transactions.js — queue a WhatsApp to the customer / supplier for every new Busy voucher
// (JCM HQ, 2026-10-12). Runs every 5 minutes from JCM Sync (job 'transactions').
//
// What it does
//   1. Reads vouchers typed into Busy in the last LOOKBACK_HOURS (CheckList Action 1 = first save):
//        9 Sales (invoice)  14 Receipt  18 Credit note  17 Debit note  19 Payment  2 Purchase  12 Sales order
//      with the BILLED party's name + mobile from the voucher's Billing/Shipping Details (BillingDet), falling
//      back to the ledger account (Master1 + MasterAddressInfo) only for real customer ledgers, plus amount and
//      item count. Ledger-only accounts (Nexus Enterprises, Silver Electric House, Cash — LEDGER_ONLY_CODES)
//      never fall back: no billing name + mobile → status 'no_billing', nothing is sent.
//   2. Writes each one to wa_outbox in Supabase (JCM-Busysql project; unique on db + vch_code), to go
//      15 minutes after its first save (2026-10-13). On every run, for vouchers of the last 48 h:
//        - still waiting → the row is refreshed from Busy (amount, items, billed party, number…), so an
//          edit before sending goes out as edited;
//        - deleted / cancelled in Busy while waiting → 'deleted' / 'cancelled', never sent;
//        - an INVOICE changed after its message went → queued again as a corrected copy (revision + 1,
//          template txn_invoice_revised, 15-min wait again, max 3); other kinds are only flagged
//          (after_send = 'changed' / 'deleted') for HQ → WhatsApp → Outbox.
//      Party amount = the larger side of the party's rows (a counter sale paid on the spot has bill +
//      payment rows; adding both doubled the amount until 2026-10-13).
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
const WAIT_MINUTES = 15;          // wait after the first save before the message goes
const MAX_REVISIONS = 3;          // corrected copies per invoice, at most
// Corrected copies are sent automatically only for messages sent from this moment on (the fix went in
// 2026-10-13 16:00 IST). Older messages that differ are only flagged in HQ → WhatsApp → Outbox.
const CORRECTIONS_FROM = Date.parse('2026-10-13T10:30:00Z');
const FRESH = ['vch_no', 'vch_date', 'party_name', 'ledger_name', 'mobile', 'amount', 'items'];

const KINDS = { 9: 'invoice', 14: 'receipt', 18: 'credit_note', 17: 'debit_note', 19: 'payment', 2: 'purchase', 12: 'order' };
const TYPES = Object.keys(KINDS).map(Number);
// Accounts that are never "the party" on a receipt / payment (same list as sync.js).
const CONTROL_ACCOUNTS = [4, 1100, 1115, 1116, 56680, 7398, 7501, 54463, 60016, 1];
// Ledger-only accounts (Shishir, 2026-10-12): these are dummy / collective ledgers, never a real customer.
// A voucher booked on one of them goes ONLY to the party in its Billing/Shipping Details; with no billing
// details the message is skipped (status 'no_billing') — the ledger's name and mobile are never used.
const LEDGER_ONLY_CODES = [40355 /* Nexus Enterprises */, 65494 /* Silver Electric House */, 56680 /* Cash (Retail) */, ...CONTROL_ACCOUNTS];
const LEDGER_ONLY_NAMES = /nexus enterprises|silver electric house|^cash\b/i;
const isLedgerOnly = (code, name) => LEDGER_ONLY_CODES.includes(Number(code)) || LEDGER_ONLY_NAMES.test(String(name || ''));

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

async function readVouchers(pool) {
  const r = await pool.request().query(`
    WITH entered AS (
      SELECT Code, UserName, ActionTime,
             ROW_NUMBER() OVER (PARTITION BY Code ORDER BY ActionTime) AS rn
      FROM CheckList WHERE Type = 2 AND Action = 1
        AND ActionTime >= DATEADD(HOUR, -${LOOKBACK_HOURS}, GETDATE())
    ),
    -- The party's side of the voucher. A counter sale paid on the spot has TWO rows for the party
    -- (bill Dr + payment Cr), so adding both doubled the amount (bug found 2026-10-13). Take the larger
    -- side only: for a sale that is the bill total, for a purchase the bill total on the Cr side.
    partyside AS (
      SELECT t2.VchCode,
             CASE WHEN SUM(CASE WHEN t2.Value1 > 0 THEN t2.Value1 ELSE 0 END) >= SUM(CASE WHEN t2.Value1 < 0 THEN -t2.Value1 ELSE 0 END)
                  THEN SUM(CASE WHEN t2.Value1 > 0 THEN t2.Value1 ELSE 0 END)
                  ELSE SUM(CASE WHEN t2.Value1 < 0 THEN -t2.Value1 ELSE 0 END) END AS Amt
      FROM Tran2 t2 JOIN Tran1 t1 ON t1.VchCode = t2.VchCode
      WHERE t1.VchType IN (${TYPES.join(',')}) AND t2.RecType = 1 AND t2.MasterCode1 = t1.MasterCode1
      GROUP BY t2.VchCode
    ),
    items AS (
      SELECT VchCode, COUNT(*) AS n FROM Tran2 WHERE RecType = 2 GROUP BY VchCode
    )
    SELECT t1.VchCode, t1.VchType, LTRIM(RTRIM(t1.VchNo)) AS VchNo,
           CONVERT(VARCHAR(10), t1.[Date], 23) AS VchDate,
           COALESCE(rp.MasterCode1, t1.MasterCode1) AS PartyCode, p.Name AS PartyName,
           a.Mobile, a.WhatsAppNo,
           bd.PartyName AS BilledName, bd.MobileNo AS BilledMobile,
           COALESCE(rp.Amt, ps.Amt, 0) AS Amount,
           ISNULL(i.n, 0) AS Items,
           ISNULL(t1.Cancelled, 0) AS Cancelled, ISNULL(t1.VchCancelled, 0) AS VchCancelled,
           e.UserName AS EnteredBy, CONVERT(VARCHAR(19), e.ActionTime, 126) AS EnteredAt
    FROM entered e
    JOIN Tran1 t1 ON t1.VchCode = e.Code
    -- Receipts / payments: Tran1's account is the cash or bank; the PARTY is the other side in Tran2.
    OUTER APPLY (
      SELECT TOP 1 t2.MasterCode1, ABS(t2.Value1) AS Amt
      FROM Tran2 t2 JOIN Master1 pm ON pm.Code = t2.MasterCode1
      WHERE t2.VchCode = t1.VchCode AND t2.RecType = 1 AND t1.VchType IN (14, 19)
        AND t2.MasterCode1 <> t1.MasterCode1 AND pm.MasterType = 2
        AND pm.Code NOT IN (${CONTROL_ACCOUNTS.join(',')})
      ORDER BY ABS(t2.Value1) DESC
    ) rp
    LEFT JOIN Master1 p ON p.Code = COALESCE(rp.MasterCode1, t1.MasterCode1)
    LEFT JOIN MasterAddressInfo a ON a.MasterCode = COALESCE(rp.MasterCode1, t1.MasterCode1)
    LEFT JOIN BillingDet bd ON bd.VchCode = t1.VchCode
    LEFT JOIN partyside ps ON ps.VchCode = t1.VchCode
    LEFT JOIN items i ON i.VchCode = t1.VchCode
    WHERE e.rn = 1 AND t1.VchType IN (${TYPES.join(',')})`);
  return r.recordset;
}

function toRow(v) {
  const kind = KINDS[v.VchType];
  const enteredAt = ist(v.EnteredAt);
  const cancelled = Number(v.Cancelled) === 1 || Number(v.VchCancelled) === 1;
  // The message goes to the BILLED party (Busy's Billing/Shipping Details on the voucher) — name and
  // mobile. A real customer ledger may fall back to the ledger's own name / mobile when the voucher has
  // no billing details; a ledger-only account (Nexus Enterprises, Silver Electric House, Cash) never does.
  const ledgerOnly = isLedgerOnly(v.PartyCode, v.PartyName);
  const billedName = txt(v.BilledName);
  const billedMobile = txt(v.BilledMobile);
  const noBilling = ledgerOnly && !(billedName && billedMobile);
  return {
    db: DB,
    vch_code: Number(v.VchCode),
    kind,
    vch_no: txt(v.VchNo),
    vch_date: v.VchDate,
    party_code: String(v.PartyCode),
    party_name: billedName || (ledgerOnly ? null : txt(v.PartyName)),
    ledger_name: txt(v.PartyName),
    mobile: billedMobile || (ledgerOnly ? null : txt(v.WhatsAppNo) || txt(v.Mobile)),
    amount: r2(v.Amount),
    items: Number(v.Items) || 0,
    entered_by: txt(v.EnteredBy),
    entered_at: enteredAt,
    // 15 minutes after the first save (Shishir, 2026-10-13), so a quick edit or delete in Busy is caught
    // before the customer is told anything. Already older than that → next run.
    send_after: new Date(Math.max(Date.now(), (Date.parse(enteredAt) || Date.now()) + WAIT_MINUTES * 60000)).toISOString(),
    status: AS_HISTORY ? 'skipped' : cancelled ? 'cancelled' : noBilling ? 'no_billing' : 'queued',
    error: noBilling ? `ledger-only account "${txt(v.PartyName)}" with no billing name/mobile on the voucher — not sent` : null,
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
    for (const r of rows.slice(0, 30)) console.log(`${r.kind} ${r.vch_no} ${r.vch_date} ${r.party_name} ₹${r.amount} → ${r.mobile || 'NO NUMBER'} after ${r.send_after}${r.cancelled ? ' CANCELLED' : ''}${r.status === 'no_billing' ? ' NO BILLING (ledger-only, not sent)' : ''}`);
    return;
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  // Safety: the very first run (empty outbox) loads everything as history, so vouchers typed in
  // before this was switched on never get a message — the same as --as-history.
  const probe = await supabase.from('wa_outbox').select('id', { count: 'exact', head: true });
  if (probe.error) { log(`wa_outbox not found — run the WhatsApp SQL in Supabase first (${probe.error.message})`); return; }
  const firstRun = (probe.count || 0) === 0;
  if (firstRun && !AS_HISTORY) { log('first run: outbox is empty — loading these vouchers as history, nothing will be sent'); for (const r of rows) r.status = 'skipped'; }

  // What is already in the outbox for vouchers entered in the lookback window.
  // One hour inside Busy's window, so a voucher at the 48 h edge is never mistaken for a deleted one.
  const since = new Date(Date.now() - (LOOKBACK_HOURS - 1) * 3600e3).toISOString();
  const existing = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('wa_outbox')
      .select('id, vch_code, kind, status, amount, items, vch_no, party_name, mobile, revision, sent_amount, after_send, entered_at, sent_at')
      .eq('db', DB).gte('entered_at', since).range(from, from + 999);
    if (error) { log(`outbox read failed: ${error.message}`); return; }
    for (const r of data || []) existing.set(Number(r.vch_code), r);
    if (!data || data.length < 1000) break;
  }

  const now = new Date().toISOString();
  const fresh = new Map(rows.map(r => [r.vch_code, r]));
  const counts = { added: 0, refreshed: 0, deleted: 0, cancelled: 0, revised: 0, flagged: 0 };
  const changed = (a, b) => Math.abs((Number(a.amount) || 0) - (Number(b.amount) || 0)) > 1 || (Number(a.items) || 0) !== (Number(b.items) || 0) || (a.vch_no || '') !== (b.vch_no || '');
  const upd = async (id, patch) => { const { error } = await supabase.from('wa_outbox').update(patch).eq('id', id); if (error) log(`update ${id} failed: ${error.message}`) }

  // 1. Brand-new vouchers → insert (waiting WAIT_MINUTES).
  const newRows = rows.filter(r => !existing.has(r.vch_code)).map(({ cancelled, ...r }) => r)
  for (let i = 0; i < newRows.length; i += 200) {
    const { data, error } = await supabase.from('wa_outbox').upsert(newRows.slice(i, i + 200), { onConflict: 'db,vch_code', ignoreDuplicates: true }).select('vch_code');
    if (error) { log(`outbox write failed: ${error.message}`); return; }
    counts.added += (data || []).length;
  }

  if (!firstRun && !AS_HISTORY) {
    for (const [code, old] of existing) {
      const f = fresh.get(code);
      const waiting = ['queued', 'held', 'no_billing'].includes(old.status);
      // 2. Gone from Busy (deleted) or cancelled.
      if (!f || f.cancelled) {
        if (waiting) { await upd(old.id, { status: f ? 'cancelled' : 'deleted', error: f ? 'cancelled in Busy before sending' : 'deleted in Busy before sending', changed_at: now }); counts[f ? 'cancelled' : 'deleted']++ }
        else if (old.status === 'sent' && !old.after_send) { await upd(old.id, { after_send: 'deleted', changed_at: now }); counts.flagged++ }
        continue;
      }
      // 3. Still waiting → always carry the latest values from Busy (edits before sending are picked up).
      if (waiting) {
        const patch = {};
        for (const k of FRESH) if ((f[k] ?? null) !== (old[k] ?? null) && String(f[k] ?? '') !== String(old[k] ?? '')) patch[k] = f[k];
        if (old.status !== 'held' && f.status !== old.status && ['queued', 'no_billing'].includes(f.status)) { patch.status = f.status; patch.error = f.error }
        if (Object.keys(patch).length) { patch.changed_at = now; await upd(old.id, patch); counts.refreshed++ }
        continue;
      }
      // 4. Already sent and the voucher changed since → invoices get a corrected copy (Shishir's choice), others are flagged.
      if (old.status === 'sent' && changed(f, old)) {
        const autoOk = old.kind === 'invoice' && (old.revision || 0) < MAX_REVISIONS && Date.parse(old.sent_at || 0) >= CORRECTIONS_FROM && f.status === 'queued';
        if (autoOk) {
          await upd(old.id, {
            ...Object.fromEntries(FRESH.map(k => [k, f[k]])),
            sent_amount: old.sent_amount ?? old.amount, revision: (old.revision || 0) + 1, after_send: 'changed',
            status: 'queued', error: null, changed_at: now,
            send_after: new Date(Date.now() + WAIT_MINUTES * 60000).toISOString(),
          });
          counts.revised++;
        } else if (old.after_send !== 'changed') {
          await upd(old.id, { after_send: 'changed', changed_at: now, sent_amount: old.sent_amount ?? old.amount });
          counts.flagged++;
        }
      }
    }
  }
  log(`${counts.added} new (wait ${WAIT_MINUTES} min) · ${counts.refreshed} waiting updated · ${counts.deleted} deleted · ${counts.cancelled} cancelled · ${counts.revised} corrected copies queued · ${counts.flagged} flagged (changed/deleted after sending)`);
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
