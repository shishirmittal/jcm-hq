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

// Pop-ups here lock the page's scrolling (body.pf-modal-open). Leaving the page
// must always lift it, or the next page would open frozen.
window.addEventListener('hashchange', () => document.body.classList.remove('pf-modal-open'))
import { renderPaymentReminders } from './payment-reminders.js'
import { renderPaymentSchedules } from './payment-schedules.js'
import { hqConfirm } from './hq-dialog.js'

// Wording for the bulk "Send WhatsApp to N" result (statuses from api/collections.js send-reminders).
const BULK_TEXT = {
  sent: 'Sent', failed: 'Failed', no_number: 'No number', off: 'Switched off', dnd: 'DND — not sent',
  needs_review: 'Check balance — not sent', nothing_due: 'Nothing due — not sent', recent_credit: 'Nothing over 20 days',
  under_40: 'Nothing over 40 days', recent: 'Already reminded today',
}

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
  if (!canSee(TAB_ID) && !canSee('followup-today')) return 0
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
      <a href="#payment-followup/today" class="pf-tab ${active === 'today' ? 'active' : ''}">Today's follow-ups<span class="pf-tab-count" id="pfTabToday"></span></a>
      <a href="#payment-followup/reminders" class="pf-tab ${active === 'reminders' ? 'active' : ''}">WhatsApp reminders</a>
      <a href="#payment-followup/scheduled" class="pf-tab ${active === 'scheduled' ? 'active' : ''}">⏰ Scheduled</a>
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

