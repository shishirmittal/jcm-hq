// WhatsApp — everything about JCM's WhatsApp number in one place (#whatsapp, 2026-10-12).
// Tabs: Inbox (who wrote / tapped, reply within 24 h) · Templates (live from WhatsApp Manager) ·
//       Log (every send: sent / delivered / read / failed) · Outbox (customer messages waiting) ·
//       Settings (connection, switches, samples). Server: api/whatsapp.js (+ _wa-inbox.js).
// Access: admins, or 'whatsapp' ticked in Manage Users.
import { shareBase64 } from './share-pdf.js'
import { openPdfViewer, staleChunk } from './pdf-viewer.js'
import { supabase } from './supabase.js'
import { apiUrl, IS_NATIVE as IS_APP } from './native.js'
import { openSidebar, refreshNavBadges } from './sidebar.js'
import { canSee } from './permissions.js'
import { esc } from './utils.js'
import { renderWhatsappSettings } from './whatsapp-test.js'
import { hqConfirm, hqAlert, hqPrompt } from './hq-dialog.js'
import { renderInvoiceAlerts } from './whatsapp-alerts.js'
import { openScheduler, scheduleChip } from './wa-schedule.js'

export async function callWhatsapp(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  let res
  try {
    res = await fetch(apiUrl('/api/whatsapp'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(25000),
    })
  } catch (err) {
    throw new Error(err?.name === 'TimeoutError' ? 'HQ did not answer in 25 seconds. Press Refresh and try again.' : `Could not reach HQ: ${err.message}`)
  }
  let body = null
  try { body = await res.json() } catch { /* not JSON */ }
  if (!res.ok) throw new Error(body?.error || 'Something went wrong. Try again.')
  return body
}
const call = callWhatsapp

export async function loadWhatsappBadge() {
  if (!canSee('whatsapp')) return 0
  try { return (await call({ action: 'count' })).unread || 0 } catch { return 0 }
}

export const KIND_LABEL = {
  invoice: 'Invoice', receipt: 'Receipt', credit_note: 'Credit note', debit_note: 'Debit note', payment: 'Payment made', purchase: 'Purchase bill',
  order: 'Order booked', quotation: 'Quotation', dispatch: 'Dispatched', gst_supplier: 'GSTR-1 reminder', reminder: 'Payment reminder',
  staff_followup: 'Staff: morning list', staff_evening: 'Admins: evening summary', staff_red_alert: 'Staff: Red Alert', staff_purchase: 'Staff: purchase bill',
  staff_purchase_summary: 'Staff: purchases summary', staff_gst: 'Staff: GST report', staff_orders: 'Admins: orders 17:30', staff_email_bill: 'Staff: brand invoice (email)', staff_invoice_alert: 'Staff: invoice by item group', test: 'Sample / test',
}
const TONE = { sent: 'blue', delivered: 'grn', read: 'grn', received: 'grey', failed: 'red', no_number: 'grey', no_billing: 'grey', off: 'grey', queued: 'amb', held: 'amb', deleted: 'grey', sending: 'amb', cancelled: 'grey', expired: 'grey', skipped: 'grey', APPROVED: 'grn', PENDING: 'amb', REJECTED: 'red', MISSING: 'red', PAUSED: 'red', DISABLED: 'red' }
const STATUS_TEXT = { sent: 'Sent', delivered: 'Delivered', read: 'Read ✓✓', failed: 'Failed', no_number: 'No number', no_billing: 'No billed party (ledger only)', queued: 'Waiting', held: 'On hold', deleted: 'Deleted in Busy', off: 'Switched off', received: 'Received' }
const when = iso => iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : ''
const timeOnly = iso => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : ''
const dayOf = iso => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
const pill = (s, t) => `<span class="pf-pill pf-tone-${TONE[s] || 'grey'}">${esc(t || STATUS_TEXT[s] || s)}</span>`

const TABS = [['inbox', 'Inbox'], ['templates', 'Templates'], ['log', 'Log'], ['outbox', 'Outbox'], ['alerts', 'Invoice alerts'], ['settings', 'Settings']]

export function renderWhatsapp(container, tab = 'inbox', sub = null) {
  if (!TABS.some(t => t[0] === tab)) tab = 'inbox'
  container.innerHTML = `
    <div class="app-layout wa-page">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="waMenu" aria-label="Menu">☰</button>
          <span class="logo-small">WhatsApp</span>
        </div>
        <button class="btn-ghost btn-small" id="waRefresh">Refresh</button>
      </header>
      <main class="app-main wa-main">
        <nav class="pf-tabs wa-tabs">${TABS.map(([id, label]) => `<a href="#whatsapp/${id}" class="pf-tab ${id === tab ? 'active' : ''}">${label}${id === 'inbox' ? ' <span id="waTabUnread"></span>' : ''}</a>`).join('')}</nav>
        <div id="waBody"></div>
      </main>
    </div>`
  const $ = id => container.querySelector('#' + id)
  $('waMenu').addEventListener('click', () => openSidebar())
  const body = $('waBody')
  const page = { inbox: renderInbox, templates: renderTemplates, log: renderLog, outbox: renderOutbox, alerts: renderInvoiceAlerts, settings: (el) => renderWhatsappSettings(el) }[tab]
  const ctl = page(body, sub)
  $('waRefresh').addEventListener('click', () => ctl?.refresh?.())
  loadWhatsappBadge().then(n => { const el = container.querySelector('#waTabUnread'); if (el) el.textContent = n ? ` ${n}` : '' })
  return ctl
}

