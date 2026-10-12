import { supabase } from './supabase.js'
import { esc, formatMoney, numberToWordsIndian, waHref, skeletonList } from './utils.js'
import { renderQuotationForm } from './quotation-form.js'
import { IS_NATIVE } from './native.js'
import { sharePdf, pdfFilename } from './share-pdf.js'
import logoUrl from './assets/jcm-logo.png'
import { hqConfirm, hqAlert } from './hq-dialog.js'
import './quotation-sheet.css'

// Fallback only — a payee-only code with no amount in it, shown if the QR library
// failed to load. The real one is generated per quotation by qrDataUri() below.
const QR_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAdYAAAHWCAIAAABFeD8NAAALeklEQVR4nO3d3W0lxxlFUdOYNJSEQ1DgCsFJKAoCJOBXCRDqjqemZn/VXOuV6PvPjX45qLfPj/d/AVD4d/0CAL4uCQbISDBARoIBMhIMkJFggIwEA2QkGCAjwQCZb+s///af33/N6/hl/vzvHz987blPY/2q1s977tod1S+nekfV7+rc+91x7hd7o/X7dRcMkJFggIwEA2QkGCAjwQAZCQbISDBARoIBMhIMkHmxjlu7cZmzc+25Vc/MDdu591v9cmZ+zmszl5PVJ/m85rgLBshIMEBGggEyEgyQkWCAjAQDZCQYICPBABkJBshsrePWqpPWzqlOtaq2VTee4jXzfL9zjzxzLVa5sTnuggEyEgyQkWCAjAQDZCQYICPBABkJBshIMEBGggEyB9dx/NXOuqY64W3HzNXWuW/hnOqXs8Oi7/u5CwbISDBARoIBMhIMkJFggIwEA2QkGCAjwQAZCQbIWMf9zblTvM6dLVaZucpb2/kGqxPezr3mneflZ3EXDJCRYICMBANkJBggI8EAGQkGyEgwQEaCATISDJA5uI6buenaUe3fqn3UjmpLtjZz8fW8ZV3lxtfsLhggI8EAGQkGyEgwQEaCATISDJCRYICMBANkJBggs7WOm7k12nFup1SdSjfz2h03Pu9X+5yrvd+N3AUDZCQYICPBABkJBshIMEBGggEyEgyQkWCAjAQDZF6s4248i2mmnVXPuWvPnYZ3bsV04x5s53nPXTvTV2uOu2CAjAQDZCQYICPBABkJBshIMEBGggEyEgyQkWCAzNvnx/viz9W5VTuqjdM51R5s7cZPslKdlva8JeHMc+d2XpW7YICMBANkJBggI8EAGQkGyEgwQEaCATISDJCRYIDMi3Xc2sxt1c4jV4uvmWuitWo5ee4bnPmb3HnkHc/7nNeq53UXDJCRYICMBANkJBggI8EAGQkGyEgwQEaCATISDJD5tv7z886O27n2xu3NzG/weevHnU/yxu+3et7nnVjoLhggI8EAGQkGyEgwQEaCATISDJCRYICMBANkJBggk50dt2Pm5qda1s1cfO2Y+UlWZp5YeOM5e+c4Ow7gShIMkJFggIwEA2QkGCAjwQAZCQbISDBARoIBMi/Ojlur1jXntjfVMqdaQO2o1lMzT0tbm7lDq563MvN/wV0wQEaCATISDJCRYICMBANkJBggI8EAGQkGyEgwQGZrHXdumbN24+lhN55atjbzNVen/+3sOZ93+l+lOt1xh7tggIwEA2QkGCAjwQAZCQbISDBARoIBMhIMkJFggMyLddzMZU51htu5Vd7OtdUiqNoaVa955sKtWqieM3PDtrbzqtwFA2QkGCAjwQAZCQbISDBARoIBMhIMkJFggIwEA2TePj/eF3+euerZed4dM8+dW5u5nTtn5npqzf/ChEc+Z/2a3QUDZCQYICPBABkJBshIMEBGggEyEgyQkWCAjAQDZF6cHVe5cQMz88wrK6Zf88g773fmgvHGZd3azOWku2CAjAQDZCQYICPBABkJBshIMEBGggEyEgyQkWCAzNY67nmnpe2YuQfbsbNi2rm2WnxV1+6oPue1Gxeq1bXuggEyEgyQkWCAjAQDZCQYICPBABkJBshIMEBGggEyL9ZxX22n9NXO6dpZMc1cQO1cO/NssRtf1Y1rz4q7YICMBANkJBggI8EAGQkGyEgwQEaCATISDJCRYIDM1tlxz9uwzTz/beb7PefGDdvazF/7uRMad66tvv1q7+cuGCAjwQAZCQbISDBARoIBMhIMkJFggIwEA2QkGCDz9vnx/sMXz9ztPM+53c6Nj3zOzN3djRtU3+/3cxcMkJFggIwEA2QkGCAjwQAZCQbISDBARoIBMhIMkNk6O27t3ELm3MqlOk1r7cZT6XbM/CSftxY792msPe/73eEuGCAjwQAZCQbISDBARoIBMhIMkJFggIwEA2QkGCDzYh1XbWBmrlxuPKerWm09b9F37peztn6/Vmq/xrlX5S4YICPBABkJBshIMEBGggEyEgyQkWCAjAQDZCQYILN1dtzM87Kq/cw5M08eWzv326g2XdWvfeay7pyZm71zC1V3wQAZCQbISDBARoIBMhIMkJFggIwEA2QkGCAjwQCZt8+P98WfZ+5nKud2SjfuDJ/325j5fp+3M5zp3P5tzV0wQEaCATISDJCRYICMBANkJBggI8EAGQkGyEgwQObF2XE37mfObdjOObe9udHMX93MbWT1qnZU7/ccZ8cBXEmCATISDJCRYICMBANkJBggI8EAGQkGyEgwQObF2XE7qv3bjQuoGx+5Og1v5nZu7cY92LnvqHrkmb9Jd8EAGQkGyEgwQEaCATISDJCRYICMBANkJBggI8EAmWwdN3MvNHMfVT3vzN3d2swF1A7f0c+6tuLsOIChJBggI8EAGQkGyEgwQEaCATISDJCRYICMBANkvu1cfOOZV9WrWju3cbpxo3ju0zj3vDtmbrqqVd65a6vXvOYuGCAjwQAZCQbISDBARoIBMhIMkJFggIwEA2QkGCDzYh0389yqteramZufne3cTM87W2ztq20F16rmnPtduQsGyEgwQEaCATISDJCRYICMBANkJBggI8EAGQkGyLx9frzXr+EfVCumaltVbX6+2juqzsq78XM+97xr1VK0+sW6CwbISDBARoIBMhIMkJFggIwEA2QkGCAjwQAZCQbIvDg77hzLnO937tpqabbjxvPf1mae/jfzFL6Z/2U7RXIXDJCRYICMBANkJBggI8EAGQkGyEgwQEaCATISDJB5sY47d9rSmhPPvt/ztlUz1487qm9/7aud0jbzVbkLBshIMEBGggEyEgyQkWCAjAQDZCQYICPBABkJBsgcPDvuxg3bzLPjZm5+dq49t3/bUX3O1b7xxs3ezLPjdrgLBshIMEBGggEyEgyQkWCAjAQDZCQYICPBABkJBsi8WMed2/ysVQuZtWrTdeNK7dzSrFpt7bjxNe+4cQu6du553QUDZCQYICPBABkJBshIMEBGggEyEgyQkWCAjAQDZN4+P95/+OLqtKVqd7fjxpO4Zpq5nDxn5lawOrHwxl/smrtggIwEA2QkGCAjwQAZCQbISDBARoIBMhIMkJFggMyLs+OqDcyOmQuomadaPW9pNvPkwOd9zmsz/7urXq2f110wQEaCATISDJCRYICMBANkJBggI8EAGQkGyEgwQObFOu7cpmvmI1fbm5nOfRozT/CrTmmbufhaP/KN3+9M7oIBMhIMkJFggIwEA2QkGCAjwQAZCQbISDBARoIBMltnx93o3OZn5jl71R6sOj2sWl3e+NuY6cbPaudVuQsGyEgwQEaCATISDJCRYICMBANkJBggI8EAGQkGyLxYx63NPC3teXuhHef2b5XqV3fjSXrVyXI7Zu4b13Y+K3fBABkJBshIMEBGggEyEgyQkWCAjAQDZCQYICPBAJmtddzazJOazj3vzulhO84tr6o92I2bvXOqs9TO/ZdV3+/MU+ncBQNkJBggI8EAGQkGyEgwQEaCATISDJCRYICMBANkDq7jnufc0qw64e3c/m3HzPPuZr6qauFWqU7hO/fI7oIBMhIMkJFggIwEA2QkGCAjwQAZCQbISDBARoIBMtZx/4dqH1Xt0M6ZuXHaMfO3ceOusjpXsNq+ugsGyEgwQEaCATISDJCRYICMBANkJBggI8EAGQkGyBxcxz3v3KqZJ63tPO/M0/CqM76cw/azrq22c2sz96vuggEyEgyQkWCAjAQDZCQYICPBABkJBshIMEBGggEyb58f74s/n9uTVKqztnZ8taXZzLPjZv5yzm32zn2D59z4m3QXDJCRYICMBANkJBggI8EAGQkGyEgwQEaCATISDJB5sY4D4Bx3wQAZCQbISDBARoIBMhIMkJFggIwEA2QkGCAjwQCZ/wGf1p6r2HShDAAAAABJRU5ErkJggg=='

