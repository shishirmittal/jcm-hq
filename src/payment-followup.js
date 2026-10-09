// Payment Follow-up (Collections) — #payment-followup
//
// Staff pick an account group (Busy ledger group), see every party in it who
// owes money with how old the dues are, press Call or WhatsApp, and save what
// happened: outcome, remarks, promised amount/date and the next follow-up
// date. Every save is kept, so each party has a full history.
//
// Data lives in the JCM-Busysql project and is reached only through
// /api/collections (see api/collections.js and supabase/collections-setup.sql).
import { supabase } from './supabase.js'
import { openSidebar, refreshNavBadges } from './sidebar.js'
import { canSee } from './permissions.js'
import { apiUrl } from './native.js'
import { esc, formatMoney } from './utils.js'
import { icon } from './icons.js'
import './payment-followup.css'
import { renderPaymentReminders } from './payment-reminders.js'

const TAB_ID = 'payment-followup'

export const OUTCOMES = [
  { id: 'promised', label: 'Promised to pay', tone: 'grn' },
  { id: 'paid', label: 'Says paid / sending', tone: 'grn' },
  { id: 'call_later', label: 'Call later', tone: 'amb' },
  { id: 'no_answer', label: 'No answer / switched off', tone: 'grey' },
  { id: 'dispute', label: 'Dispute / complaint', tone: 'red' },
  { id: 'refused', label: 'Refused to pay', tone: 'red' },
  { id: 'wrong_number', label: 'Wrong number', tone: 'grey' },
  { id: 'message_sent', label: 'Message sent', tone: 'blue' },
  { id: 'other', label: 'Other', tone: 'grey' },
]
const OUTCOME = Object.fromEntries(OUTCOMES.map(o => [o.id, o]))
const REMINDER_STATUS = { sent: 'Reminder sent', failed: 'Reminder failed', no_number: 'No WhatsApp number', not_set_up: 'WhatsApp not set up' }

const CHANNELS = [
  { id: 'call', label: 'Call' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'visit', label: 'Visit' },
  { id: 'note', label: 'Note' },
]
const CHANNEL_LABEL = { call: 'Call', whatsapp: 'WhatsApp', visit: 'Visit', note: 'Note', reminder: 'WhatsApp reminder' }

const SORTS = [
  { id: 'amount', label: 'Biggest due first' },
  { id: 'oldest', label: 'Oldest due first' },
  { id: 'next', label: 'Next follow-up date' },
  { id: 'name', label: 'Name A–Z' },
]

// The message the WhatsApp button opens with (sent from the staff member's own WhatsApp).
function manualMessage(p) {
  return `Namaste ${p.party_name},\n\nThis is a reminder from J.C. Mittal & Sons (JCM Retails), Ratlam. ` +
    `Your account shows ${rupees(p.balance)} due. Kindly arrange the payment at the earliest.\n\nThank you.`
}

const PHONE_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>'
const WA_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.5 14.4c-.3-.1-1.7-.8-2-.9-.3-.1-.5-.1-.7.1-.2.3-.8.9-.9 1.1-.2.2-.3.2-.6.1-.3-.1-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 2 3.1 4.9 4.3.7.3 1.2.5 1.6.6.7.2 1.3.2 1.8.1.6-.1 1.7-.7 1.9-1.4.2-.7.2-1.2.2-1.4-.1-.1-.3-.2-.6-.3zM12 21.8c-1.8 0-3.5-.5-5-1.4l-.4-.2-3.7 1 1-3.6-.2-.4C2.7 15.6 2.2 13.8 2.2 12 2.2 6.6 6.6 2.2 12 2.2c2.6 0 5.1 1 6.9 2.9 1.8 1.8 2.9 4.3 2.9 6.9 0 5.4-4.4 9.8-9.8 9.8zm8.4-18.2C18.1 1.3 15.2.1 12 .1 5.5.1.1 5.5.1 12c0 2.1.5 4.1 1.6 5.9L0 24l6.3-1.6c1.7.9 3.7 1.4 5.7 1.4 6.5 0 11.9-5.3 11.9-11.9 0-3.2-1.2-6.1-3.5-8.3z"/></svg>'

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
export async function callCollections(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(apiUrl('/api/collections'), {
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
const call = callCollections

export async function loadPaymentFollowupBadge() {
  if (!canSee(TAB_ID)) return 0
  try {
    const data = await call({ action: 'count' })
    return data?.due || 0
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------
export function rupees(n) {
  return '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN')
}
export function shortRupees(n) {
  const v = Number(n) || 0
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`
  return rupees(v)
}
export function fmtDate(s) {
  if (!s) return ''
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00+05:30` : s)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}
export function fmtDateTime(s) {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return ''
  return `${fmtDate(s)} · ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`
}
export function daysBetween(fromISO, toISO) {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86400000)
}
function addDaysISO(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)

export function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key)
    localStorage.setItem(key, value)
  } catch { /* private window — fine */ }
  return null
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
// The two tabs at the top of both views.
export function pfTabsHtml(active) {
  return `
    <nav class="pf-tabs" aria-label="Payment Follow-up">
      <a href="#payment-followup" class="pf-tab ${active === 'calls' ? 'active' : ''}">Follow-up calls</a>
      <a href="#payment-followup/reminders" class="pf-tab ${active === 'reminders' ? 'active' : ''}">WhatsApp reminders</a>
    </nav>`
}

