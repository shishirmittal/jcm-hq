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
import { hqConfirm } from './hq-dialog.js'

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
  staff_purchase_summary: 'Staff: purchases summary', staff_gst: 'Staff: GST report', staff_orders: 'Admins: orders 17:30', test: 'Sample / test',
}
const TONE = { sent: 'blue', delivered: 'grn', read: 'grn', received: 'grey', failed: 'red', no_number: 'grey', no_billing: 'grey', off: 'grey', queued: 'amb', held: 'amb', deleted: 'grey', sending: 'amb', cancelled: 'grey', expired: 'grey', skipped: 'grey', APPROVED: 'grn', PENDING: 'amb', REJECTED: 'red', MISSING: 'red', PAUSED: 'red', DISABLED: 'red' }
const STATUS_TEXT = { sent: 'Sent', delivered: 'Delivered', read: 'Read ✓✓', failed: 'Failed', no_number: 'No number', no_billing: 'No billed party (ledger only)', queued: 'Waiting', held: 'On hold', deleted: 'Deleted in Busy', off: 'Switched off', received: 'Received' }
const when = iso => iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : ''
const timeOnly = iso => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : ''
const dayOf = iso => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
const pill = (s, t) => `<span class="pf-pill pf-tone-${TONE[s] || 'grey'}">${esc(t || STATUS_TEXT[s] || s)}</span>`

const TABS = [['inbox', 'Inbox'], ['templates', 'Templates'], ['log', 'Log'], ['outbox', 'Outbox'], ['settings', 'Settings']]

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
  const page = { inbox: renderInbox, templates: renderTemplates, log: renderLog, outbox: renderOutbox, settings: (el) => renderWhatsappSettings(el) }[tab]
  const ctl = page(body, sub)
  $('waRefresh').addEventListener('click', () => ctl?.refresh?.())
  loadWhatsappBadge().then(n => { const el = container.querySelector('#waTabUnread'); if (el) el.textContent = n ? ` ${n}` : '' })
  return ctl
}

