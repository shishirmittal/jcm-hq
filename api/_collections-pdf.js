// Collections summary PDF (2026-10-14) — the "Summary PDF" button on the 19:00 staff_followup_evening message.
// Built from api/collections.js eveningSummary() at the moment of the tap (live), in the one JCM document
// style (api/_jcm-doc.js jcmKit).
//   1. Totals: followed up today · still due · promised for today
//   2. By person: done (of the morning list), left, promised, no answer
//   3. Promised for today: party, amount — check they came in
//   4. Still due, per person: party, balance, why it is due
import PDFDocument from 'pdfkit'
import { jcmKit, INK, GREY } from './_jcm-doc.js'

const RED = '#b42318', GREEN = '#067647'
const inr = n => (Math.round(Number(n) || 0)).toLocaleString('en-IN')
const longDate = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })

export function buildCollectionsSummaryPdf(sum, when = new Date()) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `Collections summary ${longDate(when)}`, Author: 'J.C. Mittal and Sons, Ratlam' } })
    const chunks = []
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject)
    const K = jcmKit(doc)
    const { L, R, FULL, BOTTOM, label, rule } = K
    let y = K.header()
    y = K.title(y, 'Collections Summary', 'Staff report', 'As on', longDate(when), new Date(when).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }))
    const ensure = h => { if (y + h > BOTTOM) { doc.addPage(); y = K.header() } }

    const col = FULL / 3
    ;[['Followed up today', String(sum.tDone), GREEN], ['Still due', String(sum.tLeft), sum.tLeft ? RED : INK], ['Promised for today', `Rs. ${inr(sum.promiseTotal)}`, INK]].forEach(([t, v, c], i) => {
      label(t, L + i * col, y)
      doc.fillColor(c).font('MM').fontSize(22).text(v, L + i * col, y + 12, { lineBreak: false })
    })
    y += 46
    rule(y); y += 14

    const table = (cols, rows, colorOf = null) => {
      const scale = FULL / cols.reduce((s, c) => s + c[1], 0)
      const head = () => { let x = L; for (const [t, w, al] of cols) { label(t, x + 2, y, { width: w * scale - 6, align: al === 'r' ? 'right' : 'left' }); x += w * scale } rule(y + 11); y += 15 }
      head()
      rows.forEach((cells, ri) => {
        doc.font('S').fontSize(7.5)
        const rowH = Math.max(14, ...cols.map(([, w], i) => doc.heightOfString(String(cells[i] ?? ''), { width: w * scale - 6 }) + 5))
        if (y + rowH > BOTTOM) { doc.addPage(); y = K.header(); head() }
        let x = L
        cols.forEach(([, w, al], i) => {
          doc.fillColor(colorOf ? colorOf(ri, i) || INK : INK).font(al === 'r' ? 'M' : 'S').fontSize(7.5)
            .text(String(cells[i] ?? ''), x + 2, y, { width: w * scale - 6, align: al === 'r' ? 'right' : 'left' })
          x += w * scale
        })
        rule(y + rowH - 2); y += rowH + 2
      })
    }
    const section = (title, right, hint) => {
      ensure(70)
      doc.fillColor(INK).font('S').fontSize(15).text(title, L, y, { lineBreak: false })
      if (right) doc.fillColor(GREY).font('M').fontSize(8).text(right, R - 160, y + 6, { width: 160, align: 'right', lineBreak: false })
      y += 20
      if (hint) { doc.fillColor(GREY).font('S').fontSize(7.5).text(hint, L, y, { width: FULL }); y = doc.y + 8 } else y += 4
    }
    const none = text => { doc.fillColor(GREY).font('S').fontSize(8).text(text, L, y); y += 22 }

    // 2. by person
    section('By person', `${sum.rows.length} people`, 'Done = parties called or noted today (WhatsApp reminders not counted), out of the morning list.')
    if (!sum.rows.length) none('Nobody had follow-ups today.')
    else table([['Person', 190], ['Done', 70, 'r'], ['Left', 60, 'r'], ['Promised', 120, 'r'], ['No answer', 75, 'r']],
      sum.rows.map(r => [r.name, r.of != null ? `${r.done} of ${r.of}` : String(r.done), String(r.left), r.promised ? `${r.promised} · Rs. ${inr(r.promisedAmt)}` : '—', r.noAnswer ? String(r.noAnswer) : '—']),
      (ri, i) => i === 2 && sum.rows[ri].left ? RED : null)
    y += 14

    // 3. promised for today
    section('Promised for today', `${sum.promisedToday.length} parties`, 'Parties who promised to pay today. Check the payments came in; call again if not.')
    if (!sum.promisedToday.length) none('No promises for today.')
    else table([['Party', 380], ['Promised', 135, 'r']], sum.promisedToday.map(p => [p.party_name || p.party_code, `Rs. ${inr(p.promised_amount)}`]))
    y += 14

    // 4. still due, per person
    section('Still due', `${sum.tLeft + sum.unassigned.length} parties`, 'Follow-ups not done yet, per person, biggest first. They stay on tomorrow\'s list.')
    const groups = [...sum.rows.filter(r => r.dueList.length).map(r => [r.name, r.dueList]), ...(sum.unassigned.length ? [['Nobody assigned — set in Assign groups', sum.unassigned]] : [])]
    if (!groups.length) none('Nothing left — every follow-up is done.')
    for (const [who, list] of groups) {
      ensure(48)
      doc.fillColor(INK).font('SB').fontSize(9).text(`${who}  ·  ${list.length}`, L, y, { lineBreak: false, width: FULL })
      y += 16
      table([['Party', 270], ['Due', 100, 'r'], ['Why today', 145]], list.map(x => [x.name, `Rs. ${inr(x.balance)}`, x.reason]))
      y += 8
    }

    const pages = doc.bufferedPageRange()
    for (let i = 0; i < pages.count; i++) { doc.switchToPage(i); K.footer(i + 1, pages.count, 'Collections summary for staff · sent from JCM HQ', longDate(when)) }
    doc.end()
  })
}
