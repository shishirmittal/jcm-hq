// Red Alerts — what happened in Busy that an owner should look at:
// ₹0-rate and ₹0-quantity sales lines, sales below average purchase cost,
// bill edits (with before → after), backdated entries and old bills edited,
// and deletions of items, accounts and bills.
//
// Data: red_alerts / red_alert_skip_items / busy_user_names in the JCM-Busysql
// project, filled every 15 minutes by busy-sync/sync-red-alerts.js on
// JCM-Server. Those tables are closed to the browser (RLS, no policies), so
// every read and write goes through /api/red-alerts, which checks the HQ
// session first.
//
// Life of an alert:
//   New → (Mark seen) Seen → (Clear) Cleared
//   New / Seen → (Ask for explanation) Asked → staff reply on #explain → Answered → Clear
// Nothing is ever deleted; Cleared alerts stay under the Cleared / All tabs.
import { supabase } from './supabase.js'
import { openSidebar, refreshNavBadges } from './sidebar.js'
import { canSee } from './permissions.js'
import { apiUrl } from './native.js'
import { esc, formatMoney } from './utils.js'
import { icon } from './icons.js'

export const STATUS_TABS = [
  { id: 'open', label: 'Open' },
  { id: 'new', label: 'New', count: 'new' },
  { id: 'asked', label: 'Asked', count: 'asked' },
  { id: 'answered', label: 'Answered', count: 'answered' },
  { id: 'seen', label: 'Seen' },
  { id: 'ok', label: 'Cleared' },
  { id: 'all', label: 'All' },
]

// Filter menu (ids are the groups api/red-alerts.js understands).
const FILTERS = [
  { id: 'all', label: 'All types' },
  { id: 'deleted', label: 'Deleted — all' },
  { id: 'deleted_voucher', label: '   Bills deleted' },
  { id: 'deleted_item', label: '   Items deleted' },
  { id: 'deleted_account', label: '   Accounts & others deleted' },
  { id: 'modified', label: 'Bill edited' },
  { id: 'zero_rate', label: '₹0 rate billing' },
  { id: 'zero_qty', label: '₹0 qty billing' },
  { id: 'below_cost', label: 'Below purchase cost' },
  { id: 'backdated', label: 'Backdated / old bill edited' },
]

const TILES = [
  { id: 'deleted', label: 'Deleted', tone: 'red' },
  { id: 'modified', label: 'Bills edited', tone: 'amber' },
  { id: 'zero_rate', label: '₹0 rate', tone: 'red' },
  { id: 'zero_qty', label: '₹0 qty', tone: 'grey' },
  { id: 'below_cost', label: 'Below purchase cost', tone: 'red' },
  { id: 'backdated', label: 'Backdated / old edits', tone: 'amber' },
]

export const TYPE_INFO = {
  zero_rate: { label: '₹0 rate', tone: 'red' },
  zero_billing: { label: '₹0 rate', tone: 'red' },
  zero_qty: { label: '₹0 qty', tone: 'grey' },
  below_cost: { label: 'Below cost', tone: 'red' },
  modified: { label: 'Bill edited', tone: 'amber' },
  old_bill_edited: { label: 'Old bill edited', tone: 'red' },
  backdated: { label: 'Backdated', tone: 'amber' },
  deleted_voucher: { label: 'Bill deleted', tone: 'red' },
  deleted_item: { label: 'Item deleted', tone: 'amber' },
  deleted_account: { label: 'Account deleted', tone: 'amber' },
  deleted_other: { label: 'Deleted', tone: 'grey' },
}

const STATUS_LABEL = { new: 'New', seen: 'Seen', asked: 'Asked', answered: 'Answered', ok: 'Cleared' }

const QUESTION_HINTS = [
  'Why was this billed at ₹0?',
  'Why was this sold below cost?',
  'What was changed in this bill, and why?',
  'Why was this deleted?',
  'Why was this entered with an old date?',
]

export async function callRedAlerts(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(apiUrl('/api/red-alerts'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
    body: JSON.stringify(payload),
  })
  let body = null
  try { body = await res.json() } catch { /* empty or non-JSON answer */ }
  if (!res.ok) {
    const err = new Error(body?.error || 'Something went wrong. Try again.')
    err.status = res.status
    throw err
  }
  return body
}
const call = callRedAlerts

function fmtDateTime(s, withTime = true) {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return ''
  const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
  if (!withTime) return date
  return `${date} · ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`
}
function fmtBillDate(s) {
  if (!s) return ''
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) return s // deleted bills carry Busy's own dd-mm-yyyy
  return fmtDateTime(`${s}T00:00:00+05:30`, false)
}
const num = n => (n == null ? '' : Number.isInteger(Number(n)) ? String(Number(n)) : String(Math.round(Number(n) * 1000) / 1000))

function personName(login, userNames) {
  if (login === null || login === undefined || login === '') return ''
  const name = userNames[String(login).toLowerCase()]
  return name ? `${name} (${login})` : `Login “${login}”`
}

