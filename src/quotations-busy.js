// Quotations → "From Busy" tab (2026-10-15): quotations typed in Busy (VchType 26, QT/…), synced by
// busy-sync/sync-quotations.js every 10 min. Read-only list with search, a detail sheet with the
// item lines, PDF (in-app viewer) and Send on WhatsApp (quotation_sent template + PDF Copy button).
// Server: api/customers.js actions busy-quotes / busy-quote / busy-quote-pdf / busy-quote-send.
import { supabase } from './supabase.js'
import { apiUrl } from './native.js'
import { esc, formatMoney } from './utils.js'
import { openPdfViewer } from './pdf-viewer.js'
import { hqAlert } from './hq-dialog.js'
import './quotations-busy.css'

async function call(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(apiUrl('/api/customers'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` }, body: JSON.stringify(payload),
  })
  let body = null
  try { body = await res.json() } catch { /* no body */ }
  if (!res.ok) throw new Error(body?.error || 'Something went wrong. Try again.')
  return body
}
const day = s => (s ? new Date(s + (String(s).length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '')
const pretty = d => /^[6-9]\d{9}$/.test(d) ? `${d.slice(0, 5)} ${d.slice(5)}` : d
const WA = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 20zm4.4-6c-.2-.1-1.4-.7-1.6-.8s-.4-.1-.5.1l-.8.9c-.1.2-.3.2-.5.1a6.5 6.5 0 0 1-3.3-2.9c-.2-.4.3-.4.8-1.3.1-.2 0-.3 0-.4l-.7-1.7c-.2-.5-.4-.4-.5-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.1.6a2.6 2.6 0 0 0 1.7-1.2 2 2 0 0 0 .2-1.2c-.1-.1-.3-.2-.5-.3z"/></svg>'

export function renderBusyQuotations(host) {
  const state = { q: '', page: 0, data: null, loading: false, ticket: 0 }
  host.innerHTML = `
    <div class="qb-wrap">
      <div class="qtn-filters-row">
        <input type="search" id="qbSearch" class="search-input" placeholder="Search party or quotation no…" autocomplete="off">
      </div>
      <div class="qb-note" id="qbNote"></div>
      <div id="qbList"><div class="loading-state">Loading quotations from Busy…</div></div>
      <div id="qbPager" class="qb-pager"></div>
    </div>`
  const $ = id => host.querySelector('#' + id)
  let t = null
  $('qbSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.q = $('qbSearch').value.trim(); state.page = 0; load() }, 300) })
  $('qbList').addEventListener('click', e => {
    const row = e.target.closest('[data-key]')
    if (row) openQuote(row.dataset.key)
  })
  $('qbPager').addEventListener('click', e => {
    const b = e.target.closest('[data-page]'); if (!b) return
    state.page = Number(b.dataset.page); load()
  })

  async function load() {
    const ticket = ++state.ticket
    $('qbList').innerHTML = '<div class="loading-state">Loading…</div>'
    try {
      const d = await call({ action: 'busy-quotes', q: state.q, page: state.page })
      if (ticket !== state.ticket || !host.isConnected) return
      state.data = d
      draw()
    } catch (err) {
      if (ticket !== state.ticket) return
      $('qbList').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`
    }
  }

  function draw() {
    const d = state.data
    $('qbNote').textContent = d.lastSync ? `From Busy · last synced ${new Date(d.lastSync).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${d.total} quotation${d.total === 1 ? '' : 's'}` : 'No quotations synced from Busy yet — the JCM Sync job "Quotations from Busy" fills this every 10 minutes.'
    if (!d.rows.length) { $('qbList').innerHTML = '<div class="empty-state">No quotation matches.</div>'; $('qbPager').innerHTML = ''; return }
    $('qbList').innerHTML = `
      <div class="qb-rows">${d.rows.map(r => `
        <button type="button" class="qb-row ${r.cancelled ? 'is-cancelled' : ''}" data-key="${esc(r.vch_key)}">
          <span class="qb-main">
            <span class="qb-name">${esc(r.billed_name || r.party_name || '—')}</span>
            <span class="qb-sub">${esc(r.vch_no || '')} · ${esc(day(r.quote_date))}${r.city ? ` · ${esc(r.city)}` : ''}${r.entered_by ? ` · by ${esc(r.entered_by)}` : ''}</span>
          </span>
          <span class="qb-side">
            <span class="qb-amt">${r.cancelled ? '<span class="pf-pill pf-tone-red">Cancelled</span>' : esc(formatMoney(r.quote_total || 0))}</span>
            <span class="qb-sub">${r.item_count} item${r.item_count === 1 ? '' : 's'}${r.mobile ? ` · ${esc(pretty(String(r.mobile).replace(/\D/g, '').slice(-10)))}` : ' · no mobile'}</span>
          </span>
        </button>`).join('')}</div>`
    const pages = Math.max(1, Math.ceil(d.total / d.pageSize))
    $('qbPager').innerHTML = pages > 1 ? `
      <button type="button" class="btn-ghost btn-small" data-page="${Math.max(0, d.page - 1)}" ${d.page === 0 ? 'disabled' : ''}>‹ Prev</button>
      <span class="qb-sub">Page ${d.page + 1} of ${pages}</span>
      <button type="button" class="btn-ghost btn-small" data-page="${Math.min(pages - 1, d.page + 1)}" ${d.page >= pages - 1 ? 'disabled' : ''}>Next ›</button>` : ''
  }

  async function openQuote(key) {
    const ov = document.createElement('div')
    ov.className = 'modal-overlay'
    ov.innerHTML = '<div class="modal qb-modal" role="dialog" aria-modal="true"><div class="loading-state">Loading…</div></div>'
    document.body.appendChild(ov)
    const close = () => ov.remove()
    ov.addEventListener('click', e => { if (e.target === ov) close() })
    let d
    try { d = await call({ action: 'busy-quote', vch_key: key }) } catch (err) { ov.querySelector('.modal').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`; return }
    const q = d.quote
    const name = q.billed_name || q.party_name || '—'
    const mobile = String(q.mobile || '').replace(/\D/g, '').slice(-10)
    ov.querySelector('.modal').innerHTML = `
      <div class="modal-header">
        <div><h2>${esc(q.vch_no || 'Quotation')}</h2><div class="qb-sub">${esc(day(q.quote_date))}${q.cancelled ? ' · <b style="color:var(--red-dk)">Cancelled in Busy</b>' : ''}</div></div>
        <button type="button" class="btn-ghost btn-small" id="qbClose" aria-label="Close">✕</button>
      </div>
      <div class="qb-party"><b>${esc(name)}</b>${q.billed_name && q.party_name && q.billed_name !== q.party_name ? `<div class="qb-sub">A/c ${esc(q.party_name)}</div>` : ''}<div class="qb-sub">${[q.city, mobile ? pretty(mobile) : 'No mobile on the quotation'].filter(Boolean).map(esc).join(' · ')}</div></div>
      ${q.narration ? `<div class="qb-sub">“${esc(q.narration)}”</div>` : ''}
      <table class="cu-table qb-table">
        <thead><tr><th>#</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">GST</th><th class="num">Amount</th></tr></thead>
        <tbody>${d.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.item_name || '')}${l.discount_pct ? `<div class="qb-sub">less ${esc(String(l.discount_pct))}%</div>` : ''}</td><td class="num">${esc(String(l.qty ?? ''))}</td><td class="num">${esc(formatMoney(l.rate_before_gst || 0))}</td><td class="num">${l.gst_rate != null ? esc(String(l.gst_rate)) + '%' : ''}</td><td class="num">${esc(formatMoney(l.amount || 0))}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="5" class="num"><b>Total (GST incl.)</b></td><td class="num"><b>${esc(formatMoney(q.quote_total || 0))}</b></td></tr></tfoot>
      </table>
      <div class="qb-actions">
        <button type="button" class="btn-ghost" id="qbPdf">PDF</button>
        <button type="button" class="btn-contact btn-whatsapp" id="qbSend" ${q.cancelled ? 'disabled' : ''}>${WA} Send on WhatsApp</button>
      </div>
      <div class="qb-send" id="qbSendBox" hidden>
        <label>Send to <input type="tel" id="qbPhone" inputmode="numeric" maxlength="10" value="${esc(mobile)}" placeholder="10-digit mobile"></label>
        <div class="qb-sub">The approved JCM quotation message goes out with a <b>PDF Copy</b> button. It cannot be taken back.</div>
        <p class="cu-error" id="qbErr" hidden></p>
        <div class="qb-actions"><button type="button" class="btn-ghost btn-small" id="qbNo">Cancel</button><button type="button" class="btn-primary btn-small" id="qbYes">Yes, send</button></div>
      </div>`
    ov.querySelector('#qbClose').addEventListener('click', close)
    ov.querySelector('#qbPdf').addEventListener('click', async () => {
      const b = ov.querySelector('#qbPdf'); b.disabled = true; b.textContent = 'Making PDF…'
      try { const r = await call({ action: 'busy-quote-pdf', vch_key: key }); await openPdfViewer({ base64: r.base64, filename: r.filename }) }
      catch (err) { hqAlert(err.message) }
      b.disabled = false; b.textContent = 'PDF'
    })
    ov.querySelector('#qbSend').addEventListener('click', () => { ov.querySelector('#qbSendBox').hidden = false; ov.querySelector('#qbPhone').focus() })
    ov.querySelector('#qbNo').addEventListener('click', () => { ov.querySelector('#qbSendBox').hidden = true })
    ov.querySelector('#qbYes').addEventListener('click', async () => {
      const phone = ov.querySelector('#qbPhone').value.replace(/\D/g, '')
      const err = ov.querySelector('#qbErr')
      if (!/^[6-9]\d{9}$/.test(phone)) { err.textContent = 'Type a 10-digit mobile number.'; err.hidden = false; return }
      const y = ov.querySelector('#qbYes'); y.disabled = true; y.textContent = 'Sending…'; err.hidden = true
      try {
        const r = await call({ action: 'busy-quote-send', vch_key: key, phone })
        ov.querySelector('#qbSendBox').innerHTML = `<div class="qb-ok">✓ Quotation ${esc(q.vch_no || '')} sent to <b>${esc(pretty(phone))}</b> (${esc(r.name)}). See WhatsApp → Log.</div>`
      } catch (e) { err.textContent = e.message; err.hidden = false; y.disabled = false; y.textContent = 'Yes, send' }
    })
  }

  load()
}
