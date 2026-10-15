import { jcmDoc, money as inr2 } from './_jcm-doc.js'

// Ledger statement PDF for the WhatsApp "Ledger" button and the Customer Card / Payment Follow-up
// "Send ledger" buttons. Opening balance = party_anchor_balance (Busy's balance as at 31 March, Dr positive /
// Cr negative, both sides imported), then this year's postings from party_ledger run forward. Closing =
// opening + debits − credits. party_dues is NOT used: it only holds parties that still owe, so a customer
// sitting in credit (advance paid) came out as 0 Dr with every running balance wrong (2026-10-15).

// → { rows (oldest first), opening, closing, asOf, anchored } or null when the ledger is not synced yet.
export async function loadStatement(busy, partyCode) {
  const code = String(Number(partyCode))
  const [r, anchor, job] = await Promise.all([
    busy.from('party_ledger').select('*').eq('party_code', code)
      .order('vch_date', { ascending: true }).order('vch_code', { ascending: true }).order('sr_no', { ascending: true })
      .range(0, 4999),
    busy.from('party_anchor_balance').select('anchor_balance, anchor_date').eq('party_code', code).limit(1),
    busy.from('sync_jobs').select('last_ok_at').eq('job_id', 'ledger').limit(1),
  ])
  if (r.error) return null
  const a = anchor.error ? null : anchor.data?.[0]
  const opening = Math.round((Number(a?.anchor_balance) || 0) * 100) / 100
  let bal = opening
  const rows = (r.data || []).map(x => {
    const debit = Number(x.debit) || 0, credit = Number(x.credit) || 0
    bal = Math.round((bal + debit - credit) * 100) / 100
    return { date: x.vch_date, type: x.vch_type_name || '', no: x.vch_no || '', debit, credit, balance: bal }
  })
  const asOf = (!job.error && job.data?.[0]?.last_ok_at) || null
  return { rows, opening, closing: bal, asOf, anchored: !!a }
}

const inr = n => (Math.round(n * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const drcr = n => `${inr(Math.abs(n))} ${n >= 0 ? 'Dr' : 'Cr'}`
function dmy(v) {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(+d) ? String(v).slice(0, 10) : d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' })
}
const longDate = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })

export function buildLedgerPdf({ partyName, stmt }) {
  const now = new Date()
  const y = now.getFullYear(), fyStart = now.getMonth() >= 3 ? y : y - 1
  const totD = stmt.rows.reduce((s, x) => s + x.debit, 0), totC = stmt.rows.reduce((s, x) => s + x.credit, 0)
  const rows = stmt.rows.map(x => ({ date: dmy(x.date), type: x.type, no: x.no || '', debit: x.debit ? inr2(x.debit) : '', credit: x.credit ? inr2(x.credit) : '', balance: drcr(x.balance) }))
  const credit = stmt.closing < 0
  const upd = stmt.asOf ? new Date(stmt.asOf).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : null
  return jcmDoc({
    fileTitle: `Statement of Account - ${partyName}`, title: 'Statement of Account', badge: 'Ledger',
    numberLabel: 'Financial year', number: `${fyStart}-${String(fyStart + 1).slice(2)}`, dated: longDate(now),
    blocks: [
      { label: 'Account of', lines: [partyName] },
      { label: 'Period', rows: [['From', `01/04/${fyStart}`], ['To', dmy(now.toISOString())], ['Entries', String(stmt.rows.length)], ['Ledger updated', upd || '—']] },
    ],
    table: {
      cols: [{ k: 'date', t: 'Date', w: 62, mono: true }, { k: 'type', t: 'Particulars', w: 90 }, { k: 'no', t: 'Vch no.', w: 0, mono: true }, { k: 'debit', t: 'Debit', w: 78, right: true }, { k: 'credit', t: 'Credit', w: 78, right: true }, { k: 'balance', t: 'Balance', w: 92, right: true, bold: true }],
      rows: [{ type: 'Opening b/f', balance: drcr(stmt.opening) }, ...rows],
      totalsRows: [{ type: 'Total', debit: inr2(totD), credit: inr2(totC) }, { type: 'Closing balance', balance: drcr(stmt.closing) }],
      empty: 'No entries in this financial year yet.',
    },
    totals: [[credit ? 'CREDIT IN YOUR FAVOUR' : 'AMOUNT DUE FROM YOU', `₹${inr2(Math.abs(stmt.closing))}`, { big: true }]],
    leftNote: { label: 'Notes', lines: [
      credit ? `You have ₹${inr2(Math.abs(stmt.closing))} lying with us as advance / credit. Nothing is due from you; this amount will be adjusted against your next bills.`
             : (stmt.closing > 0 ? `₹${inr2(stmt.closing)} is due from you. Please pay by UPI (QR Code) or bank transfer and share the receipt on WhatsApp.` : 'Your account is fully settled. Nothing is due from you.'),
      'Dr = amount you owe us · Cr = credit in your favour. Opening balance is as at 1 April.',
      'Payments made in the last day or two may not show yet.',
      'If anything looks different from your books, please tell us on WhatsApp.'] },
    footerLeft: 'E. & O.E. · Computer-generated statement, valid without signature.',
  })
}
