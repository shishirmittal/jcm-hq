import PDFDocument from 'pdfkit'
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import { FONT_REG, FONT_BOLD, LOGO_PNG } from './_ledger-assets.js'

// GSTR-2A reconciliation — the two things the WhatsApp messages carry:
//   bannerPng(month)   the header image of the supplier reminder template ("GST MISMATCH /
//                      AUGUST 2026"), same look as the payment-reminder banners (public/wa)
//   buildMismatchPdf   the staff summary: one PDF with a cover (who sent it, which month,
//                      deadline, counts) and one section per red-flag type, party-wise
// Fonts and logo are the ledger PDF's (api/_ledger-assets.js).

const NAVY = '#12213B', GOLD = '#D9AE55', GREY = '#5b6678', LINE = '#e3e7ee', TINT = '#f6f8fb', RED = '#b42318', AMBER = '#b54708'

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

// ---------- banner (1200 × 628, like public/wa/reminder-*.png) ----------
let fontsReady = false
function fonts() {
  if (fontsReady) return
  GlobalFonts.register(Buffer.from(FONT_BOLD, 'base64'), 'JCMBold')
  GlobalFonts.register(Buffer.from(FONT_REG, 'base64'), 'JCMReg')
  fontsReady = true
}
export async function bannerPng(month) {
  fonts()
  const W = 1200, H = 628
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  const g = ctx.createLinearGradient(0, 0, W, 0)
  g.addColorStop(0, '#F3B21A'); g.addColorStop(1, '#F9CB4A')
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = NAVY; ctx.fillRect(0, H - 14, W, 14)
  // logo in a navy circle with a gold ring
  const cx = 275, cy = 300, r = 160
  ctx.beginPath(); ctx.arc(cx, cy, r + 6, 0, Math.PI * 2); ctx.fillStyle = GOLD; ctx.fill()
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = NAVY; ctx.fill()
  const logo = await loadImage(Buffer.from(LOGO_PNG, 'base64'))
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r - 2, 0, Math.PI * 2); ctx.clip()
  ctx.drawImage(logo, cx - (r - 2), cy - (r - 2), (r - 2) * 2, (r - 2) * 2); ctx.restore()
  // text
  ctx.fillStyle = NAVY; ctx.textBaseline = 'alphabetic'
  const fit = (text, size, maxW) => { do { ctx.font = `${size}px JCMBold`; size -= 2 } while (ctx.measureText(text).width > maxW && size > 20) }
  const X = 500, MAXW = W - X - 50
  fit('GST MISMATCH', 86, MAXW); ctx.fillText('GST MISMATCH', X, 262)
  fit(monthName(month).toUpperCase(), 66, MAXW); ctx.fillText(monthName(month).toUpperCase(), X, 350)
  fit('J.C. MITTAL AND SONS, RATLAM', 32, MAXW); ctx.fillText('J.C. MITTAL AND SONS, RATLAM', X, 420)
  return canvas.toBuffer('image/png')
}