// One line under the title that says what happened, per type.
export function describe(a) {
  const d = a.details || {}
  const party = d.party ? ` · ${esc(d.party)}` : ''
  switch (a.alert_type) {
    case 'zero_rate':
    case 'zero_billing':
      if (d.near_zero) return `${esc(a.subtitle || 'Item')} · Qty ${esc(num(a.qty))} at ${formatMoney(d.sale_unit)}/pc (cost ${formatMoney(d.avg_cost)})${party}`
      return `${esc(a.subtitle || 'Item')} · Qty ${esc(num(a.qty))} at ₹0${party}`
    case 'zero_qty':
      return `${esc(a.subtitle || 'Item')} · Qty 0${d.rate ? ` (rate ${formatMoney(d.rate)})` : ''}${party}`
    case 'below_cost':
      return `${esc(a.subtitle || 'Item')} · Qty ${esc(num(a.qty))} at ${formatMoney(d.sale_unit)}/pc vs cost ${formatMoney(d.avg_cost)}${party}`
    case 'modified':
    case 'old_bill_edited': {
      const parts = [esc(a.subtitle || 'Bill')]
      if (d.amount_changed) parts.push(`${formatMoney(d.amount_before)} → ${formatMoney(a.amount)}`)
      else parts.push(`${formatMoney(a.amount)}, amount unchanged`)
      if (d.qty_changed) parts.push(`qty ${esc(num(d.qty_before))} → ${esc(num(a.qty))}`)
      return parts.join(' · ') + party
    }
    case 'backdated':
      return `${esc(a.subtitle || 'Bill')} dated ${esc(fmtBillDate(d.bill_date))}, typed in ${esc(String(d.days_after_bill))} days later${party}`
    case 'deleted_voucher':
      return `${esc(a.subtitle || 'Bill')}${d.vch_date ? ` dated ${esc(d.vch_date)}` : ''}`
    default:
      return esc(a.subtitle || '')
  }
}

// Little flags beside the description.
export function badges(a) {
  const d = a.details || {}
  const out = []
  if (d.after_print) out.push('<span class="ra-flag ra-flag-red">After printing</span>')
  if (a.alert_type === 'old_bill_edited') out.push(`<span class="ra-flag">${esc(String(d.days_after_bill))} days after bill date</span>`)
  if ((a.alert_type === 'modified' || a.alert_type === 'old_bill_edited') && !d.changed) out.push('<span class="ra-flag ra-flag-quiet">No change in total</span>')
  if (a.alert_type === 'below_cost' && d.loss) out.push(`<span class="ra-flag ra-flag-red">Loss ${formatMoney(d.loss)}</span>`)
  return out.join('')
}