// Payee side of the UPI intent — kept next to the bank strip's own UPI line
// (.sheet-bankstrip below) so the printed VPA and the scanned VPA can't drift apart.
const UPI_VPA = '7415277521-1@okbizaxis'
const UPI_PAYEE = 'J.C. Mittal and Sons'

// The QR used to be a single hardcoded PNG, so every quotation showed the same
// pre-baked amount no matter what it actually totalled. It's now built from this
// quotation's own grand total, at render time — and grandTotal is deliberately the
// final payable figure for whichever pricing mode is active (Tax Paid Total, or
// Grand Total with GST already added in Discount + Tax), which is the same number
// printed in the .grand totals row, so the scanned amount always matches the sheet.
function upiPayUri(amount, note) {
  const params = new URLSearchParams({
    pa: UPI_VPA,
    pn: UPI_PAYEE,
    am: (Math.round((Number(amount) || 0) * 100) / 100).toFixed(2),
    cu: 'INR'
  })
  if (note) params.set('tn', note)
  // Two fixups on URLSearchParams' output, both about what UPI apps in the wild
  // actually accept: '+' for a space gets passed through literally into the payee
  // name by some of them (%20 is understood everywhere), and the '@' in a VPA is
  // conventionally left bare in a upi:// link rather than percent-encoded.
  return `upi://pay?${params.toString().replace(/\+/g, '%20').replace(/%40/g, '@')}`
}

