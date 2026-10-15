// Email Purchase Summary — what the brands have billed us by email: every supplier
// invoice that arrived in the Gmail inbox, read by Claude on JCM-Server, with supplier,
// invoice no. and date, when the mail came in, and every item with qty, pre-GST rate,
// GST and amount. Credit / debit notes are shown too, marked apart.
//
// Looks and works like Purchase Summary (src/purchases.js) — same pur-* styles — and
// uses the same /api/purchases function (actions email-*), which checks the HQ session
// and the 'email-purchases' page right. Data comes from busy-sync/sync-email-purchases.js
// (JCM Sync job every 15 min).
import { openSidebar } from './sidebar.js'
import { canSee } from './permissions.js'
import { esc } from './utils.js'
import { icon } from './icons.js'
import { openPdfViewer } from './pdf-viewer.js'
import { hqConfirm } from './hq-dialog.js'
import { callPurchases as call } from './purchases.js'
import './email-purchases.css'

const TAB_ID = 'email-purchases'

// ---------- formatting ----------
const IST_MS = 5.5 * 3600 * 1000
const dayIST = (offsetDays = 0) => new Date(Date.now() + IST_MS + offsetDays * 86400000).toISOString().slice(0, 10)
const dayOf = s => new Date(new Date(s).getTime() + IST_MS).toISOString().slice(0, 10)
function fmtDate(s) {
  if (!s) return ''
  const d = new Date(String(s).length === 10 ? `${s}T00:00:00+05:30` : s)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}
function fmtDay(s) {
  const d = new Date(`${s}T00:00:00+05:30`)
  return d.toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}
function fmtTime(s) {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
}
function ago(s) {
  if (!s) return 'never'
  const mins = Math.round((Date.now() - new Date(s).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const h = Math.round(mins / 60)
  return h < 48 ? `${h} hr ago` : fmtDate(s)
}
const num = n => { const v = Number(n || 0); return Number.isInteger(v) ? v.toLocaleString('en-IN') : (Math.round(v * 1000) / 1000).toLocaleString('en-IN') }
const money = n => {
  const v = Math.round(Number(n || 0) * 100) / 100
  return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })
}
const pct = n => (n == null || n === '' ? '' : `${num(n)}%`)
const KIND = { invoice: 'Invoice', credit_note: 'Credit note', debit_note: 'Debit note' }

