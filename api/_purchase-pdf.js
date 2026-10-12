// Purchase bill PDF — sent on WhatsApp to staff for every new purchase bill (template
// staff_purchase_pdf, document header) and opened from the Purchase Summary page.
// Same invoice-portal look as every other JCM PDF (api/_jcm-doc.js, Shishir's rule 2026-10-12).
//
// Item table (Shishir, 2026-10-13): # · Item · Qty · Pre-tax rate · GST · Tax-paid rate · Amount
// (tax-paid rate × qty), totals at the bottom. Rates are as saved in Busy: D6 = rate before GST,
// D2 = rate typed with GST (purchase_lines.rate_before_gst / rate).
import { jcmDoc, money, dmy, rupeesInWords } from './_jcm-doc.js'

const qtyText = q => { const n = Number(q || 0); return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000) }
const istStamp = s => {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
}

// GST % from the two rates Busy keeps; whole numbers (0 / 5 / 12 / 18 / 28).
function gstPct(l) {
  const r = Number(l.rate) || 0, b = Number(l.rate_before_gst) || 0
  if (!b || !r) return null
  return Math.round((r / b - 1) * 100)
}

export function purchaseFileName(v) {
  const safe = s => String(s || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  return `Purchase-${safe(v.vch_no) || 'bill'}-${safe(v.party_name) || 'party'}.pdf`
}

export function buildPurchasePdf(v, lines, enteredByName) {
  let preTax = 0, paid = 0, pcs = 0
  const rows = lines.map((l, i) => {
    const q = Number(l.qty) || 0
    const pre = Number(l.rate_before_gst) || 0
    const rate = Number(l.rate) || 0
    const amount = l.amount != null ? Number(l.amount) : q * rate
    preTax += q * pre; paid += amount; pcs += q
    const g = gstPct(l)
    return {
      n: String(i + 1), item: l.item_name || 'Item', qty: qtyText(q),
      pre: pre ? money(pre) : '—', gst: g == null ? '—' : `${g}%`, rate: rate ? money(rate) : '—', amount: money(amount),
    }
  })
  const bill = Number(v.bill_total) || 0
  const diff = bill ? bill - paid : 0
  const totals = [
    ['Pre-tax value', money(preTax)],
    ['GST', money(paid - preTax)],
  ]
  if (Math.abs(diff) >= 1) {
    totals.push(['Items total (tax paid)', money(paid)])
    totals.push(['Discount / freight / round off', (diff >= 0 ? '' : '-') + money(Math.abs(diff))])
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
        { k: 'n', t: '#', w: 20 },
        { k: 'item', t: 'Item', w: 0 },
        { k: 'qty', t: 'Qty', w: 40, right: true },
        { k: 'pre', t: 'Pre-tax rate', w: 64, right: true },
        { k: 'gst', t: 'GST', w: 34, right: true },
        { k: 'rate', t: 'Tax-paid rate', w: 66, right: true },
        { k: 'amount', t: 'Amount', w: 72, right: true, bold: true },
      ],
      rows, empty: 'No item lines on this bill.',
    },
    words: rupeesInWords(grand),
    totals,
    leftNote: { label: 'Please check', lines: ['Count the goods received against the quantities above.', 'Check the rates against the agreed price list or order.', 'Anything wrong or missing: note it on the Task Board today.'] },
    footerLeft: 'Purchase entry as saved in Busy · for JCM staff · not a tax invoice.',
  })
}
