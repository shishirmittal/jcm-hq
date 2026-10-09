// Red Alerts — sales lines billed at ₹0 and anything deleted in Busy
// (items, accounts, vouchers), so an admin sees them the same day.
//
// Data: red_alerts / red_alert_skip_items / busy_user_names in the JCM-Busysql
// project, filled every 15 minutes by busy-sync/sync-red-alerts.js on
// JCM-Server. Those tables are closed to the browser (RLS, no policies), so
// every read and write here goes through /api/red-alerts, which checks the
// person's HQ session first.
//
// Each alert is New until someone looks at it. "Seen" = looked at, still
// open. "OK" = explained, closed (with an optional note). Closed alerts stay
// on record under the OK / All tabs; nothing is ever deleted.
import { supabase } from './supabase.js'
import { openSidebar, refreshNavBadges } from './sidebar.js'
import { canSee } from './permissions.js'
import { apiUrl } from './native.js'
import { esc, formatMoney } from './utils.js'
import { icon } from './icons.js'

const STATUS_TABS = [
  { id: 'open', label: 'Open' },
  { id: 'new', label: 'New' },
  { id: 'seen', label: 'Seen' },
  { id: 'ok', label: 'OK' },
  { id: 'all', label: 'All' },
]

const TYPE_INFO = {
  zero_billing: { label: '₹0 billing', tone: 'red' },
  deleted_voucher: { label: 'Voucher deleted', tone: 'red' },
  deleted_item: { label: 'Item deleted', tone: 'amber' },
  deleted_account: { label: 'Account deleted', tone: 'amber' },
  deleted_other: { label: 'Other deleted', tone: 'grey' },
}

const STATUS_LABEL = { new: 'New', seen: 'Seen', ok: 'OK' }

async function call(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(apiUrl('/api/red-alerts'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
    body: JSON.stringify(payload),
  })
  let body = null
  try { body = await res.json() } catch { /* empty or non-JSON answer */ }
  if (!res.ok) throw new Error(body?.error || 'Something went wrong. Try again.')
  return body
}

// Zero-billing alerts carry the bill date only (Busy stores no time on the
// line), so they show a date; deletions carry the exact time.
function fmtWhen(alert) {
  const d = new Date(alert.happened_at)
  if (Number.isNaN(d.getTime())) return ''
  const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
  if (alert.alert_type === 'zero_billing') return date
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
  return `${date} · ${time}`
}

function fmtStamp(s) {
  if (!s) return ''
  const d = new Date(s)
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' }) +
    ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
}

function personName(login, userNames) {
  if (login === null || login === undefined || login === '') return ''
  const name = userNames[String(login).toLowerCase()]
  return name ? `${name} (${login})` : `Login “${login}”`
}