// ---- Inbox -----------------------------------------------------------------
// 2026-10-16 tools: filter chips (Open · Unread · Waiting for us · Can reply · Mine · Done · All) + label filter,
// pin, mark done (reopens by itself when they write again), mark unread, assign to a person, label,
// mark all read, saved quick replies, and Send ledger / Send QR straight from the chat.
const FILTERS = [
  ['open', 'Open', c => !c.done],
  ['unread', 'Unread', c => c.unread > 0],
  ['waiting', 'Waiting for us', c => !!c.waiting],
  ['window', 'Can reply', c => c.windowOpen && !c.done],
  ['mine', 'Mine', (c, me) => !c.done && c.assignedTo && c.assignedTo === me?.id],
  ['done', 'Done', c => c.done],
  ['all', 'All', () => true],
]
const ago = iso => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`
}
const inr = n => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN')
const store = { get: (k, d) => { try { return localStorage.getItem(k) || d } catch { return d } }, set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } } }

function renderInbox(el, number) {
  el.innerHTML = `
    <div class="wa-inbox">
      <aside class="wa-conv-list">
        <div class="wa-search">
          <input type="search" id="waConvQ" placeholder="Search name, number or message" autocomplete="off" enterkeyhint="search">
          <div class="wa-filters" id="waFilters"></div>
          <div class="wa-list-tools"><select id="waLabelF" aria-label="Label"><option value="">Any label</option></select><button type="button" class="btn-ghost btn-small" id="waReadAll">✓ Mark all read</button></div>
        </div>
        <div id="waConvs"><div class="loading-state">Loading…</div></div>
      </aside>
      <section class="wa-thread" id="waThread"><div class="empty-state">Pick a conversation.</div></section>
    </div>`
  const state = { convs: [], number: number || null, timer: null, thread: null, filter: store.get('wa.filter', 'open'), label: '', quick: [], labels: [], me: null, people: null, party: {}, media: {}, att: null, sig: null, convSig: null }
  if (!FILTERS.some(f => f[0] === state.filter)) state.filter = 'open'
  const $ = id => el.querySelector('#' + id)
  // The chat panel. On a phone it is lifted out of the page onto the whole screen (setFull), so nothing
  // around it — page header, tabs, a sliding wrapper — can push it sideways or under the status bar.
  const TH = $('waThread')
  const home = TH.parentElement
  const phone = () => window.matchMedia('(max-width: 800px)').matches
  function setFull(on) {
    on = on && phone()
    if (on && TH.parentElement !== document.body) document.body.appendChild(TH)
    if (!on && TH.parentElement !== home) home.appendChild(TH)
    TH.classList.toggle('wa-thread-full', on)
    document.body.classList.toggle('wa-chat-full', on)
  }
  const conv = n => state.convs.find(x => x.number === n) || {}

  async function loadConvs(silent) {
    try {
      const d = await call({ action: 'inbox', withPeople: !state.people })
      if (!el.isConnected) return
      if (d.setup) { $('waConvs').innerHTML = '<div class="pf-warn">Run the WhatsApp inbox SQL in Supabase first (ask in the HQ chat).</div>'; return }
      const sig = JSON.stringify(d.conversations) + Math.floor(Date.now() / 120000)
      const changed = sig !== state.convSig
      state.convSig = sig
      state.convs = d.conversations
      state.quick = d.quick || []
      state.me = d.me || null
      if (d.people) state.people = d.people
      if (d.labels && !state.labels.length) {
        state.labels = d.labels
        $('waLabelF').insertAdjacentHTML('beforeend', d.labels.map(l => `<option>${esc(l)}</option>`).join(''))
      }
      if (changed || !silent) drawConvs()
      if (!state.number && state.convs.length && window.innerWidth > 800) { const first = visible()[0]; if (first) openThread(first.number) }
    } catch (err) { if (!silent) $('waConvs').innerHTML = `<div class="empty-state">${esc(err.message)}</div>` }
  }
  function visible() {
    const q = ($('waConvQ').value || '').trim().toLowerCase()
    const qDigits = q.replace(/\D/g, '')
    const test = FILTERS.find(f => f[0] === state.filter)[2]
    const list = state.convs.filter(c => test(c, state.me) && (!state.label || c.label === state.label) && (!q
      || `${c.name || ''} ${c.display || ''} ${c.last?.text || ''} ${c.assignedName || ''} ${c.label || ''}`.toLowerCase().includes(q)
      || (qDigits.length >= 3 && String(c.number || '').includes(qDigits))))
    return [...list.filter(c => c.pinned), ...list.filter(c => !c.pinned)]
  }
  function drawConvs() {
    $('waFilters').innerHTML = FILTERS.map(([id, label, test]) => {
      const n = state.convs.filter(c => test(c, state.me)).length
      return `<button type="button" class="wa-chip ${id === state.filter ? 'on' : ''} ${id === 'waiting' && n ? 'hot' : ''}" data-filter="${id}">${label}${id !== 'all' && id !== 'open' ? ` <b>${n}</b>` : ''}</button>`
    }).join('')
    const list = visible()
    if (!state.convs.length) { $('waConvs').innerHTML = '<div class="empty-state">No messages yet. When a customer replies or taps a button, it shows here.</div>'; return }
    if (!list.length) { $('waConvs').innerHTML = `<div class="empty-state">Nothing here${$('waConvQ').value ? ` for “${esc($('waConvQ').value)}”` : ''}.</div>`; return }
    $('waConvs').innerHTML = list.map(c => {
      const waitMin = c.waiting ? (Date.now() - Date.parse(c.waiting)) / 60000 : 0
      return `
      <button type="button" class="wa-conv ${c.number === state.number ? 'active' : ''} ${c.unread ? 'unread' : ''} ${c.done ? 'is-done' : ''}" data-number="${esc(c.number)}">
        <div class="wa-conv-top"><span class="wa-conv-name">${c.pinned ? '<span class="wa-pin" title="Pinned">📌</span>' : ''}${esc(c.name || c.display)}</span><span class="wa-conv-time">${esc(when(c.last.at))}</span></div>
        <div class="wa-conv-sub">${c.staff ? '<span class="wa-staff">Staff</span> ' : ''}${c.name ? `<span class="wa-muted">${esc(c.display)}${c.nameHow === 'maybe' ? ' · maybe' : ''}</span> · ` : ''}${c.last.direction === 'out' ? '↗ ' : ''}${esc((c.last.text || '').slice(0, 70))}</div>
        <div class="wa-conv-flags">${c.unread ? `<span class="wa-unread">${c.unread}</span>` : ''}${c.waiting ? `<span class="pf-pill pf-tone-${waitMin > 120 ? 'red' : 'amb'}">waiting ${esc(ago(c.waiting))}</span>` : ''}${c.done ? `<span class="pf-pill pf-tone-grey">✓ done${c.doneBy ? ` · ${esc(c.doneBy)}` : ''}</span>` : c.windowOpen ? '<span class="pf-pill pf-tone-grn">can reply</span>' : ''}${c.label ? `<span class="wa-label wa-label-${esc(c.label.toLowerCase())}">${esc(c.label)}</span>` : ''}${c.assignedName ? `<span class="wa-who">👤 ${esc(c.assignedName)}</span>` : ''}</div>
      </button>`
    }).join('')
  }
  $('waConvs').addEventListener('click', e => { const b = e.target.closest('[data-number]'); if (b) openThread(b.dataset.number) })
  $('waFilters').addEventListener('click', e => { const b = e.target.closest('[data-filter]'); if (!b) return; state.filter = b.dataset.filter; store.set('wa.filter', state.filter); drawConvs() })
  $('waLabelF').addEventListener('change', e => { state.label = e.target.value; drawConvs() })
  $('waConvQ').addEventListener('input', drawConvs)
  $('waReadAll').addEventListener('click', async () => {
    const n = state.convs.reduce((s, c) => s + (c.unread || 0), 0)
    if (!n) return
    if (!await hqConfirm(`Mark all ${n} unread message${n === 1 ? '' : 's'} as read?`)) return
    try { await call({ action: 'read-all' }); for (const c of state.convs) c.unread = 0; drawConvs(); refreshNavBadges?.() } catch (err) { hqAlert(err.message) }
  })

  async function op(payload, after) {
    try { await call({ action: 'conv-op', number: state.number, ...payload }); after?.(); drawConvs(); drawTools() }
    catch (err) { hqAlert(err.message) }
  }

  function drawTools() {
    const th = TH, box = th.querySelector('#waTools')
    if (!box) return
    const c = conv(state.number)
    box.innerHTML = `
      <button type="button" class="btn-ghost btn-small" data-t="${c.done ? 'reopen' : 'done'}" title="${c.done ? 'Move back to Open' : 'Nothing more to do — hide from Open until they write again'}">${c.done ? '↺ Reopen' : '✓ Done'}</button>
      <button type="button" class="btn-ghost btn-small" data-t="${c.pinned ? 'unpin' : 'pin'}">${c.pinned ? '📌 Unpin' : '📌 Pin'}</button>
      <button type="button" class="btn-ghost btn-small" data-t="unread" title="Keep it bold in the list">✉ Mark unread</button>
      <select data-t="assign" aria-label="Assign to"><option value="">👤 Assign to…</option>${(state.people || []).map(p => `<option value="${esc(p.id)}" ${p.id === c.assignedTo ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <select data-t="label" aria-label="Label"><option value="">🏷 Label…</option>${state.labels.map(l => `<option ${l === c.label ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`
  }

  function drawCust(t) {
    const c = conv(state.number), box = TH.querySelector('#waCust')
    if (!box) return
    if (c.staff) { box.innerHTML = `<span class="wa-muted">${esc(c.name)} is in our team (Manage Users) — customer tools are not shown for staff numbers.</span>`; return }
    if (!c.code) { box.innerHTML = '<span class="wa-muted">Customer not known for this number — use ⏰ Schedule reminder → search to link one.</span>'; return }
    const p = state.party[c.code]
    box.innerHTML = `
      <span class="wa-cust-due">${p ? (p.due > 0 ? `Due <b>${inr(p.due)}</b>${p.group ? ` · ${esc(p.group)}` : ''}` : 'Nothing due') : 'Loading dues…'}</span>
      <button type="button" class="btn-ghost btn-small" data-send="ledger">📄 Send ledger</button>
      ${t.windowOpen ? '<button type="button" class="btn-ghost btn-small" data-send="qr">💳 Send payment QR</button>' : ''}`
  }

  // Smooth refresh (2026-10-16): the 20-second refresh asks for the open chat quietly and only touches the
  // messages box when something changed (new message, a tick turned blue) — header, buttons, what you are
  // typing and the photo you picked stay as they are; scroll stays put unless you were at the bottom.
  // Photos already opened in this chat stay visible when the messages box is redrawn.
  function showLoadedImages(root) {
    for (const [mid, d] of Object.entries(state.media)) {
      const img = root.querySelector(`#waImg${mid}`)
      if (!img || img.innerHTML) continue
      img.innerHTML = `<img src="data:${d.mime};base64,${d.base64}" alt="" style="cursor:pointer">`
      img.querySelector('img').addEventListener('click', () => openPdfViewer(d))
    }
  }
  const threadSig = t => `${t.windowOpen}|${t.items.map(m => `${m.id}:${m.status}`).join(',')}`
  function msgsHtml(t) {
    let lastDay = ''
    return t.items.map(m => {
        const day = dayOf(m.at)
        const sep = day !== lastDay ? `<div class="wa-day">${esc(day)}</div>` : ''
        lastDay = day
        const st = m.direction === 'out' ? `<span class="wa-msg-status wa-st-${esc(m.status)}" title="${esc(m.error || m.status || '')}">${m.status === 'read' ? '✓✓' : m.status === 'delivered' ? '✓✓' : m.status === 'failed' || m.status === 'no_number' || m.status === 'off' ? '✕ ' + esc(STATUS_TEXT[m.status] || m.status) : '✓'}</span>` : ''
        const who = m.direction === 'out' ? `<span class="wa-muted">${esc(m.by || 'HQ')}</span>` : ''
        const text = m.kind === 'template' ? `<span class="wa-template">📨 ${esc(m.template)}</span><div class="wa-muted">${esc((m.text || '').replace(/^\[[^\]]+\]\s*/, ''))}</div>` : m.kind === 'button' ? `<span class="wa-tap">↩ tapped <strong>${esc(m.text)}</strong></span>` : m.media ? `<button type="button" class="wa-file" data-media="${m.mid}">${m.kind === 'image' ? '🖼' : m.kind === 'video' ? '🎬' : m.kind === 'audio' ? '🎙' : '📎'} ${esc(String(m.text || m.kind).replace(/^[🖼📄]\s*/u, ''))}<span class="wa-muted"> · tap to ${m.kind === 'image' || /\.pdf\b/i.test(m.text || '') ? 'open' : IS_APP ? 'open / save' : 'download'}</span></button>${m.kind === 'image' ? `<div class="wa-img" id="waImg${m.mid}"></div>` : ''}` : esc(m.text || '')
        return `${sep}<div class="wa-msg wa-${m.direction} ${m.kind === 'template' ? 'wa-tpl' : ''}"><div class="wa-bubble">${text}${m.error && m.direction === 'out' ? `<div class="wa-err">${esc(m.error)}</div>` : ''}<div class="wa-meta">${who} ${esc(timeOnly(m.at))} ${st}</div></div></div>`
    }).join('') || '<div class="empty-state">Nothing here yet.</div>'
  }
  function closeThread() {
    state.number = null
    history.replaceState(null, '', '#whatsapp/inbox')
    el.classList.remove('wa-show-thread')
    setFull(false)
    drawConvs()
  }
  async function openThread(number, silent = false) {
    const th = TH
    const quiet = silent && state.number === number && th.querySelector('#waMsgs')
    if (!quiet) {
      state.number = number
      state.att = null; state.media = {}
      drawConvs()
      history.replaceState(null, '', `#whatsapp/inbox/${number}`)
      th.innerHTML = '<div class="loading-state">Loading…</div>'
    }
    try {
      const t = await call({ action: 'thread', number })
      if (!el.isConnected || state.number !== number) return
      const sig = threadSig(t)
      if (quiet) {
        if (sig === state.sig) return
        if (t.windowOpen === state.thread?.windowOpen) {
          const box = th.querySelector('#waMsgs')
          const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80
          box.innerHTML = msgsHtml(t)
          showLoadedImages(box)
          if (atBottom) box.scrollTop = 1e9
          state.thread = t; state.sig = sig
          return
        }
      }
      const typed = th.querySelector('#waReplyText')?.value || ''
      state.thread = t; state.sig = sig
      const c = conv(number)
      for (const x of state.convs) if (x.number === number) x.unread = 0
      drawConvs(); refreshNavBadges?.()
      const rows = msgsHtml(t)
      const fill = s => s.replace(/\{name\}/g, c.name || '')
      th.innerHTML = `
        <div class="wa-thread-head">
          <button type="button" class="wa-back" id="waBack" aria-label="Back to chats">‹</button>
          <div class="wa-head-info"><div class="wa-conv-name">${c.pinned ? '📌 ' : ''}${esc(c.name || c.display || number)}</div><div class="wa-muted wa-head-sub">${esc(c.display || number)}${c.nameHow ? `<span class="wa-name-how"> · name from ${esc(c.nameHow === 'maybe' ? 'a matching customer record (maybe)' : c.nameHow === 'whatsapp profile' ? 'their WhatsApp profile' : c.nameHow === 'staff' ? 'Manage Users (our staff)' : 'the last ' + (KIND_LABEL[c.nameHow] || c.nameHow).toLowerCase() + ' we sent')}</span>` : ''}</div></div>
          <div class="wa-head-acts">
            ${c.code ? `<a class="btn-ghost btn-small wa-hbtn" href="#customers/${esc(c.code)}" title="Customer card" aria-label="Customer card">👤<span class="wa-btn-text"> Customer card</span></a>` : ''}
            <button type="button" class="btn-primary btn-small wa-hbtn wa-hbtn-main" id="waSched" ${c.staff ? 'hidden' : ''} title="Schedule payment reminder" aria-label="Schedule reminder">⏰<span class="wa-btn-text"> Schedule reminder</span></button>
            <button type="button" class="btn-ghost btn-small wa-hbtn wa-more-btn" id="waMore" title="More: Done, Pin, Assign, Label, Ledger, QR" aria-label="More" aria-expanded="false">⋯</button>
          </div>
        </div>
        <div class="wa-sched-chip" id="waSchedChip"></div>
        <div class="wa-tools" id="waTools"></div>
        <div class="wa-cust" id="waCust"></div>
        <div class="wa-msgs" id="waMsgs">${rows}</div>
        <div class="wa-reply">
          ${t.windowOpen
            ? `${state.quick.length || state.me?.isAdmin ? `<div class="wa-quick">${state.quick.map((q, i) => `<button type="button" class="wa-chip" data-quick="${i}" title="${esc(fill(q))}">${esc(fill(q).slice(0, 34))}${q.length > 34 ? '…' : ''}</button>`).join('')}${state.me?.isAdmin ? '<button type="button" class="wa-chip wa-chip-edit" id="waQuickEdit" title="Change the saved replies">✎ Edit</button>' : ''}</div>` : ''}
               <div class="wa-att-prev" id="waAttPrev" hidden></div>
               <div class="wa-reply-row">
                 <label class="wa-attach" title="Send a photo, PDF, Excel or Word file">📎<input type="file" id="waFile" accept="image/*,application/pdf,.pdf,.xlsx,.xls,.docx,.doc,.txt" hidden></label>
                 <label class="wa-attach wa-cam" title="Take a photo">📷<input type="file" id="waCam" accept="image/*" capture="environment" hidden></label>
                 <textarea id="waReplyText" rows="2" placeholder="Type a reply…"></textarea>
                 <button class="btn-primary btn-small" id="waReplySend">Send</button>
               </div>`
            : `<div class="wa-muted">They have not written in the last 24 hours, so WhatsApp allows only an approved template now. Use 📄 Send ledger above, ⏰ Schedule reminder, or a payment reminder from Payment Follow-up.</div>`}
          <p class="pf-error" id="waReplyErr" hidden></p>
        </div>`
      drawTools(); drawCust(t)
      if (c.code && !state.party[c.code]) call({ action: 'schedule-list', party_code: c.code }).then(d => {
        state.party[c.code] = d.party
        if (state.number === number) drawCust(t)
        const a = d.schedules.find(x => x.status === 'active'); const chip = th.querySelector('#waSchedChip'); if (a && chip) chip.textContent = scheduleChip(a)
      }).catch(() => {})
      else if (c.code) call({ action: 'schedule-list', party_code: c.code }).then(d => { const a = d.schedules.find(x => x.status === 'active'); const chip = th.querySelector('#waSchedChip'); if (a && chip) chip.textContent = scheduleChip(a) }).catch(() => {})
      th.querySelector('#waMsgs').scrollTop = 1e9
      th.querySelector('#waBack').addEventListener('click', closeThread)
      th.querySelector('#waMore').addEventListener('click', e => { const on = th.classList.toggle('wa-tools-open'); e.currentTarget.setAttribute('aria-expanded', String(on)) })
      el.classList.add('wa-show-thread')
      setFull(true)
      th.querySelector('#waTools').addEventListener('click', e => {
        const b = e.target.closest('button[data-t]')
        if (!b) return
        const x = conv(number), t2 = b.dataset.t
        if (t2 === 'unread') return op({ op: 'unread' }, () => { x.unread = 1; closeThread(); th.innerHTML = '<div class="empty-state">Marked unread.</div>'; refreshNavBadges?.() })
        op({ op: t2 }, () => { if (t2 === 'done') { x.done = true; x.doneBy = 'you'; x.waiting = null } if (t2 === 'reopen') x.done = false; if (t2 === 'pin') x.pinned = true; if (t2 === 'unpin') x.pinned = false })
      })
      th.querySelector('#waTools').addEventListener('change', e => {
        const s = e.target.closest('select[data-t]')
        if (!s) return
        const x = conv(number)
        if (s.dataset.t === 'assign') op({ op: 'assign', person: s.value }, () => { x.assignedTo = s.value || null; x.assignedName = s.value ? s.selectedOptions[0].textContent : null })
        else op({ op: 'label', label: s.value }, () => { x.label = s.value || null })
      })
      th.querySelector('#waCust').addEventListener('click', async e => {
        const b = e.target.closest('[data-send]')
        if (!b) return
        const x = conv(number), what = b.dataset.send
        if (!await hqConfirm(what === 'ledger' ? `Send the ledger statement of ${x.name || 'this customer'} to ${x.display}?` : `Send the payment QR card of ${x.name || 'this customer'} to ${x.display}?`)) return
        b.disabled = true; const label = b.textContent; b.textContent = 'Sending…'
        try { await call({ action: what === 'ledger' ? 'chat-ledger' : 'chat-qr', number, code: x.code }); b.textContent = '✓ Sent'; setTimeout(() => { if (state.number === number) openThread(number) }, 1200) }
        catch (err) { b.disabled = false; b.textContent = label; hqAlert(err.message) }
      })
      th.querySelector('.wa-quick')?.addEventListener('click', async e => {
        if (e.target.closest('#waQuickEdit')) {
          const v = await hqPrompt('Saved replies — one per line. {name} is replaced by the chat name.', state.quick.join('\n'))
          if (v == null) return
          try { const d = await call({ action: 'quick-save', quick: v.split('\n') }); state.quick = d.quick; openThread(number) } catch (err) { hqAlert(err.message) }
          return
        }
        const q = e.target.closest('[data-quick]')
        if (!q) return
        const ta = th.querySelector('#waReplyText')
        ta.value = (ta.value ? ta.value.trimEnd() + ' ' : '') + fill(state.quick[Number(q.dataset.quick)] || '')
        ta.focus()
      })
      th.querySelector('#waMsgs').addEventListener('click', async e => {
        const b = e.target.closest('[data-media]')
        if (!b) return
        b.disabled = true
        try {
          const d = await call({ action: 'media', id: Number(b.dataset.media) })
          const img = TH.querySelector(`#waImg${b.dataset.media}`)
          if (img && d.mime.startsWith('image/') && !img.innerHTML) {
            // Photos show right in the chat; tap the photo to see it full screen (Save / share there).
            state.media[b.dataset.media] = d
            showLoadedImages(TH)
          } else if (/pdf|^image\//.test(d.mime)) {
            await openPdfViewer(d) // opens on screen; "Save / share" button inside
          } else {
            await shareBase64(d.base64, d.filename, d.mime) // other files (Excel, Word …): phone opens them via the share sheet
          }
        } catch (err) {
          if (staleChunk(err)) { location.reload(); return } // HQ was updated since this page opened
          hqAlert(err.message)
        }
        finally { b.disabled = false }
      })
      th.querySelector('#waSched').addEventListener('click', () => openScheduler({ number, code: c.code, name: c.name, onSaved: sch => { const chip = th.querySelector('#waSchedChip'); if (chip) chip.textContent = scheduleChip(sch) } }))
      if (typed && th.querySelector('#waReplyText')) th.querySelector('#waReplyText').value = typed
      for (const id of ['waFile', 'waCam']) th.querySelector('#' + id)?.addEventListener('change', e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) pickFile(f) })
      th.querySelector('#waAttPrev')?.addEventListener('click', e => { if (e.target.closest('[data-att-x]')) { state.att = null; drawAtt() } })
      th.querySelector('#waReplySend')?.addEventListener('click', sendReply)
      th.querySelector('#waReplyText')?.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendReply() })
    } catch (err) { th.innerHTML = `<div class="empty-state">${esc(err.message)}</div>` }
  }
  // Photo / file reply (2026-10-16): photos are shrunk on the phone (1600 px JPEG) so they pass through HQ fast.
  async function pickFile(f) {
    const err = TH.querySelector('#waReplyErr')
    err.hidden = true
    try {
      if (/^image\//.test(f.type) && !/gif|svg/.test(f.type)) state.att = await shrinkImage(f)
      else {
        if (f.size > 3_000_000) throw new Error(`${f.name} is ${(f.size / 1e6).toFixed(1)} MB — WhatsApp from HQ takes files up to 3 MB.`)
        const mime = f.type || (/\.pdf$/i.test(f.name) ? 'application/pdf' : /\.xlsx$/i.test(f.name) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : /\.docx$/i.test(f.name) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : '')
        state.att = { kind: 'document', mime, filename: f.name, size: f.size, base64: await fileBase64(f) }
      }
      drawAtt()
      TH.querySelector('#waReplyText')?.focus()
    } catch (e) { err.textContent = e.message; err.hidden = false }
  }
  function drawAtt() {
    const box = TH.querySelector('#waAttPrev'), ta = TH.querySelector('#waReplyText')
    if (!box) return
    const a = state.att
    box.hidden = !a
    box.innerHTML = a ? `${a.kind === 'image' ? `<img src="data:${a.mime};base64,${a.base64}" alt="">` : '<span class="wa-att-ico">📄</span>'}
      <span class="wa-att-name">${esc(a.filename)}<span class="wa-muted"> · ${(a.size / 1e6 >= 0.1 ? (a.size / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(a.size / 1e3)) + ' KB')}</span></span>
      <button type="button" class="btn-ghost btn-small" data-att-x aria-label="Remove">✕</button>` : ''
    if (ta) ta.placeholder = a ? 'Add a caption (optional)…' : 'Type a reply…'
  }
  async function sendReply() {
    const ta = TH.querySelector('#waReplyText'), btn = TH.querySelector('#waReplySend'), err = TH.querySelector('#waReplyErr')
    const text = ta.value.trim()
    const att = state.att
    if (!text && !att) return
    btn.disabled = true; err.hidden = true; btn.textContent = att ? 'Sending…' : 'Send'
    try {
      if (att) await call({ action: 'reply-media', number: state.number, base64: att.base64, mime: att.mime, filename: att.filename, caption: text })
      else await call({ action: 'reply', number: state.number, text })
      ta.value = ''; state.att = null; drawAtt()
      await openThread(state.number, true); TH.querySelector('#waMsgs').scrollTop = 1e9; loadConvs(true)
    }
    catch (e) { err.textContent = e.message; err.hidden = false }
    finally { btn.disabled = false; btn.textContent = 'Send' }
  }

  // Leaving the Inbox (another tab or page) always gives the header and tab bar back.
  // Leaving the page (or the Inbox) takes the full-screen chat away with it.
  const onHash = () => {
    if (el.isConnected && location.hash.startsWith('#whatsapp/inbox/')) return
    if (TH.parentElement === document.body) TH.remove()
    document.body.classList.remove('wa-chat-full')
    if (!el.isConnected) window.removeEventListener('hashchange', onHash)
  }
  window.addEventListener('hashchange', onHash)
  loadConvs().then(() => { if (number) openThread(number) })
  // Every 20 s: list always; the open chat only when nobody is typing or picking from a dropdown.
  state.timer = setInterval(() => {
    if (!el.isConnected) { clearInterval(state.timer); return }
    loadConvs(true)
    if (state.number && !document.querySelector('.hq-dlg, .modal-overlay') && !TH.querySelector('#waReplySend:disabled')) openThread(state.number, true)
  }, 20000)
  return { refresh: () => { loadConvs(); if (state.number) openThread(state.number, true) } }
}

