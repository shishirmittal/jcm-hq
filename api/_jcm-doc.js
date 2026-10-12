// The one JCM document style for every PDF sent on WhatsApp (Shishir's rule, 2026-10-12):
// the invoice-portal tax-invoice look — white A4, black JCM logo + "J.C.Mittal And Sons" with the
// GSTIN at top-left and address / phone at top-right, a big thin title with a small pill badge, the
// document number in monospace with "Dated …", small uppercase grey labels over values, a
// hairline-ruled table with uppercase grey headers, totals at the right, terms bottom-left and a
// one-line grey footer. Fonts: Instrument Sans + IBM Plex Mono (api/_jcm-fonts.js).
//
//   jcmDoc({
//     fileTitle, title, badge, numberLabel, number, dated,
//     blocks: [ { label, lines: ['Name', 'Ratlam'] } | { label, rows: [['Place of supply', 'MP (23)'], …] } ],
//     table: { cols: [{ k, t, w, right?, bold?, mono? }], rows: [{ k: value }] },   // one col with w 0 = flexible
//     totals: [ ['Taxable value', '2,801.86'] , ['TOTAL', '₹3,306.00', { big: true }] ],
//     words: 'Rupees … Only', leftNote: { label: 'TERMS', lines: [...] }, rightNote: { label, lines },
//     footerLeft,
//   }) → Promise<Buffer>
import PDFDocument from 'pdfkit'
import { SANS_REG, SANS_MED, SANS_BOLD, MONO_REG, MONO_MED, RUPEE_REG, RUPEE_BOLD } from './_jcm-fonts.js'
import { LOGO_PNG } from './_ledger-assets.js'

export const INK = '#111111', GREY = '#6b7280', LINE = '#e5e7eb', PILL_BG = '#eef2ff', PILL_FG = '#3b5bdb', SOFT = '#f6f7fb'
export const COMPANY = { name: 'J.C.Mittal And Sons', gstin: '23AAPFJ0607D1ZT', addr1: '87-88 Freeganj Road, Ratlam, MP 457001', addr2: '+91 91091 05999 · www.jcmretails.com' }

export const money = n => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const dmy = v => {
  const s = String(v || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s || '—'
  const [y, m, d] = s.split('-'); return `${d}-${m}-${y}`
}
export const stampIST = (d = new Date()) => new Date(d).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }).replace(',', '')

// Indian number to words (rupees only, paise ignored) — "Rupees Three Thousand Three Hundred Six Only".
export function rupeesInWords(n) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
  const two = x => x < 20 ? ones[x] : `${tens[Math.floor(x / 10)]}${x % 10 ? ' ' + ones[x % 10] : ''}`
  const three = x => `${x >= 100 ? ones[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' : '') : ''}${x % 100 ? two(x % 100) : ''}`
  let v = Math.round(Math.abs(Number(n) || 0))
  if (!v) return 'Rupees Zero Only'
  const parts = []
  const crore = Math.floor(v / 1e7); v %= 1e7
  const lakh = Math.floor(v / 1e5); v %= 1e5
  const thousand = Math.floor(v / 1e3); v %= 1e3
  if (crore) parts.push(`${two(crore)} Crore`)
  if (lakh) parts.push(`${two(lakh)} Lakh`)
  if (thousand) parts.push(`${two(thousand)} Thousand`)
  if (v) parts.push(three(v))
  return `Rupees ${parts.join(' ')} Only`
}