export async function renderRedAlerts(container) {
  if (!canSee('red-alerts')) {
    container.innerHTML = '<div class="empty-state">You do not have access to this page.</div>'
    setTimeout(() => { window.location.hash = '' }, 1500)
    return
  }

  const state = {
    status: 'open', type: 'all', q: '', from: '', to: '', user: '', sort: 'newest', changedOnly: false,
    offset: 0, total: 0, pageSize: 200,
    alerts: [], userNames: {}, skipItems: [], skipParties: [], band: { from: 80, to: 97 }, tiles: {}, statusCounts: {},
    selected: new Set(), allMatching: false, expanded: null, busy: false,
    people: null, hqUsers: [], linkedLogins: [], whatsappReady: false,
  }

  container.innerHTML = `
    <div class="app-layout ra-page">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="raHamburgerBtn" aria-label="Menu">☰</button>
          <span class="logo-small ra-title">${icon('alert-triangle', 18)} Red Alerts</span>
        </div>
        <div class="ra-header-actions">
          <button class="btn-ghost btn-small" id="raSettingsBtn">Skip lists</button>
          <button class="btn-ghost btn-small" id="raRefreshBtn">Refresh</button>
        </div>
      </header>
      <main class="app-main">
        <div class="ra-tiles" id="raTiles"></div>
        <div class="op-tabs" id="raStatusTabs"></div>
        <div class="ra-toolbar">
          <select id="raTypeSelect" class="ra-select" aria-label="Alert type">
            ${FILTERS.map(f => `<option value="${f.id}">${esc(f.label).replace(/^ {3}/, '&nbsp;&nbsp;&nbsp;')}</option>`).join('')}
          </select>
          <label class="ra-date"><span>From</span><input type="date" id="raFrom" min="2026-04-01" /></label>
          <label class="ra-date"><span>To</span><input type="date" id="raTo" min="2026-04-01" /></label>
          <select id="raUserSelect" class="ra-select" aria-label="Done by"><option value="">Anyone</option></select>
          <select id="raSortSelect" class="ra-select" aria-label="Order">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
          <input id="raSearch" class="ra-search" type="search" placeholder="Search bill no., item, party or account…" autocomplete="off" />
          <label class="ra-changed" id="raChangedWrap" hidden><input type="checkbox" id="raChanged" /> Only where the total or quantity changed</label>
        </div>
        <div class="ra-bulkbar" id="raBulkBar">
          <label class="ra-selectall"><input type="checkbox" id="raSelectAll" /> <span id="raSelectAllLabel">Select all on this page</span></label>
          <button class="ra-link" id="raSelectMatching" hidden></button>
          <span class="ra-bulk-count" id="raBulkCount"></span>
          <div class="ra-bulk-actions">
            <button class="btn-ghost btn-small" data-bulk="seen" disabled>Mark seen</button>
            <button class="btn-ghost btn-small" data-bulk="ask" disabled>${icon('send', 14)} Ask for explanation</button>
            <button class="btn-primary btn-small" data-bulk="ok" disabled>${icon('check', 14)} Clear</button>
          </div>
        </div>
        <div id="raList"><div class="loading-state">Loading alerts…</div></div>
        <div class="ra-pager" id="raPager"></div>
      </main>

      <div class="ra-drawer-backdrop" id="raDrawerBackdrop" hidden></div>
      <aside class="ra-drawer" id="raDrawer" hidden aria-label="Skip lists">
        <div class="ra-drawer-head">
          <strong>Skip lists</strong>
          <button class="btn-ghost btn-small" id="raDrawerClose" aria-label="Close">${icon('x', 16)}</button>
        </div>
        <section id="raGiftPane">
          <p class="ra-drawer-hint">People — names, WhatsApp numbers and Busy logins — are managed in <a href="#admin">Manage Users</a>.</p>
          <h4 class="ra-drawer-sub">Gift items</h4>
          <p class="ra-drawer-hint">Items given away free on purpose. A ₹0 line for these is not flagged. The name must match the item name in Busy exactly.</p>
          <form class="ra-gift-form" id="raGiftForm">
            <input id="raGiftInput" type="text" placeholder="Exact item name, e.g. Umbrella" autocomplete="off" />
            <button class="btn-primary btn-small" type="submit">Add</button>
          </form>
          <ul class="ra-gift-list" id="raGiftList"></ul>
          <h4 class="ra-drawer-sub">Deliberate billing below cost</h4>
          <p class="ra-drawer-hint">Sales billed at about one-tenth of cost on purpose are not flagged, for any party. Lines further below than this (close to ₹0) and normal under-cost sales are still flagged.</p>
          <form class="ra-band-form" id="raBandForm">
            <span>Skip lines between</span>
            <input name="from" type="number" min="0" max="100" step="1" inputmode="numeric" />
            <span>% and</span>
            <input name="to" type="number" min="0" max="100" step="1" inputmode="numeric" />
            <span>% below cost</span>
            <button class="btn-primary btn-small" type="submit">Save</button>
          </form>
          <h4 class="ra-drawer-sub">Parties billed below cost on purpose</h4>
          <p class="ra-drawer-hint">Sales to these parties are not checked for "below purchase cost". Every other check (₹0 lines, edits, backdating, deletions) still applies to them. The name must match the party name in Busy exactly.</p>
          <form class="ra-gift-form" id="raPartyForm">
            <input id="raPartyInput" type="text" placeholder="Exact party name, e.g. Cash (Retail)" autocomplete="off" />
            <button class="btn-primary btn-small" type="submit">Add</button>
          </form>
          <ul class="ra-gift-list" id="raPartyList"></ul>
        </section>
      </aside>

      <div class="modal-overlay" id="raAskModal" hidden>
        <div class="modal ra-ask" role="dialog" aria-modal="true" aria-labelledby="raAskTitle">
          <div class="modal-header">
            <strong id="raAskTitle">Ask for explanation</strong>
            <button class="btn-ghost btn-small" id="raAskClose" aria-label="Close">${icon('x', 16)}</button>
          </div>
          <p class="ra-ask-summary" id="raAskSummary"></p>
          <label class="ra-field"><span>Ask</span>
            <select id="raAskPerson" class="ra-select"></select>
          </label>
          <label class="ra-field"><span>Question (optional)</span>
            <textarea id="raAskQuestion" rows="3" maxlength="500" placeholder="e.g. Why was this billed at ₹0?"></textarea>
          </label>
          <div class="ra-hints" id="raAskHints">${QUESTION_HINTS.map(h => `<button type="button" class="ra-hint">${esc(h)}</button>`).join('')}</div>
          <p class="ra-drawer-hint" id="raAskWa"></p>
          <div class="ra-panel-actions">
            <button class="btn-ghost btn-small" id="raAskCancel">Cancel</button>
            <button class="btn-primary btn-small" id="raAskSend">${icon('send', 14)} Send</button>
          </div>
        </div>
      </div>
    </div>
  `

  const $ = id => document.getElementById(id)
  $('raHamburgerBtn').addEventListener('click', () => openSidebar())
  $('raRefreshBtn').addEventListener('click', () => load())

  // ---- Filters ----
  const resetPage = () => { state.offset = 0; state.selected.clear(); state.allMatching = false; state.expanded = null }
  $('raStatusTabs').addEventListener('click', e => {
    const btn = e.target.closest('[data-status]')
    if (!btn || btn.dataset.status === state.status) return
    state.status = btn.dataset.status
    resetPage(); load()
  })
  $('raTypeSelect').addEventListener('change', e => {
    state.type = e.target.value
    if (state.type !== 'modified') state.changedOnly = false
    resetPage(); load()
  })
  $('raFrom').addEventListener('change', e => { state.from = e.target.value; resetPage(); load() })
  $('raTo').addEventListener('change', e => { state.to = e.target.value; resetPage(); load() })
  $('raUserSelect').addEventListener('change', e => { state.user = e.target.value; resetPage(); load() })
  $('raSortSelect').addEventListener('change', e => { state.sort = e.target.value; resetPage(); load() })
  $('raChanged').addEventListener('change', e => { state.changedOnly = e.target.checked; resetPage(); load() })
  let searchTimer = null
  $('raSearch').addEventListener('input', e => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { state.q = e.target.value.trim(); resetPage(); load() }, 350)
  })

  // ---- Selection and bulk actions ----
  $('raSelectAll').addEventListener('change', e => {
    state.allMatching = false
    if (e.target.checked) state.alerts.forEach(a => state.selected.add(a.id))
    else state.selected.clear()
    paintList(); paintBulk()
  })
  $('raSelectMatching').addEventListener('click', () => {
    state.allMatching = !state.allMatching
    if (state.allMatching) state.alerts.forEach(a => state.selected.add(a.id))
    else state.selected.clear()
    paintList(); paintBulk()
  })
  $('raBulkBar').addEventListener('click', e => {
    const btn = e.target.closest('[data-bulk]')
    if (!btn || btn.disabled) return
    const act = btn.dataset.bulk
    if (act === 'ask') { openAsk([...state.selected]); return }
    if (state.allMatching) updateMatching(act)
    else setStatus([...state.selected], act)
  })

  // ---- Rows ----
  $('raList').addEventListener('click', async e => {
    const check = e.target.closest('input[data-select]')
    if (check) {
      const id = Number(check.dataset.select)
      state.allMatching = false
      if (check.checked) state.selected.add(id); else state.selected.delete(id)
      paintBulk()
      return
    }
    const action = e.target.closest('[data-act]')
    if (action) {
      const id = Number(action.dataset.id)
      const act = action.dataset.act
      if (act === 'gift') { await addGift(action.dataset.item); return }
      if (act === 'party') { await addParty(action.dataset.party); return }
      if (act === 'ask') { openAsk([id]); return }
      const note = document.getElementById(`raNote${id}`)?.value
      await setStatus([id], act, note)
      return
    }
    const row = e.target.closest('[data-row]')
    if (row && !e.target.closest('textarea, input, button, a, label')) {
      const id = Number(row.dataset.row)
      state.expanded = state.expanded === id ? null : id
      paintList()
    }
  })
  $('raPager').addEventListener('click', e => {
    const btn = e.target.closest('[data-page]')
    if (!btn) return
    state.offset = Math.max(0, state.offset + Number(btn.dataset.page) * state.pageSize)
    state.selected.clear(); state.allMatching = false; state.expanded = null
    load()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })

  // ---- Drawer: gift items and people ----
  $('raSettingsBtn').addEventListener('click', () => toggleDrawer(true))
  $('raDrawerClose').addEventListener('click', () => toggleDrawer(false))
  $('raDrawerBackdrop').addEventListener('click', () => toggleDrawer(false))
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
  $('raBandForm').addEventListener('submit', async e => {
    e.preventDefault()
    const form = e.target
    const btn = form.querySelector('button')
    btn.disabled = true
    try {
      const r = await call({ action: 'band-save', from: Number(form.elements.from.value), to: Number(form.elements.to.value) })
      flash(r.closed ? `Saved. ${r.closed.toLocaleString('en-IN')} open below-cost alerts in that band cleared.` : 'Saved.')
      await load()
      refreshNavBadges()
    } catch (err) { flash(err.message) }
    btn.disabled = false
  })
  $('raPartyForm').addEventListener('submit', async e => {
    e.preventDefault()
    const name = $('raPartyInput').value.trim()
    if (!name) return
    await addParty(name)
    $('raPartyInput').value = ''
  })
  $('raPartyList').addEventListener('click', async e => {
    const btn = e.target.closest('[data-remove-party]')
    if (!btn) return
    btn.disabled = true
    try {
      await call({ action: 'party-remove', party_name: btn.dataset.removeParty })
      await load()
    } catch (err) { flash(err.message); btn.disabled = false }
  })

  // ---- Ask dialog ----
  let askIds = []
  $('raAskClose').addEventListener('click', closeAsk)
  $('raAskCancel').addEventListener('click', closeAsk)
  $('raAskModal').addEventListener('click', e => { if (e.target.id === 'raAskModal') closeAsk() })
  $('raAskHints').addEventListener('click', e => {
    const hint = e.target.closest('.ra-hint')
    if (hint) $('raAskQuestion').value = hint.textContent
  })
  $('raAskSend').addEventListener('click', sendAsk)

  load()

  // -------------------------------------------------------------------------
  async function load() {
    const listEl = $('raList')
    if (!listEl) return
    listEl.innerHTML = '<div class="loading-state">Loading alerts…</div>'
    try {
      const data = await call({
        action: 'list', status: state.status, type: state.type, q: state.q, from: state.from, to: state.to,
        user: state.user, sort: state.sort, changedOnly: state.changedOnly, offset: state.offset,
      })
      if (!container.isConnected) return
      Object.assign(state, {
        alerts: data.alerts || [], total: data.total || 0, pageSize: data.pageSize || 200,
        userNames: data.userNames || {}, skipItems: data.skipItems || [], skipParties: data.skipParties || [], band: data.band || state.band,
        tiles: data.tiles || {}, statusCounts: data.statusCounts || {},
      })
      const ids = new Set(state.alerts.map(a => a.id))
      if (!state.allMatching) state.selected = new Set([...state.selected].filter(id => ids.has(id)))
      paintAll()
    } catch (err) {
      if (!container.isConnected) return
      listEl.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`
      $('raPager').innerHTML = ''
    }
  }

  function paintAll() {
    paintTabs(); paintTiles(); paintToolbar(); paintList(); paintBulk(); paintPager(); paintGift()
  }

  function paintTabs() {
    $('raStatusTabs').innerHTML = STATUS_TABS.map(t => {
      const n = t.count ? state.statusCounts[t.count] : 0
      return `<button class="op-tab${t.id === state.status ? ' active' : ''}" data-status="${t.id}">${esc(t.label)}${n ? ` <span class="ra-tab-count${t.id === 'answered' ? ' is-hot' : ''}">${n}</span>` : ''}</button>`
    }).join('')
  }

  function paintTiles() {
    $('raTiles').innerHTML = TILES.map(t => `
      <button class="ra-tile ra-tone-${t.tone}${state.type === t.id ? ' active' : ''}" data-tile="${t.id}">
        <span class="ra-tile-value">${(state.tiles[t.id] || 0).toLocaleString('en-IN')}</span>
        <span class="ra-tile-label">${esc(t.label)}</span>
      </button>`).join('')
    $('raTiles').querySelectorAll('[data-tile]').forEach(btn => btn.addEventListener('click', () => {
      state.type = state.type === btn.dataset.tile ? 'all' : btn.dataset.tile
      if (state.type !== 'modified') state.changedOnly = false
      resetPage(); load()
    }))
  }

  function paintToolbar() {
    $('raTypeSelect').value = state.type
    $('raChangedWrap').hidden = state.type !== 'modified'
    $('raChanged').checked = state.changedOnly
    const sel = $('raUserSelect')
    const known = Object.entries(state.userNames)
    const current = state.user
    sel.innerHTML = '<option value="">Anyone</option>' +
      known.map(([login, name]) => `<option value="${esc(login)}">${esc(name)} (${esc(login)})</option>`).join('') +
      (current && !state.userNames[current.toLowerCase()] ? `<option value="${esc(current)}">${esc(current)}</option>` : '')
    sel.value = current
  }

  function paintList() {
    const listEl = $('raList')
    if (!state.alerts.length) {
      const calm = state.status === 'open' || state.status === 'new'
      const msg = calm ? 'Nothing needs attention here.' : 'No alerts here.'
      listEl.innerHTML = `<div class="empty-state ra-empty">${icon('check', 22)}<div>${esc(msg)}</div></div>`
      return
    }
    listEl.innerHTML = `<div class="ra-list">${state.alerts.map(rowHtml).join('')}</div>`
  }

  function rowHtml(a) {
    const t = TYPE_INFO[a.alert_type] || TYPE_INFO.deleted_other
    const who = personName(a.busy_user, state.userNames)
    const open = state.expanded === a.id
    const isVoucherDelete = a.alert_type === 'deleted_voucher'
    const isEdit = a.alert_type === 'modified' || a.alert_type === 'old_bill_edited' || a.alert_type === 'backdated'
    const amount = (isVoucherDelete || isEdit) && a.amount != null ? `<span class="ra-amount">${formatMoney(a.amount)}</span>`
      : a.alert_type.startsWith('zero') ? '<span class="ra-amount ra-amount-zero">₹0</span>'
      : a.alert_type === 'below_cost' ? `<span class="ra-amount ra-amount-zero">−${esc(String(a.details?.below_pct ?? ''))}%</span>` : ''
    const meta = [fmtDateTime(a.happened_at), who && `by ${who}`, a.computer_name && `on ${a.computer_name}`].filter(Boolean).map(esc).join(' · ')

    return `
      <div class="ra-row ra-tone-${t.tone}${a.status === 'new' ? ' is-new' : ''}${a.status === 'answered' ? ' is-answered' : ''}${open ? ' is-open' : ''}" data-row="${a.id}">
        <label class="ra-check" title="Select"><input type="checkbox" data-select="${a.id}" ${state.selected.has(a.id) ? 'checked' : ''} /></label>
        <div class="ra-row-body">
          <div class="ra-row-top">
            <span class="ra-tag">${esc(t.label)}</span>
            <span class="ra-main">${esc(a.title || '—')}</span>
            ${badges(a)}
            ${amount}
          </div>
          <div class="ra-sub">${describe(a)}</div>
          <div class="ra-meta">${meta}</div>
          ${askedHtml(a)}
          ${a.status === 'seen' || a.status === 'ok' ? reviewHtml(a) : ''}
          ${open ? panelHtml(a) : ''}
        </div>
        <span class="ra-status ra-status-${esc(a.status)}">${esc(STATUS_LABEL[a.status] || a.status)}</span>
      </div>`
  }

  function askedHtml(a) {
    if (!a.asked_at) return ''
    const wa = { sent: ' · WhatsApp sent', failed: ' · WhatsApp failed', no_number: ' · no WhatsApp number', not_set_up: '' }[a.whatsapp_status] || ''
    return `
      <div class="ra-asked">
        <div><strong>Asked ${esc(a.asked_name || '')}</strong> · ${esc(fmtDateTime(a.asked_at))} by ${esc(a.asked_by || '')}${esc(wa)}${a.question ? ` — “${esc(a.question)}”` : ''}</div>
        ${a.reply
          ? `<div class="ra-reply"><strong>Reply</strong> · ${esc(fmtDateTime(a.replied_at))}: “${esc(a.reply)}”</div>`
          : '<div class="ra-waiting">Waiting for a reply</div>'}
      </div>`
  }

  function reviewHtml(a) {
    if (!a.reviewed_by) return ''
    return `<div class="ra-review">${esc(STATUS_LABEL[a.status] || a.status)} by ${esc(a.reviewed_by)}${a.reviewed_at ? ` · ${esc(fmtDateTime(a.reviewed_at))}` : ''}${a.review_note ? ` — “${esc(a.review_note)}”` : ''}</div>`
  }

  function panelHtml(a) {
    const d = a.details || {}
    const facts = []
    if (d.party) facts.push(['Party', d.party])
    if (d.bill_date) facts.push(['Bill date', fmtBillDate(d.bill_date)])
    if (a.alert_type === 'deleted_voucher') {
      if (d.series) facts.push(['Series', d.series])
      if (d.original_amount != null) facts.push(['Amount when first saved', formatMoney(d.original_amount)])
      if (d.final_amount != null) facts.push(['Amount when deleted', formatMoney(d.final_amount)])
    }
    if (a.alert_type.startsWith('zero')) {
      if (d.item_code) facts.push(['Item code', d.item_code])
      if (d.rate != null) facts.push(['Rate on the line', formatMoney(d.rate)])
      if (d.qty_raw != null && Number(d.qty_raw) > 0) facts.push(['Note', 'Quantity is positive on a sale (stock came in, not out)'])
    }
    if (a.alert_type === 'below_cost') {
      facts.push(['Sold at (per piece, before GST)', formatMoney(d.sale_unit)])
      facts.push(['Average purchase cost this year', formatMoney(d.avg_cost)])
      facts.push(['Below cost by', `${d.below_pct}% · ${formatMoney(d.loss)} on ${num(a.qty)} pcs`])
      if (d.item_code) facts.push(['Item code', d.item_code])
    }
    if (a.alert_type === 'modified' || a.alert_type === 'old_bill_edited') {
      facts.push(['Total', d.amount_changed ? `${formatMoney(d.amount_before)} → ${formatMoney(a.amount)}` : `${formatMoney(a.amount)} (unchanged)`])
      facts.push(['Quantity', d.qty_changed ? `${num(d.qty_before)} → ${num(a.qty)}` : `${num(a.qty)} (unchanged)`])
      if (d.edit_no) facts.push(['Edit number', d.edit_no])
      if (d.days_after_bill != null) facts.push(['Edited', d.days_after_bill === 0 ? 'same day as the bill' : `${d.days_after_bill} days after the bill date`])
      if (d.first_print) facts.push(['First printed', fmtDateTime(`${d.first_print}+05:30`)])
    }
    if (a.alert_type === 'backdated') {
      facts.push(['Typed in', fmtDateTime(a.happened_at)])
      facts.push(['Days after bill date', d.days_after_bill])
    }
    const canAsk = a.status !== 'ok' && a.busy_user
    return `
      <div class="ra-panel">
        ${facts.length ? `<dl class="ra-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join('')}</dl>` : ''}
        <textarea id="raNote${a.id}" class="ra-note" rows="2" placeholder="Your note (optional) — e.g. replacement given, duplicate bill, test entry">${esc(a.review_note || '')}</textarea>
        <div class="ra-panel-actions">
          ${a.status === 'new' ? `<button class="btn-ghost btn-small" data-act="seen" data-id="${a.id}">Mark seen</button>` : ''}
          ${canAsk ? `<button class="btn-ghost btn-small" data-act="ask" data-id="${a.id}">${icon('send', 14)} ${a.asked_at ? 'Ask again' : 'Ask for explanation'}</button>` : ''}
          <button class="btn-primary btn-small" data-act="ok" data-id="${a.id}">${a.status === 'ok' ? 'Save note' : `${icon('check', 14)} Clear`}</button>
          ${a.status !== 'new' ? `<button class="btn-ghost btn-small" data-act="new" data-id="${a.id}">Reopen</button>` : ''}
          ${a.alert_type.startsWith('zero') && a.subtitle ? `<button class="btn-ghost btn-small ra-gift-btn" data-act="gift" data-id="${a.id}" data-item="${esc(a.subtitle)}">Treat “${esc(a.subtitle)}” as a gift item</button>` : ''}
          ${a.alert_type === 'below_cost' && d.party ? `<button class="btn-ghost btn-small ra-gift-btn" data-act="party" data-id="${a.id}" data-party="${esc(d.party)}">Stop checking below-cost for “${esc(d.party)}”</button>` : ''}
        </div>
      </div>`
  }

  function paintBulk() {
    const pageIds = state.alerts.map(a => a.id)
    const allOnPage = pageIds.length > 0 && pageIds.every(id => state.selected.has(id))
    $('raSelectAll').checked = allOnPage
    $('raSelectAll').indeterminate = !allOnPage && pageIds.some(id => state.selected.has(id))
    $('raSelectAll').disabled = pageIds.length === 0
    $('raSelectAllLabel').textContent = state.total > pageIds.length ? `Select all ${pageIds.length} on this page` : 'Select all'

    const moreThanPage = state.total > pageIds.length
    const matchBtn = $('raSelectMatching')
    matchBtn.hidden = !(allOnPage && moreThanPage)
    matchBtn.textContent = state.allMatching ? 'Undo — select this page only' : `Select all ${state.total.toLocaleString('en-IN')} matching`

    const n = state.allMatching ? state.total : state.selected.size
    $('raBulkCount').textContent = n ? `${n.toLocaleString('en-IN')} selected` : ''
    $('raBulkBar').classList.toggle('has-selection', n > 0)
    $('raBulkBar').querySelectorAll('[data-bulk]').forEach(btn => {
      const act = btn.dataset.bulk
      btn.disabled = n === 0 || (act === 'ask' && (state.allMatching || n > 300))
      btn.title = act === 'ask' && n > 300 ? 'Ask about up to 300 at a time' : ''
    })
  }

  function paintPager() {
    const { offset, total, pageSize } = state
    if (total <= pageSize) {
      $('raPager').innerHTML = total ? `<span>${total.toLocaleString('en-IN')} alert${total === 1 ? '' : 's'}</span>` : ''
      return
    }
    const end = Math.min(offset + pageSize, total)
    $('raPager').innerHTML = `
      <button class="btn-ghost btn-small" data-page="-1" ${offset === 0 ? 'disabled' : ''}>${icon('chevron-left', 14)} Previous</button>
      <span>${(offset + 1).toLocaleString('en-IN')}–${end.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')}</span>
      <button class="btn-ghost btn-small" data-page="1" ${end >= total ? 'disabled' : ''}>Next ${icon('chevron-right', 14)}</button>`
  }

  function paintGift() {
    $('raGiftList').innerHTML = state.skipItems.length
      ? state.skipItems.map(s => `
          <li>
            <span>${esc(s.item_name)}</span>
            <button class="btn-ghost btn-small" data-remove-gift="${esc(s.item_name)}" aria-label="Remove ${esc(s.item_name)}">${icon('x', 14)}</button>
          </li>`).join('')
      : '<li class="ra-gift-empty">No gift items yet.</li>'
    const bandForm = $('raBandForm')
    if (document.activeElement?.form !== bandForm) {
      bandForm.elements.from.value = state.band.from
      bandForm.elements.to.value = state.band.to
    }
    $('raPartyList').innerHTML = state.skipParties.length
      ? state.skipParties.map(s => `
          <li>
            <span>${esc(s.party_name)}</span>
            <button class="btn-ghost btn-small" data-remove-party="${esc(s.party_name)}" aria-label="Remove ${esc(s.party_name)}">${icon('x', 14)}</button>
          </li>`).join('')
      : '<li class="ra-gift-empty">No parties yet.</li>'
  }

  function toggleDrawer(show) {
    $('raDrawer').hidden = !show
    $('raDrawerBackdrop').hidden = !show
  }

  async function openAsk(ids) {
    if (!ids.length) return
    askIds = ids
    const chosen = state.alerts.filter(a => ids.includes(a.id))
    const who = [...new Set(chosen.map(a => personName(a.busy_user, state.userNames)).filter(Boolean))]
    $('raAskSummary').textContent = ids.length === 1
      ? `About ${chosen[0]?.title || 'this alert'} — made by ${who[0] || 'unknown'}.`
      : `About ${ids.length} alerts — made by ${who.length ? who.join(', ') : 'unknown'}.`
    $('raAskQuestion').value = ''
    $('raAskPerson').innerHTML = '<option value="">The person who made each entry</option>'
    $('raAskWa').textContent = ''
    $('raAskModal').hidden = false
    try {
      if (!state.people) {
        const data = await call({ action: 'people' })
        state.people = true
        state.hqUsers = data.hqUsers || []
        state.linkedLogins = data.linkedLogins || []
        state.whatsappReady = !!data.whatsappReady
      }
      $('raAskPerson').innerHTML = '<option value="">The person who made each entry</option>' +
        state.hqUsers.map(u => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('')
      const unlinked = chosen.some(a => a.busy_user && !state.linkedLogins.includes(String(a.busy_user).toLowerCase()))
      $('raAskWa').textContent = [
        'They get a task on the Task Board and answer under My Explanations.',
        state.whatsappReady ? 'A WhatsApp goes too, if their number is saved in Manage Users.' : '',
        unlinked ? 'Some of these Busy logins are not set on anyone in Manage Users yet — pick a person above, or add their Busy login in Manage Users.' : '',
      ].filter(Boolean).join(' ')
    } catch (err) { $('raAskWa').textContent = err.message }
    $('raAskQuestion').focus()
  }

  function closeAsk() { $('raAskModal').hidden = true }

  async function sendAsk() {
    const btn = $('raAskSend')
    btn.disabled = true
    try {
      const r = await call({ action: 'ask', ids: askIds, question: $('raAskQuestion').value, hq_user_id: $('raAskPerson').value || null })
      const sentTo = (r.asked || []).map(x => `${x.name} (${x.count})`).join(', ')
      flash(`Asked ${sentTo}.${r.unassigned ? ` ${r.unassigned} could not be sent — no HQ person linked.` : ''}`)
      closeAsk()
      askIds.forEach(id => state.selected.delete(id))
      state.allMatching = false
      await load()
      refreshNavBadges()
    } catch (err) {
      flash(err.message)
    } finally {
      btn.disabled = false
    }
  }

  async function setStatus(ids, status, note) {
    if (!ids.length || state.busy) return
    state.busy = true
    try {
      await call({ action: 'update', ids, status, note })
      ids.forEach(id => state.selected.delete(id))
      state.expanded = null
      if (ids.length > 1) flash(`${ids.length} alerts ${status === 'ok' ? 'cleared' : 'marked seen'}.`)
      await load()
      refreshNavBadges()
    } catch (err) {
      flash(err.message)
    } finally {
      state.busy = false
    }
  }

  async function updateMatching(status) {
    if (state.busy) return
    const verb = status === 'ok' ? 'Clear' : 'Mark as seen'
    if (!window.confirm(`${verb} all ${state.total.toLocaleString('en-IN')} alerts that match these filters?`)) return
    state.busy = true
    try {
      // `status` is the new status; the tab being looked at travels as filter_status.
      const r = await call({
        action: 'update-matching', status, expected: state.total, filter_status: state.status,
        type: state.type, q: state.q, from: state.from, to: state.to, user: state.user, changedOnly: state.changedOnly,
      })
      flash(`${r.updated.toLocaleString('en-IN')} alerts ${status === 'ok' ? 'cleared' : 'marked seen'}.`)
      state.selected.clear(); state.allMatching = false
      resetPage()
      await load()
      refreshNavBadges()
    } catch (err) {
      flash(err.message)
    } finally {
      state.busy = false
    }
  }

  async function addParty(name) {
    try {
      const r = await call({ action: 'party-add', party_name: name })
      flash(r.closed ? `“${name}” added. ${r.closed.toLocaleString('en-IN')} open below-cost alert${r.closed === 1 ? '' : 's'} for it cleared.` : `“${name}” will no longer be checked for below-cost.`)
      await load()
      refreshNavBadges()
    } catch (err) { flash(err.message) }
  }

  async function addGift(name) {
    try {
      const r = await call({ action: 'skip-add', item_name: name })
      flash(r.closed ? `“${name}” added. ${r.closed} open alert${r.closed === 1 ? '' : 's'} for it cleared.` : `“${name}” added to gift items.`)
      await load()
      refreshNavBadges()
    } catch (err) { flash(err.message) }
  }
}

export function flash(message) {
  document.querySelectorAll('.app-notice').forEach(el => el.remove())
  const el = document.createElement('div')
  el.className = 'app-notice'
  el.setAttribute('role', 'status')
  el.textContent = message
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 4000)
}

// Sidebar badge: alerts still New plus answers waiting to be read. Asked only
// for people who can open the page; any failure just leaves the badge hidden.
export async function loadRedAlertsBadge() {
  if (!canSee('red-alerts')) return 0
  try {
    const data = await call({ action: 'count' })
    return (data?.new || 0) + (data?.answered || 0)
  } catch {
    return 0
  }
}

export async function loadMyExplainBadge() {
  try {
    const data = await call({ action: 'my-count' })
    return data?.pending || 0
  } catch {
    return 0
  }
}
