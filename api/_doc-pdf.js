// Order copy and invoice copy PDFs for WhatsApp button replies (2026-10-12).
//   buildOrderPdf   — "Order copy" button on txn_order: the sales order as JCM Orders has it
//                     (CRM project: orders + order_lines, by so_vch_no).
//   buildInvoicePdf — "Invoice PDF" button on order_dispatched*: from the invoice portal's
//                     tables in the Busy project (invoices + invoice_items by vch_no; synced nightly).
// Same look as the ledger statement (api/_ledger-pdf.js). Not a tax invoice — a copy for the customer.
import PDFDocument from 'pdfkit'
import { FONT_REG, FONT_BOLD, LOGO_PNG } from './_ledger-assets.js'

const NAVY = '#12213B', GOLD = '#D9AE55', GREY = '#5b6678', LINE = '#e3e7ee', TINT = '#f6f8fb'
const inr = n => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const qty = q => (Number.isInteger(Number(q)) ? String(Number(q)) : String(Math.round(Number(q) * 1000) / 1000))
const dmy = v => {
  const s = String(v || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s || '—'
  const [y, m, d] = s.split('-')
  return `${d}/${m}/${y}`
}

// One generic document: header band, a title, a party block, a key/value box, a table, totals, notes.
function render({ title, fileTitle, party, info, box, cols, rows, totals, note }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true, info: { Title: fileTitle, Author: 'J.C. Mittal and Sons, Ratlam' } })
    const chunks = []
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject)
    doc.registerFont('R', Buffer.from(FONT_REG, 'base64'))
    doc.registerFont('B', Buffer.from(FONT_BOLD, 'base64'))
    const W = doc.page.width, L = 36, R = W - 36, FULL = R - L

    doc.rect(0, 0, W, 92).fill(NAVY)
    doc.rect(0, 92, W, 4).fill(GOLD)
    doc.circle(L + 30, 46, 33).fill(GOLD); doc.circle(L + 30, 46, 30).fill('#ffffff')
    doc.image(Buffer.from(LOGO_PNG, 'base64'), L, 16, { width: 60, height: 60 })
    doc.fillColor('#ffffff').font('B').fontSize(17).text('J.C. MITTAL AND SONS', L + 78, 28)
    doc.fillColor(GOLD).font('R').fontSize(10).text('JCM Retails  ·  87-88 Freeganj Road, Ratlam, Madhya Pradesh', L + 78, 52)
    doc.fillColor('#ffffff').font('B').fontSize(12).text(title, R - 200, 36, { width: 200, align: 'right' })

    doc.fillColor(GREY).font('R').fontSize(9).text(party.label, L, 112)
    doc.fillColor(NAVY).font('B').fontSize(15).text(party.name, L, 124, { width: FULL * 0.58 })
    for (const line of party.lines || []) doc.fillColor(GREY).font('R').fontSize(9.5).text(line, L, doc.y + 1, { width: FULL * 0.58 })
    const bx = R - 200
    doc.roundedRect(bx, 108, 200, 16 + box.length * 15, 8).fill(TINT)
    let by = 116
    for (const [k, v] of box) {
      doc.fillColor(GREY).font('R').fontSize(8.5).text(k, bx + 12, by)
      doc.fillColor(NAVY).font('B').fontSize(9.5).text(v, bx + 70, by - 1, { width: 120, align: 'right' })
      by += 15
    }
    let top = Math.max(doc.y + 14, 108 + 16 + box.length * 15 + 14)
    for (const line of info || []) { doc.fillColor(GREY).font('R').fontSize(9).text(line, L, top, { width: FULL }); top = doc.y + 4 }
    top += 6

    const fit = (text, width) => {
      let t = String(text ?? '')
      if (doc.widthOfString(t) <= width) return t
      while (t.length > 1 && doc.widthOfString(t + '…') > width) t = t.slice(0, -1)
      return t + '…'
    }
    cols[cols.length - 1].w = FULL - cols.slice(0, -1).reduce((s, c) => s + c.w, 0)
    const header = yy => {
      doc.rect(L, yy, FULL, 20).fill(NAVY)
      let x = L
      doc.fillColor('#ffffff').font('B').fontSize(9)
      for (const c of cols) { doc.text(fit(c.t, c.w - 8), x + 4, yy + 6, { width: c.w - 8, align: c.right ? 'right' : 'left', lineBreak: false }); x += c.w }
      return yy + 20
    }
    const line = (yy, vals, o = {}) => {
      if (o.tint) doc.rect(L, yy, FULL, 18).fill(TINT)
      let x = L
      doc.fillColor(NAVY).font(o.bold ? 'B' : 'R').fontSize(9)
      for (const c of cols) { doc.text(fit(vals[c.k] ?? '', c.w - 8), x + 4, yy + 5, { width: c.w - 8, align: c.right ? 'right' : 'left', lineBreak: false }); x += c.w }
      doc.moveTo(L, yy + 18).lineTo(R, yy + 18).lineWidth(0.4).strokeColor(LINE).stroke()
      return yy + 18
    }
    let yy = header(top)
    const bottomLimit = doc.page.height - 56
    const ensure = () => { if (yy + 18 > bottomLimit) { doc.addPage(); yy = header(36) } }
    rows.forEach((r, i) => { ensure(); yy = line(yy, r, { tint: i % 2 === 1 }) })
    for (const t of totals) { ensure(); yy = line(yy, t, { bold: true, tint: true }) }
    if (!rows.length) doc.fillColor(GREY).font('R').fontSize(10).text('No lines found.', L, yy + 14)
    if (yy + 60 > bottomLimit) { doc.addPage(); yy = 36 }
    if (note) doc.fillColor(GREY).font('R').fontSize(8.5).text(note, L, yy + 14, { width: FULL })

    const range = doc.bufferedPageRange()
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i)
      doc.page.margins.bottom = 0
      doc.fillColor(GREY).font('R').fontSize(8).text(`J.C. Mittal and Sons, Ratlam  ·  WhatsApp +91 91091 05999  ·  Page ${i + 1} of ${range.count}`, L, doc.page.height - 30, { width: FULL, align: 'center', lineBreak: false })
    }
    doc.end()
  })
}

