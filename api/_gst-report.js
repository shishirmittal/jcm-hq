import PDFDocument from 'pdfkit'
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import { LOGO_PNG } from './_ledger-assets.js'
import { SANS_REG, SANS_MED, MONO_MED } from './_jcm-fonts.js'
import { jcmKit, INK, GREY, PILL_BG, PILL_FG, COMPANY } from './_jcm-doc.js'

// GSTR-2A reconciliation — the two things the WhatsApp messages carry:
//   bannerPng(month)   the header image of the supplier reminder template ("GST MISMATCH /
//                      AUGUST 2026"), same look as the payment-reminder banners (public/wa)
//   buildMismatchPdf   the staff summary: one PDF with a cover (who sent it, which month,
//                      deadline, counts) and one section per red-flag type, party-wise
// Fonts and logo are the ledger PDF's (api/_ledger-assets.js).

const LINE = '#e3e7ee', RED = '#b42318'

export const BUCKET_LABEL = {
  missing_busy: 'Missing in Busy', not_in_2a: 'Not in GSTR-2A', amount: 'Amount mismatch',
  docno: 'Document no. mismatch', sequence: 'Odd numbering', zero: '₹0 value (FOC / scheme)',
}
const BUCKET_HINT = {
  missing_busy: 'In the GST portal (2A) but not entered in Busy — get these bills to the accountant and enter them.',
  not_in_2a: 'Booked in Busy but the supplier has not filed it in GSTR-1 — follow up with the supplier.',
  amount: 'Same invoice on both sides, but taxable or tax differs by more than ₹1 — check the bill and correct Busy or ask the supplier.',
  docno: 'Same invoice (amounts match), invoice number typed differently — correct the number in Busy. Low priority.',
  sequence: 'A supplier invoice number booked twice, or a later bill with a smaller number — check the date or number typed.',
  zero: '₹0 purchase vouchers (FOC, replacement, scheme) — confirm each one is genuine.',
}