// ---------- staff summary PDF ----------
// rows: the reconcile() rows (unmarked) for the chosen kinds; counts/totals: per kind.
export function buildMismatchPdf({ month, kinds, rows, counts, totals, sender, deadline, contacts = {} }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true, info: { Title: `GSTR-2A mismatch ${month}`, Author: 'JCM HQ' } })
    const chunks = []
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject)
    doc.registerFont('R', Buffer.from(FONT_REG, 'base64'))
    doc.registerFont('B', Buffer.from(FONT_BOLD, 'base64'))
    const L = 36, R = doc.page.width - 36, FULL = R - L
    const BOTTOM = doc.page.height - 48

    // ---- header band
    doc.rect(0, 0, doc.page.width, 92).fill(NAVY)
    doc.image(Buffer.from(LOGO_PNG, 'base64'), L, 18, { width: 56 })
    doc.fillColor('#ffffff').font('B').fontSize(17).text('J.C. MITTAL AND SONS', L + 70, 24)
    doc.fillColor(GOLD).font('R').fontSize(10).text('JCM Retails  ·  87-88 Freeganj Road, Ratlam, Madhya Pradesh', L + 70, 48)
    doc.fillColor('#ffffff').font('B').fontSize(12).text('GSTR-2A MISMATCH SUMMARY', R - 230, 30, { width: 230, align: 'right' })
    doc.fillColor(GOLD).font('B').fontSize(14).text(monthName(month).toUpperCase(), R - 230, 50, { width: 230, align: 'right' })

    // ---- cover block
    let y = 112
    doc.fillColor(GREY).font('R').fontSize(9).text('SENT BY', L, y)
    doc.fillColor(NAVY).font('B').fontSize(13).text(sender || 'JCM HQ', L, y + 12)
    doc.fillColor(GREY).font('R').fontSize(9).text('SENT ON', L + 180, y)
    doc.fillColor(NAVY).font('B').fontSize(13).text(longDate(new Date()), L + 180, y + 12)
    const bx = R - 200
    doc.roundedRect(bx, y - 4, 200, 46, 6).fill('#fdecec')
    doc.fillColor(RED).font('R').fontSize(9).text('CLEAR ALL ITEMS BY', bx + 12, y + 4)
    doc.fillColor(RED).font('B').fontSize(14).text(longDate(deadline), bx + 12, y + 18)
    y += 62
    doc.fillColor(GREY).font('R').fontSize(9.5).text(
      'Busy purchase entries compared with the GSTR-2A data downloaded in Busy. Only mismatches are listed, party-wise. Each section says what to do.', L, y, { width: FULL })
    y = doc.y + 12

    // ---- counts table
    const cw = [FULL - 200, 70, 130]
    doc.rect(L, y, FULL, 20).fill(TINT)
    doc.fillColor(GREY).font('B').fontSize(9)
    doc.text('RED FLAG', L + 8, y + 6); doc.text('ITEMS', L + cw[0], y + 6, { width: cw[1], align: 'right' }); doc.text('AMOUNT (Rs.)', L + cw[0] + cw[1], y + 6, { width: cw[2] - 8, align: 'right' })
    y += 20
    for (const k of kinds) {
      doc.fillColor(NAVY).font('R').fontSize(10)
      doc.text(BUCKET_LABEL[k], L + 8, y + 6); doc.text(String(counts[k] || 0), L + cw[0], y + 6, { width: cw[1], align: 'right' }); doc.text(inr(totals[k] || 0), L + cw[0] + cw[1], y + 6, { width: cw[2] - 8, align: 'right' })
      doc.moveTo(L, y + 22).lineTo(R, y + 22).strokeColor(LINE).lineWidth(0.5).stroke()
      y += 22
    }
    y += 14

    // ---- sections
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
    const ensure = h => { if (y + h > BOTTOM) { doc.addPage(); y = 40 } }

    for (const k of kinds) {
      const list = rows.filter(r => r.bucket === k)
      ensure(60)
      doc.fillColor(NAVY).font('B').fontSize(13).text(`${BUCKET_LABEL[k]}  ·  ${list.length} item${list.length === 1 ? '' : 's'}`, L, y)
      y = doc.y + 2
      doc.fillColor(AMBER).font('R').fontSize(9).text(BUCKET_HINT[k], L, y, { width: FULL })
      y = doc.y + 8
      if (!list.length) { doc.fillColor(GREY).font('R').fontSize(10).text('Nothing here.', L, y); y += 24; continue }

      // party-wise
      const byParty = new Map()
      for (const r of list) { const key = `${r.party || ''}|${r.gstin}`; if (!byParty.has(key)) byParty.set(key, []); byParty.get(key).push(r) }
      const cols = colsFor(k)
      const scale = FULL / cols.reduce((s, c) => s + c[1], 0)
      for (const [, prs] of [...byParty.entries()].sort((a, b) => (a[1][0].party || '').localeCompare(b[1][0].party || ''))) {
        const r0 = prs[0]
        ensure(60)
        const c = contacts[r0.gstin]
        const sub = [r0.gstin, c?.station, (c?.whatsapp || c?.mobile) ? String(c.whatsapp || c.mobile) : null].filter(Boolean).join('  ·  ')
        doc.fillColor(NAVY).font('B').fontSize(10.5).text(r0.party || (r0.new_party ? '(not in Busy party master)' : r0.gstin), L, y)
        doc.fillColor(GREY).font('R').fontSize(8.5).text(sub, L, doc.y)
        y = doc.y + 3
        // table head
        doc.rect(L, y, FULL, 16).fill(TINT)
        let x = L
        doc.fillColor(GREY).font('B').fontSize(8)
        for (const [label, w, al] of cols) { doc.text(label.toUpperCase(), x + 4, y + 4, { width: w * scale - 8, align: al === 'r' ? 'right' : 'left', lineBreak: false }); x += w * scale }
        y += 16
        for (const r of prs) {
          ensure(18)
          x = L
          const cells = cellsFor(k, r)
          doc.fillColor(NAVY).font('R').fontSize(8.5)
          const rowH = Math.max(16, ...cols.map(([, w], i) => doc.heightOfString(String(cells[i] ?? ''), { width: w * scale - 8 }) + 6))
          cols.forEach(([, w, al], i) => { doc.text(String(cells[i] ?? ''), x + 4, y + 4, { width: w * scale - 8, align: al === 'r' ? 'right' : 'left' }); x += w * scale })
          doc.moveTo(L, y + rowH).lineTo(R, y + rowH).strokeColor(LINE).lineWidth(0.5).stroke()
          y += rowH
        }
        y += 10
      }
      y += 6
    }

    // ---- footer on every page
    const pages = doc.bufferedPageRange()
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i)
      doc.fillColor(GREY).font('R').fontSize(8)
        .text(`JCM HQ · GSTR-2A mismatch summary · ${monthName(month)} · page ${i + 1} of ${pages.count}`, L, doc.page.height - 30, { width: FULL, align: 'center', lineBreak: false })
    }
    doc.end()
  })
}