// "Dues as of …" — the amounts come from the dues sync on JCM-Server; say when
// it last ran, and shout if it has stopped.
export function syncNoteHtml(lastSync) {
  if (!lastSync) return ''
  const hours = (Date.now() - new Date(lastSync).getTime()) / 3600000
  if (hours > 3) {
    return `<div class="pf-sync pf-sync-old">Dues last updated ${esc(fmtDateTime(lastSync))} — the dues sync on JCM-Server (run-dues.bat) has not run since. Amounts may be out of date.</div>`
  }
  return `<div class="pf-sync">Dues as of ${esc(fmtDateTime(lastSync))}</div>`
}

export function renderPaymentFollowup(container, sub) {
  if (!canSee(TAB_ID)) {
    container.innerHTML = '<div class="empty-state">You do not have access to this page.</div>'
    setTimeout(() => { window.location.hash = '' }, 1500)
    return
  }
  if (sub === 'reminders') return renderPaymentReminders(container)

  const state = {
    meta: null,
    view: store('pf.view') || 'group',
    group: store('pf.group') || '',
    q: '',
    sort: store('pf.sort') || 'amount',
    parties: [],
    today: todayIST(),
    loading: false,
    modal: null, // { party, channel, outcome, history }
  }

  container.innerHTML = `
    <div class="app-layout pf-page">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="pfHamburger" aria-label="Menu">☰</button>
          <span class="logo-small">Payment Follow-up</span>
        </div>
        <button class="btn-ghost btn-small" id="pfRefresh">Refresh</button>
      </header>
      <main class="app-main">
        ${pfTabsHtml('calls')}
        <div id="pfSync"></div>
        <div class="pf-tiles" id="pfTiles"></div>
        <div class="pf-toolbar">
          <select id="pfGroup" class="pf-select" aria-label="Account group"><option>Loading groups…</option></select>
          <input id="pfSearch" class="pf-search" type="search" placeholder="Search party or phone" autocomplete="off">
          <select id="pfSort" class="pf-select pf-sort" aria-label="Sort">
            ${SORTS.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('')}
          </select>
        </div>
        <div id="pfList" class="pf-list"><div class="loading-state">Loading…</div></div>
      </main>

      <div class="modal-overlay pf-overlay" id="pfModal" hidden>
        <div class="modal pf-modal" role="dialog" aria-modal="true" aria-labelledby="pfModalTitle">
          <div class="modal-header">
            <div>
              <h2 id="pfModalTitle"></h2>
              <div class="pf-modal-sub" id="pfModalSub"></div>
            </div>
            <button class="btn-ghost btn-small" id="pfModalClose" aria-label="Close">${icon('x', 16)}</button>
          </div>
          <div class="pf-modal-contact" id="pfModalContact"></div>

          <div class="pf-field"><span>How</span>
            <div class="pf-chips" id="pfChannel">
              ${CHANNELS.map(c => `<button type="button" class="pf-chip" data-channel="${c.id}">${esc(c.label)}</button>`).join('')}
            </div>
          </div>
          <div class="pf-field"><span>What happened</span>
            <div class="pf-chips" id="pfOutcome">
              ${OUTCOMES.map(o => `<button type="button" class="pf-chip pf-tone-${o.tone}" data-outcome="${o.id}">${esc(o.label)}</button>`).join('')}
            </div>
          </div>
          <div class="pf-row2" id="pfPromiseRow">
            <label class="pf-field"><span>Promised amount (₹)</span>
              <input id="pfPromisedAmount" type="number" inputmode="decimal" min="0" step="1" placeholder="e.g. 25000">
            </label>
            <label class="pf-field"><span>Promised by</span>
              <input id="pfPromisedDate" type="date">
            </label>
          </div>
          <label class="pf-field"><span>Remarks</span>
            <textarea id="pfRemarks" rows="2" maxlength="1000" placeholder="What did they say?"></textarea>
          </label>
          <div class="pf-field"><span>Next follow-up</span>
            <div class="pf-next">
              <input id="pfNext" type="date">
              <div class="pf-quick" id="pfQuick">
                <button type="button" data-days="1">Tomorrow</button>
                <button type="button" data-days="3">3 days</button>
                <button type="button" data-days="7">1 week</button>
                <button type="button" data-days="15">15 days</button>
                <button type="button" data-days="">None</button>
              </div>
            </div>
          </div>
          <p class="pf-error" id="pfModalError" hidden></p>
          <div class="pf-modal-actions">
            <button class="btn-ghost btn-small" id="pfCancel">Cancel</button>
            <button class="btn-primary btn-small" id="pfSave">Save follow-up</button>
          </div>

          <h3 class="pf-history-title">History</h3>
          <div id="pfHistory" class="pf-history"></div>
        </div>
      </div>
    </div>
  `

  const $ = id => document.getElementById(id)
  $('pfHamburger').addEventListener('click', () => openSidebar())
  $('pfRefresh').addEventListener('click', () => { loadMeta(); loadList() })
  $('pfSort').value = SORTS.some(s => s.id === state.sort) ? state.sort : 'amount'

  $('pfGroup').addEventListener('change', e => {
    const v = e.target.value
    if (v === '__all') { state.view = 'all'; state.group = '' }
    else if (v === '__due') { state.view = 'due'; state.group = '' }
    else { state.view = 'group'; state.group = v }
    store('pf.view', state.view); store('pf.group', state.group)
    loadList()
  })
  let searchTimer = null
  $('pfSearch').addEventListener('input', e => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); drawList() }, 150)
  })
  $('pfSort').addEventListener('change', e => { state.sort = e.target.value; store('pf.sort', state.sort); drawList() })

  $('pfTiles').addEventListener('click', e => {
    const t = e.target.closest('[data-goto]')
    if (!t) return
    state.view = t.dataset.goto
    state.group = ''
    store('pf.view', state.view); store('pf.group', '')
    drawGroupSelect()
    loadList()
  })

  // Row buttons. Call / WhatsApp are real links (the phone dials / WhatsApp
  // opens); the follow-up form opens alongside so it is waiting on return.
  $('pfList').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]')
    if (!btn) return
    const party = state.parties.find(p => p.party_code === btn.dataset.code)
    if (!party) return
    const act = btn.dataset.act
    if (act === 'call') setTimeout(() => openModal(party, 'call'), 400)
    else if (act === 'whatsapp') setTimeout(() => openModal(party, 'whatsapp'), 400)
    else if (act === 'log') openModal(party, 'call')
    else if (act === 'history') openModal(party, 'call', true)
  })

  // ---- Modal ----
  $('pfModalClose').addEventListener('click', closeModal)
  $('pfCancel').addEventListener('click', closeModal)
  $('pfModal').addEventListener('click', e => { if (e.target.id === 'pfModal') closeModal() })
  document.addEventListener('keydown', onKey)
  function onKey(e) {
    if (!container.isConnected) { document.removeEventListener('keydown', onKey); return }
    if (e.key === 'Escape' && state.modal) closeModal()
  }
  $('pfChannel').addEventListener('click', e => {
    const b = e.target.closest('[data-channel]')
    if (!b || !state.modal) return
    state.modal.channel = b.dataset.channel
    drawModalChoices()
  })
  $('pfOutcome').addEventListener('click', e => {
    const b = e.target.closest('[data-outcome]')
    if (!b || !state.modal) return
    state.modal.outcome = b.dataset.outcome
    drawModalChoices()
    if (state.modal.outcome === 'promised' && !$('pfPromisedAmount').value) $('pfPromisedAmount').focus()
  })
  $('pfQuick').addEventListener('click', e => {
    const b = e.target.closest('button')
    if (!b) return
    $('pfNext').value = b.dataset.days ? addDaysISO(state.today, Number(b.dataset.days)) : ''
  })
  $('pfPromisedDate').addEventListener('change', () => {
    // Follow up the day after the promised date unless someone already picked a date.
    const pd = $('pfPromisedDate').value
    if (pd && !$('pfNext').dataset.touched) $('pfNext').value = addDaysISO(pd, 1)
  })
  $('pfNext').addEventListener('input', () => { $('pfNext').dataset.touched = '1' })
  $('pfSave').addEventListener('click', save)

  loadMeta()
  loadList()

  // -------------------------------------------------------------------------
  async function loadMeta() {
    try {
      state.meta = await call({ action: 'meta' })
      state.today = state.meta.today || state.today
      // The remembered group may have no dues any more — ask again.
      if (state.view === 'group' && state.group && !state.meta.groups.some(g => g.group_name === state.group)) {
        state.group = ''
        loadList()
      }
      drawGroupSelect()
      drawTiles()
      $('pfSync').innerHTML = syncNoteHtml(state.meta.lastSync)
    } catch (err) {
      $('pfGroup').innerHTML = `<option>${esc(err.message)}</option>`
    }
  }

  function drawGroupSelect() {
    const m = state.meta
    if (!m) return
    const opt = g => `<option value="${esc(g.group_name)}">${esc(g.group_name)} — ${g.parties} · ${esc(shortRupees(g.total))}${g.dnd ? ' · DND' : ''}</option>`
    const bySeg = seg => m.groups.filter(g => g.segment === seg)
    const others = m.groups.filter(g => !['Retail', 'Distribution'].includes(g.segment))
    $('pfGroup').innerHTML = `
      ${state.view === 'group' && !state.group ? '<option value="" selected disabled>Pick an account group…</option>' : ''}
      <option value="__due">Follow-ups due today${m.dueFollowups ? ` (${m.dueFollowups})` : ''}</option>
      <option value="__all">All groups — ${m.totalParties} · ${esc(shortRupees(m.totalDue))}</option>
      ${bySeg('Retail').length ? `<optgroup label="Retail">${bySeg('Retail').map(opt).join('')}</optgroup>` : ''}
      ${bySeg('Distribution').length ? `<optgroup label="Distribution">${bySeg('Distribution').map(opt).join('')}</optgroup>` : ''}
      ${others.length ? `<optgroup label="Other">${others.map(opt).join('')}</optgroup>` : ''}
    `
    $('pfGroup').value = state.view === 'all' ? '__all' : state.view === 'due' ? '__due' : state.group
  }

  function drawTiles() {
    const ps = state.parties
    const total = ps.reduce((s, p) => s + p.balance, 0)
    const over90 = ps.reduce((s, p) => s + (p.ageing ? p.ageing.d90_plus + p.ageing.older : 0), 0)
    const due = state.meta?.dueFollowups ?? 0
    const viewLabel = state.view === 'all' ? 'All groups' : state.view === 'due' ? 'Due today' : (state.group || '—')
    $('pfTiles').innerHTML = `
      <div class="pf-tile"><span class="pf-tile-label">${esc(viewLabel)}</span><span class="pf-tile-value">${ps.length}</span><span class="pf-tile-sub">parties</span></div>
      <div class="pf-tile"><span class="pf-tile-label">Total due</span><span class="pf-tile-value">${esc(shortRupees(total))}</span><span class="pf-tile-sub">in this list</span></div>
      <div class="pf-tile pf-tile-red"><span class="pf-tile-label">Over 90 days</span><span class="pf-tile-value">${esc(shortRupees(over90))}</span><span class="pf-tile-sub">${total ? Math.round(over90 / total * 100) : 0}% of the dues</span></div>
      <button type="button" class="pf-tile pf-tile-amb" data-goto="due"><span class="pf-tile-label">Follow-ups due</span><span class="pf-tile-value">${due}</span><span class="pf-tile-sub">today or overdue →</span></button>
    `
  }

  async function loadList() {
    const listEl = $('pfList')
    if (state.view === 'group' && !state.group) {
      state.parties = []
      drawTiles()
      listEl.innerHTML = '<div class="empty-state">Pick an account group above to see who owes money.</div>'
      return
    }
    const ticket = Symbol('load')
    state.ticket = ticket
    listEl.innerHTML = '<div class="loading-state">Loading parties…</div>'
    try {
      const data = await call({ action: 'list', view: state.view, group: state.group })
      if (state.ticket !== ticket || !container.isConnected) return
      state.parties = data.parties || []
      state.today = data.today || state.today
      drawTiles()
      drawList()
    } catch (err) {
      if (state.ticket !== ticket || !container.isConnected) return
      listEl.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`
    }
  }

  function sorted(list) {
    const by = state.sort
    const oldestKey = p => p.ageing?.older > 0 ? '0000-00-00' : (p.ageing?.oldest_unpaid_date || '9999-99-99')
    const nextKey = p => p.latest?.next_followup || '9999-99-99'
    return [...list].sort((a, b) => {
      if (by === 'name') return String(a.party_name).localeCompare(String(b.party_name))
      if (by === 'oldest') return oldestKey(a).localeCompare(oldestKey(b)) || b.balance - a.balance
      if (by === 'next') return nextKey(a).localeCompare(nextKey(b)) || b.balance - a.balance
      return b.balance - a.balance
    })
  }

  function drawList() {
    const listEl = $('pfList')
    const q = state.q
    const qDigits = q.replace(/\D/g, '')
    let list = state.parties
    if (q) {
      list = list.filter(p => String(p.party_name || '').toLowerCase().includes(q) ||
        (qDigits.length >= 4 && p.phones.some(ph => ph.includes(qDigits))))
    }
    if (!list.length) {
      listEl.innerHTML = `<div class="empty-state">${q ? 'No party matches that search.' : state.view === 'due' ? 'No follow-ups due today. 🎉' : 'Nobody in this group owes money.'}</div>`
      return
    }
    listEl.innerHTML = sorted(list).map(rowHtml).join('')
  }

  function ageingHtml(p) {
    const a = p.ageing
    if (!a || p.balance <= 0) return ''
    const parts = [
      { key: 'd0_30', label: '0–30 d', cls: 'a1' },
      { key: 'd31_60', label: '31–60 d', cls: 'a2' },
      { key: 'd61_90', label: '61–90 d', cls: 'a3' },
      { key: 'd90_plus', label: '90+ d', cls: 'a4' },
      { key: 'older', label: 'Older', cls: 'a5' },
    ].filter(x => a[x.key] > 0.5)
    const total = parts.reduce((s, x) => s + a[x.key], 0) || 1
    const bar = parts.map(x => `<span class="pf-age-${x.cls}" style="width:${(a[x.key] / total * 100).toFixed(2)}%" title="${esc(x.label)}: ${esc(rupees(a[x.key]))}"></span>`).join('')
    const legend = parts.map(x => `<span class="pf-age-key"><i class="pf-age-${x.cls}"></i>${esc(x.label)} ${esc(rupees(a[x.key]))}</span>`).join('')
    let oldest = ''
    if (a.older > 0.5) oldest = 'Part of the due is from before the bills on record'
    else if (a.oldest_unpaid_date) oldest = `Oldest unpaid bill ${fmtDate(a.oldest_unpaid_date)} · ${daysBetween(a.oldest_unpaid_date, state.today)} days`
    return `
      <div class="pf-age">
        <div class="pf-age-bar">${bar}</div>
        <div class="pf-age-legend">${legend}</div>
        <div class="pf-age-note">${esc(oldest)}${a.last_bill_date ? ` · Last bill ${fmtDate(a.last_bill_date)}` : ''}</div>
      </div>`
  }

  function latestHtml(p) {
    const l = p.latest
    if (!l) return '<div class="pf-latest pf-muted">Not followed up yet</div>'
    const o = OUTCOME[l.outcome]
    const bits = [`${fmtDate(l.created_at)}`, l.created_by_name, CHANNEL_LABEL[l.channel] || l.channel].filter(Boolean)
    let promise = ''
    if (l.outcome === 'promised' && (l.promised_amount || l.promised_date)) {
      const missed = l.promised_date && l.promised_date < state.today && p.balance > 0
      promise = `<span class="pf-pill ${missed ? 'pf-pill-red' : 'pf-pill-grn'}">${missed ? 'Promise missed' : 'Promised'}${l.promised_amount ? ` ${esc(rupees(l.promised_amount))}` : ''}${l.promised_date ? ` by ${esc(fmtDate(l.promised_date))}` : ''}</span>`
    }
    return `
      <div class="pf-latest">
        <span class="pf-muted">Last: ${esc(bits.join(' · '))}</span>
        ${promise || (o ? `<span class="pf-pill pf-tone-${o.tone}">${esc(o.label)}</span>` : '')}
        ${l.remarks ? `<div class="pf-remark">“${esc(l.remarks)}”</div>` : ''}
      </div>`
  }

  function nextHtml(p) {
    const n = p.latest?.next_followup
    if (!n) return ''
    const d = daysBetween(state.today, n)
    if (d < 0) return `<span class="pf-next-chip pf-next-over">Follow-up overdue ${-d} day${d === -1 ? '' : 's'}</span>`
    if (d === 0) return '<span class="pf-next-chip pf-next-today">Follow up today</span>'
    return `<span class="pf-next-chip">Next follow-up ${esc(fmtDate(n))}</span>`
  }

  function rowHtml(p) {
    const code = esc(p.party_code)
    const phone = p.phones[0]
    const wa = p.whatsapp
    const waHref = wa ? `https://wa.me/91${wa}?text=${encodeURIComponent(manualMessage(p))}` : null
    const tags = [
      state.view !== 'group' && p.group_name ? `<span class="pf-tag">${esc(p.group_name)}</span>` : '',
      p.dnd ? '<span class="pf-tag pf-tag-dnd" title="This group never gets automatic WhatsApp reminders">DND</span>' : '',
      p.needs_review ? '<span class="pf-tag pf-tag-review" title="Balance flagged for checking in the dues sync">Check balance</span>' : '',
    ].join('')
    return `
      <article class="pf-row">
        <div class="pf-row-main">
          <div class="pf-row-top">
            <span class="pf-name">${esc(p.party_name)}</span>${tags}
          </div>
          <div class="pf-phones">${p.phones.length
            ? p.phones.map(ph => `<a href="tel:+91${ph}" class="pf-phone" data-act="call" data-code="${code}">${esc(ph.replace(/(\d{5})(\d{5})/, '$1 $2'))}</a>`).join('')
            : '<span class="pf-muted">No phone number in Busy</span>'}</div>
          ${ageingHtml(p)}
          ${latestHtml(p)}
        </div>
        <div class="pf-row-side">
          <div class="pf-balance ${p.balance <= 0 ? 'pf-balance-clear' : ''}">${p.balance > 0 ? esc(rupees(p.balance)) : 'Nothing due'}</div>
          ${nextHtml(p)}
          <div class="pf-actions">
            ${phone ? `<a class="btn-contact btn-call" href="tel:+91${phone}" data-act="call" data-code="${code}">${PHONE_SVG} Call</a>` : ''}
            ${waHref ? `<a class="btn-contact btn-whatsapp" href="${esc(waHref)}" target="_blank" rel="noopener" data-act="whatsapp" data-code="${code}">${WA_SVG} WhatsApp</a>` : ''}
            <button type="button" class="btn-ghost btn-small" data-act="log" data-code="${code}">Save outcome</button>
            <button type="button" class="pf-link" data-act="history" data-code="${code}">History</button>
          </div>
        </div>
      </article>`
  }

  // ---- Modal -------------------------------------------------------------
  function openModal(party, channel, historyOnly = false) {
    state.modal = { party, channel, outcome: channel === 'whatsapp' ? 'message_sent' : null, history: null }
    $('pfModalTitle').textContent = party.party_name
    $('pfModalSub').innerHTML = `${esc(party.group_name || '')}${party.balance > 0 ? ` · Due <strong>${esc(rupees(party.balance))}</strong>` : ''}`
    $('pfModalContact').innerHTML = [
      ...party.phones.map(ph => `<a class="btn-contact btn-call" href="tel:+91${ph}">${PHONE_SVG} ${esc(ph)}</a>`),
      party.whatsapp ? `<a class="btn-contact btn-whatsapp" target="_blank" rel="noopener" href="https://wa.me/91${party.whatsapp}?text=${encodeURIComponent(manualMessage(party))}">${WA_SVG} WhatsApp</a>` : '',
    ].join('')
    $('pfPromisedAmount').value = ''
    $('pfPromisedDate').value = ''
    $('pfRemarks').value = ''
    $('pfNext').value = ''
    delete $('pfNext').dataset.touched
    $('pfModalError').hidden = true
    $('pfSave').disabled = false
    drawModalChoices()
    $('pfModal').hidden = false
    document.body.classList.add('pf-modal-open')
    loadHistory(party, historyOnly)
  }

  function closeModal() {
    state.modal = null
    $('pfModal').hidden = true
    document.body.classList.remove('pf-modal-open')
  }

  function drawModalChoices() {
    const m = state.modal
    if (!m) return
    $('pfChannel').querySelectorAll('[data-channel]').forEach(b => b.classList.toggle('active', b.dataset.channel === m.channel))
    $('pfOutcome').querySelectorAll('[data-outcome]').forEach(b => b.classList.toggle('active', b.dataset.outcome === m.outcome))
    $('pfPromiseRow').hidden = !['promised', 'paid'].includes(m.outcome)
  }

  async function loadHistory(party, scrollToIt = false) {
    const el = $('pfHistory')
    el.innerHTML = '<div class="loading-state">Loading history…</div>'
    try {
      const data = await call({ action: 'history', party_code: party.party_code })
      if (state.modal?.party !== party) return
      state.modal.history = data.history || []
      drawHistory()
      if (scrollToIt) $('pfHistory').previousElementSibling.scrollIntoView({ block: 'start', behavior: 'smooth' })
    } catch (err) {
      if (state.modal?.party === party) el.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`
    }
  }

  function drawHistory() {
    const rows = state.modal?.history || []
    const el = $('pfHistory')
    if (!rows.length) { el.innerHTML = '<div class="pf-muted pf-history-empty">No follow-ups saved yet.</div>'; return }
    el.innerHTML = rows.map(h => {
      const o = OUTCOME[h.outcome]
      const label = h.channel === 'reminder' ? (REMINDER_STATUS[h.outcome] || h.outcome) : (o?.label || h.outcome || '')
      const tone = h.channel === 'reminder' ? (h.outcome === 'sent' ? 'blue' : 'red') : (o?.tone || 'grey')
      const extras = [
        h.promised_amount ? `Promised ${rupees(h.promised_amount)}` : '',
        h.promised_date ? `by ${fmtDate(h.promised_date)}` : '',
        h.next_followup ? `Next follow-up ${fmtDate(h.next_followup)}` : '',
        h.balance_at_time != null ? `Due then ${rupees(h.balance_at_time)}` : '',
      ].filter(Boolean).join(' · ')
      return `
        <div class="pf-history-item">
          <div class="pf-history-top">
            <span class="pf-pill pf-tone-${tone}">${esc(label)}</span>
            <span class="pf-muted">${esc(CHANNEL_LABEL[h.channel] || h.channel)} · ${esc(fmtDateTime(h.created_at))}${h.created_by_name ? ` · ${esc(h.created_by_name)}` : ''}</span>
          </div>
          ${h.remarks ? `<div class="pf-remark">“${esc(h.remarks)}”</div>` : ''}
          ${h.message ? `<div class="pf-remark pf-muted">${esc(h.message)}</div>` : ''}
          ${extras ? `<div class="pf-muted pf-history-extra">${esc(extras)}</div>` : ''}
        </div>`
    }).join('')
  }

  async function save() {
    const m = state.modal
    if (!m) return
    const err = $('pfModalError')
    if (!m.outcome) { err.textContent = 'Pick what happened.'; err.hidden = false; return }
    const payload = {
      action: 'save',
      party_code: m.party.party_code,
      channel: m.channel,
      outcome: m.outcome,
      remarks: $('pfRemarks').value.trim(),
      promised_amount: ['promised', 'paid'].includes(m.outcome) ? $('pfPromisedAmount').value : '',
      promised_date: ['promised', 'paid'].includes(m.outcome) ? $('pfPromisedDate').value : '',
      next_followup: $('pfNext').value,
    }
    err.hidden = true
    $('pfSave').disabled = true
    $('pfSave').textContent = 'Saving…'
    try {
      const data = await call(payload)
      const saved = data.followup
      if (saved) {
        m.party.latest = saved
        if (state.view === 'due' && (!saved.next_followup || saved.next_followup > state.today)) {
          state.parties = state.parties.filter(p => p !== m.party)
        }
      }
      closeModal()
      drawList()
      loadMeta()
      refreshNavBadges?.()
    } catch (e) {
      err.textContent = e.message
      err.hidden = false
    } finally {
      $('pfSave').disabled = false
      $('pfSave').textContent = 'Save follow-up'
    }
  }
}