export function jcmDoc(spec) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: spec.fileTitle || spec.title, Author: 'J.C. Mittal and Sons, Ratlam' } })
    const chunks = []
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject)
    doc.registerFont('S', Buffer.from(SANS_REG, 'base64'))
    doc.registerFont('SM', Buffer.from(SANS_MED, 'base64'))
    doc.registerFont('SB', Buffer.from(SANS_BOLD, 'base64'))
    doc.registerFont('M', Buffer.from(MONO_REG, 'base64'))
    doc.registerFont('MM', Buffer.from(MONO_MED, 'base64'))
    doc.registerFont('RR', Buffer.from(RUPEE_REG, 'base64'))
    doc.registerFont('RB', Buffer.from(RUPEE_BOLD, 'base64'))
    // Instrument Sans has no ₹ — draw the sign from a DejaVu subset, then the number. Right-aligned in `width`.
    const rupeeText = (text, x, y, width, { font = 'S', size = 7.5, align = 'right', color = INK } = {}) => {
      const t = String(text)
      if (!t.startsWith('₹')) { doc.fillColor(color).font(font).fontSize(size).text(t, x, y, { width, align, lineBreak: false }); return }
      const rest = t.slice(1)
      const rf = font === 'SB' || font === 'SM' ? 'RB' : 'RR'
      doc.font(rf).fontSize(size); const wr = doc.widthOfString('₹')
      doc.font(font).fontSize(size); const wn = doc.widthOfString(rest)
      const x0 = align === 'right' ? x + width - wr - wn : x
      doc.fillColor(color).font(rf).fontSize(size).text('₹', x0, y + size * 0.04, { lineBreak: false })
      doc.font(font).fontSize(size).text(rest, x0 + wr, y, { lineBreak: false })
    }
    const W = doc.page.width, H = doc.page.height, L = 40, R = W - 40, FULL = R - L, BOTTOM = H - 54
    const label = (t, x, y, o = {}) => doc.fillColor(GREY).font('SM').fontSize(6.5).text(String(t).toUpperCase(), x, y, { characterSpacing: 0.6, lineBreak: false, height: 10, ...o })
    const rule = (y, x1 = L, x2 = R, c = LINE) => doc.moveTo(x1, y).lineTo(x2, y).lineWidth(0.5).strokeColor(c).stroke()
    const fit = (text, width, font, size) => {
      doc.font(font).fontSize(size)
      let t = String(text ?? '')
      if (doc.widthOfString(t) <= width) return t
      while (t.length > 1 && doc.widthOfString(t + '…') > width) t = t.slice(0, -1)
      return t + '…'
    }

    // ---- header (every page)
    const header = () => {
      doc.image(Buffer.from(LOGO_PNG, 'base64'), L, 36, { width: 34, height: 34 })
      doc.fillColor(INK).font('SB').fontSize(15).text(COMPANY.name, L + 44, 38, { lineBreak: false })
      doc.fillColor(GREY).font('M').fontSize(6.5).text(`GSTIN ${COMPANY.gstin}`, L + 44, 58, { lineBreak: false })
      doc.fillColor(GREY).font('S').fontSize(6.5).text(COMPANY.addr1, R - 260, 40, { width: 260, align: 'right', lineBreak: false })
      doc.text(COMPANY.addr2, R - 260, 50, { width: 260, align: 'right', lineBreak: false })
      return 92
    }
    // ---- footer (every page, after we know the count)
    const footer = (i, n) => {
      doc.page.margins.bottom = 0
      rule(H - 40)
      doc.fillColor(GREY).font('S').fontSize(6.5).text(spec.footerLeft || 'E. & O.E. · Computer-generated document, valid without signature.', L, H - 33, { lineBreak: false })
      doc.font('M').fontSize(6.5).text(`${spec.number ? spec.number + ' · ' : ''}${stampIST()} · Page ${i} of ${n}`, R - 260, H - 33, { width: 260, align: 'right', lineBreak: false })
    }

    let y = header()
    // ---- title row
    doc.fillColor(INK).font('S').fontSize(26).text(spec.title, L, y, { lineBreak: false })
    let tx = L + doc.widthOfString(spec.title) + 12
    if (spec.badge) {
      doc.font('SM').fontSize(6.5)
      const bw = doc.widthOfString(String(spec.badge).toUpperCase(), { characterSpacing: 0.6 }) + 16
      doc.roundedRect(tx, y + 11, bw, 13, 6.5).fill(PILL_BG)
      doc.fillColor(PILL_FG).text(String(spec.badge).toUpperCase(), tx + 8, y + 14.5, { characterSpacing: 0.6, lineBreak: false })
    }
    if (spec.number) {
      label(spec.numberLabel || 'Document no.', R - 220, y + 2, { width: 220, align: 'right' })
      doc.fillColor(INK).font('MM').fontSize(15).text(spec.number, R - 260, y + 11, { width: 260, align: 'right', lineBreak: false })
      if (spec.dated) doc.fillColor(GREY).font('M').fontSize(7).text(`Dated ${spec.dated}`, R - 260, y + 30, { width: 260, align: 'right', lineBreak: false })
    }
    y += 50
    rule(y)
    y += 12

    // ---- blocks (columns)
    const blocks = spec.blocks || []
    if (blocks.length) {
      const colW = FULL / blocks.length
      let maxY = y
      blocks.forEach((b, i) => {
        const x = L + i * colW
        let yy = y
        label(b.label, x, yy); yy += 11
        if (b.lines) {
          b.lines.filter(Boolean).forEach((line, j) => {
            doc.fillColor(INK).font(j === 0 ? 'SB' : 'S').fontSize(j === 0 ? 9.5 : 8).text(fit(line, colW - 14, j === 0 ? 'SB' : 'S', j === 0 ? 9.5 : 8), x, yy, { lineBreak: false })
            yy += j === 0 ? 14 : 12
          })
        }
        if (b.rows) {
          for (const [k, v, o] of b.rows) {
            doc.fillColor(GREY).font('S').fontSize(7.5).text(k, x, yy, { lineBreak: false })
            doc.fillColor(o?.muted ? GREY : INK).font(o?.mono ? 'M' : 'S').fontSize(7.5).text(fit(v ?? '—', colW - 90, o?.mono ? 'M' : 'S', 7.5), x + 78, yy, { lineBreak: false })
            yy += 12
          }
        }
        maxY = Math.max(maxY, yy)
      })
      y = maxY + 8
      rule(y)
      y += 10
    }

    // ---- table
    const t = spec.table
    if (t) {
      const cols = t.cols.map(c => ({ ...c }))
      const flex = cols.find(c => !c.w) || cols[cols.length - 1]
      flex.w = 0; flex.w = FULL - cols.reduce((s, c) => s + c.w, 0)
      const head = yy => {
        let x = L
        for (const c of cols) { label(c.t, x + (c.right ? 0 : 2), yy, { width: c.w - 4, align: c.right ? 'right' : 'left' }); x += c.w }
        rule(yy + 11)
        return yy + 16
      }
      const rowH = 16
      const twoLines = r => { doc.font('S').fontSize(7.5); return doc.heightOfString(String(r[flex.k] ?? ''), { width: flex.w - 6 }) > 11 }
      const line = (yy, r, o = {}) => {
        let x = L
        const tall = !o.bold && twoLines(r)
        for (const c of cols) {
          const font = o.bold || c.bold ? 'SB' : c.mono ? 'M' : 'S'
          doc.fillColor(o.grey ? GREY : INK).font(font).fontSize(7.5)
          if (c === flex && tall) doc.text(String(r[c.k] ?? ''), x + 2, yy, { width: c.w - 6, height: 22, ellipsis: true })
          else if (String(r[c.k] ?? '').startsWith('₹')) rupeeText(r[c.k], x, yy, c.w - 4, { font, align: c.right ? 'right' : 'left' })
          else doc.text(fit(r[c.k] ?? '', c.w - 6, font, 7.5), x + (c.right ? 0 : 2), yy, { width: c.w - 4, align: c.right ? 'right' : 'left', lineBreak: false })
          x += c.w
        }
        const h = tall ? rowH + 10 : rowH
        rule(yy + h - 4, L, R, o.strong ? '#cbd5e1' : LINE)
        return yy + h
      }
      y = head(y)
      const ensure = () => { if (y + rowH + 12 > BOTTOM - 20) { doc.addPage(); y = header(); y = head(y) } }
      for (const r of t.rows) { ensure(); y = line(y, r) }
      for (const r of t.totalsRows || []) { ensure(); y = line(y, r, { bold: true, strong: true }) }
      if (!t.rows.length) { doc.fillColor(GREY).font('S').fontSize(8).text(t.empty || 'Nothing to show.', L, y + 4); y += 20 }
      y += 10
    }

    // ---- words + totals
    const needs = (spec.totals?.length || 0) * 13 + (spec.words ? 30 : 0) + 30
    if (y + needs > BOTTOM) { doc.addPage(); y = header() }
    if (spec.totals?.length || spec.words) {
      const leftW = FULL * 0.55
      let ly = y
      if (spec.words) {
        label('Amount in words', L, ly); ly += 11
        doc.fillColor(INK).font('SB').fontSize(8.5).text(spec.words, L, ly, { width: leftW - 20 }); ly = doc.y + 10
      }
      if (spec.leftTable) {
        label(spec.leftTable.label, L, ly); ly += 12
        const n = spec.leftTable.cols.length
        const first = 40, cw = (leftW - 20 - first) / (n - 1)
        const xAt = i => (i === 0 ? L : L + first + (i - 1) * cw)
        const wAt = i => (i === 0 ? first : cw)
        spec.leftTable.cols.forEach((c, i) => label(c, xAt(i), ly, { width: wAt(i) - 4, align: i ? 'right' : 'left' })); ly += 11
        for (const r of spec.leftTable.rows) { r.forEach((v, i) => doc.fillColor(INK).font('S').fontSize(7.5).text(String(v), xAt(i), ly, { width: wAt(i) - 4, align: i ? 'right' : 'left', lineBreak: false })); ly += 12 }
      }
      let ty = y
      const tx0 = L + leftW + 10, tw = FULL - leftW - 10
      for (const [k, v, o = {}] of spec.totals || []) {
        if (o.big) { rule(ty + 2, tx0, R, '#cbd5e1'); ty += 10 }
        doc.fillColor(o.big ? INK : GREY).font(o.big ? 'SB' : 'S').fontSize(o.big ? 8 : 7.5).text(k, tx0, ty + (o.big ? 4 : 0), { lineBreak: false })
        rupeeText(v, tx0, ty - (o.big ? 2 : 0), tw, { font: o.big ? 'SB' : 'S', size: o.big ? 15 : 7.5 })
        ty += o.big ? 22 : 13
        if (o.sub) { doc.fillColor(GREY).font('S').fontSize(6.5).text(o.sub, tx0, ty - 4, { width: tw, align: 'right', lineBreak: false }); ty += 10 }
      }
      y = Math.max(ly, ty) + 10
      rule(y); y += 10
    }

    // ---- notes (two columns)
    if (spec.leftNote || spec.rightNote) {
      if (y + 70 > BOTTOM) { doc.addPage(); y = header() }
      const half = FULL / 2
      let ly = y, ry = y
      if (spec.leftNote) {
        label(spec.leftNote.label, L, ly); ly += 11
        spec.leftNote.lines.forEach((t, i) => { doc.fillColor(INK).font('S').fontSize(7).text(`${i + 1}. ${t}`, L, ly, { width: half - 16 }); ly = doc.y + 2 })
      }
      if (spec.rightNote) {
        const x = L + half + 8
        label(spec.rightNote.label, x, ry); ry += 11
        for (const [k, v] of spec.rightNote.rows || []) { doc.fillColor(GREY).font('S').fontSize(7.5).text(k, x, ry, { lineBreak: false }); doc.fillColor(INK).font('S').fontSize(7.5).text(v, x + 70, ry, { lineBreak: false }); ry += 12 }
        if (spec.rightNote.pill) {
          ry += 4
          doc.roundedRect(x, ry, half - 16, 18, 4).fill(PILL_BG)
          doc.fillColor(PILL_FG).font('SM').fontSize(6.5).text(spec.rightNote.pill[0].toUpperCase(), x + 8, ry + 6, { characterSpacing: 0.6, lineBreak: false })
          doc.fillColor(INK).font('MM').fontSize(9).text(spec.rightNote.pill[1], x + 8, ry + 4, { width: half - 32, align: 'right', lineBreak: false })
        }
      }
      y = Math.max(ly, ry)
    }

    const range = doc.bufferedPageRange()
    for (let i = 0; i < range.count; i++) { doc.switchToPage(range.start + i); footer(i + 1, range.count) }
    doc.end()
  })
}

