// Purchase bill PDF — sent on WhatsApp to staff for every new purchase bill (template
// staff_purchase_pdf, document header) and opened from the Purchase Summary page.
// Same invoice-portal look as every other JCM PDF (api/_jcm-doc.js, Shishir's rule 2026-10-12).
//
// Item table (Shishir, 2026-10-13): # · Item · Qty · Pre-tax rate (before discount) · Disc. % · GST % ·
// Tax-paid rate (after discount, with GST) · Amount (tax-paid rate × qty), totals at the bottom.
// D2 alone is not safe: Busy keeps it with or without GST depending on how the bill was typed.
import { jcmDoc, money, dmy, rupeesInWords } from './_jcm-doc.js'

const qtyText = q => { const n = Number(q || 0); return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000) }
const istStamp = s => {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
}

export function purchaseFileName(v) {
  const safe = s => String(s || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  return `Purchase-${safe(v.vch_no) || 'bill'}-${safe(v.party_name) || 'party'}.pdf`
}

// One line in numbers. New rows (sync from 2026-10-13) carry list_rate / discount_pct / gst_rate /
// tax_amount / taxable from Busy (D9, D11, VchGSTSumItemWise, Value3). Rows synced before that only
// have rate / rate_before_gst; they show GST worked out from those two and no discount.
function lineNumbers(l) {
  const q = Number(l.qty) || 0
  if (l.gst_rate != null || l.tax_amount != null) {
    const taxable = Number(l.taxable) || 0
    const tax = Number(l.tax_amount) || 0
    const disc = Number(l.discount_pct) || 0
    const list = Number(l.list_rate) || (q ? taxable / q : 0)
    const gst = l.gst_rate != null ? Number(l.gst_rate) : (taxable ? Math.round(tax / taxable * 100) : null)
    return { q, list, disc, gst, gross: list * q, taxable, tax, amount: taxable + tax }
  }
  const pre = Number(l.rate_before_gst) || 0, rate = Number(l.rate) || 0
  const amount = l.amount != null ? Number(l.amount) : q * rate
  const gst = pre && rate ? Math.round((rate / pre - 1) * 100) : null
  return { q, list: pre, disc: 0, gst, gross: pre * q, taxable: pre * q, tax: amount - pre * q, amount }
}
const pct = n => `${Math.round(Number(n) * 100) / 100}%`

export function buildPurchasePdf(v, lines, enteredByName) {
  let gross = 0, taxable = 0, tax = 0, paid = 0, pcs = 0
  const rows = lines.map((l, i) => {
    const x = lineNumbers(l)
    gross += x.gross; taxable += x.taxable; tax += x.tax; paid += x.amount; pcs += x.q
    return {
      n: String(i + 1), item: l.item_name || 'Item', qty: qtyText(x.q),
      pre: x.list ? money(x.list) : '—', disc: x.disc ? pct(x.disc) : '—', gst: x.gst == null ? '—' : pct(x.gst),
      rate: x.q ? money(x.amount / x.q) : '—', amount: money(x.amount),
    }
  })
  const bill = Number(v.bill_total) || 0
  const diff = bill ? bill - paid : 0
  const discount = gross - taxable
  const totals = [['Pre-tax value', money(gross)]]
  if (discount >= 0.01) totals.push(['Discount', '-' + money(discount)], ['Taxable value', money(taxable)])
  totals.push(['GST', money(tax)])
  if (Math.abs(diff) >= 1) {
    totals.push(['Items total (tax paid)', money(paid)])
    totals.push(['Freight / other charges / round off', (diff >= 0 ? '' : '-') + money(Math.abs(diff))])
  }
  const grand = Math.abs(diff) >= 1 ? bill : paid
  totals.push(['BILL TOTAL', `₹${money(grand)}`, { big: true, sub: `${qtyText(pcs)} Pcs across ${lines.length} item${lines.length === 1 ? '' : 's'}` }])

  return jcmDoc({
    fileTitle: `Purchase ${v.vch_no || ''} - ${v.party_name || ''}`,
    title: 'Purchase Bill', badge: 'Material received',
    numberLabel: 'Supplier bill no.', number: v.vch_no || '—', dated: dmy(v.bill_date),
    blocks: [
      { label: 'Supplier', lines: [v.party_name || 'Unknown party', v.party_code ? `Busy code ${v.party_code}` : null] },
      { label: 'Bill', rows: [['Bill no.', v.vch_no || '—', { mono: true }], ['Bill date', dmy(v.bill_date), { mono: true }], ['Items', String(lines.length)]] },
      { label: 'Entered in Busy', rows: [['On', istStamp(v.entered_at)], ['By', enteredByName || v.entered_by || '—'], ['Edited', v.edit_count ? `${v.edit_count} time${v.edit_count === 1 ? '' : 's'}` : 'No']] },
    ],
    table: {
      cols: [
        { k: 'n', t: '#', w: 18 },
        { k: 'item', t: 'Item', w: 0 },
        { k: 'qty', t: 'Qty', w: 34, right: true },
        { k: 'pre', t: 'Pre-tax rate', w: 60, right: true },
        { k: 'disc', t: 'Disc.', w: 36, right: true },
        { k: 'gst', t: 'GST', w: 32, right: true },
        { k: 'rate', t: 'Tax-paid rate', w: 62, right: true },
        { k: 'amount', t: 'Amount', w: 68, right: true, bold: true },
      ],
      rows, empty: 'No item lines on this bill.',
    },
    words: rupeesInWords(grand),
    totals,
    leftNote: { label: 'Please check', lines: ['Count the goods received against the quantities above.', 'Check the rates against the agreed price list or order.', 'Anything wrong or missing: note it on the Task Board today.'] },
    footerLeft: 'Purchase entry as saved in Busy · for JCM staff · not a tax invoice.',
  })
}