function fileBase64(f) {
  return new Promise((ok, bad) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result).split(',')[1] || '')
    r.onerror = () => bad(new Error('Could not read that file.'))
    r.readAsDataURL(f)
  })
}
async function shrinkImage(f, max = 1600) {
  const url = URL.createObjectURL(f)
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('That photo could not be opened (try a JPG or PNG).')); i.src = url })
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
    const c = document.createElement('canvas')
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k)
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height)
    const base64 = c.toDataURL('image/jpeg', 0.8).split(',')[1]
    return { kind: 'image', mime: 'image/jpeg', filename: (f.name || 'photo').replace(/\.\w+$/, '') + '.jpg', size: Math.round(base64.length * 0.75), base64 }
  } finally { URL.revokeObjectURL(url) }
}

// ---- Templates --------------------------------------------------------------
function renderTemplates(el) {
  el.innerHTML = '<div class="loading-state">Asking WhatsApp Manager…</div>'
  let templates = [], tplQ = ''
  async function load() {
    try {
      const d = await call({ action: 'templates' })
      const ok = d.templates.filter(t => t.status === 'APPROVED').length, miss = d.templates.filter(t => t.status === 'MISSING').length, pend = d.templates.filter(t => t.status === 'PENDING').length, rej = d.templates.filter(t => t.status === 'REJECTED').length
      el.innerHTML = `
        <div class="wa-card">
          <div class="wa-row"><strong>${ok} approved</strong>${pend ? ` · ${pend} in review` : ''}${rej ? ` · <span class="pf-pill pf-tone-red">${rej} rejected</span>` : ''}${miss ? ` · <span class="pf-pill pf-tone-red">${miss} not created yet</span>` : ''}
            <span class="wa-muted">— the wording for the missing ones is in the templates file (docs/whatsapp-templates.md). Create them in WhatsApp Manager; this list refreshes from Meta.</span></div>
        </div>
        <div class="wa-search"><input type="search" id="waTplQ" placeholder="Search template name, use, wording or status" autocomplete="off" enterkeyhint="search" value="${esc(tplQ)}"></div>
        <div id="waTplList"></div>`
      templates = d.templates
      el.querySelector('#waTplQ').addEventListener('input', e => { tplQ = e.target.value; drawTemplates() })
      drawTemplates()
    } catch (err) { el.innerHTML = `<div class="empty-state">${esc(err.message)}</div>` }
  }
  function drawTemplates() {
    const q = tplQ.trim().toLowerCase()
    const list = !q ? templates : templates.filter(t => {
      const status = t.status === 'MISSING' ? 'not created missing' : String(t.status || '').toLowerCase()
      return `${t.name} ${t.used || ''} ${t.body || ''} ${(t.buttons || []).join(' ')} ${status} ${t.category || ''}`.toLowerCase().includes(q)
    })
    const box = el.querySelector('#waTplList')
    if (!box) return
    if (!list.length) { box.innerHTML = `<div class="empty-state">No template matches “${esc(q)}”.</div>`; return }
    box.innerHTML = `
        <div class="wa-table wa-card wa-tpl-table"><table><thead><tr><th>Template</th><th>Used for</th><th>Status</th><th>Last real send</th><th>Buttons</th><th>Body</th></tr></thead><tbody>
          ${list.map(t => `<tr><td><code>${esc(t.name)}</code>${t.language ? `<div class="wa-muted">${esc(t.language)} · ${esc(t.category || '')}</div>` : ''}</td><td>${esc(t.used)}</td><td>${pill(t.status, t.status === 'MISSING' ? 'Not created' : t.status.toLowerCase())}${t.rejected_reason && t.rejected_reason !== 'NONE' ? `<div class="wa-muted">${esc(t.rejected_reason)}</div>` : ''}${t.quality && t.quality !== 'UNKNOWN' ? `<div class="wa-muted">quality ${esc(t.quality.toLowerCase())}</div>` : ''}</td><td>${t.last ? `${pill(t.last.status)}<div class="wa-muted">${esc(when(t.last.at))}</div>${t.last.error ? `<div class="wa-err">${esc(t.last.error)}</div>` : ''}` : '<span class="wa-muted">never sent</span>'}</td><td>${(t.buttons || []).map(b => `<div>${esc(b)}</div>`).join('')}</td><td class="wa-body-cell">${esc(t.body || '')}</td></tr>`).join('')}
        </tbody></table></div>`
  }
  load()
  return { refresh: load }
}