// ---- Order copy (JCM Orders, CRM project) ----------------------------------
export async function loadOrder(hq, soVchNo) {
  const o = await hq.from('orders').select('id, so_vch_no, so_date, party_name, party_city, party_mobile, stage, boxes, invoice_vch_no').eq('so_vch_no', soVchNo).order('so_date', { ascending: false }).limit(1).maybeSingle()
  if (o.error || !o.data) return null
  const l = await hq.from('order_lines').select('line_no, item_name, ordered_qty, invoiced_qty, line_value').eq('order_id', o.data.id).order('line_no')
  return { order: o.data, lines: l.data || [] }
}

export function buildOrderPdf({ partyName, order, lines }) {
  const rows = lines.map((l, i) => {
    const q = Number(l.ordered_qty) || 0, v = Number(l.line_value) || 0
    return { n: String(i + 1), item: l.item_name || 'Item', qty: qty(q), rate: q ? inr(v / q) : '', amount: v ? inr(v) : '' }
  })
  const total = lines.reduce((s, l) => s + (Number(l.line_value) || 0), 0)
  return render({
    title: 'SALES ORDER COPY', fileTitle: `Order ${order.so_vch_no} - ${partyName}`,
    party: { label: 'ORDER FOR', name: partyName, lines: [order.party_city].filter(Boolean) },
    box: [['Order No.', order.so_vch_no || '—'], ['Date', dmy(order.so_date)], ['Items', String(lines.length)]],
    cols: [{ k: 'n', t: '#', w: 26 }, { k: 'item', t: 'Item', w: 0 }, { k: 'qty', t: 'Qty', w: 56, right: true }, { k: 'rate', t: 'Rate', w: 74, right: true }, { k: 'amount', t: 'Amount', w: 90, right: true }],
    rows, totals: total ? [{ item: 'Order value', amount: inr(total) }] : [],
    note: 'This is a copy of your order as booked with us, for checking. Rates are as on the order; the invoice may differ if prices change before billing. Reply on WhatsApp for any change.',
  })
}

// ---- Invoice copy (invoice portal tables, Busy project) ---------------------
export async function loadInvoice(busy, vchNo) {
  const i = await busy.from('invoices').select('*').eq('vch_no', vchNo).order('vch_date', { ascending: false }).limit(1).maybeSingle()
  if (i.error || !i.data) return null
  const l = await busy.from('invoice_items').select('*').eq('vch_no', vchNo).order('line_no')
  return { invoice: i.data, items: l.data || [] }
}

export function buildInvoicePdf({ partyName, invoice, items }) {
  const rows = items.map((l, i) => ({
    n: String(i + 1), item: l.item_name || 'Item', hsn: l.hsn_code || '', qty: qty(l.qty), rate: inr(l.rate),
    taxable: inr(l.taxable_amount), gst: l.gst_rate != null ? `${Number(l.gst_rate)}%` : '', tax: inr(l.tax_amount),
  }))
  const taxable = items.reduce((s, l) => s + (Number(l.taxable_amount) || 0), 0)
  const tax = items.reduce((s, l) => s + (Number(l.tax_amount) || 0), 0)
  const total = Number(invoice.total_amount) || taxable + tax
  const partyLines = [invoice.customer_address, invoice.customer_gst_no ? `GSTIN ${invoice.customer_gst_no}` : null].filter(Boolean)
  const info = [
    [invoice.transport ? `Transport: ${invoice.transport}` : null, invoice.vehicle_no ? `Vehicle: ${invoice.vehicle_no}` : null, invoice.gr_no ? `LR/GR: ${invoice.gr_no}` : null].filter(Boolean).join('   ·   ') || null,
    invoice.einvoice_irn ? `e-Invoice IRN: ${invoice.einvoice_irn}` : null,
  ].filter(Boolean)
  return render({
    title: 'INVOICE COPY', fileTitle: `Invoice ${invoice.vch_no} - ${partyName}`,
    party: { label: 'BILLED TO', name: invoice.customer_name || partyName, lines: partyLines }, info,
    box: [['Invoice No.', invoice.vch_no || '—'], ['Date', dmy(invoice.vch_date)], ['Amount', `Rs. ${inr(total)}`]],
    cols: [{ k: 'n', t: '#', w: 24 }, { k: 'item', t: 'Item', w: 0 }, { k: 'hsn', t: 'HSN', w: 50 }, { k: 'qty', t: 'Qty', w: 44, right: true }, { k: 'rate', t: 'Rate', w: 62, right: true }, { k: 'taxable', t: 'Taxable', w: 70, right: true }, { k: 'gst', t: 'GST', w: 38, right: true }, { k: 'tax', t: 'Tax', w: 60, right: true }],
    rows, totals: [{ item: 'Taxable value', taxable: inr(taxable), tax: inr(tax) }, { item: 'Invoice total (incl. GST)', tax: inr(total) }],
    note: 'Copy of your invoice for reference. The signed tax invoice travels with the goods and is on the invoice portal (https://invoice.jcmretails.com, log in with your registered mobile number).',
  })
}
