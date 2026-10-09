// Payment Follow-up → WhatsApp reminders (#payment-followup/reminders)
//
// Pick an account group, tick parties, check the message, Send. Messages go
// out through Whatshub360 from the server (api/collections.js, action
// send-reminders), 10 parties per request so a progress bar can move.
//
// Never sent, whatever is ticked — and the server checks again:
//   • the JCM Due DND group (not even listed here)
//   • parties flagged "check balance" (needs_review in the dues sync)
//   • parties with nothing due, or no WhatsApp/mobile number
//   • anyone already reminded in the last 20 hours
// Every attempt lands in that party's History on the Follow-up calls tab.
import { openSidebar } from './sidebar.js'
import { esc } from './utils.js'
import {
  callCollections as call, pfTabsHtml, syncNoteHtml, rupees, shortRupees, fmtDateTime, daysBetween, store,
} from './payment-followup.js'

const BATCH = 10

const DEFAULT_TEMPLATE = `Namaste {name},

This is a gentle reminder from J.C. Mittal & Sons (JCM Retails), Ratlam. Your outstanding balance with us is {amount}.

Kindly arrange the payment at the earliest. If you have already paid, please ignore this message.

Thank you.`

const STATUS_TEXT = {
  sent: 'Sent',
  failed: 'Failed',
  no_number: 'No number',
  not_set_up: 'WhatsApp not set up',
  dnd: 'DND — not sent',
  needs_review: 'Check balance — not sent',
  nothing_due: 'Nothing due — not sent',
  recent: 'Already reminded today',
  not_found: 'Not in dues list',
}

const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)