// ---- Log --------------------------------------------------------------------
function renderLog(el) {
  el.innerHTML = `
    <div class="wa-card" id="waSummary"><div class="loading-state">Loading…</div></div>
    <div class="wa-card">
      <div class="wa-row">
        <select id="waLogKind"><option value="">All kinds</option>${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
        <select id="waLogStatus"><option value="">All statuses</option><option value="failed">Failed</option><option value="sent">Sent (not yet delivered)</option><option value="delivered">Delivered</option><option value="read">Read</option><option value="no_number">No number</option><option value="off">Switched off</option></select>
        <input id="waLogQ" placeholder="Search name / number / template" style="flex:1 1 200px">
      </div>
      <div id="waLog" class="wa-table"><div class="loading-state">Loading…</div></div>
    </div>`
  const $ = id => el.querySelector('#' + id)
  let rows = []
  async function load() {
    try {
      const [s, d] = await Promise.all([call({ action: 'log-summary' }), call({ action: 'log', kind: $('waLogKind').value, limit: 500 })])
      rows = d.rows
      const sum = Object.entries(s.summary || {})
      $('waSummary').innerHTML = sum.length ? `<div class="wa-row"><strong>Last ${s.days} days</strong></div><div class="wa-sum">${sum.map(([k, v]) => `<div class="wa-sum-item"><div class="wa-muted">${esc(KIND_LABEL[k] || k)}</div><div>${v.sent + v.delivered + v.read} sent · <span class="wa-ok">${v.read} read</span>${v.failed ? ` · <span class="wa-bad">${v.failed} failed</span>` : ''}</div></div>`).join('')}</div>` : '<div class="wa-muted">Nothing sent in the last 7 days.</div>'
      draw()
    } catch (err) { $('waLog').innerHTML = `<div class="empty-state">${esc(err.message)}</div>` }
  }
  function draw() {
    const st = $('waLogStatus').value, q = $('waLogQ').value.trim().toLowerCase()
    const list = rows.filter(r => (!st || r.status === st) && (!q || `${r.ref_name || ''} ${r.to_number || ''} ${r.template || ''} ${r.ref || ''}`.toLowerCase().includes(q)))
    if (!list.length) { $('waLog').innerHTML = '<div class="empty-state">No sends match.</div>'; return }
    $('waLog').innerHTML = `<table><thead><tr><th>When</th><th>Kind</th><th>To</th><th>Template</th><th>Status</th><th>By</th></tr></thead><tbody>
      ${list.map(r => `<tr><td>${esc(when(r.created_at))}</td><td>${esc(KIND_LABEL[r.kind] || r.kind)}</td><td>${esc(r.ref_name || '')}<div class="wa-muted">${esc(r.to_number || '')}</div></td><td><code>${esc(r.template || '')}</code>${r.ref ? `<div class="wa-muted">${esc(r.ref)}</div>` : ''}</td><td>${pill(r.status)}${r.read_at ? `<div class="wa-muted">read ${esc(when(r.read_at))}</div>` : r.delivered_at ? `<div class="wa-muted">delivered ${esc(when(r.delivered_at))}</div>` : ''}${r.error ? `<div class="wa-err">${esc(r.error)}</div>` : ''}</td><td>${esc(r.sent_by || '')}</td></tr>`).join('')}
      </tbody></table>`
  }
  $('waLogKind').addEventListener('change', load)
  $('waLogStatus').addEventListener('change', draw)
  $('waLogQ').addEventListener('input', draw)
  load()
  return { refresh: load }
}