export async function renderRedAlerts(container) {
  if (!canSee('red-alerts')) {
    container.innerHTML = '<div class="empty-state">You do not have access to this page.</div>'
    setTimeout(() => { window.location.hash = '' }, 1500)
    return
  }

  const state = {
    status: 'open',
    type: 'all',
    q: '',
    alerts: [],
    userNames: {},
    skipItems: [],
    counts: {},
    limited: false,
    selected: new Set(),
    expanded: null,
    busy: false,
  }

  container.innerHTML = `
    <div class="app-layout ra-page">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="raHamburgerBtn" aria-label="Menu">☰</button>
          <span class="logo-small ra-title">${icon('alert-triangle', 18)} Red Alerts</span>
        </div>
        <div class="ra-header-actions">
          <button class="btn-ghost btn-small" id="raGiftBtn">Gift items</button>
          <button class="btn-ghost btn-small" id="raRefreshBtn">Refresh</button>
        </div>
      </header>
      <main class="app-main">
        <div class="ra-tiles" id="raTiles"><div class="loading-state">Loading…</div></div>
        <div class="op-tabs" id="raStatusTabs">
          ${STATUS_TABS.map(t => `<button class="op-tab${t.id === state.status ? ' active' : ''}" data-status="${t.id}">${esc(t.label)}</button>`).join('')}
        </div>
        <div class="ra-toolbar">
          <select id="raTypeSelect" class="ra-select" aria-label="Alert type">
            <option value="all">All types</option>
            ${Object.entries(TYPE_INFO).map(([id, t]) => `<option value="${id}">${esc(t.label)}</option>`).join('')}
          </select>
          <input id="raSearch" class="ra-search" type="search" placeholder="Search bill no., item or account…" autocomplete="off" />
          <div class="ra-bulk" id="raBulk" hidden>
            <span id="raBulkCount"></span>
            <button class="btn-ghost btn-small" data-bulk="seen">Mark seen</button>
            <button class="btn-primary btn-small" data-bulk="ok">Mark OK</button>
          </div>
        </div>
        <div id="raList"><div class="loading-state">Loading alerts…</div></div>
      </main>
      <div class="ra-drawer-backdrop" id="raGiftBackdrop" hidden></div>
      <aside class="ra-drawer" id="raGiftDrawer" hidden aria-label="Gift items">
        <div class="ra-drawer-head">
          <strong>Gift / free items</strong>
          <button class="btn-ghost btn-small" id="raGiftClose" aria-label="Close">${icon('x', 16)}</button>
        </div>
        <p class="ra-drawer-hint">Items given away free on purpose. A sales line for these at ₹0 is not flagged. The name must match the item name in Busy.</p>
        <form class="ra-gift-form" id="raGiftForm">
          <input id="raGiftInput" type="text" placeholder="Exact item name, e.g. Umbrella" autocomplete="off" />
          <button class="btn-primary btn-small" type="submit">Add</button>
        </form>
        <ul class="ra-gift-list" id="raGiftList"></ul>
      </aside>
    </div>
  `

  const $ = id => document.getElementById(id)
  $('raHamburgerBtn').addEventListener('click', () => openSidebar())
  $('raRefreshBtn').addEventListener('click', () => load())
  $('raGiftBtn').addEventListener('click', () => toggleGift(true))
  $('raGiftClose').addEventListener('click', () => toggleGift(false))
  $('raGiftBackdrop').addEventListener('click', () => toggleGift(false))

  $('raStatusTabs').addEventListener('click', e => {
    const btn = e.target.closest('[data-status]')
    if (!btn || btn.dataset.status === state.status) return
    state.status = btn.dataset.status
    $('raStatusTabs').querySelectorAll('.op-tab').forEach(b => b.classList.toggle('active', b === btn))
    load()
  })
  $('raTypeSelect').addEventListener('change', e => { state.type = e.target.value; load() })
  let searchTimer = null
  $('raSearch').addEventListener('input', e => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { state.q = e.target.value.trim(); load() }, 350)
  })
  $('raBulk').addEventListener('click', e => {
    const btn = e.target.closest('[data-bulk]')
    if (btn) setStatus([...state.selected], btn.dataset.bulk)
  })

  $('raGiftForm').addEventListener('submit', async e => {
    e.preventDefault()
    const name = $('raGiftInput').value.trim()
    if (!name) return
    await addGift(name)
    $('raGiftInput').value = ''
  })
  $('raGiftList').addEventListener('click', async e => {
    const btn = e.target.closest('[data-remove-gift]')
    if (!btn) return
    btn.disabled = true
    try {
      await call({ action: 'skip-remove', item_name: btn.dataset.removeGift })
      await load()
    } catch (err) { flash(err.message); btn.disabled = false }
  })

  // One delegated handler for every row: select box, expand, and the actions
  // inside the expanded panel.
  $('raList').addEventListener('click', async e => {
    const check = e.target.closest('input[data-select]')
    if (check) {
      const id = Number(check.dataset.select)
      if (check.checked) state.selected.add(id); else state.selected.delete(id)
      paintBulk()
      return
    }
    const action = e.target.closest('[data-act]')
    if (action) {
      const id = Number(action.dataset.id)
      const act = action.dataset.act
      if (act === 'gift') { await addGift(action.dataset.item); return }
      const note = document.getElementById(`raNote${id}`)?.value
      await setStatus([id], act, note)
      return
    }
    const row = e.target.closest('[data-row]')
    if (row && !e.target.closest('textarea, input, button, a')) {
      const id = Number(row.dataset.row)
      state.expanded = state.expanded === id ? null : id
      paintList()
    }
  })

  load()

  async function load() {
    const listEl = $('raList')
    if (!listEl) return
    listEl.innerHTML = '<div class="loading-state">Loading alerts…</div>'
    try {
      const data = await call({ action: 'list', status: state.status, type: state.type, q: state.q })
      if (!container.isConnected) return
      state.alerts = data.alerts || []
      state.userNames = data.userNames || {}
      state.skipItems = data.skipItems || []
      state.counts = data.counts || {}
      state.limited = !!data.limited
      const ids = new Set(state.alerts.map(a => a.id))
      state.selected = new Set([...state.selected].filter(id => ids.has(id)))
      paintTiles(); paintList(); paintGift(); paintBulk()
    } catch (err) {
      if (!container.isConnected) return
      $('raTiles').innerHTML = ''
      listEl.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`
    }
  }

  function paintTiles() {
    const c = state.counts
    const tile = (label, value, type, tone) => `
      <button class="ra-tile ra-tone-${tone}${state.type === type ? ' active' : ''}" data-tile="${type}">
        <span class="ra-tile-value">${value || 0}</span>
        <span class="ra-tile-label">${esc(label)}</span>
      </button>`
    $('raTiles').innerHTML = `
      ${tile('Open alerts', c.open, 'all', c.new ? 'red' : 'grey')}
      ${tile('₹0 billing', c.zero_billing, 'zero_billing', 'red')}
      ${tile('Vouchers deleted', c.deleted_voucher, 'deleted_voucher', 'red')}
      ${tile('Items deleted', c.deleted_item, 'deleted_item', 'amber')}
      ${tile('Accounts deleted', c.deleted_account, 'deleted_account', 'amber')}
      ${c.deleted_other ? tile('Other deleted', c.deleted_other, 'deleted_other', 'grey') : ''}
    `
    $('raTiles').querySelectorAll('[data-tile]').forEach(btn => btn.addEventListener('click', () => {
      state.type = btn.dataset.tile
      $('raTypeSelect').value = state.type
      load()
    }))
  }

  function paintList() {
    const listEl = $('raList')
    if (!state.alerts.length) {
      const msg = state.status === 'open' || state.status === 'new'
        ? 'Nothing needs attention. No ₹0 bills or deletions waiting.'
        : 'No alerts here.'
      listEl.innerHTML = `<div class="empty-state ra-empty">${icon('check', 22)}<div>${esc(msg)}</div></div>`
      return
    }
    listEl.innerHTML = `
      <div class="ra-list">${state.alerts.map(rowHtml).join('')}</div>
      ${state.limited ? '<div class="ra-more">Showing the newest 500. Use the filters or search to narrow it down.</div>' : ''}
    `
  }

  function rowHtml(a) {
    const t = TYPE_INFO[a.alert_type] || TYPE_INFO.deleted_other
    const d = a.details || {}
    const isZero = a.alert_type === 'zero_billing'
    const isVoucher = a.alert_type === 'deleted_voucher'
    const who = personName(a.busy_user, state.userNames)
    const open = state.expanded === a.id

    let main = esc(a.title || '—')
    let sub = ''
    if (isZero) {
      sub = `${esc(a.subtitle || 'Unknown item')} · Qty ${esc(String(a.qty ?? 0))}${d.rate ? ` · rate ${formatMoney(d.rate)}` : ''}`
    } else if (isVoucher) {
      sub = `${esc(a.subtitle || 'Voucher')}${d.vch_date ? ` dated ${esc(d.vch_date)}` : ''}`
    } else {
      sub = esc(a.subtitle || '')
    }
    const meta = [fmtWhen(a), who && `by ${who}`, a.computer_name && `on ${a.computer_name}`].filter(Boolean).map(esc).join(' · ')
    const amount = isVoucher && a.amount != null ? `<span class="ra-amount">${formatMoney(a.amount)}</span>`
      : isZero ? '<span class="ra-amount ra-amount-zero">₹0</span>' : ''

    return `
      <div class="ra-row ra-tone-${t.tone}${a.status === 'new' ? ' is-new' : ''}${open ? ' is-open' : ''}" data-row="${a.id}">
        <label class="ra-check" title="Select"><input type="checkbox" data-select="${a.id}" ${state.selected.has(a.id) ? 'checked' : ''} /></label>
        <div class="ra-row-body">
          <div class="ra-row-top">
            <span class="ra-tag">${esc(t.label)}</span>
            <span class="ra-main">${main}</span>
            ${amount}
          </div>
          <div class="ra-sub">${sub}</div>
          <div class="ra-meta">${meta}</div>
          ${a.status !== 'new' && a.reviewed_by ? `<div class="ra-review">${esc(STATUS_LABEL[a.status] || a.status)} by ${esc(a.reviewed_by)}${a.reviewed_at ? ` · ${esc(fmtStamp(a.reviewed_at))}` : ''}${a.review_note ? ` — “${esc(a.review_note)}”` : ''}</div>` : ''}
          ${open ? panelHtml(a, d, isZero, isVoucher) : ''}
        </div>
        <span class="ra-status ra-status-${esc(a.status)}">${esc(STATUS_LABEL[a.status] || a.status)}</span>
      </div>`
  }

  function panelHtml(a, d, isZero, isVoucher) {
    const facts = []
    if (isVoucher) {
      if (d.series) facts.push(['Series', d.series])
      if (d.original_amount != null) facts.push(['Amount when first saved', formatMoney(d.original_amount)])
      if (d.final_amount != null) facts.push(['Amount when deleted', formatMoney(d.final_amount)])
    }
    if (isZero) {
      if (d.item_code) facts.push(['Item code', d.item_code])
      if (d.rate != null) facts.push(['Rate on the line', formatMoney(d.rate)])
      if (d.qty_raw != null && Number(d.qty_raw) > 0) facts.push(['Note', 'Quantity is positive on a sale (stock came in, not out)'])
    }
    return `
      <div class="ra-panel">
        ${facts.length ? `<dl class="ra-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join('')}</dl>` : ''}
        <textarea id="raNote${a.id}" class="ra-note" rows="2" placeholder="Note (optional) — e.g. replacement given, duplicate bill, test entry">${esc(a.review_note || '')}</textarea>
        <div class="ra-panel-actions">
          ${a.status !== 'seen' ? `<button class="btn-ghost btn-small" data-act="seen" data-id="${a.id}">Mark seen</button>` : ''}
          ${a.status !== 'ok' ? `<button class="btn-primary btn-small" data-act="ok" data-id="${a.id}">Mark OK</button>` : `<button class="btn-primary btn-small" data-act="ok" data-id="${a.id}">Save note</button>`}
          ${a.status !== 'new' ? `<button class="btn-ghost btn-small" data-act="new" data-id="${a.id}">Reopen</button>` : ''}
          ${isZero && a.subtitle ? `<button class="btn-ghost btn-small ra-gift-btn" data-act="gift" data-id="${a.id}" data-item="${esc(a.subtitle)}">Treat “${esc(a.subtitle)}” as a gift item</button>` : ''}
        </div>
      </div>`
  }

  function paintBulk() {
    const n = state.selected.size
    $('raBulk').hidden = n === 0
    $('raBulkCount').textContent = `${n} selected`
  }

  function paintGift() {
    $('raGiftBtn').textContent = `Gift items (${state.skipItems.length})`
    $('raGiftList').innerHTML = state.skipItems.length
      ? state.skipItems.map(s => `
          <li>
            <span>${esc(s.item_name)}</span>
            <button class="btn-ghost btn-small" data-remove-gift="${esc(s.item_name)}" aria-label="Remove ${esc(s.item_name)}">${icon('x', 14)}</button>
          </li>`).join('')
      : '<li class="ra-gift-empty">No gift items yet.</li>'
  }

  function toggleGift(show) {
    $('raGiftDrawer').hidden = !show
    $('raGiftBackdrop').hidden = !show
    if (show) setTimeout(() => $('raGiftInput')?.focus(), 0)
  }

  async function setStatus(ids, status, note) {
    if (!ids.length || state.busy) return
    state.busy = true
    try {
      await call({ action: 'update', ids, status, note })
      ids.forEach(id => state.selected.delete(id))
      state.expanded = null
      await load()
      refreshNavBadges()
    } catch (err) {
      flash(err.message)
    } finally {
      state.busy = false
    }
  }

  async function addGift(name) {
    try {
      const r = await call({ action: 'skip-add', item_name: name })
      flash(r.closed ? `“${name}” added. ${r.closed} open alert${r.closed === 1 ? '' : 's'} for it closed.` : `“${name}” added to gift items.`)
      await load()
      refreshNavBadges()
    } catch (err) { flash(err.message) }
  }

  function flash(message) {
    document.querySelectorAll('.app-notice').forEach(el => el.remove())
    const el = document.createElement('div')
    el.className = 'app-notice'
    el.setAttribute('role', 'status')
    el.textContent = message
    document.body.appendChild(el)
    setTimeout(() => el.remove(), 3500)
  }
}

// Sidebar badge: how many alerts are still New. Asked only for people who can
// open the page, and any failure just leaves the badge hidden.
export async function loadRedAlertsBadge() {
  if (!canSee('red-alerts')) return 0
  try {
    const data = await call({ action: 'count' })
    return data?.new || 0
  } catch {
    return 0
  }
}