// ---- Low-level kit for documents with several tables (GST report etc.) — same look as jcmDoc.
export function jcmKit(doc) {
  doc.registerFont('S', Buffer.from(SANS_REG, 'base64'))
  doc.registerFont('SM', Buffer.from(SANS_MED, 'base64'))
  doc.registerFont('SB', Buffer.from(SANS_BOLD, 'base64'))
  doc.registerFont('M', Buffer.from(MONO_REG, 'base64'))
  doc.registerFont('MM', Buffer.from(MONO_MED, 'base64'))
  const W = doc.page.width, H = doc.page.height, L = 40, R = W - 40, FULL = R - L, BOTTOM = H - 54
  const label = (t, x, y, o = {}) => doc.fillColor(GREY).font('SM').fontSize(6.5).text(String(t).toUpperCase(), x, y, { characterSpacing: 0.6, lineBreak: false, height: 10, ...o })
  const rule = (y, x1 = L, x2 = R, c = LINE) => doc.moveTo(x1, y).lineTo(x2, y).lineWidth(0.5).strokeColor(c).stroke()
  const header = () => {
    doc.image(Buffer.from(LOGO_PNG, 'base64'), L, 36, { width: 34, height: 34 })
    doc.fillColor(INK).font('SB').fontSize(15).text(COMPANY.name, L + 44, 38, { lineBreak: false })
    doc.fillColor(GREY).font('M').fontSize(6.5).text(`GSTIN ${COMPANY.gstin}`, L + 44, 58, { lineBreak: false })
    doc.fillColor(GREY).font('S').fontSize(6.5).text(COMPANY.addr1, R - 260, 40, { width: 260, align: 'right', lineBreak: false })
    doc.text(COMPANY.addr2, R - 260, 50, { width: 260, align: 'right', lineBreak: false })
    return 92
  }
  const title = (y, text, badge, numberLabel, number, dated) => {
    doc.fillColor(INK).font('S').fontSize(26).text(text, L, y, { lineBreak: false })
    const tx = L + doc.widthOfString(text) + 12
    if (badge) {
      doc.font('SM').fontSize(6.5)
      const bw = doc.widthOfString(String(badge).toUpperCase(), { characterSpacing: 0.6 }) + 16
      doc.roundedRect(tx, y + 11, bw, 13, 6.5).fill(PILL_BG)
      doc.fillColor(PILL_FG).text(String(badge).toUpperCase(), tx + 8, y + 14.5, { characterSpacing: 0.6, lineBreak: false })
    }
    if (number) {
      label(numberLabel || 'Document', R - 220, y + 2, { width: 220, align: 'right' })
      doc.fillColor(INK).font('MM').fontSize(15).text(number, R - 260, y + 11, { width: 260, align: 'right', lineBreak: false })
      if (dated) doc.fillColor(GREY).font('M').fontSize(7).text(`Dated ${dated}`, R - 260, y + 30, { width: 260, align: 'right', lineBreak: false })
    }
    rule(y + 50)
    return y + 62
  }
  const footer = (i, n, left, right) => {
    doc.page.margins.bottom = 0
    rule(H - 40)
    doc.fillColor(GREY).font('S').fontSize(6.5).text(left || 'E. & O.E. · Computer-generated document, valid without signature.', L, H - 33, { lineBreak: false })
    doc.font('M').fontSize(6.5).text(`${right ? right + ' · ' : ''}${stampIST()} · Page ${i} of ${n}`, R - 260, H - 33, { width: 260, align: 'right', lineBreak: false })
  }
  return { L, R, FULL, BOTTOM, H, W, label, rule, header, title, footer }
}