export function renderPaymentReminders(container) {
  const state = {
    meta: null,
    group: store('pfr.group') || '',
    parties: [],
    selected: new Set(),
    results: {},          // party_code -> status from the last send
    minAmount: Number(store('pfr.min')) || 0,
    skipDays: store('pfr.skipDays') === null ? 7 : Number(store('pfr.skipDays')),
    template: store('pfr.template') || DEFAULT_TEMPLATE,
    sending: false,
    today: todayIST(),
  }

  container.innerHTML = `
    <div class="app-layout pf-page">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="pfrHamburger" aria-label="Menu">☰</button>
          <span class="logo-small">Payment Follow-up</span>
        </div>
        <button class="btn-ghost btn-small" id="pfrRefresh">Refresh</button>
      </header>
      <main class="app-main">
        ${pfTabsHtml('reminders')}
        <div id="pfrSync"></div>
        <div class="pf-note" id="pfrNote"></div>

        <div class="pfr-layout">
          <section class="pfr-left">
            <div class="pf-toolbar">
              <select id="pfrGroup" class="pf-select" aria-label="Account group"><option>Loading groups…</option></select>
            </div>
            <div class="pfr-filters">
              <label>Due at least ₹ <input id="pfrMin" type="number" min="0" step="100" inputmode="numeric"></label>
              <label>Skip if reminded in the last
                <select id="pfrSkip">
                  <option value="0">— (don't skip)</option><option value="3">3 days</option>
                  <option value="7">7 days</option><option value="15">15 days</option><option value="30">30 days</option>
                </select>
              </label>
            </div>
            <div class="pfr-bulkbar" id="pfrBulk"></div>
            <div id="pfrList" class="pfr-list"><div class="empty-state">Pick an account group above.</div></div>
          </section>

          <aside class="pfr-right">
            <label class="pf-field"><span>Message</span>
              <textarea id="pfrTemplate" rows="9" maxlength="1000"></textarea>
            </label>
            <div class="pfr-help">{name} becomes the party name, {amount} the amount due. <button type="button" class="pf-link" id="pfrReset">Use the standard message</button></div>
            <div class="pfr-preview-label">Preview</div>
            <div class="pfr-preview" id="pfrPreview"></div>
            <p class="pf-error" id="pfrError" hidden></p>
            <div class="pfr-progress" id="pfrProgress" hidden><div class="pfr-progress-bar" id="pfrProgressBar"></div><span id="pfrProgressText"></span></div>
            <div class="pfr-confirm" id="pfrConfirm" hidden></div>
            <button class="btn-whatsapp-solid pfr-send" id="pfrSend" disabled>Send WhatsApp</button>
            <div class="pfr-summary" id="pfrSummary"></div>
          </aside>
        </div>
      </main>
    </div>
  `

  const $ = id => document.getElementById(id)
  $('pfrHamburger').addEventListener('click', () => openSidebar())
  $('pfrRefresh').addEventListener('click', () => { loadMeta(); loadList() })
  $('pfrMin').value = state.minAmount || ''
  $('pfrSkip').value = String([0, 3, 7, 15, 30].includes(state.skipDays) ? state.skipDays : 7)
  $('pfrTemplate').value = state.template

  $('pfrGroup').addEventListener('change', e => {
    state.group = e.target.value
    store('pfr.group', state.group)
    loadList()
  })
  $('pfrMin').addEventListener('input', e => {
    state.minAmount = Math.max(0, Number(e.target.value) || 0)
    store('pfr.min', String(state.minAmount))
    resetSelection(); draw()
  })
  $('pfrSkip').addEventListener('change', e => {
    state.skipDays = Number(e.target.value) || 0
    store('pfr.skipDays', String(state.skipDays))
    resetSelection(); draw()
  })
  $('pfrTemplate').addEventListener('input', e => {
    state.template = e.target.value
    store('pfr.template', state.template)
    drawPreview()
  })
  $('pfrReset').addEventListener('click', () => {
    state.template = DEFAULT_TEMPLATE
    $('pfrTemplate').value = DEFAULT_TEMPLATE
    store('pfr.template', DEFAULT_TEMPLATE)
    drawPreview()
  })
  $('pfrBulk').addEventListener('click', e => {
    const b = e.target.closest('[data-bulk]')
    if (!b || state.sending) return
    if (b.dataset.bulk === 'jump') { $('pfrTemplate').closest('.pfr-right').scrollIntoView({ behavior: 'smooth', block: 'start' }); return }
    if (b.dataset.bulk === 'all') eligible().forEach(p => state.selected.add(p.party_code))
    else state.selected.clear()
    draw()
  })
  $('pfrList').addEventListener('change', e => {
    const cb = e.target.closest('input[data-code]')
    if (!cb || state.sending) return
    if (cb.checked) state.selected.add(cb.dataset.code)
    else state.selected.delete(cb.dataset.code)
    drawBulk(); drawSend(); drawPreview()
  })
  $('pfrSend').addEventListener('click', askConfirm)

  loadMeta()
  loadList()

  // -------------------------------------------------------------------------
  async function loadMeta() {
    try {
      state.meta = await call({ action: 'meta' })
      state.today = state.meta.today || state.today
      const m = state.meta
      const sendable = m.groups.filter(g => !g.dnd)
      if (state.group && state.group !== '__all' && !sendable.some(g => g.group_name === state.group)) {
        state.group = ''
        loadList()
      }
      $('pfrSync').innerHTML = syncNoteHtml(m.lastSync)
      const dnd = m.groups.find(g => g.dnd)
      const allTotal = sendable.reduce((s, g) => s + g.total, 0)
      const allCount = sendable.reduce((s, g) => s + g.parties, 0)
      const opt = g => `<option value="${esc(g.group_name)}">${esc(g.group_name)} — ${g.parties} · ${esc(shortRupees(g.total))}</option>`
      const seg = name => sendable.filter(g => g.segment === name)
      const other = sendable.filter(g => !['Retail', 'Distribution'].includes(g.segment))
      $('pfrGroup').innerHTML = `
        <option value="" ${state.group ? '' : 'selected'} disabled>Pick an account group…</option>
        <option value="__all">All groups (except DND) — ${allCount} · ${esc(shortRupees(allTotal))}</option>
        ${seg('Retail').length ? `<optgroup label="Retail">${seg('Retail').map(opt).join('')}</optgroup>` : ''}
        ${seg('Distribution').length ? `<optgroup label="Distribution">${seg('Distribution').map(opt).join('')}</optgroup>` : ''}
        ${other.length ? `<optgroup label="Other">${other.map(opt).join('')}</optgroup>` : ''}
        ${dnd ? `<option disabled>${esc(dnd.group_name)} — never sent (DND)</option>` : ''}
      `
      if (state.group) $('pfrGroup').value = state.group
      $('pfrNote').innerHTML = `
        <strong>${esc(m.dndGroup)}</strong> is never sent reminders${dnd ? ` (${dnd.parties} part${dnd.parties === 1 ? 'y' : 'ies'})` : ''}.
        Parties marked “check balance”, with nothing due or with no number are skipped too.
        ${m.whatsappReady ? '' : '<div class="pf-warn">WhatsApp sending is not set up yet — WHATSHUB_SEND_URL and WHATSHUB_VID need to be added in Vercel. You can still look at the list.</div>'}`
      drawSend()
    } catch (err) {
      $('pfrGroup').innerHTML = `<option>${esc(err.message)}</option>`
    }
  }

  async function loadList() {
    resetSelection()
    state.results = {}
    $('pfrSummary').innerHTML = ''
    if (!state.group) { state.parties = []; draw(); return }
    const ticket = Symbol('load')
    state.ticket = ticket
    $('pfrList').innerHTML = '<div class="loading-state">Loading parties…</div>'
    try {
      const data = state.group === '__all'
        ? await call({ action: 'list', view: 'all' })
        : await call({ action: 'list', view: 'group', group: state.group })
      if (state.ticket !== ticket || !container.isConnected) return
      // DND parties are never shown here at all.
      state.parties = (data.parties || []).filter(p => !p.dnd && p.balance > 0)
        .sort((a, b) => b.balance - a.balance)
      state.today = data.today || state.today
      draw()
    } catch (err) {
      if (state.ticket !== ticket || !container.isConnected) return
      $('pfrList').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`
    }
  }

  function resetSelection() { state.selected.clear() }

  // Why a party can't be ticked (null = it can).
  function blockReason(p) {
    if (p.needs_review) return 'Check balance'
    if (!p.whatsapp) return 'No number'
    if (p.last_reminder && state.skipDays > 0) {
      const d = daysBetween(new Date(new Date(p.last_reminder).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10), state.today)
      if (d < state.skipDays) return `Reminded ${d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'} ago`}`
    }
    return null
  }
  function shown() { return state.parties.filter(p => p.balance >= state.minAmount) }
  function eligible() { return shown().filter(p => !blockReason(p) && state.results[p.party_code] !== 'sent') }

  function draw() {
    drawList(); drawBulk(); drawSend(); drawPreview()
  }

  function drawList() {
    const list = shown()
    if (!state.group) { $('pfrList').innerHTML = '<div class="empty-state">Pick an account group above.</div>'; return }
    if (!list.length) { $('pfrList').innerHTML = '<div class="empty-state">No party in this group matches.</div>'; return }
    $('pfrList').innerHTML = list.map(p => {
      const reason = blockReason(p)
      const result = state.results[p.party_code]
      const ageDays = p.ageing?.oldest_unpaid_date ? daysBetween(p.ageing.oldest_unpaid_date, state.today) : null
      const resultTone = result === 'sent' ? 'grn' : result ? 'red' : ''
      return `
        <label class="pfr-row ${reason ? 'is-blocked' : ''} ${state.selected.has(p.party_code) ? 'is-picked' : ''}">
          <input type="checkbox" data-code="${esc(p.party_code)}" ${reason || state.sending || result === 'sent' ? 'disabled' : ''} ${state.selected.has(p.party_code) ? 'checked' : ''}>
          <span class="pfr-row-main">
            <span class="pfr-name">${esc(p.party_name)}</span>
            <span class="pf-muted">${p.whatsapp ? esc(p.whatsapp.replace(/(\d{5})(\d{5})/, '$1 $2')) : 'No number'}${state.group === '__all' && p.group_name ? ` · ${esc(p.group_name)}` : ''}${ageDays !== null && !(p.ageing?.older > 0) ? ` · oldest ${ageDays} d` : p.ageing?.older > 0 ? ' · has older dues' : ''}</span>
            ${p.last_reminder ? `<span class="pf-muted">Last reminder ${esc(fmtDateTime(p.last_reminder))}</span>` : ''}
          </span>
          <span class="pfr-row-side">
            <span class="pfr-amount">${esc(rupees(p.balance))}</span>
            ${result ? `<span class="pf-pill pf-tone-${resultTone}">${esc(STATUS_TEXT[result] || result)}</span>` : reason ? `<span class="pf-pill pf-tone-grey">${esc(reason)}</span>` : ''}
          </span>
        </label>`
    }).join('')
  }

  function drawBulk() {
    const list = shown()
    const elig = eligible()
    const total = list.filter(p => state.selected.has(p.party_code)).reduce((s, p) => s + p.balance, 0)
    $('pfrBulk').innerHTML = state.group ? `
      <span><strong>${state.selected.size}</strong> of ${elig.length} ticked${state.selected.size ? ` · ${esc(shortRupees(total))} due` : ''}</span>
      <span class="pfr-bulk-actions">
        <button type="button" class="pf-link" data-bulk="all">Tick all ${elig.length}</button>
        <button type="button" class="pf-link" data-bulk="none">Untick all</button>
      </span>
      <span class="pf-muted">${list.length - elig.length ? `${list.length - elig.length} can't be sent` : ''}</span>
      ${state.selected.size ? '<button type="button" class="pfr-jump" data-bulk="jump">Write message &amp; send ↓</button>' : ''}` : ''
  }

  function drawSend() {
    const n = state.selected.size
    const ready = !!state.meta?.whatsappReady
    $('pfrSend').disabled = !n || state.sending || !ready
    $('pfrSend').textContent = state.sending ? 'Sending…' : n ? `Send WhatsApp to ${n} part${n === 1 ? 'y' : 'ies'}` : 'Tick parties to send'
  }

  function fill(t, p) {
    return t.replace(/\{name\}/gi, p.party_name || '').replace(/\{amount\}/gi, rupees(p.balance)).trim()
  }

  function drawPreview() {
    const p = state.parties.find(x => state.selected.has(x.party_code)) || eligible()[0] || { party_name: 'Badshah Electric', balance: 15000 }
    $('pfrPreview').textContent = fill(state.template, p)
  }

  // ---- Sending -----------------------------------------------------------
  function askConfirm() {
    const n = state.selected.size
    if (!n || state.sending) return
    if (state.template.trim().length < 10) return showError('Write the message first.')
    const total = state.parties.filter(p => state.selected.has(p.party_code)).reduce((s, p) => s + p.balance, 0)
    $('pfrConfirm').innerHTML = `
      <p>Send this WhatsApp to <strong>${n} part${n === 1 ? 'y' : 'ies'}</strong> (${esc(shortRupees(total))} due)? It can't be taken back.</p>
      <div class="pf-modal-actions">
        <button class="btn-ghost btn-small" id="pfrNo">Cancel</button>
        <button class="btn-whatsapp-solid btn-small" id="pfrYes">Yes, send</button>
      </div>`
    $('pfrConfirm').hidden = false
    $('pfrSend').hidden = true
    $('pfrNo').addEventListener('click', () => { $('pfrConfirm').hidden = true; $('pfrSend').hidden = false })
    $('pfrYes').addEventListener('click', () => { $('pfrConfirm').hidden = true; $('pfrSend').hidden = false; sendAll() })
  }

  function showError(msg) {
    $('pfrError').textContent = msg
    $('pfrError').hidden = !msg
  }

  async function sendAll() {
    const codes = state.parties.filter(p => state.selected.has(p.party_code)).map(p => p.party_code)
    if (!codes.length) return
    showError('')
    state.sending = true
    drawSend(); drawList()
    const bar = $('pfrProgressBar')
    $('pfrProgress').hidden = false
    const counts = {}
    let done = 0
    try {
      for (let i = 0; i < codes.length; i += BATCH) {
        if (!container.isConnected) return
        $('pfrProgressText').textContent = `Sending ${Math.min(i + BATCH, codes.length)} of ${codes.length}…`
        const data = await call({ action: 'send-reminders', party_codes: codes.slice(i, i + BATCH), template: state.template })
        for (const r of data.results || []) {
          state.results[r.party_code] = r.status
          counts[r.status] = (counts[r.status] || 0) + 1
          state.selected.delete(r.party_code)
          if (r.status === 'sent') {
            const p = state.parties.find(x => x.party_code === r.party_code)
            if (p) p.last_reminder = data.sentAt
          }
        }
        done = Math.min(i + BATCH, codes.length)
        bar.style.width = `${Math.round(done / codes.length * 100)}%`
        drawList(); drawBulk()
      }
    } catch (err) {
      showError(`${err.message} — ${done} of ${codes.length} were handled before this stopped.`)
    } finally {
      state.sending = false
      $('pfrProgress').hidden = true
      bar.style.width = '0'
      drawList(); drawBulk(); drawSend()
      const parts = Object.entries(counts).map(([k, v]) => `${v} ${STATUS_TEXT[k] || k}`.toLowerCase())
      $('pfrSummary').innerHTML = parts.length
        ? `<strong>Done:</strong> ${esc(parts.join(' · '))}. Each one is in that party's History.`
        : ''
    }
  }
}
