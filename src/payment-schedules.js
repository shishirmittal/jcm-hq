// Payment Follow-up → Scheduled (#payment-followup/scheduled, 2026-10-16).
// Two kinds of cards, each with an On / Off switch:
//   • Reminder lists — made on the WhatsApp reminders tab with "⏰ Schedule for later" (or "+ New schedule"
//     here): name, date + time, repeat, parties. Tap a card to change its name, time, rules or parties
//     (tick boxes; search to add more). Send now, Delete.
//   • Customer reminders — one customer each, made from the WhatsApp Inbox (⏰ Schedule reminder). Change
//     time, Stop. They also stop by themselves when the payment shows in Busy.
// Server: api/collections.js actions batch-list / batch-save / batch-op / batch-run / inbox-sched-op /
// party-find → api/_batches.js. Sending: runBatches from the 5-minute WhatsApp tick. Classes ps-*.
import './payment-schedules.css'
import { openSidebar } from './sidebar.js'
import { esc } from './utils.js'
import { callCollections as call, pfTabsHtml, rupees, shortRupees } from './payment-followup.js'
import { hqConfirm, hqAlert } from './hq-dialog.js'

const IST = { timeZone: 'Asia/Kolkata' }
const REPEAT = [['none', 'Once'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']]
const REPEAT_TEXT = { none: 'once', daily: 'every day', weekly: 'every week', monthly: 'every month' }
const RESULT_TEXT = {
  sent: 'Sent', failed: 'Failed', no_number: 'No number', dnd: 'DND', needs_review: 'Check balance', nothing_due: 'Nothing due',
  recent_credit: 'Nothing over 20 days', under_40: 'Nothing over 40 days', recent: 'Already reminded today',
  contacted: 'Contacted recently', no_dates: 'Bill dates missing', not_found: 'Not in dues list', off: 'Switched off',
}
const when = iso => iso ? new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', ...IST }) : ''
const istParts = iso => {
  const d = new Date(Date.parse(iso) + 5.5 * 3600e3).toISOString()
  return { date: d.slice(0, 10), time: d.slice(11, 16) }
}
const tomorrow11 = () => ({ date: new Date(Date.now() + 5.5 * 3600e3 + 86400e3).toISOString().slice(0, 10), time: '11:00' })
const switchHtml = (on, attrs) => `<button type="button" class="ps-switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" ${attrs} title="${on ? 'On — tap to switch off' : 'Off — tap to switch on'}"><span></span><b>${on ? 'On' : 'Off'}</b></button>`

export function renderPaymentSchedules(container) {
  container.innerHTML = `
    <div class="app-layout pf-page">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="psMenu" aria-label="Menu">☰</button>
          <span class="logo-small">Payment Follow-up</span>
        </div>
        <button class="btn-ghost btn-small" id="psRefresh">Refresh</button>
      </header>
      <main class="app-main">
        ${pfTabsHtml('scheduled')}
        <div class="ps-head">
          <div>
            <h2 class="ps-h">Reminder lists</h2>
            <div class="pf-muted">Payment reminders that go out by themselves at the time you set. Make one from <a href="#payment-followup/reminders">WhatsApp reminders</a> (tick parties → ⏰ Schedule for later) or here.</div>
          </div>
          <button type="button" class="btn-primary btn-small" id="psNew">+ New schedule</button>
        </div>
        <div id="psBatches" class="ps-grid"><div class="loading-state">Loading…</div></div>
        <h2 class="ps-h ps-h2">Customer reminders <span class="pf-muted">— from the WhatsApp Inbox, one customer each</span></h2>
        <div id="psInbox" class="ps-grid"></div>
      </main>
    </div>`
  const $ = id => container.querySelector('#' + id)
  const state = { batches: [], inbox: [] }
  $('psMenu').addEventListener('click', () => openSidebar())
  $('psRefresh').addEventListener('click', load)
  $('psNew').addEventListener('click', async () => { if (await openBatchEditor({})) load() })

  async function load() {
    try {
      const d = await call({ action: 'batch-list' })
      if (!container.isConnected) return
      state.batches = d.batches; state.inbox = d.inbox
      draw()
    } catch (err) { $('psBatches').innerHTML = `<div class="empty-state">${esc(err.message)}</div>` }
  }

  function statusLine(b) {
    const n = b.parties.length
    if (b.status === 'sending') return `<span class="pf-pill pf-tone-amb">Sending… ${b.done} of ${n}</span>`
    if (b.status === 'done') return `<span class="pf-pill pf-tone-grn">Done</span> ${countsText(b.last_counts)}`
    const past = Date.parse(b.send_at) <= Date.now()
    return `${b.enabled ? (past ? '<span class="pf-pill pf-tone-amb">Going out now</span>' : '<span class="pf-pill pf-tone-blue">Waiting</span>') : '<span class="pf-pill pf-tone-grey">Off — will not send</span>'}${b.last_counts ? ` <span class="pf-muted">Last run ${esc(when(b.last_run_at))}: ${countsText(b.last_counts)}</span>` : ''}`
  }
  const countsText = c => c ? Object.entries(c).map(([k, v]) => `${v} ${esc((RESULT_TEXT[k] || k).toLowerCase())}`).join(' · ') : ''

  function draw() {
    $('psBatches').innerHTML = state.batches.length ? state.batches.map(b => `
      <article class="ps-card ${b.enabled ? '' : 'is-off'} ${b.status === 'done' ? 'is-done' : ''}" data-batch="${b.id}">
        <div class="ps-card-top">
          <button type="button" class="ps-title" data-open="${b.id}">${esc(b.title)}</button>
          ${b.status === 'done' ? '' : switchHtml(b.enabled, `data-toggle="${b.id}"`)}
        </div>
        <div class="ps-when">⏰ ${b.status === 'done' ? `Sent ${esc(when(b.last_run_at || b.send_at))}` : `${esc(when(b.send_at))} · ${REPEAT_TEXT[b.repeat] || b.repeat}`}</div>
        <div class="ps-meta"><b>${b.parties.length}</b> part${b.parties.length === 1 ? 'y' : 'ies'} · ${esc(shortRupees(b.total))} due · over ${b.tier} days${b.respect_gap ? ' · skips recently contacted' : ''}</div>
        <div class="ps-status">${statusLine(b)}</div>
        <div class="ps-names pf-muted">${esc(b.parties.slice(0, 4).map(p => p.name).join(', '))}${b.parties.length > 4 ? ` +${b.parties.length - 4} more` : ''}</div>
        <div class="ps-actions">
          <button type="button" class="btn-ghost btn-small" data-open="${b.id}">✎ Open / edit</button>
          ${b.status !== 'sending' ? `<button type="button" class="btn-ghost btn-small" data-now="${b.id}">${b.status === 'done' ? '↻ Send again now' : '➤ Send now'}</button>` : ''}
          ${b.status !== 'sending' ? `<button type="button" class="btn-ghost btn-small ps-danger" data-del="${b.id}">Delete</button>` : ''}
        </div>
        <div class="ps-by pf-muted">Made by ${esc(b.created_by_name || '—')}${b.updated_by && b.updated_by !== b.created_by_name ? ` · changed by ${esc(b.updated_by)}` : ''}</div>
      </article>`).join('') : '<div class="empty-state">No reminder lists yet. Tick parties on WhatsApp reminders and press ⏰ Schedule for later, or press + New schedule.</div>'

    $('psInbox').innerHTML = state.inbox.length ? state.inbox.map(s => `
      <article class="ps-card ps-card-small ${s.status === 'paused' ? 'is-off' : ''}">
        <div class="ps-card-top">
          <a class="ps-title" href="#customers/${esc(s.party_code)}">${esc(s.party_name || s.party_code)}</a>
          ${switchHtml(s.status === 'active', `data-itoggle="${s.id}"`)}
        </div>
        <div class="ps-when">⏰ ${s.next_at && !s.next_at.startsWith('9999') ? esc(when(s.next_at)) : 'sending…'} · ${REPEAT_TEXT[s.repeat] || s.repeat}</div>
        <div class="ps-meta">${s.promised_amount ? `Promised ${esc(rupees(s.promised_amount))} · ` : ''}sent ${s.sent_count} so far${s.note ? ` · “${esc(String(s.note).slice(0, 60))}”` : ''}</div>
        <div class="ps-actions">
          <button type="button" class="btn-ghost btn-small" data-iedit="${s.id}">✎ Change time</button>
          <button type="button" class="btn-ghost btn-small ps-danger" data-istop="${s.id}">Stop</button>
        </div>
        <div class="ps-by pf-muted">Set by ${esc(s.created_by_name || '—')} · stops by itself when their payment shows in Busy</div>
      </article>`).join('') : '<div class="empty-state">None. Open a chat in WhatsApp → Inbox and press ⏰ to set one.</div>'
  }

  container.addEventListener('click', async e => {
    const t = e.target.closest('button, a')
    if (!t) return
    const d = t.dataset
    try {
      if (d.toggle) {
        const b = state.batches.find(x => x.id === Number(d.toggle))
        await call({ action: 'batch-op', id: b.id, op: b.enabled ? 'off' : 'on' }); return load()
      }
      if (d.open) {
        const b = state.batches.find(x => x.id === Number(d.open))
        if (await openBatchEditor({ batch: b })) load()
        return
      }
      if (d.now) {
        const b = state.batches.find(x => x.id === Number(d.now))
        if (!await hqConfirm(`Send "${b.title}" now to ${b.parties.length} part${b.parties.length === 1 ? 'y' : 'ies'}? The usual skips still apply (DND, check balance, reminded today${b.respect_gap ? ', contacted recently' : ''}).`)) return
        t.disabled = true; t.textContent = 'Sending…'
        const r = await call({ action: 'batch-run', id: b.id, restart: b.status === 'done' })
        const left = r.run && r.run.finished ? '' : ' The rest go out within 5 minutes.'
        hqAlert(`Sent ${r.run?.sent || 0}, skipped ${r.run?.skipped || 0}${r.run?.failed ? `, failed ${r.run.failed}` : ''}.${left}`)
        return load()
      }
      if (d.del) {
        const b = state.batches.find(x => x.id === Number(d.del))
        if (!await hqConfirm(`Delete the schedule "${b.title}"? Nothing more will be sent from it.`)) return
        await call({ action: 'batch-op', id: b.id, op: 'remove' }); return load()
      }
      if (d.itoggle) {
        const s = state.inbox.find(x => x.id === Number(d.itoggle))
        await call({ action: 'inbox-sched-op', id: s.id, op: s.status === 'active' ? 'off' : 'on' }); return load()
      }
      if (d.istop) {
        const s = state.inbox.find(x => x.id === Number(d.istop))
        if (!await hqConfirm(`Stop the reminders to ${s.party_name}?`)) return
        await call({ action: 'inbox-sched-op', id: s.id, op: 'stop' }); return load()
      }
      if (d.iedit) {
        const s = state.inbox.find(x => x.id === Number(d.iedit))
        if (await openTimeEditor(s)) load()
      }
    } catch (err) { hqAlert(err.message); load() }
  })

  load()
  const timer = setInterval(() => { if (!container.isConnected) { clearInterval(timer); return } if (!document.querySelector('.modal-overlay')) load() }, 60000)
}

// Small pop-up: new date / time / repeat for one Inbox customer schedule.
function openTimeEditor(s) {
  return new Promise(resolve => {
    const p = s.next_at && !s.next_at.startsWith('9999') ? istParts(s.next_at) : tomorrow11()
    const ov = document.createElement('div')
    ov.className = 'modal-overlay'
    ov.innerHTML = `<div class="modal ps-modal ps-modal-small" role="dialog" aria-modal="true">
      <div class="modal-header"><h2>${esc(s.party_name)}</h2><button type="button" class="btn-ghost btn-small" data-x aria-label="Close">✕</button></div>
      <div class="ps-row2"><label class="ps-f">Next reminder on<input type="date" data-date value="${p.date}"></label><label class="ps-f">at<input type="time" data-time value="${p.time}"></label></div>
      <div class="ps-f">Repeat<div class="ps-seg">${REPEAT.map(([v, l]) => `<button type="button" data-rep="${v}" class="${v === s.repeat ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <p class="pf-error" data-err hidden></p>
      <div class="ps-foot"><button type="button" class="btn-ghost btn-small" data-x>Cancel</button><button type="button" class="btn-primary btn-small" data-save>Save</button></div>
    </div>`
    document.body.appendChild(ov)
    let rep = s.repeat || 'none'
    const done = v => { ov.remove(); resolve(v) }
    ov.addEventListener('click', async e => {
      if (e.target === ov || e.target.closest('[data-x]')) return done(false)
      const r = e.target.closest('[data-rep]')
      if (r) { rep = r.dataset.rep; ov.querySelectorAll('[data-rep]').forEach(b => b.classList.toggle('on', b === r)); return }
      if (e.target.closest('[data-save]')) {
        try { await call({ action: 'inbox-sched-op', id: s.id, op: 'edit', date: ov.querySelector('[data-date]').value, time: ov.querySelector('[data-time]').value, repeat: rep }); done(true) }
        catch (err) { const x = ov.querySelector('[data-err]'); x.textContent = err.message; x.hidden = false }
      }
    })
  })
}

// The editor for a reminder list — new (from ticked parties, or empty) or an existing card.
//   openBatchEditor({ batch })                               edit a card
//   openBatchEditor({ parties, tier, respectGap, title })    new, with the ticked parties
export function openBatchEditor({ batch = null, parties = null, tier = 20, respectGap = true, title = '' }) {
  return new Promise(resolve => {
    const at = batch && batch.status !== 'done' ? istParts(batch.send_at) : tomorrow11()
    const st = {
      list: (batch ? batch.parties : parties || []).map(p => ({ code: String(p.code ?? p.party_code), name: p.name ?? p.party_name, group: p.group ?? p.group_name, balance: Number(p.balance) || 0 })),
      ticked: null, repeat: batch?.repeat || 'none', results: batch?.results || {},
    }
    st.ticked = new Set(st.list.map(p => p.code))
    const ov = document.createElement('div')
    ov.className = 'modal-overlay'
    ov.innerHTML = `<div class="modal ps-modal" role="dialog" aria-modal="true">
      <div class="modal-header"><h2>${batch ? 'Edit schedule' : 'Schedule reminders for later'}</h2><button type="button" class="btn-ghost btn-small" data-x aria-label="Close">✕</button></div>
      <label class="ps-f">Name<input data-title maxlength="80" value="${esc(batch?.title || title)}" placeholder="e.g. Retail Ratlam — Monday"></label>
      <div class="ps-row2"><label class="ps-f">Send on<input type="date" data-date value="${at.date}"></label><label class="ps-f">at<input type="time" data-time value="${at.time}"></label></div>
      <div class="ps-f">Repeat<div class="ps-seg">${REPEAT.map(([v, l]) => `<button type="button" data-rep="${v}" class="${v === st.repeat ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="ps-row2">
        <label class="ps-f">Only dues over<select data-tier><option value="20" ${(batch?.tier || tier) !== 40 ? 'selected' : ''}>20 days</option><option value="40" ${(batch?.tier || tier) === 40 ? 'selected' : ''}>40 days</option></select></label>
        <label class="ps-check"><input type="checkbox" data-gap ${(batch ? batch.respect_gap : respectGap) ? 'checked' : ''}> Skip anyone contacted recently (7 / 14 days)</label>
      </div>
      <div class="ps-plist-head"><b data-count></b><span><button type="button" class="pf-link" data-all>Tick all</button> · <button type="button" class="pf-link" data-none>Untick all</button></span></div>
      <div class="ps-plist" data-plist></div>
      <div class="ps-add"><input type="search" data-q placeholder="+ Add a party — search name or Busy code" autocomplete="off"><div class="ps-results" data-results></div></div>
      <div class="pf-muted ps-note">At the time set, each ticked party gets the approved payment reminder (QR Code · Ledger · Invoices). Still skipped: DND group, “check balance”, nothing due, no number, anyone reminded in the last 20 h.</div>
      <p class="pf-error" data-err hidden></p>
      <div class="ps-foot"><button type="button" class="btn-ghost btn-small" data-x>Cancel</button><button type="button" class="btn-primary" data-save>${batch ? 'Save changes' : '⏰ Save schedule'}</button></div>
    </div>`
    document.body.appendChild(ov)
    const q = s => ov.querySelector(s)
    const done = v => { ov.remove(); resolve(v) }
    const err = m => { q('[data-err]').textContent = m; q('[data-err]').hidden = !m }
    function drawList() {
      const n = st.ticked.size, total = st.list.filter(p => st.ticked.has(p.code)).reduce((s, p) => s + p.balance, 0)
      q('[data-count]').textContent = `${n} of ${st.list.length} ticked · ${shortRupees(total)} due`
      q('[data-plist]').innerHTML = st.list.length ? st.list.map(p => {
        const r = st.results[p.code]
        return `<label class="ps-prow ${st.ticked.has(p.code) ? '' : 'is-out'}"><input type="checkbox" data-code="${esc(p.code)}" ${st.ticked.has(p.code) ? 'checked' : ''}><span class="ps-pname">${esc(p.name)}<span class="pf-muted"> · ${esc(p.group || p.code)}</span></span><span class="ps-pamt">${esc(rupees(p.balance))}</span>${r ? `<span class="pf-pill pf-tone-${r.s === 'sent' ? 'grn' : 'grey'}">${esc(RESULT_TEXT[r.s] || r.s)}</span>` : ''}</label>`
      }).join('') : '<div class="empty-state">No parties yet — search below to add.</div>'
    }
    drawList()
    let timer = null
    q('[data-q]').addEventListener('input', () => {
      clearTimeout(timer)
      timer = setTimeout(async () => {
        const v = q('[data-q]').value.trim()
        if (v.length < 2) { q('[data-results]').innerHTML = ''; return }
        try {
          const d = await call({ action: 'party-find', q: v })
          q('[data-results]').innerHTML = d.rows.map(r => `<button type="button" data-add="${esc(r.code)}" data-name="${esc(r.name)}" data-group="${esc(r.group || '')}" data-bal="${r.balance}">${st.list.some(p => p.code === r.code) ? '✓ ' : '+ '}<b>${esc(r.name)}</b><span class="pf-muted"> · ${esc(r.group || r.code)} · ${esc(rupees(r.balance))}</span></button>`).join('') || '<div class="pf-muted">No party with dues matches.</div>'
        } catch (x) { err(x.message) }
      }, 250)
    })
    ov.addEventListener('change', e => {
      const cb = e.target.closest('[data-code]')
      if (!cb) return
      if (cb.checked) st.ticked.add(cb.dataset.code); else st.ticked.delete(cb.dataset.code)
      drawList()
    })
    ov.addEventListener('click', async e => {
      if (e.target === ov || e.target.closest('[data-x]')) return done(null)
      const r = e.target.closest('[data-rep]')
      if (r) { st.repeat = r.dataset.rep; ov.querySelectorAll('[data-rep]').forEach(b => b.classList.toggle('on', b === r)); return }
      if (e.target.closest('[data-all]')) { st.list.forEach(p => st.ticked.add(p.code)); return drawList() }
      if (e.target.closest('[data-none]')) { st.ticked.clear(); return drawList() }
      const add = e.target.closest('[data-add]')
      if (add) {
        const code = add.dataset.add
        if (!st.list.some(p => p.code === code)) st.list.unshift({ code, name: add.dataset.name, group: add.dataset.group, balance: Number(add.dataset.bal) || 0 })
        st.ticked.add(code)
        q('[data-q]').value = ''; q('[data-results]').innerHTML = ''
        return drawList()
      }
      const save = e.target.closest('[data-save]')
      if (save) {
        err('')
        const codes = st.list.filter(p => st.ticked.has(p.code)).map(p => p.code)
        if (!codes.length) return err('Tick at least one party.')
        save.disabled = true
        try {
          const res = await call({
            action: 'batch-save', id: batch?.id || null, title: q('[data-title]').value, date: q('[data-date]').value, time: q('[data-time]').value,
            repeat: st.repeat, tier: Number(q('[data-tier]').value), respect_gap: q('[data-gap]').checked, party_codes: codes,
          })
          done(res.batch)
        } catch (x) { err(x.message); save.disabled = false }
      }
    })
  })
}
