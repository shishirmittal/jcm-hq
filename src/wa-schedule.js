// "Schedule reminder" pop-up on the WhatsApp Inbox (2026-10-16). Customer (guessed from what we sent this
// number; change with search) → what they said, promised amount, first reminder date + time, repeat
// (once / daily / weekly / monthly). Saves a collection_schedules row + a Payment Follow-up note; HQ sends
// the payment-reminder template at that time and stops when their payment shows in Busy.
// Server: api/whatsapp.js actions party-search / schedule-list / schedule-save / schedule-stop.
import { esc } from './utils.js'
import { callWhatsapp as call } from './whatsapp.js'

const IST = { timeZone: 'Asia/Kolkata' }
const inr = n => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN')
const when = iso => iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', ...IST }) : ''
const tomorrowIST = () => new Date(Date.now() + 5.5 * 3600e3 + 86400e3).toISOString().slice(0, 10)
const REPEAT = [['none', 'Once'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']]
const STATE = { active: ['Active', 'grn'], paused: ['Off', 'amb'], done: ['Done', 'grey'], stopped: ['Stopped', 'grey'] }

export function scheduleChip(s) {
  return s ? `⏰ Reminder ${when(s.next_at)}${s.repeat !== 'none' ? ` · ${s.repeat}` : ''}` : ''
}

export function openScheduler({ number, code, name, onSaved }) {
  return new Promise(resolve => {
    const st = { code: code || null, party: null, schedules: [], repeat: 'none' }
    const ov = document.createElement('div')
    ov.className = 'modal-overlay'
    ov.innerHTML = `
      <div class="modal ws-modal" role="dialog" aria-modal="true">
        <div class="modal-header"><div><h2>Schedule payment reminder</h2><div class="ws-sub">WhatsApp reminder at the time you pick — stops by itself when their payment shows in Busy.</div></div><button type="button" class="btn-ghost btn-small" data-x aria-label="Close">✕</button></div>
        <div class="ws-party" data-party><div class="loading-state">Loading…</div></div>
        <div class="ws-find" data-find hidden>
          <input type="search" data-q placeholder="Search customer by name, mobile or Busy code" autocomplete="off">
          <div class="ws-results" data-results></div>
        </div>
        <label class="ws-f">What did they say?<textarea data-note rows="2" maxlength="500" placeholder="e.g. Will pay tomorrow, forgot to pay"></textarea></label>
        <div class="ws-grid">
          <label class="ws-f">Promised amount (optional)<input data-amt type="number" min="0" inputmode="numeric" placeholder="₹"></label>
          <label class="ws-f">First reminder on<input data-date type="date" value="${tomorrowIST()}"></label>
          <label class="ws-f">at<input data-time type="time" value="11:00"></label>
        </div>
        <div class="ws-f">Repeat<div class="ws-seg" data-seg>${REPEAT.map(([v, l]) => `<button type="button" data-rep="${v}" class="${v === 'none' ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="ws-hint" data-hint></div>
        <div class="ws-old" data-old></div>
        <p class="cu-error" data-err hidden></p>
        <div class="ws-actions"><button type="button" class="btn-ghost btn-small" data-x>Cancel</button><button type="button" class="btn-primary btn-small" data-save>Save schedule</button></div>
      </div>`
    document.body.appendChild(ov)
    const q = s => ov.querySelector(s)
    const done = v => { ov.remove(); resolve(v) }
    const err = m => { q('[data-err]').textContent = m; q('[data-err]').hidden = !m }

    function hint() {
      const r = st.repeat, d = q('[data-date]').value, t = q('[data-time]').value
      const first = d && t ? new Date(`${d}T${t}:00+05:30`) : null
      q('[data-hint]').textContent = first ? `First reminder ${first.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', ...IST })}${r === 'none' ? ', once' : `, then ${r === 'daily' ? 'every day' : r === 'weekly' ? 'every week' : 'every month'} at the same time`} — until their payment shows in Busy.` : ''
    }

    function drawParty() {
      const p = st.party
      q('[data-party]').innerHTML = p ? `
        <div><b>${esc(p.name)}</b> <span class="ws-sub">Busy code ${esc(p.code)}${p.group ? ` · ${esc(p.group)}` : ''}</span></div>
        <div class="ws-due">${p.due > 0 ? `Due now <b>${inr(p.due)}</b>` : 'Nothing due in Busy right now'}</div>
        <div class="ws-links"><a href="#customers/${esc(p.code)}" class="ws-link">Open customer card</a> · <button type="button" class="ws-link" data-change>Not this customer?</button></div>`
        : '<div class="ws-sub">Which customer is this? Search below.</div>'
      q('[data-find]').hidden = !!p
      q('[data-change]')?.addEventListener('click', () => { q('[data-find]').hidden = false; q('[data-q]').focus() })
      q('[data-old]').innerHTML = st.schedules.length ? `<div class="ws-sub">Earlier schedules</div>${st.schedules.slice(0, 4).map(s => {
        const [t, tone] = STATE[s.status] || [s.status, 'grey']
        return `<div class="ws-old-row"><span class="pf-pill pf-tone-${tone}">${esc(t)}</span> <span>${s.status === 'active' ? `next ${esc(when(s.next_at))}` : esc(when(s.first_at))}${s.repeat !== 'none' ? ` · ${esc(s.repeat)}` : ''} · sent ${s.sent_count}</span>${s.stop_reason ? `<span class="ws-sub"> — ${esc(s.stop_reason)}</span>` : ''}${s.status === 'active' ? ` <button type="button" class="ws-link" data-stop="${s.id}">Stop</button>` : ''}</div>`
      }).join('')}` : ''
    }

    async function loadParty(c) {
      st.code = c
      q('[data-party]').innerHTML = '<div class="loading-state">Loading…</div>'
      try { const d = await call({ action: 'schedule-list', party_code: c }); st.party = d.party; st.schedules = d.schedules } catch (e) { st.party = null; err(e.message) }
      drawParty()
    }

    let t = null
    q('[data-q]').addEventListener('input', () => {
      clearTimeout(t)
      t = setTimeout(async () => {
        const v = q('[data-q]').value.trim()
        if (v.length < 2) { q('[data-results]').innerHTML = ''; return }
        try {
          const d = await call({ action: 'party-search', q: v })
          q('[data-results]').innerHTML = d.rows.map(r => `<button type="button" data-pick="${esc(r.code)}"><b>${esc(r.name)}</b><span class="ws-sub"> · ${esc(r.code)}${r.mobile ? ` · ${esc(r.mobile)}` : ''}</span></button>`).join('') || '<div class="ws-sub">No match.</div>'
        } catch (e) { err(e.message) }
      }, 250)
    })
    ov.addEventListener('click', async e => {
      if (e.target === ov || e.target.closest('[data-x]')) return done(null)
      const pick = e.target.closest('[data-pick]')
      if (pick) { q('[data-q]').value = ''; q('[data-results]').innerHTML = ''; return loadParty(pick.dataset.pick) }
      const rep = e.target.closest('[data-rep]')
      if (rep) { st.repeat = rep.dataset.rep; ov.querySelectorAll('[data-rep]').forEach(b => b.classList.toggle('on', b === rep)); return hint() }
      const stop = e.target.closest('[data-stop]')
      if (stop) { stop.disabled = true; try { await call({ action: 'schedule-stop', id: Number(stop.dataset.stop) }); await loadParty(st.code) } catch (x) { err(x.message) } return }
      if (e.target.closest('a.ws-link')) return done(null)
      if (e.target.closest('[data-save]')) {
        if (!st.party) return err('Pick the customer first.')
        const b = e.target.closest('[data-save]'); b.disabled = true; b.textContent = 'Saving…'; err('')
        try {
          const r = await call({ action: 'schedule-save', party_code: st.party.code, number, note: q('[data-note]').value, promised_amount: q('[data-amt]').value || null, date: q('[data-date]').value, time: q('[data-time]').value, repeat: st.repeat })
          onSaved?.(r.schedule); done(r.schedule)
        } catch (x) { err(x.message); b.disabled = false; b.textContent = 'Save schedule' }
      }
    })
    q('[data-date]').addEventListener('input', hint)
    q('[data-time]').addEventListener('input', hint)
    hint()
    if (code) loadParty(code); else { st.party = null; drawParty(); q('[data-q]').value = name || ''; q('[data-q]').dispatchEvent(new Event('input')) }
  })
}
