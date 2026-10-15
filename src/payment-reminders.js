// Payment Follow-up → WhatsApp reminders (#payment-followup/reminders)
//
// Two things on this tab (2026-10-12, Meta templates — no free text any more):
//   1. Automatic daily reminders (admins): on/off, time, which tiers, cap per day. HQ runs it once
//      a day after the time (api/collections.js runDaily → runAutoReminders, asked every 15 min by
//      JCM Sync's followup-notify job). Preview shows exactly who would get one right now.
//   2. Send now: pick a group, tick parties, Send — the same approved template goes out.
// Which template: Dealer group → payment_reminder_20d / _40d, Retail group → retail_reminder_20d / _40d
// (Assign groups on the Today tab sets Dealer / Retail); red when something is over 40 days, else amber.
//
// Never sent, whatever is ticked — the server checks again:
//   • the JCM Due DND group (not even listed here) • parties flagged "check balance"
//   • nothing over 20 days, or no WhatsApp number • anyone reminded in the last 20 hours
//   • contacted (call / note / visit / reminder) in the last 6 days (over 40 d) or 13 days (over 20 d)
// Every attempt lands in that party's History on the Follow-up calls tab.
import { openSidebar } from './sidebar.js'
import { esc } from './utils.js'
import {
  callCollections as call, pfTabsHtml, syncNoteHtml, rupees, shortRupees, fmtDateTime, daysBetween, store,
} from './payment-followup.js'
import { hqConfirm } from './hq-dialog.js'
import { openBatchEditor } from './payment-schedules.js'

const BATCH = 10

