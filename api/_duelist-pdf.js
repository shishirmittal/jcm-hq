// Due list PDF (2026-10-14) — the "Due List PDF" button on the 10:00 staff_followup_morning message.
// One person's follow-ups for today (api/collections.js dueListFor), live at the moment of the tap, in the
// JCM document style (api/_jcm-doc.js jcmKit). Every party has its phone number and a green Call button —
// both are tel: links, so a tap in the phone's PDF viewer starts the call.
import PDFDocument from 'pdfkit'
import { jcmKit, INK, GREY } from './_jcm-doc.js'

const RED = '#b42318', GREEN = '#0f7b4a'
const inr = n => (Math.round(Number(n) || 0)).toLocaleString('en-IN')
const longDate = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })
const show = d => `${d.slice(0, 5)} ${d.slice(5)}`

export function buildDueListPdf({ person, list, total }, when = new Date()) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `Follow-ups ${person?.name || ''} ${longDate(when)}`, Author: 'J.C. Mittal and Sons, Ratlam' } })
    const chunks = []
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject)
    const K = jcmKit(doc)
    const { L, R, FULL, BOTTOM, label, rule } = K
    let y = K.header()
    y = K.title(y, "Today's Follow-ups", 'Due list', 'For', person?.name || '—', longDate(when))

    const col = FULL / 3
    ;[['Parties to call', String(list.length), INK], ['Total due', `Rs. ${inr(total)}`, list.length ? RED : INK], ['With a phone number', String(list.filter(x => x.phone).length), INK]].forEach(([t, v, c], i) => {
      label(t, L + i * col, y)
      doc.fillColor(c).font('MM').fontSize(22).text(v, L + i * col, y + 12, { lineBreak: false })
    })
    y += 46
    doc.fillColor(GREY).font('S').fontSize(7.5).text('Tap Call to ring the party. After each call, save the outcome in JCM HQ, Payment Follow-up (promised / call later / no answer). Biggest and most overdue first.', L, y + 6, { width: FULL })
    y = doc.y + 10
    rule(y); y += 12

    // # · Party · Phone · Due · Why today · [Call]
    const C = { n: 18, party: 175, phone: 82, due: 78, why: 104, call: 58 }
    const scale = FULL / Object.values(C).reduce((a, b) => a + b, 0)
    const X = {}; { let x = L; for (const k of Object.keys(C)) { X[k] = x; x += C[k] * scale } }
    const w = k => C[k] * scale - 6
    const head = () => {
      label('#', X.n + 2, y); label('Party', X.party + 2, y); label('Phone', X.phone + 2, y)
      label('Due', X.due + 2, y, { width: w('due'), align: 'right' }); label('Why today', X.why + 2, y)
      rule(y + 11); y += 16
    }
    if (!list.length) {
      doc.fillColor(GREY).font('S').fontSize(9).text('Nothing due today — your list is clear.', L, y)
    } else head()
    list.forEach((x, i) => {
      doc.font('S').fontSize(8)
      const rowH = Math.max(22, doc.heightOfString(x.name, { width: w('party') }) + 10)
      if (y + rowH > BOTTOM) { doc.addPage(); y = K.header(); head() }
      const mid = y + (rowH - 10) / 2 - 2
      doc.fillColor(GREY).font('M').fontSize(7.5).text(String(i + 1), X.n + 2, mid, { lineBreak: false })
      doc.fillColor(INK).font('SM').fontSize(8).text(x.name, X.party + 2, y + 5, { width: w('party') })
      if (x.phone) {
        doc.fillColor(INK).font('M').fontSize(8).text(show(x.phone), X.phone + 2, mid, { lineBreak: false })
        doc.link(X.phone, y, C.phone * scale, rowH - 4, `tel:+91${x.phone}`)
        const bw = C.call * scale - 4, bh = 15, bx = X.call + 2, by = y + (rowH - bh) / 2 - 2
        doc.roundedRect(bx, by, bw, bh, 7.5).fill(GREEN)
        doc.fillColor('#ffffff').font('SB').fontSize(7.5).text('Call', bx, by + 4, { width: bw, align: 'center', lineBreak: false })
        doc.link(bx, by, bw, bh, `tel:+91${x.phone}`)
      } else {
        doc.fillColor(GREY).font('S').fontSize(7.5).text('No number in Busy', X.phone + 2, mid, { width: w('phone') + C.call * scale, lineBreak: false })
      }
      doc.fillColor(INK).font('M').fontSize(8).text(`Rs. ${inr(x.balance)}`, X.due + 2, mid, { width: w('due'), align: 'right', lineBreak: false })
      doc.fillColor(GREY).font('S').fontSize(7.5).text(x.reason || '', X.why + 2, mid, { width: w('why'), lineBreak: false })
      rule(y + rowH - 2); y += rowH
    })

    const pages = doc.bufferedPageRange()
    for (let i = 0; i < pages.count; i++) { doc.switchToPage(i); K.footer(i + 1, pages.count, `Payment follow-ups for ${person?.name || 'staff'} · sent from JCM HQ`, longDate(when)) }
    doc.end()
  })
}