export function renderPaymentFollowup(container, sub, { standalone = false } = {}) {
  // #followups = the staff page "Today's Follow-ups" (own sidebar row; also for people with only that page).
  if (!(standalone ? canSee('followup-today') : canSee(TAB_ID))) {
    container.innerHTML = '<div class="empty-state">You do not have access to this page.</div>'
    setTimeout(() => { window.location.hash = '' }, 1500)
    return
  }
  if (sub === 'reminders') return renderPaymentReminders(container)
  if (sub === 'scheduled') return renderPaymentSchedules(container)

  const today = sub === 'today'   // Today's follow-ups tab: the due list, by person
  const storedView = store('pf.view')
  const state = {
    meta: null,
    mode: today ? 'today' : 'calls',
    view: today ? 'due' : (storedView === 'all' ? 'all' : 'group'),
    person: 'me',       // Today tab: 'me', 'all' or a person's id
    summary: [],
    doneToday: [],
    people: [],
    me: null,
    group: store('pf.group') || '',
    q: '',
    sort: store('pf.sort') || 'amount',
    parties: [],
    today: todayIST(),
    loading: false,
    modal: null, // { party, channel, outcome, history }
    // 20 / 40 = only parties with something unpaid on bills older than that
    // many days (so nobody is chased for credit given last week). Not
    // remembered: every visit starts there on purpose.
    scope: 20,          // 20 / 40 (days) or 'all'
    graceDays: 20,
    graceSteps: [20, 40],
    hideRest: store('pf.hideRest') === '1', // Follow-up calls: hide greyed (resting) parties — remembered per browser
    picked: new Set(),   // ticked parties (party_code) for "Send WhatsApp to N"
    bulkSending: false,
  }

  container.innerHTML = `
    <div class="app-layout pf-page">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="pfHamburger" aria-label="Menu">☰</button>
          <span class="logo-small">${standalone ? "Today's Follow-ups" : 'Payment Follow-up'}</span>
        </div>
        <button class="btn-ghost btn-small" id="pfRefresh">Refresh</button>
      </header>
      <main class="app-main">
        ${standalone ? '' : pfTabsHtml(today ? 'today' : 'calls')}
        <div id="pfSync"></div>
        <div class="pf-tiles" id="pfTiles"></div>
        <div class="pf-people" id="pfPeople" ${today ? '' : 'hidden'}></div>
        <div class="pf-toolbar">
          <select id="pfGroup" class="pf-select" aria-label="Account group" ${today ? 'hidden' : ''}><option>Loading groups…</option></select>
          <input id="pfSearch" class="pf-search" type="search" placeholder="Search party or phone" autocomplete="off">
          <select id="pfSort" class="pf-select pf-sort" aria-label="Sort">
            ${SORTS.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('')}
          </select>
        </div>
        <div class="pf-scope-row">
          <div class="pf-scope" id="pfScope" role="group" aria-label="Which dues">
            <button type="button" data-scope="20" class="active">Over 20 days</button>
            <button type="button" data-scope="40">Over 40 days</button>
            <button type="button" data-scope="all">All dues</button>
          </div>
          <span class="pf-muted" id="pfScopeNote"></span>
          <button type="button" class="pf-rest-toggle" id="pfHideRest" ${today ? 'hidden' : ''}></button>
        </div>
        <div class="pf-pickbar" id="pfPickBar" hidden></div>
        <div id="pfList" class="pf-list"><div class="loading-state">Loading…</div></div>
        <section class="pf-done" id="pfDone" hidden></section>
      </main>

      <div class="modal-overlay pf-overlay" id="pfOwners" hidden>
        <div class="modal pf-modal pf-owners" role="dialog" aria-modal="true" aria-labelledby="pfOwnersTitle">
          <div class="modal-header">
            <div>
              <h2 id="pfOwnersTitle">Who follows up which group</h2>
              <div class="pf-modal-sub">Each Busy account group goes to one person. Their Today's follow-ups, morning WhatsApp and daily task come from these groups.</div>
            </div>
            <button class="btn-ghost btn-small" id="pfOwnersClose" aria-label="Close">${icon('x', 16)}</button>
          </div>
          <div id="pfOwnersBody"><div class="loading-state">Loading…</div></div>
          <p class="pf-error" id="pfOwnersError" hidden></p>
          <div class="pf-modal-actions">
            <button class="btn-ghost btn-small" id="pfOwnersCancel">Cancel</button>
            <button class="btn-primary btn-small" id="pfOwnersSave">Save</button>
          </div>
        </div>
      </div>

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
          <div class="pf-field"><span>Next follow-up <em class="pf-hint">— leave empty to follow the rhythm: over 40 days weekly, over 20 days every 2 weeks</em></span>
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
    else { state.view = 'group'; state.group = v }
    store('pf.view', state.view); store('pf.group', state.group)
    loadList()
  })
  let searchTimer = null
  $('pfSearch').addEventListener('input', e => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); drawList() }, 150)
  })
  $('pfHideRest').addEventListener('click', () => {
    state.hideRest = !state.hideRest
    store('pf.hideRest', state.hideRest ? '1' : '0')
    drawList()
  })
  $('pfSort').addEventListener('change', e => { state.sort = e.target.value; store('pf.sort', state.sort); drawList() })
  $('pfScope').addEventListener('click', e => {
    const b = e.target.closest('[data-scope]')
    const next = b && (b.dataset.scope === 'all' ? 'all' : Number(b.dataset.scope))
    if (!b || next === state.scope) return
    state.scope = next
    drawScope(); drawGroupSelect(); drawTiles(); drawList()
  })

  // Dues sync every 30 minutes on JCM-Server; refresh quietly every 5 so a
  // payment entered in Busy drops off without anyone pressing Refresh.
  const autoRefresh = setInterval(() => {
    if (!container.isConnected) { clearInterval(autoRefresh); return }
    if (document.hidden || state.modal || state.loading) return
    loadMeta(); loadList(true)
  }, 5 * 60 * 1000)

  $('pfTiles').addEventListener('click', e => {
    const t = e.target.closest('[data-goto]')
    if (!t) return
    window.location.hash = canSee(TAB_ID) ? '#payment-followup/today' : '#followups'
  })

  // ---- Today tab: whose list, and who follows up which group ----
  $('pfPeople').addEventListener('click', e => {
    if (e.target.closest('#pfAssign')) return openOwners()
    const sendBtn = e.target.closest('#pfSendMorning, #pfSendEvening')
    if (sendBtn) return sendDaily(sendBtn.id === 'pfSendMorning' ? 'morning' : 'evening', sendBtn)
    const b = e.target.closest('[data-person]')
    if (!b || b.dataset.person === state.person) return
    state.person = b.dataset.person
    drawPeople()
    loadList()
  })
  $('pfOwnersClose').addEventListener('click', closeOwners)
  $('pfOwnersCancel').addEventListener('click', closeOwners)
  $('pfOwners').addEventListener('click', e => { if (e.target.id === 'pfOwners') closeOwners() })
  $('pfOwnersSave').addEventListener('click', saveOwners)

  // Row buttons. Call / WhatsApp are real links (the phone dials / WhatsApp
  // opens); the follow-up form opens alongside so it is waiting on return.
  $('pfList').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]')
    if (!btn) return
    const party = state.parties.find(p => p.party_code === btn.dataset.code)
    if (!party) return
    const act = btn.dataset.act
    // Resting card (contacted recently / promised date ahead / auto reminder running): ask before contacting again.
    if (party.hold && ['call', 'send-wa', 'send-ledger'].includes(act) && !btn.dataset.ok) {
      e.preventDefault()
      hqConfirm(`${holdText(party)}\n\nContact ${party.party_name} anyway?`).then(ok => {
        if (!ok) return
        if (act === 'call') { btn.dataset.ok = '1'; btn.click(); delete btn.dataset.ok }
        else if (act === 'send-wa') confirmWhatsApp(party)
        else confirmLedger(party)
      })
      return
    }
    if (act === 'call') setTimeout(() => openModal(party, 'call'), 400)
    else if (act === 'send-wa') confirmWhatsApp(party)
    else if (act === 'send-ledger') confirmLedger(party)
    else if (act === 'log') openModal(party, 'call')
    else if (act === 'history') openModal(party, 'call', true)
  })

  $('pfModalContact').addEventListener('click', e => {
    if (e.target.closest('[data-modal-wa]') && state.modal) confirmWhatsApp(state.modal.party)
    if (e.target.closest('[data-modal-ledger]') && state.modal) confirmLedger(state.modal.party)
  })

  // ---- WhatsApp reminder: ask first, send the approved template; the send is logged by itself ----
  function toast(text) {
    document.getElementById('pfToast')?.remove()
    const t = document.createElement('div')
    t.className = 'pf-toast'; t.id = 'pfToast'; t.textContent = text
    document.body.appendChild(t)
    setTimeout(() => t.remove(), 5000)
  }
  // Ledger statement PDF on WhatsApp (2026-10-15): same as the Customer Card's Send ledger
  // (api/_send-docs.js via api/collections.js action send-ledger).
  function confirmLedger(party) {
    if (document.getElementById('pfWaConfirm')) return
    const ov = document.createElement('div')
    ov.className = 'modal-overlay pf-overlay'; ov.id = 'pfWaConfirm'
    ov.innerHTML = `
      <div class="modal pf-modal pf-wa-confirm" role="dialog" aria-modal="true">
        <h2>Send ledger on WhatsApp?</h2>
        <div class="pf-wa-lines">
          <div><strong>${esc(party.party_name)}</strong></div>
          <div>To: <strong>${esc(String(party.whatsapp).replace(/(\d{5})(\d{5})/, '+91 $1 $2'))}</strong></div>
          <div class="pf-muted">Ledger statement PDF for this financial year with a QR Code button. It cannot be taken back.</div>
        </div>
        <div class="pf-error" id="pfWaErr" hidden></div>
        <div class="pf-modal-actions">
          <button type="button" class="btn-ghost btn-small" id="pfWaNo">Cancel</button>
          <button type="button" class="btn-primary btn-small" id="pfWaYes">Yes, send ledger</button>
        </div>
      </div>`
    document.body.appendChild(ov)
    document.body.classList.add('pf-modal-open')
    const close = () => { ov.remove(); if (!state.modal && $('pfOwners').hidden) document.body.classList.remove('pf-modal-open') }
    ov.querySelector('#pfWaNo').addEventListener('click', close)
    ov.addEventListener('click', e => { if (e.target === ov) close() })
    ov.querySelector('#pfWaYes').addEventListener('click', async () => {
      const yes = ov.querySelector('#pfWaYes')
      yes.disabled = true; yes.textContent = 'Sending…'
      ov.querySelector('#pfWaNo').disabled = true
      try {
        const r = await call({ action: 'send-ledger', party_code: party.party_code, phone: party.whatsapp })
        close()
        toast(`✓ Ledger sent to ${r.name}${r.via === 'direct' ? ' (PDF in their open chat)' : ''}. See WhatsApp → Log.`)
      } catch (err) {
        const el = ov.querySelector('#pfWaErr')
        el.textContent = err.message; el.hidden = false
        yes.hidden = true
        const no = ov.querySelector('#pfWaNo'); no.disabled = false; no.textContent = 'Close'
      }
    })
  }

  function confirmWhatsApp(party) {
    if (document.getElementById('pfWaConfirm')) return
    const ov = document.createElement('div')
    ov.className = 'modal-overlay pf-overlay'
    ov.id = 'pfWaConfirm'
    ov.innerHTML = `
      <div class="modal pf-modal pf-wa-confirm" role="alertdialog" aria-modal="true">
        <div class="modal-header"><div>
          <h2>Send WhatsApp reminder?</h2>
          <div class="pf-modal-sub">${esc(party.party_name)}</div>
        </div></div>
        <div class="pf-wa-lines">
          <div>To: <strong>${esc(String(party.whatsapp).replace(/(\d{5})(\d{5})/, '+91 $1 $2'))}</strong></div>
          <div>Amount due: <strong>${esc(rupees(party.balance))}</strong></div>
          <div class="pf-muted">The approved JCM message goes out at once, with the QR Code, Ledger and Invoices buttons, and is saved in History by itself. It cannot be taken back.</div>
        </div>
        <div class="pf-error" id="pfWaErr" hidden></div>
        <div class="pf-modal-actions">
          <button type="button" class="btn-ghost btn-small" id="pfWaNo">Cancel</button>
          <button type="button" class="btn-primary btn-small" id="pfWaYes">Yes, send WhatsApp</button>
        </div>
      </div>`
    document.body.appendChild(ov)
    document.body.classList.add('pf-modal-open')
    const close = () => { ov.remove(); if (!state.modal && $('pfOwners').hidden) document.body.classList.remove('pf-modal-open') }
    ov.querySelector('#pfWaNo').addEventListener('click', close)
    ov.addEventListener('click', e => { if (e.target === ov) close() })
    ov.querySelector('#pfWaYes').addEventListener('click', async () => {
      const yes = ov.querySelector('#pfWaYes')
      yes.disabled = true; yes.textContent = 'Sending…'
      ov.querySelector('#pfWaNo').disabled = true
      try {
        const r = await call({ action: 'send-template', party_code: party.party_code })
        // close(), not ov.remove(): close() also lifts the page's scroll lock.
        // Removing only the box left the page frozen after a send.
        close()
        party.last_reminder = new Date().toISOString()
        toast(`✓ Reminder sent to ${r.name} (${r.tone === 'red' ? 'red' : 'amber'} · ${r.kind}). Saved in History.`)
        if (state.modal?.party === party) loadHistory(party)
        drawList()
        if (state.mode === 'today') loadList(true)
      } catch (err) {
        const el = ov.querySelector('#pfWaErr')
        el.textContent = err.message; el.hidden = false
        yes.hidden = true
        const no = ov.querySelector('#pfWaNo'); no.disabled = false; no.textContent = 'Close'
      }
    })
  }

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
      state.graceDays = state.meta.graceDays || state.graceDays
      state.graceSteps = state.meta.graceSteps || state.graceSteps
      drawScope()
      // The remembered group may have no dues any more — ask again.
      if (state.view === 'group' && state.group && !state.meta.groups.some(g => g.group_name === state.group)) {
        state.group = ''
        loadList()
      }
      drawGroupSelect()
      drawTiles()
      $('pfSync').innerHTML = syncNoteHtml(state.meta.lastSync)
      const tabCount = document.getElementById('pfTabToday')
      if (tabCount && state.mode !== 'today') tabCount.textContent = state.meta.dueMine ? ` ${state.meta.dueMine}` : ''
    } catch (err) {
      $('pfGroup').innerHTML = `<option>${esc(err.message)}</option>`
    }
  }

  function drawGroupSelect() {
    const m = state.meta
    if (!m) return
    const od = state.scope !== 'all'
    const stepOf = x => x.byStep?.[state.scope] || (state.scope === state.graceDays ? { parties: x.overdueParties ?? x.parties, total: x.overdue ?? x.total } : { parties: x.parties, total: x.total })
    const opt = g => `<option value="${esc(g.group_name)}">${esc(g.group_name)} — ${od
      ? `${stepOf(g).parties} · ${esc(shortRupees(stepOf(g).total))} over ${state.scope} d`
      : `${g.parties} · ${esc(shortRupees(g.total))}`}${g.dnd ? ' · DND' : ''}</option>`
    const bySeg = seg => m.groups.filter(g => g.segment === seg)
    const others = m.groups.filter(g => !['Retail', 'Distribution'].includes(g.segment))
    $('pfGroup').innerHTML = `
      ${state.view === 'group' && !state.group ? '<option value="" selected disabled>Pick an account group…</option>' : ''}
      <option value="__all">All groups — ${od
        ? `${stepOf({ byStep: m.byStep, overdueParties: m.overdueParties, overdue: m.overdueTotal, parties: m.totalParties, total: m.totalDue }).parties} · ${esc(shortRupees(stepOf({ byStep: m.byStep, overdueParties: m.overdueParties, overdue: m.overdueTotal, parties: m.totalParties, total: m.totalDue }).total))} over ${state.scope} d`
        : `${m.totalParties} · ${esc(shortRupees(m.totalDue))}`}</option>
      ${bySeg('Retail').length ? `<optgroup label="Retail">${bySeg('Retail').map(opt).join('')}</optgroup>` : ''}
      ${bySeg('Distribution').length ? `<optgroup label="Distribution">${bySeg('Distribution').map(opt).join('')}</optgroup>` : ''}
      ${others.length ? `<optgroup label="Other">${others.map(opt).join('')}</optgroup>` : ''}
    `
    $('pfGroup').value = state.view === 'all' ? '__all' : state.view === 'due' ? '__due' : state.group
  }

  // Parties on screen for the chosen scope (the due-today view always shows everyone it has).
  function visible() {
    if (state.view === 'due') return state.parties
    const inScope = state.scope === 'all' ? state.parties : state.parties.filter(p => overdueOf(p) >= 1)
    return state.hideRest ? inScope.filter(p => !p.hold) : inScope
  }
  // "Hide resting" button (calls tab): how many greyed parties are in the current scope.
  function drawRestToggle() {
    const b = $('pfHideRest')
    if (!b || state.view === 'due') return
    const inScope = state.scope === 'all' ? state.parties : state.parties.filter(p => overdueOf(p) >= 1)
    const n = inScope.filter(p => p.hold).length
    b.hidden = !n && !state.hideRest
    b.classList.toggle('on', state.hideRest)
    b.textContent = state.hideRest ? `👁 Show ${n} resting` : `⏸ Hide ${n} resting`
    b.title = 'Resting = contacted in the last 7 days (over 40 d) or 14 days (over 20 d), a promised date ahead, or an auto reminder set'
  }
  // What the party owes on bills older than the chosen number of days.
  function overdueOf(p, days = state.scope === 'all' ? state.graceDays : state.scope) {
    const v = p.overdueBy?.[days] ?? (days === state.graceDays ? p.overdue : undefined) ?? p.balance
    return Math.min(v, p.balance)
  }
  const amountOf = p => (state.scope !== 'all' && state.view !== 'due' ? overdueOf(p) : p.balance)

  function drawScope() {
    $('pfScope').querySelectorAll('[data-scope]').forEach(b => b.classList.toggle('active', b.dataset.scope === String(state.scope)))
    $('pfScope').hidden = state.view === 'due'
    $('pfScopeNote').textContent = state.view === 'due'
      ? 'Due today: dates set by staff, plus over 40 days every week and over 20 days every 2 weeks since the last call.'
      : state.scope !== 'all' ? `Credit given in the last ${state.scope} days is left out.` : 'Showing every party with dues, including recent credit.'
  }

  function drawTiles() {
    if (state.mode === 'today') return drawTodayTiles()
    const ps = visible()
    const total = ps.reduce((s, p) => s + p.balance, 0)
    const overdueSum = ps.reduce((s, p) => s + overdueOf(p, state.view === 'due' ? state.graceDays : undefined), 0)
    const days = state.scope === 'all' || state.view === 'due' ? state.graceDays : state.scope
    const over90 = ps.reduce((s, p) => s + (p.ageing ? p.ageing.d90_plus + p.ageing.older : 0), 0)
    const due = state.meta?.me?.isAdmin ? (state.meta?.dueFollowups ?? 0) : (state.meta?.dueMine ?? 0)
    const viewLabel = state.view === 'all' ? 'All groups' : state.view === 'due' ? 'Due today' : (state.group || '—')
    $('pfTiles').innerHTML = `
      <div class="pf-tile"><span class="pf-tile-label">${esc(viewLabel)}</span><span class="pf-tile-value">${ps.length}</span><span class="pf-tile-sub">parties</span></div>
      ${state.scope !== 'all' && state.view !== 'due'
        ? `<div class="pf-tile"><span class="pf-tile-label">Due over ${days} days</span><span class="pf-tile-value">${esc(shortRupees(overdueSum))}</span><span class="pf-tile-sub">of ${esc(shortRupees(total))} total due</span></div>`
        : `<div class="pf-tile"><span class="pf-tile-label">Total due</span><span class="pf-tile-value">${esc(shortRupees(total))}</span><span class="pf-tile-sub">${esc(shortRupees(overdueSum))} over ${days} days</span></div>`}
      <div class="pf-tile pf-tile-red"><span class="pf-tile-label">Over 90 days</span><span class="pf-tile-value">${esc(shortRupees(over90))}</span><span class="pf-tile-sub">${total ? Math.round(over90 / total * 100) : 0}% of the dues</span></div>
      <button type="button" class="pf-tile pf-tile-amb" data-goto="due"><span class="pf-tile-label">Follow-ups due</span><span class="pf-tile-value">${due}</span><span class="pf-tile-sub">${state.meta?.me?.isAdmin ? 'everyone, today →' : 'yours, today →'}</span></button>
    `
  }

  // ---- Today's follow-ups ------------------------------------------------
  function drawTodayTiles() {
    const ps = state.parties
    const done = state.doneToday
    const total = ps.reduce((s, p) => s + p.balance, 0)
    const weekly = ps.filter(p => p.due_reason?.kind === 'cadence' && p.due_reason.over >= 40).length
    const promised = done.filter(d => d.outcome === 'promised').reduce((s, d) => s + (Number(d.promised_amount) || 0), 0)
    $('pfTiles').innerHTML = `
      <div class="pf-tile pf-tile-amb"><span class="pf-tile-label">To call now</span><span class="pf-tile-value">${ps.length}</span><span class="pf-tile-sub">${esc(shortRupees(total))} due · ${weekly} over 40 days</span></div>
      <div class="pf-tile pf-tile-grn"><span class="pf-tile-label">Done today</span><span class="pf-tile-value">${done.length}</span><span class="pf-tile-sub">calls and notes saved</span></div>
      <div class="pf-tile"><span class="pf-tile-label">Promised today</span><span class="pf-tile-value">${esc(shortRupees(promised))}</span><span class="pf-tile-sub">${(n => `${n} part${n === 1 ? 'y' : 'ies'} promised`)(done.filter(d => d.outcome === 'promised').length)}</span></div>
      <div class="pf-tile pf-tile-red"><span class="pf-tile-label">Not reachable</span><span class="pf-tile-value">${done.filter(d => ['no_answer', 'wrong_number'].includes(d.outcome)).length}</span><span class="pf-tile-sub">no answer / wrong number today</span></div>
    `
  }

  function drawPeople() {
    const me = state.me || state.meta?.me
    const isAdmin = !!me?.isAdmin
    const mine = state.summary.find(x => x.id === me?.id) || { due: 0, done: 0 }
    const all = state.summary.reduce((a, x) => ({ due: a.due + x.due, done: a.done + x.done }), { due: 0, done: 0 })
    const chip = (id, label, c) => `<button type="button" class="pf-person ${state.person === id ? 'active' : ''}" data-person="${esc(id)}">${esc(label)} <span>${c.due} due · ${c.done} done</span></button>`
    const others = isAdmin ? state.summary.filter(x => x.id && x.id !== me?.id).map(x => chip(x.id, x.name, x)) : []
    const nobody = state.summary.find(x => !x.id)
    $('pfPeople').innerHTML = `
      ${chip('me', 'Mine', mine)}
      ${chip('all', 'Everyone', all)}
      ${others.join('')}
      ${nobody && nobody.due ? `<span class="pf-person-warn" title="These groups have nobody assigned">${nobody.due} in groups with nobody assigned</span>` : ''}
      ${isAdmin ? `<span class="pf-admin-btns">
        <button type="button" class="btn-ghost btn-small" id="pfSendMorning" title="Each person's WhatsApp + Task Board task (normally at 10:00)">Send today's lists now</button>
        <button type="button" class="btn-ghost btn-small" id="pfSendEvening" title="Summary WhatsApp to admins (normally at 19:00)">Send evening summary now</button>
        <button type="button" class="btn-ghost btn-small" id="pfAssign">Assign groups</button>
      </span>` : ''}
      <div class="pf-send-result" id="pfSendResult" hidden></div>
    `
    const tab = document.getElementById('pfTabToday')
    if (tab) tab.textContent = mine.due ? ` ${mine.due}` : ''
  }

  function drawDone() {
    const el = $('pfDone')
    const rows = state.doneToday
    if (state.mode !== 'today' || !rows.length) { el.hidden = true; return }
    el.hidden = false
    el.innerHTML = `
      <h3 class="pf-history-title">Done today (${rows.length})</h3>
      ${rows.map(d => {
        const o = OUTCOME[d.outcome]
        return `<div class="pf-done-row">
          <span class="pf-done-name">${esc(d.party_name || d.party_code)}</span>
          ${o ? `<span class="pf-pill pf-tone-${o.tone}">${esc(o.label)}</span>` : ''}
          ${d.promised_amount ? `<span class="pf-muted">${esc(rupees(d.promised_amount))}${d.promised_date ? ` by ${esc(fmtDate(d.promised_date))}` : ''}</span>` : ''}
          ${d.next_followup ? `<span class="pf-muted">next ${esc(fmtDate(d.next_followup))}</span>` : ''}
          <span class="pf-muted pf-done-by">${esc(d.created_by_name || '')} · ${esc(fmtDateTime(d.created_at).split(' · ')[1] || '')}</span>
          ${d.remarks ? `<div class="pf-remark">“${esc(d.remarks)}”</div>` : ''}
        </div>`
      }).join('')}`
  }

  // Admins: run the 10:00 / 19:00 messages now (they also run by themselves).
  async function sendDaily(which, btn) {
    const ask = which === 'morning'
      ? "Send each person their WhatsApp list now and make today's Task Board tasks (tasks are made only once a day)?"
      : 'Send the evening summary WhatsApp to admins now?'
    if (!await hqConfirm(ask)) return
    btn.disabled = true
    const out = $('pfSendResult')
    out.hidden = false
    out.textContent = 'Sending…'
    try {
      const r = await call({ action: 'daily-now', which })
      if (which === 'morning') {
        const ppl = r.morning?.people || []
        const un = r.morning?.unassigned || 0
        out.textContent = [
          ...ppl.map(p => `${p.person}: ${p.due} due · task ${p.task} · WhatsApp ${p.whatsapp}`),
          un ? `${un} due parties are in groups with nobody assigned — set them in Assign groups (or choose who gets unassigned groups)` : null,
        ].filter(Boolean).join('   |   ') || 'Nobody has follow-ups due today.'
      } else {
        out.textContent = `${r.evening?.done ?? 0} done, ${r.evening?.left ?? 0} left · ` + (r.evening?.sent || []).map(x => `${x.to}: ${x.whatsapp}`).join(', ')
      }
      refreshNavBadges?.()
    } catch (err) {
      out.textContent = err.message
    } finally {
      btn.disabled = false
    }
  }

  // ---- Assign groups (admins) ----------------------------------------------
  let ownersData = null
  async function openOwners() {
    $('pfOwners').hidden = false
    document.body.classList.add('pf-modal-open')
    $('pfOwnersError').hidden = true
    $('pfOwnersBody').innerHTML = '<div class="loading-state">Loading…</div>'
    try {
      ownersData = await call({ action: 'owners' })
      const opts = sel => `<option value="">— nobody —</option>${ownersData.people.map(p => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`
      $('pfOwnersBody').innerHTML = `
        <label class="pf-field pf-owner-default"><span>Groups not given to anyone go to</span>
          <select id="pfOwnerDefault" class="pf-select">${opts(ownersData.defaultOwner)}</select>
        </label>
        <div class="pf-owner-list">
          ${ownersData.groups.map((g, i) => `
            <div class="pf-owner-row">
              <div><div class="pf-owner-name">${esc(g.group_name || '(No group)')}${g.dnd ? ' <span class="pf-tag pf-tag-dnd">DND</span>' : ''}</div>
                <div class="pf-muted">${g.parties} parties · ${esc(shortRupees(g.total))}${g.segment ? ` · ${esc(g.segment)}` : ''}</div></div>
              <div class="pf-owner-pick">
                <select class="pf-select" data-owner="${i}">${opts(g.hq_user_id)}</select>
                ${ownersData.kindReady ? `<select class="pf-select" data-kind="${i}" title="Dealer = reminders show total outstanding and overdue. Retail = one amount due.">
                  <option value="dealer" ${g.kind === 'dealer' ? 'selected' : ''}>Dealer</option>
                  <option value="retail" ${g.kind === 'retail' ? 'selected' : ''}>Retail</option></select>` : ''}
              </div>
            </div>`).join('')}
          ${ownersData.kindReady ? '' : '<div class="pf-muted">To set Dealer / Retail, run supabase/collections-group-kind.sql in Supabase first.</div>'}
        </div>`
    } catch (err) {
      $('pfOwnersBody').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`
    }
  }
  function closeOwners() {
    $('pfOwners').hidden = true
    if (!state.modal) document.body.classList.remove('pf-modal-open')
  }
  async function saveOwners() {
    if (!ownersData) return
    const kindOf = i => $('pfOwnersBody').querySelector(`[data-kind="${i}"]`)?.value
    const owners = ownersData.groups.map((g, i) => ({ group_name: g.group_name, hq_user_id: $('pfOwnersBody').querySelector(`[data-owner="${i}"]`).value || null, kind: kindOf(i), _i: i }))
      .filter(o => o.hq_user_id !== (ownersData.groups[o._i].hq_user_id || null) || (o.kind && o.kind !== ownersData.groups[o._i].kind))
    $('pfOwnersSave').disabled = true
    try {
      await call({ action: 'owners-save', owners, default_owner: $('pfOwnerDefault').value || null })
      closeOwners()
      loadMeta(); loadList()
      refreshNavBadges?.()
    } catch (err) {
      $('pfOwnersError').textContent = err.message
      $('pfOwnersError').hidden = false
    } finally {
      $('pfOwnersSave').disabled = false
    }
  }

  async function loadList(silent = false) {
    const listEl = $('pfList')
    if (state.view === 'group' && !state.group) {
      state.parties = []
      drawTiles()
      listEl.innerHTML = '<div class="empty-state">Pick an account group above to see who owes money.</div>'
      return
    }
    const ticket = Symbol('load')
    state.ticket = ticket
    if (!silent) listEl.innerHTML = '<div class="loading-state">Loading parties…</div>'
    state.loading = true
    try {
      const data = await call({ action: 'list', view: state.view, group: state.group, person: state.person })
      if (state.ticket !== ticket || !container.isConnected) return
      state.parties = data.parties || []
      state.today = data.today || state.today
      state.graceDays = data.graceDays || state.graceDays
      if (state.mode === 'today') {
        state.summary = data.summary || []
        state.doneToday = data.doneToday || []
        state.people = data.people || []
        state.me = data.me || state.me
        drawPeople()
        drawDone()
      }
      drawScope()
      drawTiles()
      drawList()
      if (data.lastSync) $('pfSync').innerHTML = syncNoteHtml(data.lastSync)
    } catch (err) {
      if (state.ticket !== ticket || !container.isConnected) return
      if (!silent) listEl.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`
    } finally {
      if (state.ticket === ticket) state.loading = false
    }
  }

  function sorted(list) {
    const by = state.sort
    const oldestKey = p => p.ageing?.older > 0 ? '0000-00-00' : (p.ageing?.oldest_unpaid_date || '9999-99-99')
    const nextKey = p => p.latest?.next_followup || '9999-99-99'
    // Due today: typed dates first, then over-40 (weekly), then over-20, biggest first within each.
    const rank = p => !p.due_reason ? 3 : p.due_reason.kind === 'date' ? 0 : p.due_reason.over >= 40 ? 1 : 2
    return [...list].sort((a, b) => {
      if (state.view === 'due' && by === 'amount' && rank(a) !== rank(b)) return rank(a) - rank(b)
      if (by === 'name') return String(a.party_name).localeCompare(String(b.party_name))
      if (by === 'oldest') return oldestKey(a).localeCompare(oldestKey(b)) || amountOf(b) - amountOf(a)
      if (by === 'next') return nextKey(a).localeCompare(nextKey(b)) || amountOf(b) - amountOf(a)
      return amountOf(b) - amountOf(a)
    })
  }

  function drawList() {
    drawRestToggle()
    const listEl = $('pfList')
    const q = state.q
    const qDigits = q.replace(/\D/g, '')
    let list = visible()
    if (q) {
      list = list.filter(p => String(p.party_name || '').toLowerCase().includes(q) ||
        (qDigits.length >= 4 && p.phones.some(ph => ph.includes(qDigits))))
    }
    if (!list.length) {
      const hiddenRecent = state.scope !== 'all' && state.view !== 'due' ? state.parties.length : 0
      listEl.innerHTML = `<div class="empty-state">${q ? 'No party matches that search.'
        : state.view === 'due' ? (state.doneToday.length ? 'Nothing left to call today. 🎉' : 'No follow-ups due today.')
        : state.hideRest && state.parties.some(p => p.hold) ? 'Everyone left is resting (contacted recently, promised or auto reminder). Tap “Show resting” to see them.'
        : hiddenRecent ? `Nobody here has dues older than ${state.scope} days. ${hiddenRecent} part${hiddenRecent === 1 ? 'y has' : 'ies have'} only recent credit — tap “All dues” to see them.`
        : 'Nobody in this group owes money.'}</div>`
      return
    }
    listEl.innerHTML = sorted(list).map(rowHtml).join('')
    drawPickBar()
  }

  // ---- Tick boxes → "Send WhatsApp to N" (same server rules as the reminders tab) ----
  function pickableList() {
    return state.parties.filter(p => p.whatsapp && p.balance > 0 && !p.dnd && !p.needs_review)
  }
  function drawPickBar() {
    const bar = $('pfPickBar')
    const n = state.picked.size
    const all = pickableList().length
    if (!state.parties.length || !all) { bar.hidden = true; bar.innerHTML = ''; return }
    bar.hidden = false
    const total = state.parties.filter(p => state.picked.has(p.party_code)).reduce((s, p) => s + p.balance, 0)
    bar.innerHTML = `
      <span class="pf-pick-count"><strong>${n}</strong> of ${all} ticked${n ? ` · ${esc(rupees(total))} due` : ''}</span>
      <button type="button" class="pf-link" data-pick-all="1">Tick all ${all}</button>
      <button type="button" class="pf-link" data-pick-none="1" ${n ? '' : 'hidden'}>Untick all</button>
      <button type="button" class="btn-contact btn-whatsapp pf-pick-send" id="pfPickSend" ${n && !state.bulkSending ? '' : 'disabled'}>
        ${WA_SVG} ${state.bulkSending ? 'Sending…' : n ? `Send WhatsApp to ${n}` : 'Tick parties to send'}</button>`
  }
  $('pfPickBar').addEventListener('click', e => {
    if (e.target.closest('[data-pick-all]')) { pickableList().forEach(p => state.picked.add(p.party_code)); drawList() }
    else if (e.target.closest('[data-pick-none]')) { state.picked.clear(); drawList() }
    else if (e.target.closest('#pfPickSend')) confirmBulkWhatsApp()
  })
  $('pfList').addEventListener('change', e => {
    const cb = e.target.closest('input[data-pick]')
    if (!cb) return
    if (cb.checked) state.picked.add(cb.dataset.pick); else state.picked.delete(cb.dataset.pick)
    cb.closest('.pf-row')?.classList.toggle('is-picked', cb.checked)
    drawPickBar()
  })
  async function confirmBulkWhatsApp() {
    const codes = state.parties.filter(p => state.picked.has(p.party_code)).map(p => p.party_code)
    if (!codes.length || state.bulkSending) return
    const total = state.parties.filter(p => state.picked.has(p.party_code)).reduce((s, p) => s + p.balance, 0)
    const ok = await hqConfirm(`Send the WhatsApp payment reminder to ${codes.length} part${codes.length === 1 ? 'y' : 'ies'} (${rupees(total)} due)? Each gets the approved JCM message with the QR Code, Ledger and Invoices buttons. It cannot be taken back.`)
    if (!ok) return
    state.bulkSending = true
    drawPickBar()
    const tier = state.view === 'due' ? 20 : state.scope === 'all' ? 20 : state.scope
    const counts = {}
    let handled = 0
    try {
      for (let i = 0; i < codes.length; i += 10) {
        if (!container.isConnected) return
        const btn = $('pfPickSend'); if (btn) btn.textContent = `Sending ${Math.min(i + 10, codes.length)} of ${codes.length}…`
        const data = await call({ action: 'send-reminders', party_codes: codes.slice(i, i + 10), tier, respect_gap: false })
        for (const r of data.results || []) {
          counts[r.status] = (counts[r.status] || 0) + 1
          state.picked.delete(r.party_code)
          const p = state.parties.find(x => x.party_code === r.party_code)
          if (p && r.status === 'sent') p.last_reminder = data.sentAt
          handled++
        }
      }
    } catch (err) {
      toast(`✗ ${err.message} — ${handled} of ${codes.length} were handled before this stopped.`)
    } finally {
      state.bulkSending = false
      const text = Object.entries(counts).map(([k, v]) => `${v} ${(BULK_TEXT[k] || k).toLowerCase()}`).join(' · ')
      if (text) toast(`✓ Done: ${text}. Each one is saved in that party's History.`)
      drawList()
      if (state.mode === 'today') loadList(true)
    }
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

  // Red strip on every card: the last time we actually reached out, how, and who (Shishir 2026-10-16).
  function lastContactHtml(p) {
    const c = p.last_contact
    if (!c) return '<div class="pf-lastc pf-lastc-none">No follow-up yet — never called or messaged</div>'
    const days = daysBetween(String(c.at).slice(0, 10), state.today)
    return `<div class="pf-lastc"><b>Last follow-up:</b> ${esc(fmtDateTime(c.at))} · <b>${esc(CHANNEL_LABEL[c.channel] || c.channel)}</b>${c.by ? ` · ${esc(c.by)}` : ''} <span class="pf-lastc-ago">(${days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`})</span></div>`
  }
  // Promise and automatic reminder, highlighted so nobody chases a customer who already gave a date.
  function promiseHtml(p) {
    const l = p.latest, sc = p.schedule, bits = []
    if (l && (l.promised_amount || l.promised_date) && (l.outcome === 'promised' || l.promised_date)) {
      const missed = l.promised_date && l.promised_date < state.today && p.balance > 0
      bits.push(`<div class="pf-prom ${missed ? 'is-missed' : ''}">🤝 ${missed ? '<b>Promise missed</b> — ' : '<b>Promised</b> '}${l.promised_amount ? esc(rupees(l.promised_amount)) + ' ' : ''}${l.promised_date ? `by <b>${esc(fmtDate(l.promised_date))}</b>` : ''}</div>`)
    }
    if (sc) bits.push(`<div class="pf-prom pf-sched">⏰ <b>Auto WhatsApp reminder</b> ${esc(fmtDateTime(sc.next_at))}${sc.repeat !== 'none' ? `, then ${esc(sc.repeat)}` : ''}${sc.sent_count ? ` · ${sc.sent_count} sent` : ''} — stops when payment shows in Busy</div>`)
    return bits.join('')
  }
  function holdText(p) {
    const h = p.hold
    if (!h) return ''
    if (h.kind === 'schedule') return `An automatic WhatsApp reminder is already scheduled for ${fmtDateTime(h.until)}.`
    if (h.kind === 'promise') return `They promised to pay by ${fmtDate(h.until)}.`
    const ago = p.last_contact ? daysBetween(String(p.last_contact.at).slice(0, 10), state.today) : 0
    return `Followed up ${ago === 0 ? 'today' : `${ago} day${ago === 1 ? '' : 's'} ago`}. Over ${h.tier} days → once every ${h.days} days, so next contact from ${fmtDate(h.until)}.`
  }
  function holdHtml(p) {
    return p.hold ? `<div class="pf-hold">⏸ ${esc(holdText(p))}</div>` : ''
  }

  function latestHtml(p) {
    const l = p.latest
    if (!l) return '' // the red "Last follow-up" strip says it
    const o = OUTCOME[l.outcome]
    const bits = [`${fmtDate(l.created_at)}`, l.created_by_name, CHANNEL_LABEL[l.channel] || l.channel].filter(Boolean)
    const promise = '' // shown highlighted above (promiseHtml)
    return `
      <div class="pf-latest">
        <span class="pf-muted">Last outcome saved: ${esc(bits.join(' · '))}</span>
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

  // Big number = what this list is about (overdue, or total under "All dues");
  // the line under it splits the rest out so recent credit is plain to see.
  function balanceHtml(p) {
    if (p.balance <= 0) return '<div class="pf-balance pf-balance-clear">Nothing due</div>'
    const g = state.view === 'due' ? (p.due_reason?.over || state.graceDays) : state.scope === 'all' ? state.graceDays : state.scope
    const od = overdueOf(p, g)
    const recent = p.balance - od
    if (state.scope !== 'all' && state.view !== 'due') {
      return `<div class="pf-balance">${esc(rupees(od))}</div>
        <div class="pf-balance-sub">over ${g} days${recent >= 1 ? ` · total ${esc(rupees(p.balance))} (${esc(rupees(recent))} recent)` : ''}</div>`
    }
    return `<div class="pf-balance">${esc(rupees(p.balance))}</div>
      <div class="pf-balance-sub">${od < 1 ? `<span class="pf-pill pf-tone-grn">All within ${g} days</span>` : recent >= 1 ? `${esc(rupees(od))} over ${g} days · ${esc(rupees(recent))} recent` : `all over ${g} days`}</div>`
  }

  // Why a party is on the due-today list.
  function reasonHtml(p) {
    const r = p.due_reason
    if (!r || state.view !== 'due' || r.kind === 'date') return ''
    const rhythm = r.every === 7 ? 'Weekly' : `Every ${r.every} days`
    const since = r.days === null ? 'never called' : `last contact ${r.days} days ago`
    return `<span class="pf-pill ${r.over >= 40 ? 'pf-tone-red' : 'pf-tone-amb'}" title="Over ${r.over} days: follow up every ${r.every} days">${esc(rhythm)} · over ${r.over} d · ${esc(since)}</span>`
  }

  function rowHtml(p) {
    const code = esc(p.party_code)
    const phone = p.phones[0]
    const wa = p.whatsapp
    const tags = [
      state.view !== 'group' && p.group_name ? `<span class="pf-tag">${esc(p.group_name)}</span>` : '',
      p.dnd ? '<span class="pf-tag pf-tag-dnd" title="This group never gets automatic WhatsApp reminders">DND</span>' : '',
      p.owner_name && !(state.mode === 'today' && state.person !== 'all') ? `<span class="pf-tag pf-tag-owner" title="Follows up this group">${esc(p.owner_name)}</span>` : '',
      p.needs_review ? '<span class="pf-tag pf-tag-review" title="Balance flagged for checking in the dues sync">Check balance</span>' : '',
    ].join('')
    const pickable = !!wa && p.balance > 0 && !p.dnd && !p.needs_review && !p.hold
    return `
      <article class="pf-row ${state.picked.has(p.party_code) ? 'is-picked' : ''} ${p.hold ? 'is-held' : ''}">
        <label class="pf-pick" title="${pickable ? 'Tick to include in Send WhatsApp' : p.hold ? 'Resting — ' + esc(holdText(p)) : 'No WhatsApp number, DND or check balance — cannot be sent'}">
          <input type="checkbox" data-pick="${code}" ${pickable ? '' : 'disabled'} ${state.picked.has(p.party_code) ? 'checked' : ''}>
        </label>
        <div class="pf-row-main">
          <div class="pf-row-top">
            <span class="pf-name">${esc(p.party_name)}</span>${tags}
          </div>
          <div class="pf-phones">${p.phones.length
            ? p.phones.map(ph => `<a href="tel:+91${ph}" class="pf-phone" data-act="call" data-code="${code}">${esc(ph.replace(/(\d{5})(\d{5})/, '$1 $2'))}</a>`).join('')
            : '<span class="pf-muted">No phone number in Busy</span>'}</div>
          ${lastContactHtml(p)}
          ${promiseHtml(p)}
          ${ageingHtml(p)}
          ${latestHtml(p)}
        </div>
        <div class="pf-row-side">
          ${balanceHtml(p)}
          ${nextHtml(p)}
          ${reasonHtml(p)}
          ${holdHtml(p)}
          <div class="pf-actions">
            ${phone ? `<a class="btn-contact btn-call" href="tel:+91${phone}" data-act="call" data-code="${code}">${PHONE_SVG} Call</a>` : ''}
            ${wa ? `<button type="button" class="btn-contact btn-whatsapp" data-act="send-wa" data-code="${code}">${WA_SVG} WhatsApp</button>` : ''}
            ${wa ? `<button type="button" class="btn-ghost btn-small" data-act="send-ledger" data-code="${code}" title="Send the ledger statement PDF on WhatsApp">Ledger</button>` : ''}
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
      party.whatsapp ? `<button type="button" class="btn-contact btn-whatsapp" data-modal-wa>${WA_SVG} WhatsApp</button>` : '',
      party.whatsapp ? `<button type="button" class="btn-ghost btn-small" data-modal-ledger>Ledger</button>` : '',
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
      if (state.mode === 'today') loadList(true)
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