const STATUS_TEXT = {
  sent: 'Sent',
  failed: 'Failed',
  no_number: 'No number',
  off: 'Switched off',
  dnd: 'DND — not sent',
  needs_review: 'Check balance — not sent',
  nothing_due: 'Nothing due — not sent',
  recent_credit: 'Nothing over 20 days',
  under_40: 'Nothing over 40 days',
  recent: 'Already reminded today',
  contacted: 'Contacted recently — skipped',
  no_dates: 'Bill dates not synced',
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
    respectGap: true,
    auto: null,          // automatic-reminder settings (admins)
    plan: null,          // preview of the automatic run
    sending: false,
    today: todayIST(),
    overDays: 20,        // 20 / 40, or 0 = any dues; not remembered: always starts at 20
    graceDays: 20,
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
              <label>Only dues over
                <select id="pfrOverdue">
                  <option value="20" selected>20 days</option><option value="40">40 days</option>
                </select>
              </label>
              <label><input type="checkbox" id="pfrGap" checked> Skip anyone contacted recently (7 / 14 days)</label>
            </div>
            <div class="pfr-bulkbar" id="pfrBulk"></div>
            <div id="pfrList" class="pfr-list"><div class="empty-state">Pick an account group above.</div></div>
          </section>

          <aside class="pfr-right">
            <section class="pfr-auto" id="pfrAuto" hidden></section>
            <div class="pfr-preview-label">What goes out</div>
            <div class="pfr-preview" id="pfrPreview"></div>
            <p class="pf-error" id="pfrError" hidden></p>
            <div class="pfr-progress" id="pfrProgress" hidden><div class="pfr-progress-bar" id="pfrProgressBar"></div><span id="pfrProgressText"></span></div>
            <div class="pfr-confirm" id="pfrConfirm" hidden></div>
            <div class="pfr-actions">
              <button class="btn-whatsapp-solid pfr-send" id="pfrSend" disabled>Send now</button>
              <button class="btn-ghost pfr-later" id="pfrLater" disabled>⏰ Schedule for later</button>
            </div>
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
  $('pfrGap').addEventListener('change', e => { state.respectGap = e.target.checked; draw() })
  $('pfrOverdue').addEventListener('change', e => {
    state.overDays = Number(e.target.value) || 0
    resetSelection(); draw()
  })
  $('pfrAuto').addEventListener('click', onAutoClick)
  $('pfrAuto').addEventListener('change', e => { if (e.target.closest('[data-auto]')) saveAuto() })
  $('pfrBulk').addEventListener('click', e => {
    const b = e.target.closest('[data-bulk]')
    if (!b || state.sending) return
    if (b.dataset.bulk === 'jump') { $('pfrSend').scrollIntoView({ behavior: 'smooth', block: 'center' }); return }
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
  $('pfrLater').addEventListener('click', async () => {
    const picked = state.parties.filter(p => state.selected.has(p.party_code))
    if (!picked.length) return
    const groupName = state.group === '__all' ? 'All groups' : state.group
    const saved = await openBatchEditor({ parties: picked, tier: state.overDays || 20, respectGap: state.respectGap, title: groupName })
    if (!saved) return
    state.selected.clear(); draw()
    $('pfrSummary').innerHTML = `<strong>Scheduled:</strong> “${esc(saved.title)}” — ${saved.parties.length} part${saved.parties.length === 1 ? 'y' : 'ies'}, ${esc(new Date(saved.send_at).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }))}. <a href="#payment-followup/scheduled">See it on the Scheduled tab →</a>`
  })

  loadMeta()
  loadList()

  // ---- Automatic daily reminders (admins) ----------------------------------
  async function loadAuto() {
    if (!state.meta?.me?.isAdmin) return
    try {
      const d = await call({ action: 'reminder-settings' })
      state.auto = d
      drawAuto()
    } catch (err) {
      $('pfrAuto').hidden = false
      $('pfrAuto').innerHTML = `<div class="pf-muted">${esc(err.message)}</div>`
    }
  }
  function drawAuto() {
    const a = state.auto
    if (!a) return
    const st = a.settings
    const el = $('pfrAuto')
    el.hidden = false
    if (!st.ready) {
      el.innerHTML = '<h3>Automatic daily reminders</h3><div class="pf-warn">Not set up yet — run the reminder-scheduler SQL in Supabase (ask in the HQ chat).</div>'
      return
    }
    const last = a.lastRun ? `Last automatic send ${esc(fmtDateTime(a.lastRun.created_at))}` : 'Never run yet'
    el.innerHTML = `
      <h3>Automatic daily reminders</h3>
      <label class="pfr-auto-row"><input type="checkbox" data-auto="on" ${st.reminders_on ? 'checked' : ''}> <strong>${st.reminders_on ? 'On' : 'Off'}</strong> — HQ sends by itself every day</label>
      <div class="pfr-auto-hint">This one picks parties <b>by itself</b> from all groups every day — it does <b>not</b> use the tick boxes on the left. To send the ticked parties at a time you choose, use <b>⏰ Schedule for later</b> below.</div>
      <div class="pfr-auto-grid">
        <label>At <input type="time" data-auto="at" value="${esc(st.reminders_at)}"></label>
        <label><input type="checkbox" data-auto="t20" ${st.reminders_tiers.includes(20) ? 'checked' : ''}> over 20 days (amber)</label>
        <label><input type="checkbox" data-auto="t40" ${st.reminders_tiers.includes(40) ? 'checked' : ''}> over 40 days (red)</label>
        <label>Max per day <input type="number" data-auto="max" min="1" max="500" value="${st.reminders_max}"></label>
      </div>
      <div class="pf-muted">Skips anyone contacted in the last ${a.contactGap[40]} days (over 40 d) or ${a.contactGap[13] ?? a.contactGap[20]} days (over 20 d), the DND group, "check balance" and anyone reminded in the last 20 h. ${last}.</div>
      <div class="pfr-auto-actions">
        <button type="button" class="btn-ghost btn-small" data-act="preview">Who gets it today?</button>
        <button type="button" class="btn-ghost btn-small" data-act="run">Run now</button>
      </div>
      <div id="pfrPlan"></div>`
  }
  async function saveAuto() {
    const el = $('pfrAuto')
    const v = sel => el.querySelector(`[data-auto="${sel}"]`)
    try {
      state.auto = await call({ action: 'reminder-settings-save',
        reminders_on: v('on').checked, reminders_at: v('at').value,
        reminders_tiers: [v('t20').checked ? 20 : null, v('t40').checked ? 40 : null].filter(Boolean),
        reminders_max: Number(v('max').value) || 150 })
      drawAuto()
    } catch (err) { showError(err.message) }
  }
  async function onAutoClick(e) {
    const b = e.target.closest('[data-act]')
    if (!b) return
    const out = $('pfrPlan')
    if (b.dataset.act === 'preview') {
      out.innerHTML = '<div class="loading-state">Working it out…</div>'
      try {
        const d = await call({ action: 'reminder-plan' })
        const skipped = Object.entries(d.skipped || {}).map(([k, n]) => `${n} ${(STATUS_TEXT[k] || k).toLowerCase()}`).join(' · ')
        out.innerHTML = `
          <div><strong>${d.parties.length}</strong> would be sent now${d.beyondCap ? ` (${d.beyondCap} more wait for tomorrow — cap ${d.max})` : ''}.${skipped ? ` Skipped: ${esc(skipped)}.` : ''}</div>
          <div class="pfr-plan-list">${d.parties.slice(0, 200).map(p => `
            <div class="pfr-plan-row"><span class="pf-pill pf-tone-${p.tone === 'red' ? 'red' : 'amb'}">${p.tone}</span> ${esc(p.party_name)} <span class="pf-muted">${esc(p.group_name || '')} · ${p.kind}</span><span class="pfr-amount">${esc(rupees(p.balance))}</span></div>`).join('')}
            ${d.parties.length > 200 ? `<div class="pf-muted">…and ${d.parties.length - 200} more</div>` : ''}</div>`
      } catch (err) { out.innerHTML = `<div class="pf-error">${esc(err.message)}</div>` }
    }
    if (b.dataset.act === 'run') {
      if (!await hqConfirm('Send today\'s automatic reminders now? This sends real WhatsApps to customers and cannot be taken back.')) return
      b.disabled = true; b.textContent = 'Sending…'
      try {
        const r = await call({ action: 'daily-now', which: 'reminders' })
        const x = r.reminders || {}
        out.innerHTML = `<div><strong>Done:</strong> ${x.sent || 0} sent · ${x.failed || 0} failed · ${x.no_number || 0} no number${x.beyondCap ? ` · ${x.beyondCap} left for tomorrow` : ''}.</div>`
        loadAuto()
      } catch (err) { out.innerHTML = `<div class="pf-error">${esc(err.message)}</div>` }
      finally { b.disabled = false; b.textContent = 'Run now' }
    }
  }

  // -------------------------------------------------------------------------
  async function loadMeta() {
    try {
      state.meta = await call({ action: 'meta' })
      state.today = state.meta.today || state.today
      state.graceDays = state.meta.graceDays || state.graceDays
      const m = state.meta
      const sendable = m.groups.filter(g => !g.dnd)
      if (state.group && state.group !== '__all' && !sendable.some(g => g.group_name === state.group)) {
        state.group = ''
        loadList()
      }
      $('pfrSync').innerHTML = syncNoteHtml(m.lastSync)
      const tabCount = document.getElementById('pfTabToday')
      if (tabCount) tabCount.textContent = m.dueMine ? ` ${m.dueMine}` : ''
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
        ${m.whatsappReady ? '' : '<div class="pf-warn">WhatsApp (Meta) is not set up yet in Vercel. You can still look at the list.</div>'}`
      drawSend()
      loadAuto()
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
    if (p.last_reminder && Date.now() - Date.parse(p.last_reminder) < 20 * 3600e3) return 'Reminded today'
    if (state.respectGap && p.latest?.created_at) {
      const red = overdueOf(p, 40) >= 1
      const gap = red ? 7 : 14
      const d = daysBetween(new Date(new Date(p.latest.created_at).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10), state.today)
      if (d < gap) return `Contacted ${d === 0 ? 'today' : `${d} d ago`}`
    }
    return null
  }
  function overdueOf(p, days) {
    const v = p.overdueBy?.[days] ?? (days === state.graceDays ? p.overdue : undefined) ?? p.balance
    return Math.min(v, p.balance)
  }

  function shown() {
    return state.parties.filter(p => p.balance >= state.minAmount && (!state.overDays || overdueOf(p, state.overDays) >= 1))
  }
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
            ${overdueOf(p, state.overDays || state.graceDays) < p.balance ? `<span class="pf-muted">${esc(rupees(overdueOf(p, state.overDays || state.graceDays)))} over ${state.overDays || state.graceDays} d</span>` : ''}
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
    $('pfrSend').textContent = state.sending ? 'Sending…' : n ? `Send now to ${n} part${n === 1 ? 'y' : 'ies'}` : 'Tick parties to send'
    $('pfrLater').disabled = !n || state.sending
    $('pfrLater').textContent = n ? `⏰ Schedule ${n} for later` : '⏰ Schedule for later'
  }

  function drawPreview() {
    const picked = state.parties.filter(x => state.selected.has(x.party_code))
    const red = picked.filter(p => overdueOf(p, 40) >= 1).length
    $('pfrPreview').innerHTML = `
      <div>The approved JCM reminder, with the <strong>QR Code</strong>, <strong>Ledger</strong> and <strong>Invoices</strong> buttons.</div>
      <div class="pf-muted">Dealer groups get the total outstanding and the overdue part; Retail groups (set in Assign groups) get one amount due. Amber banner for over 20 days, red for over 40 days — each party gets the one that fits.</div>
      ${picked.length ? `<div class="pfr-preview-count"><span class="pf-pill pf-tone-red">${red} red</span> <span class="pf-pill pf-tone-amb">${picked.length - red} amber</span></div>` : ''}`
  }

  // ---- Sending -----------------------------------------------------------
  function askConfirm() {
    const n = state.selected.size
    if (!n || state.sending) return
    const total = state.parties.filter(p => state.selected.has(p.party_code)).reduce((s, p) => s + p.balance, 0)
    $('pfrConfirm').innerHTML = `
      <p>Send the WhatsApp reminder <strong>right now</strong> to <strong>${n} part${n === 1 ? 'y' : 'ies'}</strong> (${esc(shortRupees(total))} due)? It can't be taken back. (To send later, press Cancel and use ⏰ Schedule for later.)</p>
      <div class="pf-modal-actions">
        <button class="btn-ghost btn-small" id="pfrNo">Cancel</button>
        <button class="btn-whatsapp-solid btn-small" id="pfrYes">Yes, send</button>
      </div>`
    $('pfrConfirm').hidden = false
    $('pfrSend').hidden = true; $('pfrLater').hidden = true
    $('pfrNo').addEventListener('click', () => { $('pfrConfirm').hidden = true; $('pfrSend').hidden = false; $('pfrLater').hidden = false })
    $('pfrYes').addEventListener('click', () => { $('pfrConfirm').hidden = true; $('pfrSend').hidden = false; $('pfrLater').hidden = false; sendAll() })
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
        const data = await call({ action: 'send-reminders', party_codes: codes.slice(i, i + BATCH), tier: state.overDays || 20, respect_gap: state.respectGap })
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
