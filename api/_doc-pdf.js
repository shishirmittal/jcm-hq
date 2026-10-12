// Order copy and invoice copy PDFs for WhatsApp button replies (2026-10-12), in the one JCM document
// style (api/_jcm-doc.js — the invoice-portal look, Shishir's rule).
//   buildOrderPdf   — "Order copy" button on txn_order: the sales order as JCM Orders has it (CRM: orders + order_lines).
//   buildInvoicePdf — "Invoice PDF" button on order_dispatched*: from the invoice portal's tables (invoices + invoice_items).
import { jcmDoc, money, dmy, rupeesInWords } from './_jcm-doc.js'

const qty = q => (Number.isInteger(Number(q)) ? String(Number(q)) : String(Math.round(Number(q) * 1000) / 1000))

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
    return { n: String(i + 1), item: l.item_name || 'Item', qty: `${qty(q)} Pcs`, rate: q ? money(v / q) : '', amount: v ? money(v) : '' }
  })
  const total = lines.reduce((s, l) => s + (Number(l.line_value) || 0), 0)
  const pcs = lines.reduce((s, l) => s + (Number(l.ordered_qty) || 0), 0)
  return jcmDoc({
    fileTitle: `Order ${order.so_vch_no} - ${partyName}`, title: 'Sales Order', badge: 'Order copy',
    numberLabel: 'Order no.', number: order.so_vch_no || '—', dated: dmy(order.so_date),
    blocks: [
      { label: 'Ordered by', lines: [partyName, order.party_city, order.party_mobile] },
      { label: 'Order', rows: [['Status', String(order.stage || 'booked').replace(/_/g, ' ')], ['Items', String(lines.length)], ['Pieces', qty(pcs)]] },
    ],
    table: { cols: [{ k: 'n', t: '#', w: 22 }, { k: 'item', t: 'Item', w: 0 }, { k: 'qty', t: 'Qty', w: 60, right: true }, { k: 'rate', t: 'Rate', w: 80, right: true }, { k: 'amount', t: 'Amount', w: 90, right: true, bold: true }], rows },
    totals: [['Order value', `₹${money(total)}`, { big: true, sub: `${qty(pcs)} Pcs across ${lines.length} item${lines.length === 1 ? '' : 's'}` }]],
    leftNote: { label: 'Note', lines: ['Copy of your order as booked with us, for checking.', 'Rates are as on the order; the invoice may differ if prices change before billing.', 'Reply on WhatsApp for any change in quantity or item.'] },
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
  const rows = items.map((l, i) => {
    const q = Number(l.qty) || 0, taxable = Number(l.taxable_amount) || 0, rateEx = q ? taxable / q : Number(l.rate) || 0
    return { n: String(i + 1), item: l.item_name || 'Item', hsn: l.hsn_code || '', code: l.item_code != null ? String(l.item_code) : '', qty: `${qty(q)} Pcs`, list: Number(l.rate) ? money(l.rate) : '', disc: Number(l.discount_percent) ? `${Number(l.discount_percent)}%` : '—', gst: l.gst_rate != null ? `${Number(l.gst_rate)}%` : '', price: money(rateEx), amount: money(taxable) }
  })
  const taxable = items.reduce((s, l) => s + (Number(l.taxable_amount) || 0), 0)
  const tax = items.reduce((s, l) => s + (Number(l.tax_amount) || 0), 0)
  const total = Number(invoice.total_amount) || taxable + tax
  const pcs = items.reduce((s, l) => s + (Number(l.qty) || 0), 0)
  const inter = invoice.is_interstate === true
  const roundOff = total - (taxable + tax)
  // GST break-up by rate
  const byRate = new Map()
  for (const l of items) { const r = Number(l.gst_rate) || 0; const b = byRate.get(r) || { taxable: 0, tax: 0 }; b.taxable += Number(l.taxable_amount) || 0; b.tax += Number(l.tax_amount) || 0; byRate.set(r, b) }
  const gstRows = [...byRate.entries()].sort((a, b) => a[0] - b[0]).map(([r, b]) => inter ? [`${r}%`, money(b.taxable), money(b.tax), money(b.tax)] : [`${r}%`, money(b.taxable), money(b.tax / 2), money(b.tax / 2), money(b.tax)])
  return jcmDoc({
    fileTitle: `Invoice ${invoice.vch_no} - ${partyName}`, title: 'Tax Invoice', badge: 'Copy',
    numberLabel: 'Invoice no.', number: invoice.vch_no || '—', dated: dmy(invoice.vch_date),
    blocks: [
      { label: 'Billed to', lines: [invoice.customer_name || partyName, invoice.customer_address, invoice.customer_gst_no ? `GSTIN ${invoice.customer_gst_no}` : null, invoice.customer_mobile] },
      { label: 'Supply', rows: [['Place of supply', invoice.place_of_supply_code ? `State code ${invoice.place_of_supply_code}` : '—'], ['Transport', invoice.transport || '—'], ['Station', invoice.station || '—'], ['Vehicle', invoice.vehicle_no || '—'], ['LR / GR', invoice.gr_no || '—']] },
      { label: 'e-Invoice', rows: [['IRN', invoice.einvoice_irn ? String(invoice.einvoice_irn).slice(0, 18) + '…' : 'Not generated', { mono: true, muted: !invoice.einvoice_irn }], ['Ack no.', invoice.einvoice_ack_no || '—', { mono: true }], ['Ack date', invoice.einvoice_ack_date ? dmy(invoice.einvoice_ack_date) : '—', { mono: true }]] },
    ],
    table: { cols: [{ k: 'n', t: '#', w: 18 }, { k: 'item', t: 'Item', w: 0 }, { k: 'hsn', t: 'HSN', w: 48, mono: true }, { k: 'code', t: 'Code', w: 40, mono: true }, { k: 'qty', t: 'Qty', w: 44, right: true }, { k: 'list', t: 'List price', w: 56, right: true }, { k: 'disc', t: 'Discount', w: 46, right: true }, { k: 'gst', t: 'GST', w: 34, right: true }, { k: 'price', t: 'Price', w: 56, right: true }, { k: 'amount', t: 'Amount', w: 62, right: true, bold: true }], rows },
    words: rupeesInWords(total),
    leftTable: { label: 'GST break-up — prices exclusive of tax', cols: inter ? ['Rate', 'Taxable value', 'IGST', 'Total tax'] : ['Rate', 'Taxable value', 'CGST', 'SGST', 'Total tax'], rows: gstRows },
    totals: [
      ['Taxable value', money(taxable)],
      ...(inter ? [['IGST', money(tax)]] : [['CGST', money(tax / 2)], ['SGST', money(tax / 2)]]),
      ['Round off', (roundOff >= 0 ? '' : '-') + money(Math.abs(roundOff))],
      ['TOTAL', `₹${money(total)}`, { big: true, sub: `${qty(pcs)} Pcs across ${items.length} item${items.length === 1 ? '' : 's'}` }],
    ],
    leftNote: { label: 'Terms', lines: ['Installation charges are not included in this invoice.', 'No return policy.', 'Interest at 18% p.a. on delayed payments.', 'Not responsible for damage or loss in transit.', 'Service claims are handled by the respective service centre.', 'Subject to Ratlam jurisdiction only.'] },
    rightNote: { label: 'Pay to', rows: [['Bank', 'State Bank of India'], ['Account no.', '38596845721'], ['IFSC', 'SBIN0009452'], ['Branch', 'SME Branch, Ratlam']], pill: ['Customer care', '910 910 8258'] },
    footerLeft: 'E. & O.E. · Computer-generated copy of the invoice; the signed tax invoice travels with the goods.',
  })
}