// ---------- page ----------
export async function renderEmailPurchases(container) {
  if (!canSee(TAB_ID)) {
    container.innerHTML = '<div class="empty-state">You do not have access to this page.</div>'
    setTimeout(() => { window.location.hash = '' }, 1500)
    return
  }

  const state = {
    range: 'today', from: dayIST(), to: dayIST(), by: 'received', kind: 'all', q: '',
    bills: [], totals: null, more: false, lastSyncAt: null, lastSyncNote: null,
    open: new Set(), allOpen: true, seq: 0, senders: null,
  }

  container.innerHTML = `
    <div class="app-layout pur-page ep-page">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="epHamburgerBtn" aria-label="Menu">☰</button>
          <span class="logo-small pur-title">${icon('message', 18)} Email Purchase Summary</span>
        </div>
        <div class="pur-header-actions">
          <button class="btn-ghost btn-small" id="epSendersBtn">${icon('users', 14)} Brands &amp; mails</button>
          <button class="btn-ghost btn-small" id="epRefreshBtn">Refresh</button>
        </div>
      </header>
      <main class="app-main">
        <div class="pur-toolbar">
          <div class="pur-chips" id="epChips">
            <button class="pur-chip" data-range="today">Today</button>
            <button class="pur-chip" data-range="yesterday">Yesterday</button>
            <button class="pur-chip" data-range="week">Last 7 days</button>
            <button class="pur-chip" data-range="month">This month</button>
          </div>
          <label class="pur-date"><span>From</span><input type="date" id="epFrom" min="2026-04-01" /></label>
          <label class="pur-date"><span>To</span><input type="date" id="epTo" min="2026-04-01" /></label>
          <select id="epBy" class="pur-select" aria-label="Which date">
            <option value="received">By date the mail came in</option>
            <option value="invoice">By invoice date</option>
          </select>
          <select id="epKind" class="pur-select" aria-label="Which documents">
            <option value="all">Invoices + notes</option>
            <option value="invoice">Invoices only</option>
            <option value="notes">Credit / debit notes</option>
          </select>
          <input id="epSearch" class="pur-search" type="search" placeholder="Search brand, invoice no. or item…" autocomplete="off" />
        </div>
        <div class="pur-tiles" id="epTiles"></div>
        <div class="pur-listbar">
          <span class="pur-sync" id="epSync"></span>
          <span class="pur-listbar-actions">
            <button class="btn-ghost btn-small pur-wa-btn" id="epSendersBtn2">Brands &amp; mails</button>
            <button class="pur-link" id="epToggleAll">Hide items</button>
          </span>
        </div>
        <div id="epList"><div class="loading-state">Loading…</div></div>
      </main>

      <div class="pur-drawer-backdrop" id="epDrawerBackdrop" hidden></div>
      <aside class="pur-drawer ep-drawer" id="epDrawer" hidden aria-label="Brands and mails">
        <div class="pur-drawer-head">
          <strong>Brands &amp; mails</strong>
          <button class="btn-ghost btn-small" id="epDrawerClose" aria-label="Close">${icon('x', 16)}</button>
        </div>
        <div id="epDrawerBody"><div class="loading-state">Loading…</div></div>
      </aside>
    </div>
  `

  const $ = id => document.getElementById(id)
  $('epHamburgerBtn').addEventListener('click', () => openSidebar())
  $('epRefreshBtn').addEventListener('click', () => load())

  // ---- filters
  function setRange(range) {
    state.range = range
    const today = dayIST()
    if (range === 'today') { state.from = today; state.to = today }
    if (range === 'yesterday') { state.from = dayIST(-1); state.to = dayIST(-1) }
    if (range === 'week') { state.from = dayIST(-6); state.to = today }
    if (range === 'month') { state.from = `${today.slice(0, 8)}01`; state.to = today }
  }
  $('epChips').addEventListener('click', e => {
    const b = e.target.closest('[data-range]')
    if (!b) return
    setRange(b.dataset.range)
    load()
  })
  $('epFrom').addEventListener('change', e => {
    if (!e.target.value) return
    state.range = ''; state.from = e.target.value
    if (state.to < state.from) state.to = state.from
    load()
  })
  $('epTo').addEventListener('change', e => {
    if (!e.target.value) return
    state.range = ''; state.to = e.target.value
    if (state.from > state.to) state.from = state.to
    load()
  })
  $('epBy').addEventListener('change', e => { state.by = e.target.value; load() })
  $('epKind').addEventListener('change', e => { state.kind = e.target.value; load() })
  let searchTimer = null
  $('epSearch').addEventListener('input', e => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { state.q = e.target.value.trim(); load() }, 350)
  })
  $('epToggleAll').addEventListener('click', () => {
    state.allOpen = !state.allOpen
    state.open.clear()
    paintList()
  })

  // ---- bills
  $('epList').addEventListener('click', async e => {
    const pdfBtn = e.target.closest('[data-pdf]')
    if (pdfBtn) {
      e.stopPropagation()
      pdfBtn.disabled = true
      try {
        const r = await call({ action: 'email-pdf', id: pdfBtn.dataset.pdf })
        await openPdfViewer({ base64: r.base64, filename: r.filename })
      } catch (err) { flash(err.message) } finally { pdfBtn.disabled = false }
      return
    }
    const head = e.target.closest('[data-toggle]')
    if (!head) return
    const key = head.dataset.toggle
    if (state.open.has(key)) state.open.delete(key)
    else state.open.add(key)
    paintList()
  })
  $('epList').addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-toggle]')) { e.preventDefault(); e.target.click() }
  })

  async function load(quiet = false) {
    const seq = ++state.seq
    paintFilters()
    if (!quiet) $('epList').innerHTML = '<div class="loading-state">Loading…</div>'
    try {
      const data = await call({ action: 'email-list', from: state.from, to: state.to, by: state.by, kind: state.kind, q: state.q })
      if (seq !== state.seq) return
      state.bills = data.bills || []
      state.totals = data.totals
      state.more = data.more
      state.lastSyncAt = data.lastSyncAt
      state.lastSyncNote = data.lastSyncNote
      state.open.clear()
      paintTiles(); paintList()
    } catch (err) {
      if (seq !== state.seq) return
      $('epList').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`
      $('epTiles').innerHTML = ''
    }
  }

  function paintFilters() {
    $('epFrom').value = state.from
    $('epTo').value = state.to
    $('epBy').value = state.by
    $('epKind').value = state.kind
    document.querySelectorAll('#epChips [data-range]').forEach(b => b.classList.toggle('active', b.dataset.range === state.range))
  }

  function paintTiles() {
    const t = state.totals || {}
    const tiles = [
      { label: 'Invoices by email', value: num(t.bills) },
      { label: 'Brands', value: num(t.parties) },
      { label: 'Item lines', value: num(t.items) },
      { label: 'Invoice value', value: money(t.value), wide: true },
    ]
    if (t.notes) tiles.push({ label: 'Credit / debit notes', value: `${num(t.notes)} · ${money(t.notesValue)}` })
    $('epTiles').innerHTML = tiles.map(x => `
      <div class="pur-tile${x.wide ? ' is-value' : ''}"><div class="pur-tile-value">${esc(x.value)}</div><div class="pur-tile-label">${esc(x.label)}</div></div>`).join('')
    $('epSync').innerHTML = `${icon('clock', 13)} Mailbox last read ${esc(ago(state.lastSyncAt))}${state.lastSyncAt ? ` (${esc(fmtTime(state.lastSyncAt))})` : ''} · every 15 min`
  }

  function paintList() {
    $('epToggleAll').textContent = state.allOpen ? 'Hide items' : 'Show items'
    if (!state.bills.length) {
      const what = state.from === state.to ? fmtDate(state.from) : `${fmtDate(state.from)} – ${fmtDate(state.to)}`
      $('epList').innerHTML = `<div class="empty-state">No invoice mails ${state.by === 'invoice' ? 'dated' : 'received'} ${state.from === state.to ? 'on' : 'between'} ${esc(what)}${state.q ? ` matching “${esc(state.q)}”` : ''}.</div>`
      return
    }
    const multi = state.from !== state.to
    const groups = []
    for (const b of state.bills) {
      const day = state.by === 'invoice' ? b.invoice_date : (b.received_at ? dayOf(b.received_at) : b.invoice_date)
      let g = groups[groups.length - 1]
      if (!g || g.day !== day) { g = { day, bills: [] }; groups.push(g) }
      g.bills.push(b)
    }
    const html = groups.map(g => {
      const inv = g.bills.filter(b => b.doc_kind === 'invoice')
      const total = inv.reduce((s, b) => s + Number(b.bill_total || 0), 0)
      const head = multi ? `<div class="pur-day"><strong>${esc(g.day ? fmtDay(g.day) : 'No date')}</strong><span>${inv.length} invoice${inv.length === 1 ? '' : 's'} · ${money(total)}${g.bills.length > inv.length ? ` · ${g.bills.length - inv.length} note${g.bills.length - inv.length === 1 ? '' : 's'}` : ''}</span></div>` : ''
      return head + g.bills.map(billCard).join('')
    }).join('')
    $('epList').innerHTML = `<div class="pur-list">${html}</div>${state.more ? '<p class="pur-more">Showing the first 300. Pick a shorter date range to see the rest.</p>' : ''}`
  }

  function billCard(b) {
    const key = String(b.id)
    const open = state.allOpen !== state.open.has(key)
    const isNote = b.doc_kind !== 'invoice'
    const flags = []
    if (isNote) flags.push(`<span class="pur-flag pur-flag-bad">${esc(KIND[b.doc_kind] || b.doc_kind)}</span>`)
    if (b.source === 'body') flags.push('<span class="pur-flag pur-flag-quiet">From the mail text, no PDF</span>')
    if (b.extract_note) flags.push(`<span class="pur-flag" title="${esc(b.extract_note)}">${icon('question', 11)} Note from the reader</span>`)
    const lines = b.lines || []
    const sub = [`${KIND[b.doc_kind] || 'Invoice'} <strong>${esc(b.invoice_no || '—')}</strong>`, `dated ${esc(fmtDate(b.invoice_date)) || '—'}`, `${b.item_count} item${b.item_count === 1 ? '' : 's'}, qty ${esc(num(b.total_qty))}`]
    const showTax = b.taxable_total != null && Math.abs(Number(b.taxable_total) + Number(b.tax_total || 0) - Number(b.bill_total || 0)) < 1.01
    return `
      <article class="pur-bill${isNote ? ' ep-note' : ''}${open ? ' is-open' : ''}">
        <div class="pur-bill-head" data-toggle="${key}" role="button" tabindex="0" aria-expanded="${open}">
          <div class="pur-bill-main">
            <div class="pur-party">${esc(b.supplier_name || b.brand || 'Unknown supplier')}${b.brand && b.supplier_name && !b.supplier_name.toLowerCase().includes(b.brand.split(' ')[0].toLowerCase()) ? ` <small class="ep-brand">${esc(b.brand)}</small>` : ''}</div>
            <div class="pur-bill-sub">${sub.join(' · ')}</div>
            <div class="pur-bill-meta">Mail received <strong>${esc(fmtDate(b.received_at))}, ${esc(fmtTime(b.received_at))}</strong> from ${esc(b.sender || '')}</div>
            ${flags.length ? `<div class="pur-flags">${flags.join('')}</div>` : ''}
          </div>
          <div class="pur-bill-side">
            <div class="pur-amount">${isNote ? '−' : ''}${money(b.bill_total)}</div>
            <span class="pur-chevron">${icon(open ? 'chevron-down' : 'chevron-right', 16)}</span>
          </div>
        </div>
        ${open ? `
        <div class="pur-items">
          <table class="pur-table ep-table">
            <thead><tr><th class="pur-n">#</th><th>Item</th><th class="pur-r">Qty</th><th class="pur-r">Rate <small>(before GST)</small></th><th class="pur-r">GST</th><th class="pur-r">Amount</th></tr></thead>
            <tbody>
              ${lines.map((l, i) => `<tr><td class="pur-n">${i + 1}</td><td>${esc(l.item_name || 'Item')}${l.hsn ? ` <small class="ep-hsn">HSN ${esc(l.hsn)}</small>` : ''}</td><td class="pur-r">${esc(num(l.qty))}${l.unit ? ` <small>${esc(l.unit)}</small>` : ''}</td><td class="pur-r">${l.rate == null ? '' : money(l.rate)}</td><td class="pur-r">${esc(pct(l.gst_rate))}</td><td class="pur-r">${money(l.amount)}</td></tr>`).join('') || '<tr><td colspan="6" class="pur-noitems">No item lines were found on this document.</td></tr>'}
            </tbody>
            <tfoot>
              ${showTax ? `<tr><td></td><td>Before GST</td><td class="pur-r">${esc(num(b.total_qty))}</td><td></td><td></td><td class="pur-r">${money(b.taxable_total)}</td></tr>
              <tr><td></td><td>GST</td><td></td><td></td><td></td><td class="pur-r">${money(b.tax_total)}</td></tr>` : ''}
              <tr class="pur-total"><td></td><td>${isNote ? 'Note value' : 'Invoice total'}</td><td class="pur-r">${showTax ? '' : esc(num(b.total_qty))}</td><td></td><td></td><td class="pur-r">${money(b.bill_total)}</td></tr>
            </tfoot>
          </table>
          ${b.extract_note ? `<p class="ep-extract-note">${icon('question', 12)} ${esc(b.extract_note)}</p>` : ''}
          <div class="pur-item-actions">
            ${b.attachment_path ? `<button class="btn-ghost btn-small" data-pdf="${key}">${icon('file', 13)} Open the PDF</button>` : ''}
          </div>
        </div>` : ''}
      </article>`
  }

  // ---- drawer: senders + recent mails
  $('epSendersBtn').addEventListener('click', openDrawer)
  $('epSendersBtn2').addEventListener('click', openDrawer)
  $('epDrawerClose').addEventListener('click', closeDrawer)
  $('epDrawerBackdrop').addEventListener('click', closeDrawer)
  function closeDrawer() { $('epDrawer').hidden = true; $('epDrawerBackdrop').hidden = true }
  async function openDrawer() {
    $('epDrawer').hidden = false; $('epDrawerBackdrop').hidden = false
    $('epDrawerBody').innerHTML = '<div class="loading-state">Loading…</div>'
    try {
      state.senders = await call({ action: 'email-senders' })
      paintDrawer()
    } catch (err) {
      $('epDrawerBody').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`
    }
  }

  const MAIL_STATUS = { done: ['Read', 'ok'], no_invoice: ['No invoice in it', 'quiet'], skipped: ['Skipped by subject', 'quiet'], failed: ['Failed — will retry', 'bad'], reading: ['Reading…', 'quiet'] }
  function paintDrawer() {
    const { senders, settings, mails } = state.senders
    $('epDrawerBody').innerHTML = `
      <p class="pur-hint">Only mails from these senders are read. Add a brand's invoice address (or just its domain) and the next run picks it up.</p>
      <div class="ep-senders">
        ${senders.map(s => `
          <div class="ep-sender${s.enabled ? '' : ' is-off'}">
            <label class="ep-sender-main"><input type="checkbox" data-sender-toggle="${esc(s.match)}" ${s.enabled ? 'checked' : ''} /> <span><strong>${esc(s.brand || s.match)}</strong><br><small>${esc(s.match)}${s.note ? ` · ${esc(s.note)}` : ''}</small></span></label>
            <button class="btn-ghost btn-small" data-sender-remove="${esc(s.match)}" aria-label="Remove ${esc(s.match)}">${icon('x', 12)}</button>
          </div>`).join('')}
      </div>
      <div class="ep-add">
        <input id="epAddMatch" placeholder="noreply@brand.com or brand.com" autocomplete="off" />
        <input id="epAddBrand" placeholder="Brand name" autocomplete="off" />
        <button class="btn-ghost btn-small" id="epAddBtn">${icon('plus', 12)} Add</button>
      </div>
      <h4 class="pur-drawer-sub">Mailbox</h4>
      <p class="pur-hint">Last read ${esc(ago(settings.last_sync_at))}${settings.last_sync_note ? ` — ${esc(settings.last_sync_note)}` : ''}. Reading started from ${esc(fmtDate(settings.scan_from))}.</p>
      <h4 class="pur-drawer-sub">Mails looked at recently</h4>
      <div class="ep-mails">
        ${mails.map(m => {
          const [text, tone] = MAIL_STATUS[m.status] || [m.status, 'quiet']
          return `<div class="ep-mail">
            <div><strong>${esc(m.subject || '(no subject)')}</strong><br><small>${esc(m.sender || '')} · ${esc(fmtDate(m.received_at))} ${esc(fmtTime(m.received_at))}${m.bills ? ` · ${m.bills} bill${m.bills === 1 ? '' : 's'}` : ''}</small>${m.note && m.status !== 'done' ? `<br><small class="ep-mail-note">${esc(m.note)}</small>` : ''}</div>
            <div class="ep-mail-side"><span class="pur-flag pur-flag-${tone}">${esc(text)}</span>${m.status === 'no_invoice' || m.status === 'skipped' ? `<button class="pur-link" data-mail-retry="${esc(m.message_id)}">Read again</button>` : ''}</div>
          </div>`
        }).join('') || '<div class="empty-state">Nothing read yet.</div>'}
      </div>
    `
    const body = $('epDrawerBody')
    body.querySelectorAll('[data-sender-toggle]').forEach(box => box.addEventListener('change', async () => {
      try { await call({ action: 'email-sender-save', match: box.dataset.senderToggle, enabled: box.checked }); flash('Saved.') }
      catch (err) { box.checked = !box.checked; flash(err.message) }
    }))
    body.querySelectorAll('[data-sender-remove]').forEach(btn => btn.addEventListener('click', async () => {
      if (!await hqConfirm(`Stop reading mails from ${btn.dataset.senderRemove}?`)) return
      try { await call({ action: 'email-sender-save', match: btn.dataset.senderRemove, remove: true }); openDrawer() }
      catch (err) { flash(err.message) }
    }))
    body.querySelector('#epAddBtn').addEventListener('click', async () => {
      const match = body.querySelector('#epAddMatch').value.trim()
      const brand = body.querySelector('#epAddBrand').value.trim()
      if (!match) { flash('Type the sender address or domain first.'); return }
      try { await call({ action: 'email-sender-save', match, brand, enabled: true }); flash('Added.'); openDrawer() }
      catch (err) { flash(err.message) }
    })
    body.querySelectorAll('[data-mail-retry]').forEach(btn => btn.addEventListener('click', async () => {
      try { await call({ action: 'email-mail-retry', message_id: btn.dataset.mailRetry }); flash('It will be read again within 15 minutes.'); openDrawer() }
      catch (err) { flash(err.message) }
    }))
  }

  setRange('today')
  load()
}

function flash(message) {
  document.querySelectorAll('.app-notice').forEach(el => el.remove())
  const el = document.createElement('div')
  el.className = 'app-notice'
  el.setAttribute('role', 'status')
  el.textContent = message
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 4000)
}

// Sidebar badge: invoice mails received today. Only for people who can open the page.
export async function loadEmailPurchasesBadge() {
  if (!canSee(TAB_ID)) return 0
  try {
    const data = await call({ action: 'email-count' })
    return data?.today || 0
  } catch {
    return 0
  }
}