// qrcodejs renders into a DOM node synchronously, so a detached div is enough —
// we only want the finished pixels as a data URI, because html2canvas (the PDF
// path) handles an <img src="data:..."> far more predictably than a live <canvas>.
function qrDataUri(text) {
  if (!window.QRCode) return null
  try {
    const holder = document.createElement('div')
    new window.QRCode(holder, {
      text,
      width: 240,
      height: 240,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: window.QRCode.CorrectLevel.M
    })
    const canvas = holder.querySelector('canvas')
    if (canvas) return canvas.toDataURL('image/png')
    return holder.querySelector('img')?.src || null
  } catch {
    return null
  }
}

function money(n) {
  if (n == null) return 'On request'
  return formatMoney(n)
}

const BRANDS = [
  'Philips', 'Havells', 'Schneider Electric', 'Legrand', 'LK', 'Larsen & Toubro',
  'Finolex', 'Orient Electric', 'Crompton', 'Daikin', 'Voltas', 'Panasonic', 'Bajaj', 'Anchor',
  'Polycab', 'Godrej', 'etc.'
]

// Conservative — comfortably fits under the repeated header/meta/client block with
// room to spare, based on the v3 design's row height. A real per-item budget is
// larger than this on non-final pages; the final page also needs to fit
// totals/words/bank/brands/policies/footer below its items, hence the margin.
const ITEMS_PER_PAGE = 15

