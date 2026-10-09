// My Explanations — the staff side of Red Alerts. When an admin asks someone
// to explain an entry they made in Busy (a ₹0 bill, a bill edited after
// printing, a deletion …), it lands here and as a Task Board task. Answering
// here sends the reply back to the alert and, once every question on that
// task is answered, marks the task done.
//
// Open to every signed-in person; /api/red-alerts only ever returns the
// questions asked of the caller.
import { openSidebar, refreshNavBadges } from './sidebar.js'
import { esc, formatMoney } from './utils.js'
import { icon } from './icons.js'
import { callRedAlerts, describe, badges, TYPE_INFO, flash } from './red-alerts.js'

function fmt(s) {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) +
    ' · ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
}

export async function renderExplain(container) {
  container.innerHTML = `
    <div class="app-layout ra-page">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="exHamburgerBtn" aria-label="Menu">☰</button>
          <span class="logo-small">My Explanations</span>
        </div>
        <button class="btn-ghost btn-small" id="exRefreshBtn">Refresh</button>
      </header>
      <main class="app-main ex-main">
        <p class="ex-intro">Entries you made in Busy that the office has a question about. Please write a short explanation for each.</p>
        <div id="exList"><div class="loading-state">Loading…</div></div>
      </main>
    </div>
  `
  const $ = id => document.getElementById(id)
  $('exHamburgerBtn').addEventListener('click', () => openSidebar())
  $('exRefreshBtn').addEventListener('click', load)

  $('exList').addEventListener('submit', async e => {
    e.preventDefault()
    const form = e.target.closest('form[data-id]')
    if (!form) return
    const btn = form.querySelector('button[type="submit"]')
    btn.disabled = true
    try {
      await callRedAlerts({ action: 'reply', id: Number(form.dataset.id), reply: form.elements.reply.value })
      flash('Thank you — your explanation has been sent.')
      await load()
      refreshNavBadges()
    } catch (err) {
      flash(err.message)
      btn.disabled = false
    }
  })

  load()

  async function load() {
    const listEl = $('exList')
    if (!listEl) return
    try {
      const data = await callRedAlerts({ action: 'my-list' })
      if (!container.isConnected) return
      const all = data.alerts || []
      const waiting = all.filter(a => a.status === 'asked')
      const done = all.filter(a => a.status !== 'asked')
      if (!all.length) {
        listEl.innerHTML = `<div class="empty-state ra-empty">${icon('check', 22)}<div>No questions for you.</div></div>`
        return
      }
      listEl.innerHTML = `
        ${waiting.length ? `<h3 class="ex-heading">Waiting for your answer (${waiting.length})</h3>${waiting.map(card).join('')}` : `<div class="empty-state ra-empty">${icon('check', 22)}<div>All answered — thank you.</div></div>`}
        ${done.length ? `<h3 class="ex-heading">Answered</h3>${done.map(card).join('')}` : ''}`
    } catch (err) {
      if (container.isConnected) listEl.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`
    }
  }

  function card(a) {
    const t = TYPE_INFO[a.alert_type] || TYPE_INFO.deleted_other
    const pending = a.status === 'asked'
    return `
      <div class="ra-row ra-tone-${t.tone} ex-card${pending ? ' is-new' : ''}">
        <div class="ra-row-body">
          <div class="ra-row-top">
            <span class="ra-tag">${esc(t.label)}</span>
            <span class="ra-main">${esc(a.title || '—')}</span>
            ${badges(a)}
            ${a.amount != null && !String(a.alert_type).startsWith('zero') ? `<span class="ra-amount">${formatMoney(a.amount)}</span>` : ''}
          </div>
          <div class="ra-sub">${describe(a)}</div>
          <div class="ra-meta">${esc(fmt(a.happened_at))}${a.computer_name ? ` · on ${esc(a.computer_name)}` : ''}</div>
          <div class="ra-asked">
            <div><strong>${esc(a.asked_by || 'Office')} asked</strong> · ${esc(fmt(a.asked_at))}${a.question ? ` — “${esc(a.question)}”` : ''}</div>
            ${pending
              ? `<form class="ex-form" data-id="${a.id}">
                   <textarea name="reply" rows="2" maxlength="1000" required minlength="3" placeholder="Your explanation…"></textarea>
                   <button class="btn-primary btn-small" type="submit">${icon('send', 14)} Send</button>
                 </form>`
              : `<div class="ra-reply"><strong>Your answer</strong> · ${esc(fmt(a.replied_at))}: “${esc(a.reply || '')}”</div>`}
          </div>
        </div>
      </div>`
  }
}
