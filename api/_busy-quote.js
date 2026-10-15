// Quotations typed in Busy (2026-10-15): read from busy_quotations / busy_quotation_lines (synced by
// busy-sync/sync-quotations.js), PDF in the one JCM document style, WhatsApp send as the approved
// `quotation_sent` template (banner + "PDF Copy" button → the stored PDF, payload quote:<storage path>).
// Used by api/customers.js (actions busy-quotes, busy-quote, busy-quote-pdf, busy-quote-send).
import { jcmDoc, money, dmy, rupeesInWords } from './_jcm-doc.js'
import { waConfigured, sendLogged, toWaNumber, niceDate, BANNER } from './_wa-cloud.js'

const qty = q => (Number.isInteger(Number(q)) ? String(Number(q)) : String(Math.round(Number(q) * 1000) / 1000))
const PAGE = 25

export async function listBusyQuotes(busy, body) {
  const page = Math.max(0, Number(body.page) || 0)
  const q = String(body.q || '').trim()
  let sel = busy.from('busy_quotations').select('vch_key, vch_no, quote_date, party_name, billed_name, mobile, city, quote_total, item_count, cancelled, entered_by', { count: 'exact' })
    .is('deleted_at', null).order('quote_date', { ascending: false }).order('vch_code', { ascending: false })
  if (q) sel = sel.or(`party_name.ilike.%${q.replace(/[%,()]/g, '')}%,billed_name.ilike.%${q.replace(/[%,()]/g, '')}%,vch_no.ilike.%${q.replace(/[%,()]/g, '')}%`)
  const r = await sel.range(page * PAGE, page * PAGE + PAGE - 1)
  if (r.error) throw new Error(r.error.message)
  const last = await busy.from('busy_quotations').select('synced_at').order('synced_at', { ascending: false }).limit(1).maybeSingle()
  return { rows: r.data || [], total: r.count || 0, page, pageSize: PAGE, lastSync: last.data?.synced_at || null }
}

export async function loadBusyQuote(busy, vchKey) {
  const h = await busy.from('busy_quotations').select('*').eq('vch_key', String(vchKey)).maybeSingle()
  if (h.error || !h.data) return null
  const l = await busy.from('busy_quotation_lines').select('*').eq('vch_key', String(vchKey)).order('sr_no')
  return { quote: h.data, lines: l.data || [] }
}

export function buildBusyQuotePdf({ quote, lines }) {
  const rows = lines.map((l, i) => ({
    n: String(i + 1), item: l.item_name || 'Item', code: l.item_code || '', qty: `${qty(l.qty || 0)} ${l.unit || 'Pcs'}`,
    list: Number(l.list_rate) ? money(l.list_rate) : '', disc: Number(l.discount_pct) ? `${Number(l.discount_pct)}%` : '—',
    gst: l.gst_rate != null ? `${Number(l.gst_rate)}%` : '', price: money(Number(l.rate_before_gst) || 0), amount: money(Number(l.taxable) || 0),
  }))
  const taxable = lines.reduce((s, l) => s + (Number(l.taxable) || 0), 0)
  const tax = lines.reduce((s, l) => s + (Number(l.tax_amount) || 0), 0)
  const total = Number(quote.quote_total) || taxable + tax
  const pcs = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0)
  const name = quote.billed_name || quote.party_name || 'Customer'
  return jcmDoc({
    fileTitle: `Quotation ${quote.vch_no} - ${name}`, title: 'Quotation', badge: quote.cancelled ? 'Cancelled' : 'Estimate',
    numberLabel: 'Quotation no.', number: quote.vch_no || '—', dated: dmy(quote.quote_date),
    blocks: [
      { label: 'Quotation for', lines: [name, quote.billed_name && quote.party_name !== quote.billed_name ? `A/c ${quote.party_name}` : null, quote.city, quote.mobile] },
      { label: 'Summary', rows: [['Items', String(lines.length)], ['Pieces', qty(pcs)], ['Valid for', '7 days from the date above']] },
    ],
    table: { cols: [{ k: 'n', t: '#', w: 18 }, { k: 'item', t: 'Item', w: 0 }, { k: 'code', t: 'Code', w: 44, mono: true }, { k: 'qty', t: 'Qty', w: 54, right: true }, { k: 'list', t: 'List price', w: 58, right: true }, { k: 'disc', t: 'Discount', w: 48, right: true }, { k: 'gst', t: 'GST', w: 36, right: true }, { k: 'price', t: 'Price', w: 58, right: true }, { k: 'amount', t: 'Amount', w: 64, right: true, bold: true }], rows },
    words: rupeesInWords(total),
    totals: [['Taxable value', money(taxable)], ['GST', money(tax)], ['TOTAL', `₹${money(total)}`, { big: true, sub: `${qty(pcs)} Pcs across ${lines.length} item${lines.length === 1 ? '' : 's'}` }]],
    leftNote: { label: 'Terms', lines: [quote.narration || null, 'Prices are inclusive of GST as shown; subject to change without notice after validity.', 'Goods subject to availability at the time of order.', 'Subject to Ratlam jurisdiction only.'].filter(Boolean) },
    rightNote: { label: 'Contact', rows: [['WhatsApp', '910 910 5999'], ['Customer care', '910 910 8258']], pill: ['J.C. Mittal & Sons', 'Freeganj Road, Ratlam'] },
    footerLeft: 'E. & O.E. · This is a quotation, not a tax invoice.',
  })
}

const safeName = s => String(s || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'Quotation'

export async function sendBusyQuote(busy, body, by) {
  if (!waConfigured()) return { error: 'WhatsApp is not set up in HQ yet.' }
  const number = toWaNumber(body.phone)
  if (!number) return { error: 'That is not a valid 10-digit mobile number.' }
  const data = await loadBusyQuote(busy, body.vch_key)
  if (!data) return { error: 'This quotation is not in HQ (yet).' }
  if (data.quote.cancelled) return { error: 'This quotation is cancelled in Busy.' }
  const pdf = await buildBusyQuotePdf(data)
  const path = `quotations/${safeName(data.quote.vch_no)}-${Date.now()}.pdf`
  let stored = false
  for (const bucket of ['wa-docs', 'gst-reports']) {
    const up = await busy.storage.from(bucket).upload(path, pdf, { contentType: 'application/pdf', upsert: true })
    if (!up.error) { stored = true; break }
  }
  if (!stored) return { error: 'Could not store the PDF (storage bucket wa-docs missing).' }
  const name = data.quote.billed_name || data.quote.party_name || 'Customer'
  const out = await sendLogged(busy, {
    kind: 'quotation', to: number, template: 'quotation_sent',
    params: [name, String(data.quote.vch_no || ''), niceDate(data.quote.quote_date), Number(data.quote.quote_total || 0).toLocaleString('en-IN')],
    opts: { headerImageUrl: BANNER('quotation'), buttonPayloads: [`quote:${path}`] },
    ref: String(data.quote.vch_no || ''), refName: name, by,
  })
  if (out.status !== 'sent') return { error: `Not sent: ${out.error || out.status}` }
  return { ok: true, to: number, name }
}
