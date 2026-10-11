import PDFDocument from 'pdfkit'
import { FONT_REG, FONT_BOLD, LOGO_PNG } from './_ledger-assets.js'

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
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true, info: { Title: `Statement of Account - ${partyName}`, Author: 'J.C. Mittal and Sons, Ratlam' } })
    const chunks = []
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject)
    doc.registerFont('R', Buffer.from(FONT_REG, 'base64'))
    doc.registerFont('B', Buffer.from(FONT_BOLD, 'base64'))
    const W = doc.page.width, L = 36, R = W - 36, FULL = R - L
    const now = new Date()
    const y = now.getFullYear(), fyStart = now.getMonth() >= 3 ? y : y - 1

    // Header band
    doc.rect(0, 0, W, 92).fill(NAVY)
    doc.rect(0, 92, W, 4).fill(GOLD)
    doc.circle(L + 30, 46, 33).fill(GOLD); doc.circle(L + 30, 46, 30).fill('#ffffff')
    doc.image(Buffer.from(LOGO_PNG, 'base64'), L, 16, { width: 60, height: 60 })
    doc.fillColor('#ffffff').font('B').fontSize(17).text('J.C. MITTAL AND SONS', L + 78, 28)
    doc.fillColor(GOLD).font('R').fontSize(10).text('JCM Retails  ·  87-88 Freeganj Road, Ratlam, Madhya Pradesh', L + 78, 52)
    doc.fillColor('#ffffff').font('B').fontSize(12).text('STATEMENT OF ACCOUNT', R - 200, 36, { width: 200, align: 'right' })

    // Party + summary
    doc.fillColor(GREY).font('R').fontSize(9).text('ACCOUNT OF', L, 112)
    doc.fillColor(NAVY).font('B').fontSize(16).text(partyName, L, 124, { width: FULL * 0.6 })
    doc.fillColor(GREY).font('R').fontSize(9.5).text(`Financial year ${fyStart}-${String(fyStart + 1).slice(2)}  (1 Apr ${fyStart} to ${longDate(now)})`, L, doc.y + 2)
    const bx = R - 190
    doc.roundedRect(bx, 108, 190, 62, 8).fill(TINT)
    doc.fillColor(GREY).font('R').fontSize(9).text(stmt.closing >= 0 ? 'AMOUNT DUE FROM YOU' : 'CREDIT BALANCE', bx + 12, 116)
    doc.fillColor(NAVY).font('B').fontSize(18).text(`Rs. ${inr(Math.abs(stmt.closing))}`, bx + 12, 131)
    let top = Math.max(doc.y + 14, 186)

    // Table
    const cols = [
      { k: 'date', t: 'Date', w: 72 }, { k: 'type', t: 'Particulars', w: 118 }, { k: 'no', t: 'Vch No.', w: 62 },
      { k: 'debit', t: 'Debit', w: 76, right: true }, { k: 'credit', t: 'Credit', w: 76, right: true }, { k: 'balance', t: 'Balance', w: 0, right: true },
    ]
    cols[5].w = FULL - cols.slice(0, 5).reduce((s, c) => s + c.w, 0)
    const header = yy => {
      doc.rect(L, yy, FULL, 20).fill(NAVY)
      let x = L
      doc.fillColor('#ffffff').font('B').fontSize(9)
      for (const c of cols) { doc.text(c.t, x + 4, yy + 6, { width: c.w - 8, align: c.right ? 'right' : 'left', lineBreak: false }); x += c.w }
      return yy + 20
    }
    const line = (yy, vals, o = {}) => {
      if (o.tint) doc.rect(L, yy, FULL, 18).fill(TINT)
      let x = L
      doc.fillColor(o.color || NAVY).font(o.bold ? 'B' : 'R').fontSize(9)
      for (const c of cols) { doc.text(vals[c.k] ?? '', x + 4, yy + 5, { width: c.w - 8, align: c.right ? 'right' : 'left', lineBreak: false, ellipsis: true }); x += c.w }
      doc.moveTo(L, yy + 18).lineTo(R, yy + 18).lineWidth(0.4).strokeColor(LINE).stroke()
      return yy + 18
    }
    let yy = header(top)
    const bottomLimit = doc.page.height - 56
    const ensure = () => { if (yy + 18 > bottomLimit) { doc.addPage(); yy = header(36) } }
    ensure(); yy = line(yy, { type: 'Opening balance b/f', balance: drcr(stmt.opening) }, { bold: true, tint: true })
    stmt.rows.forEach((x, i) => {
      ensure()
      yy = line(yy, { date: dmy(x.date), type: x.type, no: x.no, debit: x.debit ? inr(x.debit) : '', credit: x.credit ? inr(x.credit) : '', balance: drcr(x.balance) }, { tint: i % 2 === 1 })
    })
    const totD = stmt.rows.reduce((s, x) => s + x.debit, 0), totC = stmt.rows.reduce((s, x) => s + x.credit, 0)
    ensure(); yy = line(yy, { type: 'Total', debit: inr(totD), credit: inr(totC) }, { bold: true })
    ensure(); yy = line(yy, { type: 'Closing balance', balance: drcr(stmt.closing) }, { bold: true, tint: true })
    if (!stmt.rows.length) { doc.fillColor(GREY).font('R').fontSize(10).text('No entries in this financial year yet.', L, yy + 14) }

    // Notes
    const upd = stmt.asOf ? ` Ledger updated ${new Date(stmt.asOf).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}.` : ''
    if (yy + 60 > bottomLimit) { doc.addPage(); yy = 36 }
    doc.fillColor(GREY).font('R').fontSize(8.5).text(`Dr = amount you owe us, Cr = credit in your favour.${upd} If anything looks different from your books, please tell us. Payments made in the last day or two may not show yet.`, L, yy + 14, { width: FULL })

    // Footer on every page
    const range = doc.bufferedPageRange()
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i)
      doc.page.margins.bottom = 0 // footer sits in the bottom margin; without this pdfkit adds a blank page
      doc.moveTo(L, doc.page.height - 40).lineTo(R, doc.page.height - 40).lineWidth(0.6).strokeColor(GOLD).stroke()
      doc.fillColor(GREY).font('R').fontSize(8)
        .text('Computer-generated statement from J.C. Mittal and Sons, Ratlam. No signature required.', L, doc.page.height - 32, { width: FULL - 80, lineBreak: false })
        .text(`Page ${i + 1} of ${range.count}`, R - 70, doc.page.height - 32, { width: 70, align: 'right', lineBreak: false })
    }
    doc.end()
  })
}