function chunk(arr, size) {
  if (!arr.length) return [[]]
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Same look as the customer invoice PDF on invoice.jcmretails.com
// (jcm-invoiceportal public/invoice-template.html) — classes qi-*, styles in
// quotation-sheet.css. Header + footer repeat on every page; the customer block
// is on page 1; totals, terms and bank details only on the last page.
const QUOTE_TERMS = [
  'Rates are subject to revision without prior notice after the validity date.',
  'Advance payment may be requested for special or non-stock orders.',
  'Delivery is subject to stock availability at the time of order confirmation.',
  'Goods once sold are not returnable except as per brand warranty terms.',
  'Subject to Ratlam jurisdiction only.'
]

function inr(n) {
  const v = Number(n) || 0
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function dmy(d) {
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`
}

function renderPageHtml({ quotation, pageRows, pageIndex, totalPages, startNumber, isFirst, isLast, totals, qrSrc, brought, carried }) {
  const { createdDate, validUntil, grandTotal, totalMrp, totalQty, totalDiscount, onRequestCount, pricingMode, gstRate, taxableValue, gstAmount, itemCount } = totals
  const addr = [quotation.address, quotation.city].filter(Boolean).join(', ')
  const qtyText = Number.isInteger(totalQty) ? totalQty : totalQty.toFixed(2)

  return `
    <div class="print-page qi">
      <header class="qi-head">
        <div class="qi-lockup">
          <img class="qi-logo" src="${logoUrl}" alt="JCM Retails" />
          <div>
            <div class="qi-co-name">J.C.Mittal And Sons</div>
            <div class="qi-co-gstin">GSTIN 23AAPFJ0607D1ZT</div>
          </div>
        </div>
        <div class="qi-co-contact">87-88, Freeganj Road, Ratlam, MP 457001<br />07412 490490 · 910910-8258 · hello@jcmretails.com<br />www.jcmretails.com</div>
      </header>

      <div class="qi-title-row">
        <div class="qi-title-left"><h1>Quotation</h1><span class="qi-pill">Not a tax invoice</span></div>
        <div style="text-align:right">
          <div class="qi-doc-no-label">Quotation no.</div>
          <div class="qi-doc-no">${esc(quotation.quote_no || '—')}</div>
          <div class="qi-doc-date">Dated ${dmy(createdDate)}</div>
        </div>
      </div>

      ${isFirst ? `
      <section class="qi-parties">
        <div>
          <div class="qi-eyebrow">Quotation for</div>
          <div class="qi-party-name">${esc(quotation.client_name || '—')}</div>
          ${addr ? `<div class="qi-party-addr">${esc(addr)}</div>` : ''}
          ${quotation.phone ? `<div class="qi-mono qi-party-phone">${esc(quotation.phone)}</div>` : ''}
        </div>
        <div>
          <div class="qi-eyebrow">Details</div>
          <div class="qi-kv">
            <span class="k">Date</span><span>${dmy(createdDate)}</span>
            <span class="k">Valid until</span><span>${dmy(validUntil)}</span>
            <span class="k">Prices</span><span>${pricingMode === 'discount_plus_tax' ? `GST ${gstRate}% added` : 'Inclusive of GST'}</span>
            ${quotation.label ? `<span class="k">Reference</span><span>${esc(quotation.label)}</span>` : ''}
          </div>
        </div>
        <div class="qi-qr-col">
          <div>
            <div class="qi-eyebrow">Scan to pay</div>
            <div class="qi-qr-amt">₹${inr(Math.round(grandTotal))}</div>
            <div class="qi-qr-note">Any UPI app</div>
          </div>
          <img class="qi-qr" src="${qrSrc}" alt="UPI QR" />
        </div>
      </section>` : ''}

      <div class="qi-items">
        <div class="qi-row qi-ihead">
          <div>#</div><div>Item</div><div>Model</div><div>Colour</div>
          <div class="r">Qty</div><div class="r">List price</div><div class="r">Discount</div><div class="r">Price</div><div class="r">Amount</div>
        </div>
        ${!isFirst ? `<div class="qi-brought"><div>Brought forward from page ${pageIndex}</div><div>${inr(brought)}</div></div>` : ''}
        ${pageRows.map((r, i) => {
          const qty = Number(r.qty) || 0
          const disc = Number(r.discount_pct) || 0
          const price = qty ? Number(r.amount || 0) / qty : 0
          return `
        <div class="qi-row qi-line">
          <div class="sr">${startNumber + i}</div>
          <div class="desc">${esc(r.description)}</div>
          <div class="code">${esc(r.model || '—')}</div>
          <div class="code">${esc(r.colour || '—')}</div>
          <div class="num qty">${qty}</div>
          <div class="num">${r.on_request ? '—' : inr(r.mrp)}</div>
          <div class="num ${disc && !r.on_request ? '' : 'nil'}">${disc && !r.on_request ? disc.toFixed(2) + '%' : '—'}</div>
          <div class="num ink">${r.on_request ? '—' : inr(price)}</div>
          <div class="amt">${r.on_request ? 'On request' : inr(r.amount)}</div>
        </div>`
        }).join('')}
        ${!isLast ? `<div class="qi-carry"><div>Carried forward to page ${pageIndex + 2}</div><div>${inr(carried)}</div></div>` : ''}
      </div>

      <div class="qi-grow"></div>

      ${isLast ? `
      <div>
        <section class="qi-totals">
          <div>
            <div class="qi-eyebrow" style="margin-bottom:0">Amount in words</div>
            <div class="qi-words">Rupees ${numberToWordsIndian(Math.round(grandTotal))} Only</div>
            ${onRequestCount ? `<div class="qi-qty-note">+ ${onRequestCount} item(s) priced on request — not included in the total.</div>` : ''}
            <div class="qi-eyebrow" style="margin:14px 0 4px">Brands we carry</div>
            <div class="qi-brands">${BRANDS.map(esc).join(' · ')}</div>
          </div>
          <div>
            <div class="qi-sum">
              <div>Total list price</div><div class="v">${inr(totalMrp)}</div>
              <div>Discount</div><div class="v">− ${inr(totalDiscount)}</div>
              ${pricingMode === 'discount_plus_tax' ? `
              <div>Taxable value</div><div class="v">${inr(taxableValue)}</div>
              <div>CGST (${gstRate / 2}%)</div><div class="v">${inr(gstAmount / 2)}</div>
              <div>SGST (${gstRate / 2}%)</div><div class="v">${inr(gstAmount / 2)}</div>` : ''}
              <div>Round off</div><div class="v">${(Math.round(grandTotal) - grandTotal >= 0 ? '+' : '') + inr(Math.round(grandTotal) - grandTotal)}</div>
            </div>
            <div class="qi-grand">
              <div class="qi-grand-label">${pricingMode === 'discount_plus_tax' ? 'Grand total' : 'Total (tax paid)'}</div>
              <div class="qi-grand-val">₹${inr(Math.round(grandTotal))}</div>
            </div>
            <div class="qi-qty-note">${qtyText} Pcs across ${itemCount} items</div>
          </div>
        </section>

        <section class="qi-foot-cols">
          <div>
            <div class="qi-eyebrow">Terms</div>
            <ol class="qi-terms">${[pricingMode === 'discount_plus_tax' ? `GST at ${gstRate}% is added as shown. Prices valid for 7 days from the date above.` : 'Prices are inclusive of applicable GST and valid for 7 days from the date above.', ...QUOTE_TERMS].map(t => `<li>${esc(t)}</li>`).join('')}</ol>
          </div>
          <div>
            <div class="qi-eyebrow">Pay to</div>
            <div class="qi-kv">
              <span class="k">A/c name</span><span>J.C. Mittal and Sons</span>
              <span class="k">Bank</span><span>State Bank of India</span>
              <span class="k">Account no.</span><span class="qi-mono">38596845721</span>
              <span class="k">IFSC</span><span class="qi-mono">SBIN0009452</span>
              <span class="k">Branch</span><span>SME Branch, Ratlam</span>
              <span class="k">UPI</span><span class="qi-mono">${UPI_VPA}</span>
            </div>
            <div class="qi-care">
              <span class="qi-care-label">Customer care</span>
              <span class="qi-care-no">910 910 8258</span>
            </div>
          </div>
        </section>
      </div>` : ''}

      <footer class="qi-sheet-foot">
        <div>E. &amp; O.E. · Computer-generated quotation, valid without signature.</div>
        <div class="qi-mono">${esc(quotation.quote_no || '')} · ${dmy(createdDate)} · Page ${pageIndex + 1} of ${totalPages}</div>
      </footer>
    </div>
  `
}

// How much the A4 sheet has to shrink to fit the screen it is on. CSS cannot
// work this out — dividing one length by another is not something calc() does
// — so the ratio is measured here and handed to the stylesheet as a plain
// number. offsetWidth is the laid-out width and ignores the transform, so
// reading it again after scaling still reports the full 210mm.
//
// At module scope, with the listener registered once, because the view is
// re-rendered into the same container every time a quotation is opened and a
// per-render listener would stack up a new copy on each visit. It finds its
// own elements by id and no-ops when the view is not on screen.
function fitSheet() {
  const sheet = document.getElementById('printSheet')
  const page = sheet?.querySelector('.print-page')
  if (!sheet || !page) return
  // The sheet's own width, not the scrolling parent's: clientWidth on .app-main
  // counts its padding, which would size the page to the padding box and push
  // its right edge under the padding on the far side.
  const available = sheet.clientWidth
  const natural = page.offsetWidth
  if (!available || !natural) return
  // Never scaled up: in a browser or on a tablet the sheet keeps its own size.
  sheet.style.setProperty('--sheet-scale', Math.min(1, available / natural))
}

// Rotation, and the keyboard opening and closing, both change the width.
if (IS_NATIVE) window.addEventListener('resize', fitSheet)

export async function renderQuotationView(container, quotationId, onBack, autoAction) {
  container.innerHTML = skeletonList(2)

  const [{ data: quotation }, { data: items }] = await Promise.all([
    supabase.from('quotations').select('*').eq('id', quotationId).single(),
    supabase.from('quotation_items').select('*').eq('quotation_id', quotationId)
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })
  ])

  if (!quotation) { container.innerHTML = '<div class="empty-state">Quotation not found.</div>'; return }

  const rows = items || []
  const grandTotal = rows.reduce((s, r) => s + (r.on_request ? 0 : Number(r.amount || 0)), 0)
  const totalMrp = rows.reduce((s, r) => s + (r.on_request ? 0 : Number(r.mrp || 0) * Number(r.qty || 0)), 0)
  const totalQty = rows.reduce((s, r) => s + (Number(r.qty) || 0), 0)
  const onRequestCount = rows.filter(r => r.on_request).length

  const pricingMode = quotation.pricing_mode === 'discount_plus_tax' ? 'discount_plus_tax' : 'tax_paid'
  const gstRate = Number(quotation.gst_rate) || 18
  let totalDiscount, taxableValue, gstAmount
  if (pricingMode === 'discount_plus_tax') {
    taxableValue = grandTotal / (1 + gstRate / 100)
    gstAmount = grandTotal - taxableValue
    totalDiscount = totalMrp - taxableValue
  } else {
    totalDiscount = totalMrp - grandTotal
  }

  const createdDate = new Date(quotation.created_at)
  const validUntil = new Date(createdDate.getTime() + 7 * 24 * 60 * 60 * 1000)
  const totals = { createdDate, validUntil, grandTotal, totalMrp, totalQty, totalDiscount, onRequestCount, pricingMode, gstRate, taxableValue, gstAmount, itemCount: rows.length }

  // Built here, after grandTotal is final, and reused on every page — never a
  // value captured before the totals were known. Falls back to the static
  // payee-only code if the QR library didn't load.
  const qrSrc = qrDataUri(upiPayUri(grandTotal, `Quotation ${quotation.quote_no || ''}`.trim())) || QR_DATA_URI

  const pages = chunk(rows, ITEMS_PER_PAGE)
  let running = 0
  const pagesHtml = pages.map((pageRows, pageIndex) => {
    const startNumber = pages.slice(0, pageIndex).reduce((s, p) => s + p.length, 0) + 1
    const brought = running
    running += pageRows.reduce((s, r) => s + (r.on_request ? 0 : Number(r.amount || 0)), 0)
    return renderPageHtml({
      quotation, pageRows, pageIndex, totalPages: pages.length,
      startNumber, isFirst: pageIndex === 0, isLast: pageIndex === pages.length - 1, totals, qrSrc,
      brought, carried: running
    })
  }).join('')

  container.innerHTML = `
    <div class="app-layout">
      <header class="app-header qv-header">
        <button class="btn-ghost" id="backBtn">← Back</button>
        <span class="logo-small">${esc(quotation.quote_no || 'Quotation')}</span>
        <div class="qv-actions">
          <button class="btn-ghost btn-small" id="editBtn">Edit</button>
          <button class="btn-ghost btn-small" id="requoteBtn">
            <span class="qv-label-long">Duplicate as new quotation</span><span class="qv-label-short">Duplicate</span>
          </button>
          <button class="btn-ghost btn-small" id="printBtn">Print</button>
          <button class="btn-primary btn-small" id="pdfBtn">
            <span class="qv-label-long">Download PDF</span><span class="qv-label-short">PDF</span>
          </button>
          <button class="btn-whatsapp-solid btn-small" id="whatsappBtn">
            <span class="qv-label-long">Share on my WhatsApp</span><span class="qv-label-short">Share</span>
          </button>
          <button class="btn-whatsapp-solid btn-small" id="jcmWaBtn" title="Sends the quotation_sent template with the PDF from JCM's official number (+91 91091 05999)">
            <span class="qv-label-long">Send from JCM number</span><span class="qv-label-short">JCM WA</span>
          </button>
        </div>
      </header>
      <main class="app-main">
        <div class="print-sheet" id="printSheet">
          ${pagesHtml}
        </div>
      </main>
    </div>
  `

  if (IS_NATIVE) fitSheet()

  document.getElementById('backBtn').addEventListener('click', onBack)
  document.getElementById('printBtn').addEventListener('click', () => window.print())
  document.getElementById('editBtn').addEventListener('click', () => {
    renderQuotationForm(container, {
      editingQuotationId: quotation.id,
      quote_no: quotation.quote_no,
      created_at: quotation.created_at,
      created_by: quotation.created_by,
      updated_at: quotation.updated_at,
      updated_by: quotation.updated_by,
      pricing_mode: quotation.pricing_mode,
      gst_rate: quotation.gst_rate,
      client_name: quotation.client_name,
      phone: quotation.phone,
      city: quotation.city,
      address: quotation.address,
      project_id: quotation.project_id,
      label: quotation.label,
      items: rows.map(r => ({ description: r.description, qty: r.qty, model: r.model, colour: r.colour, discount_pct: r.discount_pct, mrp: r.mrp }))
    }, onBack)
  })
  document.getElementById('requoteBtn').addEventListener('click', () => {
    renderQuotationForm(container, {
      client_name: quotation.client_name,
      phone: quotation.phone,
      city: quotation.city,
      address: quotation.address,
      project_id: quotation.project_id,
      items: rows.map(r => ({ description: r.description, qty: r.qty }))
    }, onBack)
  })

  // Captures the very same #printSheet .print-page elements the screen preview and
  // window.print() use — there is no separate PDF template. Anything that has to
  // differ between the three lives in the @media print block in style.css, not in
  // a second copy of the markup.
  //
  // Renders each A4 page individually (html2canvas -> addImage -> addPage) instead of
  // handing one long element to html2pdf.js's automatic slicer, which is what caused
  // rows to get cut across a page boundary — this guarantees breaks only ever land
  // between pages, never through the middle of a row.
  async function generatePdf() {
    const pageEls = document.querySelectorAll('#printSheet .print-page')
    const { jsPDF } = window.jspdf
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
    for (let i = 0; i < pageEls.length; i++) {
      const canvas = await window.html2canvas(pageEls[i], { scale: 2, useCORS: true })
      // JPEG at high quality instead of PNG — the letterhead is mostly flat colour and
      // text, which JPEG compresses far better than lossless PNG; keeps a multi-page
      // quotation a few hundred KB instead of tens of MB, so it's actually practical
      // to send over WhatsApp/email.
      const imgData = canvas.toDataURL('image/jpeg', 0.92)
      if (i > 0) doc.addPage()
      doc.addImage(imgData, 'JPEG', 0, 0, 210, 297)
    }
    return doc
  }

  // The sheet is scaled down to fit the phone (see .qv-sheet-fit in style.css).
  // html2canvas reads the element as the page has it, so capturing while that
  // is on would bake the shrunk version into the PDF. Dropped for the length
  // of the capture and put straight back.
  async function generatePdfAtFullSize() {
    const sheet = document.getElementById('printSheet')
    sheet?.classList.add('qv-capturing')
    try {
      return await generatePdf()
    } finally {
      sheet?.classList.remove('qv-capturing')
    }
  }

  // Keeps the long/short label spans intact while a button is working, so the
  // narrow layout does not lose them the first time something is generated.
  function withBusy(btn, busyText, work) {
    const original = btn.innerHTML
    btn.disabled = true
    btn.textContent = busyText
    return work().catch(err => {
      hqAlert(`Could not produce the PDF: ${err.message}`)
    }).finally(() => {
      btn.disabled = false
      btn.innerHTML = original
    })
  }

  const fileName = pdfFilename(quotation.quote_no)

  document.getElementById('pdfBtn').addEventListener('click', () => {
    const btn = document.getElementById('pdfBtn')
    withBusy(btn, 'Generating…', async () => {
      const doc = await generatePdfAtFullSize()
      await sharePdf(doc, fileName, { title: fileName })
    })
  })

  document.getElementById('whatsappBtn').addEventListener('click', () => {
    const phone = (quotation.phone || '').trim()
    const message = `Hi ${quotation.client_name}, please find your quotation ${quotation.quote_no} from J.C. Mittal and Sons attached. Total: ${money(grandTotal)}. Valid until ${validUntil.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}.`

    // On the phone the share sheet carries the file itself, so WhatsApp opens
    // with the PDF already attached and there is nothing to find and attach by
    // hand. No phone number is needed for that — the chat is picked in the
    // sheet — so the number is only required on the web path, where all a
    // wa.me link can carry is text.
    if (IS_NATIVE) {
      const btn = document.getElementById('whatsappBtn')
      withBusy(btn, 'Generating…', async () => {
        const doc = await generatePdfAtFullSize()
        await sharePdf(doc, fileName, { title: fileName, text: message })
      })
      return
    }

    if (!phone) { hqAlert('No phone number on this quotation'); return }
    // window.open must run synchronously in the click handler, before any await —
    // otherwise most browsers' popup blockers will silently swallow the new tab.
    window.open(waHref(phone, message), '_blank', 'noopener')

    const btn = document.getElementById('whatsappBtn')
    withBusy(btn, 'Generating PDF…', async () => {
      const doc = await generatePdfAtFullSize()
      await sharePdf(doc, fileName, { title: fileName })
      hqAlert('PDF downloaded — attach it in the WhatsApp chat that just opened, then hit send.')
    })
  })

  // Official number: the quotation_sent template with the PDF attached, sent by HQ (api/whatsapp.js).
  document.getElementById('jcmWaBtn').addEventListener('click', async () => {
    const phone = (quotation.phone || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '')
    if (!/^[6-9]\d{9}$/.test(phone)) { hqAlert('No valid 10-digit mobile number on this quotation.'); return }
    if (!await hqConfirm(`Send quotation ${quotation.quote_no} to ${quotation.client_name} (+91 ${phone}) from JCM's WhatsApp number? It cannot be taken back.`)) return
    const btn = document.getElementById('jcmWaBtn')
    withBusy(btn, 'Sending…', async () => {
      const doc = await generatePdfAtFullSize()
      const uri = doc.output('datauristring')
      const { supabase } = await import('./supabase.js')
      const { apiUrl } = await import('./native.js')
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(apiUrl('/api/whatsapp'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
        body: JSON.stringify({ action: 'quotation', phone, name: quotation.client_name, quote_no: quotation.quote_no, date: createdDate.toISOString().slice(0, 10), total: Math.round(grandTotal), filename: fileName, pdf_base64: uri.slice(uri.indexOf(',') + 1) }),
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(out.error || 'Could not send.')
      hqAlert('Sent from JCM\'s WhatsApp number. You can see it under WhatsApp → Log.')
    })
  })

  // Lets other screens (e.g. quick-action buttons on the Quotations list) jump
  // straight into an action instead of landing on the view and requiring another click.
  if (autoAction === 'edit') document.getElementById('editBtn').click()
  else if (autoAction === 'duplicate') document.getElementById('requoteBtn').click()
  else if (autoAction === 'print') document.getElementById('printBtn').click()
  else if (autoAction === 'pdf') document.getElementById('pdfBtn').click()
  else if (autoAction === 'whatsapp') document.getElementById('whatsappBtn').click()
}
