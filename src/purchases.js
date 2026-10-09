// Purchase Summary — what material reached the warehouse: every purchase bill the
// accounts team types into Busy, with party, bill no. and date, when it was entered
// in Busy and by whom, and every item with qty, rate (GST included) and amount.
//
// Data: purchase_vouchers / purchase_lines (JCM-Busysql project), filled every 15
// minutes by busy-sync/sync-purchases.js on JCM-Server. Closed to the browser, so
// everything goes through /api/purchases, which checks the HQ session first.
//
// "WhatsApp settings" picks who gets a WhatsApp for every new bill and who gets
// the evening summary; the numbers come from Manage Users.
import { supabase } from './supabase.js'
import { openSidebar } from './sidebar.js'
import { canSee } from './permissions.js'
import { apiUrl } from './native.js'
import { esc } from './utils.js'
import { icon } from './icons.js'

const TAB_ID = 'purchases'

export async function callPurchases(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(apiUrl('/api/purchases'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
    body: JSON.stringify(payload),
  })
  let body = null
  try { body = await res.json() } catch { /* empty or non-JSON answer */ }
  if (!res.ok) throw new Error(body?.error || 'Something went wrong. Try again.')
  return body
}
const call = callPurchases

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

const WA_STATE = {
  sent: { text: 'WhatsApp sent', tone: 'ok' },
  failed: { text: 'WhatsApp failed', tone: 'bad' },
  not_set_up: { text: 'WhatsApp not set up', tone: 'quiet' },
  no_recipients: { text: 'No one to send to', tone: 'quiet' },
  pending: { text: 'WhatsApp due', tone: 'quiet' },
  sending: { text: 'Sending…', tone: 'quiet' },
}

