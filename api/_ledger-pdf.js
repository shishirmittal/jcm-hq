import { jcmDoc, money as inr2 } from './_jcm-doc.js'

// Ledger statement PDF for the WhatsApp "Ledger" button. Same numbers as the Customer Card ledger:
// this financial year's postings from party_ledger, running balance worked back from today's outstanding.

const NAVY = '#12213B', GOLD = '#D9AE55', GREY = '#5b6678', LINE = '#e3e7ee', TINT = '#f6f8fb'

async function duesRunAt(busy) {
  const r = await busy.from('party_dues').select('synced_at').order('synced_at', { ascending: false }).limit(1)
  return r.error ? null : (r.data?.[0]?.synced_at || null)
}
function fresh(row, latest) {
  if (!latest || !row?.synced_at) return true
  return Date.parse(row.synced_at) >= Date.parse(latest) - 30 * 60 * 1000
}

// → { rows (oldest first), opening, closing, asOf } or null when the ledger is not synced yet.
export async function loadStatement(busy, partyCode) {
  const code = String(Number(partyCode))
  const [r, dues, runAt, job] = await Promise.all([
    busy.from('party_ledger').select('*').eq('party_code', code)
      .order('vch_date', { ascending: false }).order('vch_code', { ascending: false }).order('sr_no', { ascending: false })
      .range(0, 4999),
    busy.from('party_dues').select('outstanding_balance, synced_at').eq('party_code', code).limit(1),
    duesRunAt(busy),
    busy.from('sync_jobs').select('last_ok_at').eq('job_id', 'ledger').limit(1),
  ])
  if (r.error) return null
  const d = dues.error ? null : dues.data?.[0]
  const closing = d && fresh(d, runAt) ? Number(d.outstanding_balance) || 0 : 0
  let bal = closing
  const newestFirst = (r.data || []).map(x => {
    const row = { date: x.vch_date, type: x.vch_type_name || '', no: x.vch_no || '', debit: Number(x.debit) || 0, credit: Number(x.credit) || 0, balance: Math.round(bal * 100) / 100 }
    bal -= row.debit - row.credit
    return row
  })
  const asOf = (!job.error && job.data?.[0]?.last_ok_at) || null
  return { rows: newestFirst.reverse(), opening: Math.round(bal * 100) / 100, closing, asOf }
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
  const upd = stmt.asOf ? new Date(stmt.asOf).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : null
  return jcmDoc({
    fileTitle: `Statement of Account - ${partyName}`, title: 'Statement of Account', badge: 'Ledger',
    numberLabel: 'Financial year', number: `${fyStart}-${String(fyStart + 1).slice(2)}`, dated: longDate(now),
    blocks: [
      { label: 'Account of', lines: [partyName] },
      { label: 'Period', rows: [['From', `01-04-${fyStart}`], ['To', dmy(now.toISOString())], ['Entries', String(stmt.rows.length)], ['Ledger updated', upd || '—']] },
    ],
    table: {
      cols: [{ k: 'date', t: 'Date', w: 62, mono: true }, { k: 'type', t: 'Particulars', w: 90 }, { k: 'no', t: 'Vch no.', w: 0, mono: true }, { k: 'debit', t: 'Debit', w: 78, right: true }, { k: 'credit', t: 'Credit', w: 78, right: true }, { k: 'balance', t: 'Balance', w: 92, right: true, bold: true }],
      rows: [{ type: 'Opening b/f', balance: drcr(stmt.opening) }, ...rows],
      totalsRows: [{ type: 'Total', debit: inr2(totD), credit: inr2(totC) }, { type: 'Closing balance', balance: drcr(stmt.closing) }],
      empty: 'No entries in this financial year yet.',
    },
    totals: [[stmt.closing >= 0 ? 'AMOUNT DUE FROM YOU' : 'CREDIT BALANCE', `₹${inr2(Math.abs(stmt.closing))}`, { big: true }]],
    leftNote: { label: 'Notes', lines: ['Dr = amount you owe us, Cr = credit in your favour.', 'Payments made in the last day or two may not show yet.', 'If anything looks different from your books, please tell us on WhatsApp.'] },
    footerLeft: 'E. & O.E. · Computer-generated statement, valid without signature.',
  })
}