// ---- Inbox -----------------------------------------------------------------
function renderInbox(el, number) {
  el.innerHTML = `
    <div class="wa-inbox">
      <aside class="wa-conv-list">
        <div class="wa-search"><input type="search" id="waConvQ" placeholder="Search name, number or message" autocomplete="off" enterkeyhint="search"></div>
        <div id="waConvs"><div class="loading-state">Loading…</div></div>
      </aside>
      <section class="wa-thread" id="waThread"><div class="empty-state">Pick a conversation.</div></section>
    </div>`
  const state = { convs: [], number: number || null, timer: null, thread: null }
  const $ = id => el.querySelector('#' + id)

  async function loadConvs(silent) {
    try {
      const d = await call({ action: 'inbox' })
      if (!el.isConnected) return
      if (d.setup) { $('waConvs').innerHTML = '<div class="pf-warn">Run the WhatsApp inbox SQL in Supabase first (ask in the HQ chat).</div>'; return }
      state.convs = d.conversations
      drawConvs()
      if (!state.number && state.convs.length && window.innerWidth > 800) openThread(state.convs[0].number)
    } catch (err) { if (!silent) $('waConvs').innerHTML = `<div class="empty-state">${esc(err.message)}</div>` }
  }
  function drawConvs() {
    const q = ($('waConvQ').value || '').trim().toLowerCase()
    const qDigits = q.replace(/\D/g, '')
    const list = !q ? state.convs : state.convs.filter(c =>
      `${c.name || ''} ${c.display || ''} ${c.last?.text || ''}`.toLowerCase().includes(q)
      || (qDigits.length >= 3 && String(c.number || '').includes(qDigits)))
    if (!state.convs.length) { $('waConvs').innerHTML = '<div class="empty-state">No messages yet. When a customer replies or taps a button, it shows here.</div>'; return }
    if (!list.length) { $('waConvs').innerHTML = `<div class="empty-state">No conversation matches “${esc(q)}”.</div>`; return }
    $('waConvs').innerHTML = list.map(c => `
      <button type="button" class="wa-conv ${c.number === state.number ? 'active' : ''} ${c.unread ? 'unread' : ''}" data-number="${esc(c.number)}">
        <div class="wa-conv-top"><span class="wa-conv-name">${esc(c.name || c.display)}</span><span class="wa-conv-time">${esc(when(c.last.at))}</span></div>
        <div class="wa-conv-sub">${c.name ? `<span class="wa-muted">${esc(c.display)}${c.nameHow === 'maybe' ? ' · maybe' : ''}</span> · ` : ''}${c.last.direction === 'out' ? '↗ ' : ''}${esc((c.last.text || '').slice(0, 70))}</div>
        <div class="wa-conv-flags">${c.unread ? `<span class="wa-unread">${c.unread}</span>` : ''}${c.windowOpen ? '<span class="pf-pill pf-tone-grn">can reply</span>' : ''}</div>
      </button>`).join('')
  }
  $('waConvs').addEventListener('click', e => { const b = e.target.closest('[data-number]'); if (b) openThread(b.dataset.number) })
  $('waConvQ').addEventListener('input', drawConvs)

  async function openThread(number) {
    state.number = number
    drawConvs()
    history.replaceState(null, '', `#whatsapp/inbox/${number}`)
    const th = $('waThread')
    th.innerHTML = '<div class="loading-state">Loading…</div>'
    try {
      const t = await call({ action: 'thread', number })
      if (!el.isConnected || state.number !== number) return
      state.thread = t
      const c = state.convs.find(x => x.number === number) || {}
      for (const x of state.convs) if (x.number === number) x.unread = 0
      drawConvs(); refreshNavBadges?.()
      let lastDay = ''
      const rows = t.items.map(m => {
        const day = dayOf(m.at)
        const sep = day !== lastDay ? `<div class="wa-day">${esc(day)}</div>` : ''
        lastDay = day
        const st = m.direction === 'out' ? `<span class="wa-msg-status wa-st-${esc(m.status)}" title="${esc(m.error || m.status || '')}">${m.status === 'read' ? '✓✓' : m.status === 'delivered' ? '✓✓' : m.status === 'failed' || m.status === 'no_number' || m.status === 'off' ? '✕ ' + esc(STATUS_TEXT[m.status] || m.status) : '✓'}</span>` : ''
        const who = m.direction === 'out' ? `<span class="wa-muted">${esc(m.by || 'HQ')}</span>` : ''
        const text = m.kind === 'template' ? `<span class="wa-template">📨 ${esc(m.template)}</span><div class="wa-muted">${esc((m.text || '').replace(/^\[[^\]]+\]\s*/, ''))}</div>` : m.kind === 'button' ? `<span class="wa-tap">↩ tapped <strong>${esc(m.text)}</strong></span>` : m.media ? `<button type="button" class="wa-file" data-media="${m.mid}">${m.kind === 'image' ? '🖼' : m.kind === 'video' ? '🎬' : m.kind === 'audio' ? '🎙' : '📎'} ${esc(String(m.text || m.kind).replace(/^[🖼📄]\s*/u, ''))}<span class="wa-muted"> · tap to ${m.kind === 'image' || /\.pdf\b/i.test(m.text || '') ? 'open' : IS_APP ? 'open / save' : 'download'}</span></button>${m.kind === 'image' ? `<div class="wa-img" id="waImg${m.mid}"></div>` : ''}` : esc(m.text || '')
        return `${sep}<div class="wa-msg wa-${m.direction} ${m.kind === 'template' ? 'wa-tpl' : ''}"><div class="wa-bubble">${text}${m.error && m.direction === 'out' ? `<div class="wa-err">${esc(m.error)}</div>` : ''}<div class="wa-meta">${who} ${esc(timeOnly(m.at))} ${st}</div></div></div>`
      }).join('')
      th.innerHTML = `
        <div class="wa-thread-head">
          <button type="button" class="btn-ghost btn-small wa-back" id="waBack">‹ Back</button>
          <div><div class="wa-conv-name">${esc(c.name || c.display || number)}</div><div class="wa-muted">${esc(c.display || number)}${c.nameHow ? ` · name from ${esc(c.nameHow === 'maybe' ? 'a matching customer record (maybe)' : c.nameHow === 'whatsapp profile' ? 'their WhatsApp profile' : 'the last ' + (KIND_LABEL[c.nameHow] || c.nameHow).toLowerCase() + ' we sent')}` : ''}</div></div>
          ${c.code ? `<a class="btn-ghost btn-small" href="#customers/${esc(c.code)}">Customer card</a>` : ''}
        </div>
        <div class="wa-msgs" id="waMsgs">${rows || '<div class="empty-state">Nothing here yet.</div>'}</div>
        <div class="wa-reply">
          ${t.windowOpen
            ? `<textarea id="waReplyText" rows="2" placeholder="Type a reply… (they wrote within the last 24 h, so a free message is allowed)"></textarea><button class="btn-primary btn-small" id="waReplySend">Send</button>`
            : `<div class="wa-muted">They have not written in the last 24 hours, so WhatsApp allows only an approved template now. Use Settings → Send a sample, or a payment reminder from Payment Follow-up.</div>`}
          <p class="pf-error" id="waReplyErr" hidden></p>
        </div>`
      th.querySelector('#waMsgs').scrollTop = 1e9
      th.querySelector('#waBack').addEventListener('click', () => { state.number = null; history.replaceState(null, '', '#whatsapp/inbox'); el.classList.remove('wa-show-thread'); drawConvs() })
      el.classList.add('wa-show-thread')
      th.querySelector('#waMsgs').addEventListener('click', async e => {
        const b = e.target.closest('[data-media]')
        if (!b) return
        b.disabled = true
        try {
          const d = await call({ action: 'media', id: Number(b.dataset.media) })
          const img = el.querySelector(`#waImg${b.dataset.media}`)
          if (img && d.mime.startsWith('image/') && !img.innerHTML) {
            // Photos show right in the chat; tap the photo to see it full screen (Save / share there).
            img.innerHTML = `<img src="data:${d.mime};base64,${d.base64}" alt="" style="cursor:pointer">`
            img.querySelector('img').addEventListener('click', () => openPdfViewer(d))
          } else if (/pdf|^image\//.test(d.mime)) {
            await openPdfViewer(d) // opens on screen; "Save / share" button inside
          } else {
            await shareBase64(d.base64, d.filename, d.mime) // other files (Excel, Word …): phone opens them via the share sheet
          }
        } catch (err) {
          if (staleChunk(err)) { location.reload(); return } // HQ was updated since this page opened
          alert(err.message)
        }
        finally { b.disabled = false }
      })
      th.querySelector('#waReplySend')?.addEventListener('click', sendReply)
      th.querySelector('#waReplyText')?.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendReply() })
    } catch (err) { th.innerHTML = `<div class="empty-state">${esc(err.message)}</div>` }
  }
  async function sendReply() {
    const ta = el.querySelector('#waReplyText'), btn = el.querySelector('#waReplySend'), err = el.querySelector('#waReplyErr')
    const text = ta.value.trim()
    if (!text) return
    btn.disabled = true; err.hidden = true
    try { await call({ action: 'reply', number: state.number, text }); ta.value = ''; await openThread(state.number); loadConvs(true) }
    catch (e) { err.textContent = e.message; err.hidden = false }
    finally { btn.disabled = false }
  }

  loadConvs().then(() => { if (number) openThread(number) })
  state.timer = setInterval(() => { if (!el.isConnected) { clearInterval(state.timer); return } loadConvs(true); if (state.number && !el.querySelector('#waReplyText')?.value) openThread(state.number) }, 20000)
  return { refresh: () => { loadConvs(); if (state.number) openThread(state.number) } }
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