// ---------- page ----------
export async function renderPurchases(container) {
  if (!canSee(TAB_ID)) {
    container.innerHTML = '<div class="empty-state">You do not have access to this page.</div>'
    setTimeout(() => { window.location.hash = '' }, 1500)
    return
  }

  const state = {
    range: 'today', from: dayIST(), to: dayIST(), by: 'entered', q: '',
    bills: [], totals: null, more: false, lastSyncAt: null,
    open: new Set(), allOpen: true, loading: false, seq: 0,
    people: null,
  }

  container.innerHTML = `
    <div class="app-layout pur-page">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="purHamburgerBtn" aria-label="Menu">☰</button>
          <span class="logo-small pur-title">${icon('package', 18)} Purchase Summary</span>
        </div>
        <div class="pur-header-actions">
          <button class="btn-ghost btn-small" id="purSettingsBtn">${icon('message', 14)} WhatsApp settings</button>
          <button class="btn-ghost btn-small" id="purRefreshBtn">Refresh</button>
        </div>
      </header>
      <main class="app-main">
        <div class="pur-toolbar">
          <div class="pur-chips" id="purChips">
            <button class="pur-chip" data-range="today">Today</button>
            <button class="pur-chip" data-range="yesterday">Yesterday</button>
            <button class="pur-chip" data-range="week">Last 7 days</button>
            <button class="pur-chip" data-range="month">This month</button>
          </div>
          <label class="pur-date"><span>From</span><input type="date" id="purFrom" min="2026-04-01" /></label>
          <label class="pur-date"><span>To</span><input type="date" id="purTo" min="2026-04-01" /></label>
          <select id="purBy" class="pur-select" aria-label="Which date">
            <option value="entered">By date entered in Busy</option>
            <option value="bill">By bill date</option>
          </select>
          <input id="purSearch" class="pur-search" type="search" placeholder="Search party, bill no. or item…" autocomplete="off" />
        </div>
        <div class="pur-tiles" id="purTiles"></div>
        <div class="pur-listbar">
          <span class="pur-sync" id="purSync"></span>
          <button class="pur-link" id="purToggleAll">Hide items</button>
        </div>
        <div id="purList"><div class="loading-state">Loading purchases…</div></div>
      </main>

      <div class="pur-drawer-backdrop" id="purDrawerBackdrop" hidden></div>
      <aside class="pur-drawer" id="purDrawer" hidden aria-label="WhatsApp settings">
        <div class="pur-drawer-head">
          <strong>WhatsApp settings</strong>
          <button class="btn-ghost btn-small" id="purDrawerClose" aria-label="Close">${icon('x', 16)}</button>
        </div>
        <div id="purDrawerBody"><div class="loading-state">Loading…</div></div>
      </aside>
    </div>
  `

  const $ = id => document.getElementById(id)
  $('purHamburgerBtn').addEventListener('click', () => openSidebar())
  $('purRefreshBtn').addEventListener('click', () => load())

  // ---- filters
  function setRange(range) {
    state.range = range
    const today = dayIST()
    if (range === 'today') { state.from = today; state.to = today }
    if (range === 'yesterday') { state.from = dayIST(-1); state.to = dayIST(-1) }
    if (range === 'week') { state.from = dayIST(-6); state.to = today }
    if (range === 'month') { state.from = `${today.slice(0, 8)}01`; state.to = today }
  }
  $('purChips').addEventListener('click', e => {
    const b = e.target.closest('[data-range]')
    if (!b) return
    setRange(b.dataset.range)
    load()
  })
  $('purFrom').addEventListener('change', e => {
    if (!e.target.value) return
    state.range = ''; state.from = e.target.value
    if (state.to < state.from) state.to = state.from
    load()
  })
  $('purTo').addEventListener('change', e => {
    if (!e.target.value) return
    state.range = ''; state.to = e.target.value
    if (state.from > state.to) state.from = state.to
    load()
  })
  $('purBy').addEventListener('change', e => { state.by = e.target.value; load() })
  let searchTimer = null
  $('purSearch').addEventListener('input', e => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { state.q = e.target.value.trim(); load() }, 350)
  })
  $('purToggleAll').addEventListener('click', () => {
    state.allOpen = !state.allOpen
    state.open.clear()
    paintList()
  })

  // ---- bills
  $('purList').addEventListener('click', async e => {
    const resend = e.target.closest('[data-resend]')
    if (resend) {
      e.stopPropagation()
      const bill = state.bills.find(b => b.vch_key === resend.dataset.resend)
      if (!bill || !window.confirm(`Send the WhatsApp for ${bill.party_name || 'this bill'} again, to everyone ticked for "Every bill"?`)) return
      resend.disabled = true
      try {
        const r = await call({ action: 'send-bill', vch_key: bill.vch_key })
        const ok = r.results.filter(x => x.status === 'sent').length
        flash(ok ? `Sent to ${ok} of ${r.results.length}.` : `Not sent: ${r.results.map(x => `${x.name} (${statusWord(x.status)})`).join(', ')}`)
        load(true)
      } catch (err) { flash(err.message) } finally { resend.disabled = false }
      return
    }
    const head = e.target.closest('[data-toggle]')
    if (!head) return
    const key = head.dataset.toggle
    // "open" holds the bills flipped away from the page-wide setting.
    if (state.open.has(key)) state.open.delete(key)
    else state.open.add(key)
    paintList()
  })

  $('purList').addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-toggle]')) { e.preventDefault(); e.target.click() }
  })

  async function load(quiet = false) {
    const seq = ++state.seq
    paintFilters()
    if (!quiet) $('purList').innerHTML = '<div class="loading-state">Loading purchases…</div>'
    try {
      const data = await call({ action: 'list', from: state.from, to: state.to, by: state.by, q: state.q })
      if (seq !== state.seq) return // a newer request is on its way
      state.bills = data.bills || []
      state.totals = data.totals
      state.more = data.more
      state.lastSyncAt = data.lastSyncAt
      state.open.clear()
      paintTiles(); paintList()
    } catch (err) {
      if (seq !== state.seq) return
      $('purList').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`
      $('purTiles').innerHTML = ''
    }
  }

  function paintFilters() {
    $('purFrom').value = state.from
    $('purTo').value = state.to
    $('purBy').value = state.by
    document.querySelectorAll('#purChips [data-range]').forEach(b => b.classList.toggle('active', b.dataset.range === state.range))
  }

  function paintTiles() {
    const t = state.totals || {}
    const tiles = [
      { label: 'Purchase bills', value: num(t.bills) },
      { label: 'Parties', value: num(t.parties) },
      { label: 'Item lines', value: num(t.items) },
      { label: 'Total value', value: money(t.value), wide: true },
    ]
    $('purTiles').innerHTML = tiles.map(x => `
      <div class="pur-tile${x.wide ? ' is-value' : ''}"><div class="pur-tile-value">${esc(x.value)}</div><div class="pur-tile-label">${esc(x.label)}</div></div>`).join('')
    $('purSync').innerHTML = `${icon('clock', 13)} Busy last copied ${esc(ago(state.lastSyncAt))}${state.lastSyncAt ? ` (${esc(fmtTime(state.lastSyncAt))})` : ''} · updates every 15 min`
  }

  function paintList() {
    $('purToggleAll').textContent = state.allOpen ? 'Hide items' : 'Show items'
    if (!state.bills.length) {
      const what = state.from === state.to ? fmtDate(state.from) : `${fmtDate(state.from)} – ${fmtDate(state.to)}`
      $('purList').innerHTML = `<div class="empty-state">No purchase bills ${state.by === 'bill' ? 'dated' : 'entered'} ${state.from === state.to ? 'on' : 'between'} ${esc(what)}${state.q ? ` matching “${esc(state.q)}”` : ''}.</div>`
      return
    }
    // Group by day when the range spans more than one day.
    const multi = state.from !== state.to
    const groups = []
    for (const b of state.bills) {
      const day = state.by === 'bill' ? b.bill_date : (b.entered_at ? dayOf(b.entered_at) : b.bill_date)
      let g = groups[groups.length - 1]
      if (!g || g.day !== day) { g = { day, bills: [] }; groups.push(g) }
      g.bills.push(b)
    }
    const html = groups.map(g => {
      const live = g.bills.filter(b => !b.deleted_at)
      const total = live.reduce((s, b) => s + Number(b.bill_total || 0), 0)
      const head = multi ? `<div class="pur-day"><strong>${esc(g.day ? fmtDay(g.day) : 'No date')}</strong><span>${live.length} bill${live.length === 1 ? '' : 's'} · ${money(total)}</span></div>` : ''
      return head + g.bills.map(billCard).join('')
    }).join('')
    $('purList').innerHTML = `<div class="pur-list">${html}</div>${state.more ? '<p class="pur-more">Showing the first 300 bills. Pick a shorter date range to see the rest.</p>' : ''}`
  }

  function billCard(b) {
    const open = state.allOpen !== state.open.has(b.vch_key)
    const wa = WA_STATE[b.notify_state]
    const flags = []
    if (b.deleted_at) flags.push('<span class="pur-flag pur-flag-bad">Deleted in Busy</span>')
    if (b.edit_count > 0) flags.push(`<span class="pur-flag" title="Last edit ${esc(fmtDate(b.last_edited_at))}, ${esc(fmtTime(b.last_edited_at))}${b.last_edited_by_name ? ` by ${esc(b.last_edited_by_name)}` : ''}">Edited ${b.edit_count}×</span>`)
    if (wa) flags.push(`<span class="pur-flag pur-flag-${wa.tone}">${icon(wa.tone === 'ok' ? 'check' : 'message', 11)} ${esc(wa.text)}</span>`)
    const entered = b.entered_at
      ? `Entered in Busy <strong>${esc(fmtDate(b.entered_at))}, ${esc(fmtTime(b.entered_at))}</strong>${b.entered_by_name ? ` by <strong>${esc(b.entered_by_name)}</strong>` : ''}`
      : 'Entry time not in Busy’s log'
    const lines = b.lines || []
    const itemsTotal = Number(b.items_total || 0)
    const showBoth = Math.abs(itemsTotal - Number(b.bill_total || 0)) >= 1
    return `
      <article class="pur-bill${b.deleted_at ? ' is-deleted' : ''}${open ? ' is-open' : ''}">
        <div class="pur-bill-head" data-toggle="${esc(b.vch_key)}" role="button" tabindex="0" aria-expanded="${open}">
          <div class="pur-bill-main">
            <div class="pur-party">${esc(b.party_name || 'Unknown party')}</div>
            <div class="pur-bill-sub">Bill <strong>${esc(b.vch_no || '—')}</strong> · dated ${esc(fmtDate(b.bill_date))} · ${b.item_count} item${b.item_count === 1 ? '' : 's'}, qty ${esc(num(b.total_qty))}</div>
            <div class="pur-bill-meta">${entered}</div>
            ${flags.length ? `<div class="pur-flags">${flags.join('')}</div>` : ''}
          </div>
          <div class="pur-bill-side">
            <div class="pur-amount">${money(b.bill_total)}</div>
            <span class="pur-chevron">${icon(open ? 'chevron-down' : 'chevron-right', 16)}</span>
          </div>
        </div>
        ${open ? `
        <div class="pur-items">
          <table class="pur-table">
            <thead><tr><th class="pur-n">#</th><th>Item</th><th class="pur-r">Qty</th><th class="pur-r">Rate <small>(incl. GST)</small></th><th class="pur-r">Amount</th></tr></thead>
            <tbody>
              ${lines.map((l, i) => `<tr><td class="pur-n">${i + 1}</td><td>${esc(l.item_name || 'Item')}</td><td class="pur-r">${esc(num(l.qty))}</td><td class="pur-r">${money(l.rate)}</td><td class="pur-r">${money(l.amount)}</td></tr>`).join('') || '<tr><td colspan="5" class="pur-noitems">No item lines on this bill.</td></tr>'}
            </tbody>
            <tfoot>
              ${showBoth ? `<tr><td></td><td>Items total</td><td class="pur-r">${esc(num(b.total_qty))}</td><td></td><td class="pur-r">${money(itemsTotal)}</td></tr>` : ''}
              <tr class="pur-total"><td></td><td>Bill total${showBoth ? ' <small class="pur-why">(after discounts, freight, round-off)</small>' : ''}</td><td class="pur-r">${showBoth ? '' : esc(num(b.total_qty))}</td><td></td><td class="pur-r">${money(b.bill_total)}</td></tr>
            </tfoot>
          </table>
          ${b.deleted_at ? '' : `<div class="pur-item-actions"><button class="btn-ghost btn-small" data-resend="${esc(b.vch_key)}">${icon('send', 13)} Send on WhatsApp</button></div>`}
        </div>` : ''}
      </article>`
  }

  // ---- WhatsApp settings drawer
  $('purSettingsBtn').addEventListener('click', openDrawer)
  $('purDrawerClose').addEventListener('click', closeDrawer)
  $('purDrawerBackdrop').addEventListener('click', closeDrawer)
  function closeDrawer() { $('purDrawer').hidden = true; $('purDrawerBackdrop').hidden = true }
  async function openDrawer() {
    $('purDrawer').hidden = false; $('purDrawerBackdrop').hidden = false
    $('purDrawerBody').innerHTML = '<div class="loading-state">Loading…</div>'
    try {
      state.people = await call({ action: 'people' })
      paintDrawer()
    } catch (err) {
      $('purDrawerBody').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`
    }
  }

  function paintDrawer() {
    const { users, settings, whatsappReady } = state.people
    const ticked = users.filter(u => u.instant || u.daily)
    $('purDrawerBody').innerHTML = `
      ${whatsappReady ? '' : '<p class="pur-warn">WhatsApp sending is not switched on yet (Whatshub360 link in Vercel). Choices are saved and start working once it is.</p>'}
      <label class="pur-switch"><input type="checkbox" id="purInstantOn" ${settings.instant_on !== false ? 'checked' : ''}/> <span><strong>Every new purchase bill</strong><br><small>A WhatsApp within about 15 minutes of the bill being saved in Busy.</small></span></label>
      <label class="pur-switch"><input type="checkbox" id="purDailyOn" ${settings.daily_on !== false ? 'checked' : ''}/> <span><strong>Evening summary</strong><br><small>One message listing all bills entered that day. Not sent on days with no bills.</small></span></label>
      <label class="pur-time"><span>Send the summary at</span><input type="time" id="purSummaryTime" value="${esc(settings.summary_time || '19:30')}" /><button class="btn-ghost btn-small" id="purTimeSave">Save time</button></label>
      <h4 class="pur-drawer-sub">Who gets them</h4>
      <p class="pur-hint">Tick people below. WhatsApp numbers are set in <a href="#admin">Manage Users</a>. ${ticked.length} ${ticked.length === 1 ? 'person' : 'people'} ticked.</p>
      <div class="pur-people">
        <div class="pur-people-head"><span>Person</span><span>Every bill</span><span>Summary</span></div>
        ${users.map(u => `
          <div class="pur-person">
            <span><strong>${esc(u.name)}</strong>${u.admin ? ' <small class="pur-admin">Admin</small>' : ''}<br><small class="${u.whatsapp ? '' : 'pur-nonum'}">${u.whatsapp ? `+91 ${esc(u.whatsapp)}` : 'No WhatsApp number'}</small></span>
            <input type="checkbox" data-person="${esc(u.id)}" data-kind="instant" ${u.instant ? 'checked' : ''} aria-label="Every bill for ${esc(u.name)}" />
            <input type="checkbox" data-person="${esc(u.id)}" data-kind="daily" ${u.daily ? 'checked' : ''} aria-label="Summary for ${esc(u.name)}" />
          </div>`).join('')}
      </div>
      <button class="btn-ghost btn-small pur-test" id="purTest">${icon('send', 13)} Send a test WhatsApp to me</button>
    `
    const body = $('purDrawerBody')
    body.querySelector('#purInstantOn').addEventListener('change', e => saveSetting({ instant_on: e.target.checked }, e.target))
    body.querySelector('#purDailyOn').addEventListener('change', e => saveSetting({ daily_on: e.target.checked }, e.target))
    body.querySelector('#purTimeSave').addEventListener('click', () => saveSetting({ summary_time: body.querySelector('#purSummaryTime').value }))
    body.querySelectorAll('[data-person]').forEach(box => box.addEventListener('change', () => savePerson(box.dataset.person, box)))
    body.querySelector('#purTest').addEventListener('click', async e => {
      e.target.disabled = true
      try {
        const r = await call({ action: 'test' })
        flash(r.status === 'sent' ? 'Test sent — check your WhatsApp.' : `Not sent: ${statusWord(r.status)}.`)
      } catch (err) { flash(err.message) } finally { e.target.disabled = false }
    })
  }

  async function saveSetting(patch, box) {
    try {
      await call({ action: 'settings-save', ...patch })
      Object.assign(state.people.settings, patch)
      flash('Saved.')
    } catch (err) {
      if (box) box.checked = !box.checked
      flash(err.message)
    }
  }

  async function savePerson(id, box) {
    const user = state.people.users.find(u => u.id === id)
    if (!user) return
    const next = { ...user, [box.dataset.kind]: box.checked }
    if (box.checked && !user.whatsapp) flash(`${user.name} has no WhatsApp number yet — add it in Manage Users.`)
    try {
      await call({ action: 'people-save', hq_user_id: id, instant: next.instant, daily: next.daily })
      Object.assign(user, next)
    } catch (err) {
      box.checked = !box.checked
      flash(err.message)
    }
  }

  setRange('today')
  load()
}

function statusWord(s) {
  return { sent: 'sent', failed: 'sending failed', no_number: 'no WhatsApp number in Manage Users', not_set_up: 'WhatsApp is not set up in Vercel yet' }[s] || s
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

// Sidebar badge: purchase bills entered in Busy today. Only for people who can open the page.
export async function loadPurchasesBadge() {
  if (!canSee(TAB_ID)) return 0
  try {
    const data = await call({ action: 'count' })
    return data?.today || 0
  } catch {
    return 0
  }
}