const monthName = m => new Date(`${m}-01T00:00:00+05:30`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })
function periodLabel(from, to) {
  if (!to || to === from) return monthName(from)
  const a = new Date(`${from}-01T00:00:00+05:30`), b = new Date(`${to}-01T00:00:00+05:30`)
  if (from.slice(0, 4) === to.slice(0, 4)) return `${a.toLocaleDateString('en-IN', { month: 'short', timeZone: 'Asia/Kolkata' })} – ${b.toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}`
  return `${a.toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })} – ${b.toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}`
}
const inr = n => {
  const v = Math.round(Number(n || 0) * 100) / 100
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
const dmy = s => {
  if (!s) return ''
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00+05:30`)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}
const longDate = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })

// ---------- banner (1200 × 628) — template header for gstr1_filing_reminder ----------
// JCM document style (white, black logo, Instrument Sans + IBM Plex Mono). No navy / gold (Shishir, 2026-10-13).
let fontsReady = false
function fonts() {
  if (fontsReady) return
  GlobalFonts.register(Buffer.from(SANS_REG, 'base64'), 'GSans')
  GlobalFonts.register(Buffer.from(SANS_MED, 'base64'), 'GSansMed')
  GlobalFonts.register(Buffer.from(MONO_MED, 'base64'), 'GMonoMed')
  fontsReady = true
}
export async function bannerPng(month, to = null) {
  const period = periodLabel(month, to)
  fonts()
  const W = 1200, H = 628, X = 470
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H)
  const logo = await loadImage(Buffer.from(LOGO_PNG, 'base64'))
  ctx.drawImage(logo, 110, 164, 280, 280)
  ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(X - 40, 150); ctx.lineTo(X - 40, 478); ctx.stroke()
  const fit = (text, font, size, maxW) => { do { ctx.font = `${size}px ${font}`; size -= 2 } while (ctx.measureText(text).width > maxW && size > 20) }
  const MAXW = W - X - 60
  // pill
  ctx.font = '22px GSansMed'; ctx.letterSpacing = '2px'
  const pill = 'GSTR-1 FILING', pw = ctx.measureText(pill).width + 40
  ctx.fillStyle = PILL_BG; ctx.beginPath(); ctx.roundRect(X, 168, pw, 44, 22); ctx.fill()
  ctx.fillStyle = PILL_FG; ctx.textBaseline = 'middle'; ctx.fillText(pill, X + 20, 191)
  ctx.letterSpacing = '0px'; ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = INK; fit('GST mismatch', 'GSans', 92, MAXW); ctx.fillText('GST mismatch', X, 318)
  fit(period, 'GMonoMed', 46, MAXW); ctx.fillText(period, X, 388)
  ctx.fillStyle = GREY; fit(`${COMPANY.name}, Ratlam · GSTIN ${COMPANY.gstin}`, 'GSans', 26, MAXW); ctx.fillText(`${COMPANY.name}, Ratlam · GSTIN ${COMPANY.gstin}`, X, 448)
  ctx.fillStyle = '#f6f7fb'; ctx.fillRect(0, H - 22, W, 22)
  return canvas.toBuffer('image/png')
}

// ---------- staff summary PDF (JCM document style, api/_jcm-doc.js) ----------
// rows: the reconcile() rows (unmarked) for the chosen kinds; counts/totals: per kind.
export function buildMismatchPdf({ period, kinds, rows, counts, totals, sender, deadline, contacts = {} }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `GSTR-2A mismatch ${period}`, Author: 'J.C. Mittal and Sons, Ratlam' } })
    const chunks = []
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject)
    const K = jcmKit(doc)
    const { L, R, FULL, BOTTOM, label, rule } = K
    let y = K.header()
    y = K.title(y, 'GSTR-2A Mismatch', 'Staff report', 'Period', period, longDate(new Date()))

    const col = FULL / 3
    label('Sent by', L, y); doc.fillColor(INK).font('SB').fontSize(9.5).text(sender || 'JCM HQ', L, y + 11, { lineBreak: false })
    label('Sent on', L + col, y); doc.fillColor(INK).font('SB').fontSize(9.5).text(longDate(new Date()), L + col, y + 11, { lineBreak: false })
    label('Clear all items by', L + 2 * col, y); doc.fillColor(RED).font('SB').fontSize(9.5).text(longDate(deadline), L + 2 * col, y + 11, { lineBreak: false })
    y += 32
    doc.fillColor(GREY).font('S').fontSize(7.5).text('Busy purchase entries compared with the GSTR-2A data downloaded in Busy. Only mismatches are listed, party-wise. Each section says what to do.', L, y, { width: FULL })
    y = doc.y + 10
    rule(y); y += 10

    const cw = [FULL - 190, 60, 130]
    label('Red flag', L + 2, y); label('Items', L + cw[0], y, { width: cw[1] - 4, align: 'right' }); label('Amount (Rs.)', L + cw[0] + cw[1], y, { width: cw[2] - 4, align: 'right' })
    rule(y + 11); y += 16
    for (const k of kinds) {
      doc.fillColor(INK).font('S').fontSize(8)
      doc.text(BUCKET_LABEL[k], L + 2, y, { lineBreak: false }); doc.text(String(counts[k] || 0), L + cw[0], y, { width: cw[1] - 4, align: 'right', lineBreak: false }); doc.text(inr(totals[k] || 0), L + cw[0] + cw[1], y, { width: cw[2] - 4, align: 'right', lineBreak: false })
      rule(y + 12); y += 16
    }
    y += 10

    const colsFor = k => {
      if (k === 'missing_busy') return [['Invoice (2A)', 140], ['Date', 70], ['Taxable', 80, 'r'], ['Tax', 75, 'r'], ['Total', 85, 'r'], ['Filed in', 73]]
      if (k === 'not_in_2a') return [['Bill (Busy)', 140], ['Date', 70], ['Taxable', 80, 'r'], ['Tax', 75, 'r'], ['Total', 85, 'r'], ['Entered by', 73]]
      if (k === 'amount') return [['Invoice', 108], ['Date', 60], ['2A taxable', 70, 'r'], ['Busy taxable', 70, 'r'], ['Diff', 52, 'r'], ['2A tax', 62, 'r'], ['Busy tax', 62, 'r'], ['Diff', 39, 'r']]
      if (k === 'docno') return [['In 2A', 135], ['In Busy', 135], ['Date', 65], ['Taxable', 80, 'r'], ['Tax', 70, 'r'], ['', 38]]
      if (k === 'sequence') return [['Bill (Busy)', 120], ['Date', 65], ['Total', 80, 'r'], ['Issue', 258]]
      return [['Bill (Busy)', 150], ['Date', 70], ['Series', 100], ['Entered by', 100], ['', 103]]
    }
    const cellsFor = (k, r) => {
      if (k === 'missing_busy') return [r.p_no, dmy(r.p_date), inr(r.p_taxable), inr(r.p_tax), inr(r.p_total), r.filed_period || '']
      if (k === 'not_in_2a') return [r.b_no, dmy(r.b_date), inr(r.b_taxable), inr(r.b_tax), inr(r.b_total), r.entered_by || '']
      if (k === 'amount') return [r.p_no, dmy(r.p_date || r.b_date), inr(r.p_taxable), inr(r.b_taxable), inr(r.diff_taxable), inr(r.p_tax), inr(r.b_tax), inr(r.diff_tax)]
      if (k === 'docno') return [r.p_no, r.b_no, dmy(r.p_date || r.b_date), inr(r.p_taxable), inr(r.p_tax), '']
      if (k === 'sequence') return [r.b_no, dmy(r.b_date), inr(r.b_total), `${r.kind}: ${r.note || ''}`]
      return [r.b_no, dmy(r.b_date), (r.note || '').replace(/^Series /, ''), r.entered_by || '', '']
    }
    const ensure = h => { if (y + h > BOTTOM) { doc.addPage(); y = K.header() } }

    for (const k of kinds) {
      const list = rows.filter(r => r.bucket === k)
      ensure(70)
      doc.fillColor(INK).font('S').fontSize(15).text(BUCKET_LABEL[k], L, y, { lineBreak: false })
      doc.fillColor(GREY).font('M').fontSize(8).text(`${list.length} item${list.length === 1 ? '' : 's'}`, R - 120, y + 6, { width: 120, align: 'right', lineBreak: false })
      y += 20
      doc.fillColor(GREY).font('S').fontSize(7.5).text(BUCKET_HINT[k], L, y, { width: FULL })
      y = doc.y + 8
      if (!list.length) { doc.fillColor(GREY).font('S').fontSize(8).text('Nothing here.', L, y); y += 24; continue }
      const byParty = new Map()
      for (const r of list) { const key = `${r.party || ''}|${r.gstin}`; if (!byParty.has(key)) byParty.set(key, []); byParty.get(key).push(r) }
      const cols = colsFor(k)
      const scale = FULL / cols.reduce((s, c) => s + c[1], 0)
      for (const [, prs] of [...byParty.entries()].sort((a, b) => (a[1][0].party || '').localeCompare(b[1][0].party || ''))) {
        const r0 = prs[0]
        ensure(64)
        const c = contacts[r0.gstin]
        const sub = [r0.gstin, c?.station, (c?.whatsapp || c?.mobile) ? String(c.whatsapp || c.mobile) : null].filter(Boolean).join('  ·  ')
        doc.fillColor(INK).font('SB').fontSize(9).text(r0.party || (r0.new_party ? '(not in Busy party master)' : r0.gstin), L, y, { lineBreak: false })
        doc.fillColor(GREY).font('M').fontSize(6.5).text(sub, L, y + 12, { lineBreak: false })
        y += 24
        let x = L
        for (const [t, w, al] of cols) { label(t, x + 2, y, { width: w * scale - 6, align: al === 'r' ? 'right' : 'left' }); x += w * scale }
        rule(y + 11); y += 15
        for (const r of prs) {
          ensure(18)
          x = L
          const cells = cellsFor(k, r)
          doc.fillColor(INK).font('S').fontSize(7.5)
          const rowH = Math.max(14, ...cols.map(([, w], i) => doc.heightOfString(String(cells[i] ?? ''), { width: w * scale - 6 }) + 5))
          cols.forEach(([, w, al], i) => { doc.font(i === 0 ? 'M' : 'S').text(String(cells[i] ?? ''), x + 2, y, { width: w * scale - 6, align: al === 'r' ? 'right' : 'left' }); x += w * scale })
          rule(y + rowH - 2); y += rowH + 2
        }
        y += 10
      }
      y += 6
    }
    const pages = doc.bufferedPageRange()
    for (let i = 0; i < pages.count; i++) { doc.switchToPage(i); K.footer(i + 1, pages.count, 'GSTR-2A mismatch summary for staff · sent from JCM HQ', period) }
    doc.end()
  })
}