// ---- Outbox -----------------------------------------------------------------
function renderOutbox(el) {
  el.innerHTML = `
    <div class="wa-card">
      <p class="wa-muted">Customer messages from Busy wait <b>15 minutes</b> after the first save. While waiting, edits in Busy are picked up, and a deleted or cancelled voucher is never sent. If an invoice changes after its message went, a corrected copy goes automatically. Use <b>Hold</b> to stop the clock on one message, or pause everything below.</p>
      <div class="wa-pause" id="waPauseBox"></div>
      <div class="wa-row">
        <select id="waOutboxFilter"><option value="queued">Waiting to go</option><option value="held">On hold</option><option value="sent">Sent</option><option value="after_send">Changed / deleted after sending</option><option value="revised">Corrected copies</option><option value="deleted">Deleted in Busy before sending</option><option value="failed">Failed</option><option value="no_number">No number</option><option value="no_billing">No billed party (ledger only)</option><option value="expired">Expired</option><option value="cancelled">Cancelled</option><option value="skipped">Loaded as history</option><option value="">All</option></select>
        <button class="btn-ghost btn-small" id="waTick">Send what is due now</button>
        <button class="btn-ghost btn-small" id="waOrdersNow">Send the 17:30 orders message now</button>
      </div>
      <p id="waTickResult" aria-live="polite"></p>
      <div id="waOutbox" class="wa-table">Loading…</div>
    </div>`
  const $ = id => el.querySelector('#' + id)
  const rupees = n => `₹${Number(n || 0).toLocaleString('en-IN')}`
  const ops = r => {
    const b = (op, label, cls = 'btn-ghost') => `<button type="button" class="${cls} btn-small" data-op="${op}" data-id="${r.id}">${label}</button>`
    if (r.status === 'queued') return b('send-now', 'Send now') + b('hold', 'Hold') + b('cancel', 'Cancel')
    if (r.status === 'held') return b('release', 'Release') + b('send-now', 'Send now') + b('cancel', 'Cancel')
    if (r.status === 'failed') return b('send-now', 'Try again') + b('cancel', 'Cancel')
    return ''
  }
  const note = r => [
    r.revision > 0 ? `Corrected copy ${r.revision}${r.sent_amount != null ? ` — the first message said ${rupees(r.sent_amount)}` : ''}` : '',
    r.after_send === 'changed' && !(r.revision > 0) ? 'Changed in Busy after this message went (not resent)' : '',
    r.after_send === 'deleted' ? 'Deleted / cancelled in Busy after this message went' : '',
  ].filter(Boolean).map(t => `<div class="wa-flag">${esc(t)}</div>`).join('')
  function drawPause(paused) {
    $('waPauseBox').innerHTML = paused
      ? `<div class="wa-paused">⏸ Customer messages are <b>paused</b>. Nothing from Busy is being sent; it waits here.</div><button class="btn-primary btn-small" id="waPauseBtn" data-on="0">Resume sending</button>`
      : `<button class="btn-ghost btn-small" id="waPauseBtn" data-on="1">⏸ Pause all customer messages</button>`
    $('waPauseBtn').addEventListener('click', async e => {
      const on = e.target.dataset.on === '1'
      if (on && !await hqConfirm('Pause all customer WhatsApp messages from Busy? They will wait here until you resume (anything waiting over 24 h expires).')) return
      try { await call({ action: 'outbox-pause', on }); load() } catch (err) { $('waTickResult').textContent = '❌ ' + err.message }
    })
  }
  async function load() {
    try {
      const d = await call({ action: 'outbox', status: $('waOutboxFilter').value })
      drawPause(d.paused)
      if (!d.rows.length) { $('waOutbox').innerHTML = '<div class="wa-muted">Nothing here.</div>'; return }
      $('waOutbox').innerHTML = `<table><thead><tr><th>Kind</th><th>Party</th><th>No.</th><th>Amount</th><th>Goes at</th><th>Status</th><th></th></tr></thead><tbody>
        ${d.rows.map(r => `<tr><td>${esc(KIND_LABEL[r.kind] || r.kind)}</td><td>${esc(r.party_name || r.party_code)}<div class="wa-muted">${esc(r.mobile || 'no number')}</div></td><td>${esc(r.vch_no || '')}<div class="wa-muted">${esc(r.vch_date || '')}</div></td><td>${rupees(r.amount)}</td><td>${esc(when(r.send_after))}</td><td>${pill(r.status)}${r.error ? `<div class="wa-muted">${esc(r.error)}</div>` : ''}${note(r)}</td><td class="wa-ops">${ops(r)}</td></tr>`).join('')}
        </tbody></table>`
    } catch (err) { $('waOutbox').textContent = err.message }
  }
  $('waOutbox').addEventListener('click', async e => {
    const b = e.target.closest('[data-op]')
    if (!b) return
    const op = b.dataset.op
    if (op === 'cancel' && !await hqConfirm('Cancel this message? It will never be sent.')) return
    b.disabled = true
    try {
      const d = await call({ action: 'outbox-op', id: Number(b.dataset.id), op })
      $('waTickResult').textContent = op === 'send-now' ? (d.sent ? '✓ Sent.' : d.no_number ? 'No number — not sent.' : d.failed ? '❌ Failed — see the row.' : d.skipped || 'Done.') : '✓ Done.'
      load()
    } catch (err) { $('waTickResult').textContent = '❌ ' + err.message; b.disabled = false }
  })
  $('waOutboxFilter').addEventListener('change', load)
  $('waTick').addEventListener('click', async () => {
    $('waTick').disabled = true; $('waTickResult').textContent = 'Sending…'
    try {
      const d = await call({ action: 'tick' }); const o = d.outbox || {}
      $('waTickResult').textContent = o.skipped ? o.skipped : `Done: ${o.sent || 0} sent · ${o.failed || 0} failed · ${o.no_number || 0} no number${o.off ? ` · ${o.off} waiting (kind switched off)` : ''}${o.expired ? ` · ${o.expired} expired` : ''}${o.no_billing ? ` · ${o.no_billing} skipped (ledger-only name, no billed party)` : ''}.`
      load()
    } catch (err) { $('waTickResult').textContent = '❌ ' + err.message }
    finally { $('waTick').disabled = false }
  })
  $('waOrdersNow').addEventListener('click', async () => {
    if (!await hqConfirm('Send the orders / material message to all admins now?')) return
    try { const d = await call({ action: 'tick', force: 'orders' }); const o = d.orders || {}; $('waTickResult').textContent = `Orders message: ${(o.sent || []).map(x => `${x.to} ${x.status}`).join(', ') || 'nobody to send to'}.` }
    catch (err) { $('waTickResult').textContent = '❌ ' + err.message }
  })
  load()
  return { refresh: load }
}
