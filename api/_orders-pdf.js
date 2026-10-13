// Orders & material summary PDF (2026-10-14) — the "Summary PDF" button on the 17:30 staff_orders_pending
// message. Built from the live material overview (api/_orders/lib/material.js) at the moment of the tap,
// in the one JCM document style (api/_jcm-doc.js jcmKit — white page, black logo, hairlines).
//   1. Totals: items still to order · ordered but late · parties waiting
//   2. Still to order, by supplier (item, short qty, for whom)
//   3. Ordered but late (item, supplier, short, ordered on, expected)
//   4. Parties waiting (party, SO no. / date, short lines, state)
import PDFDocument from 'pdfkit'
import { jcmKit, INK, GREY } from './_jcm-doc.js'

const RED = '#b42318', AMBER = '#b54708', GREEN = '#067647'
const dmy = s => { const v = String(s || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return v || '—'; const [y, m, d] = v.split('-'); return `${d}-${m}-${y}` }
const longDate = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })
const qty = n => (Number.isInteger(Number(n)) ? String(Number(n)) : String(Math.round(Number(n) * 100) / 100))
const who = i => ((i.orders && i.orders.length) ? i.orders.map(o => o.name) : (i.forParties || [])).join(', ')

export function buildOrdersSummaryPdf(ov, when = new Date()) {
  const all = ov.items.flatMap(g => g.items.map(i => ({ ...i, supplier: g.supplier })))
  const toOrder = ov.items.map(g => ({ supplier: g.supplier, items: g.items.filter(i => !i.orderedAt) })).filter(g => g.items.length)
  const late = all.filter(i => i.orderedAt && i.late).sort((a, b) => String(a.expectedDate).localeCompare(String(b.expectedDate)))
  const parties = ov.parties.filter(p => !p.floor)
  const nToOrder = toOrder.reduce((s, g) => s + g.items.length, 0)

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `Orders & material ${longDate(when)}`, Author: 'J.C. Mittal and Sons, Ratlam' } })
    const chunks = []
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject)
    const K = jcmKit(doc)
    const { L, R, FULL, BOTTOM, label, rule } = K
    let y = K.header()
    y = K.title(y, 'Orders & Material', 'Staff report', 'As on', longDate(when), new Date(when).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }))
    const ensure = h => { if (y + h > BOTTOM) { doc.addPage(); y = K.header() } }

    // 1. totals
    const col = FULL / 3
    ;[['Items still to order', nToOrder, nToOrder ? RED : INK], ['Ordered but late', late.length, late.length ? AMBER : INK], ['Parties waiting for material', parties.length, INK]].forEach(([t, n, c], i) => {
      label(t, L + i * col, y)
      doc.fillColor(c).font('MM').fontSize(22).text(String(n), L + i * col, y + 12, { lineBreak: false })
    })
    y += 46
    rule(y); y += 14

    // table helper: cols = [[title, width, 'r'?]], rows = arrays of cells
    const table = (cols, rows, { firstMono = false, color = null } = {}) => {
      const scale = FULL / cols.reduce((s, c) => s + c[1], 0)
      const head = () => { let x = L; for (const [t, w, al] of cols) { label(t, x + 2, y, { width: w * scale - 6, align: al === 'r' ? 'right' : 'left' }); x += w * scale } rule(y + 11); y += 15 }
      head()
      rows.forEach((cells, ri) => {
        doc.font('S').fontSize(7.5)
        const rowH = Math.max(14, ...cols.map(([, w], i) => doc.heightOfString(String(cells[i] ?? ''), { width: w * scale - 6 }) + 5))
        if (y + rowH > BOTTOM) { doc.addPage(); y = K.header(); head() }
        let x = L
        cols.forEach(([, w, al], i) => {
          doc.fillColor(color && i === cols.length - 1 ? color(ri) : INK).font(i === 0 && firstMono ? 'M' : 'S').fontSize(7.5)
            .text(String(cells[i] ?? ''), x + 2, y, { width: w * scale - 6, align: al === 'r' ? 'right' : 'left' })
          x += w * scale
        })
        rule(y + rowH - 2); y += rowH + 2
      })
    }
    const section = (title, count, hint) => {
      ensure(70)
      doc.fillColor(INK).font('S').fontSize(15).text(title, L, y, { lineBreak: false })
      doc.fillColor(GREY).font('M').fontSize(8).text(`${count} ${count === 1 ? 'line' : 'lines'}`, R - 120, y + 6, { width: 120, align: 'right', lineBreak: false })
      y += 20
      doc.fillColor(GREY).font('S').fontSize(7.5).text(hint, L, y, { width: FULL })
      y = doc.y + 8
    }

    // 2. still to order, by supplier
    section('Still to order', nToOrder, 'Short items nobody has ordered yet. Order them and mark "Ordered" with an expected date in JCM HQ, Material page.')
    if (!toOrder.length) { doc.fillColor(GREY).font('S').fontSize(8).text('Nothing — every short item is ordered.', L, y); y += 22 }
    for (const g of toOrder) {
      ensure(48)
      doc.fillColor(INK).font('SB').fontSize(9).text(g.supplier, L, y, { lineBreak: false, width: FULL })
      y += 16
      table([['Item', 300], ['Short', 60, 'r'], ['For', 155]], g.items.map(i => [i.item, qty(i.short), who(i) || '—']))
      y += 8
    }
    y += 6

    // 3. ordered but late
    section('Ordered but late', late.length, 'Ordered with the supplier, but the expected date has passed. Chase the supplier or set a new date.')
    if (!late.length) { doc.fillColor(GREY).font('S').fontSize(8).text('Nothing late.', L, y); y += 22 }
    else table([['Item', 210], ['Supplier', 120], ['Short', 50, 'r'], ['Ordered', 65], ['Expected', 70]], late.map(i => [i.item, i.supplier, qty(i.short), dmy(i.orderedAt), dmy(i.expectedDate)]), { color: () => AMBER })
    y += 14

    // 4. parties waiting
    section('Parties waiting for material', parties.length, 'Orders that cannot go out complete yet. "Not all ordered" = something short is still not ordered with the supplier.')
    if (!parties.length) { doc.fillColor(GREY).font('S').fontSize(8).text('Nobody is waiting.', L, y); y += 22 }
    else table([['Party', 200], ['Order no.', 95], ['Order date', 65], ['Short', 45, 'r'], ['State', 110]],
      parties.map(p => [p.city ? `${p.name}, ${p.city}` : p.name, p.soNo || '', dmy(p.soDate), String(p.shortLines ?? ''), p.status === 'red' ? 'Not all ordered' : p.expectedDate ? `All ordered · by ${dmy(p.expectedDate)}` : 'All ordered']),
      { firstMono: false, color: ri => parties[ri].status === 'red' ? RED : GREEN })

    const pages = doc.bufferedPageRange()
    for (let i = 0; i < pages.count; i++) { doc.switchToPage(i); K.footer(i + 1, pages.count, 'Orders & material summary for staff · sent from JCM HQ', longDate(when)) }
    doc.end()
  })
}
