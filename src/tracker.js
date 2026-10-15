// Requests Tracker (#tracker, Admin) — every bug, addition, removal, UI change and set-up step for HQ in
// one list: search, status chips, area filter, add / edit / delete. Server: api/sync-status.js actions
// tracker-* → api/_tracker.js (table hq_requests, CRM project). Classes tr-*.
import './tracker.css'
import { supabase } from './supabase.js'
import { apiUrl } from './native.js'
import { openSidebar } from './sidebar.js'
import { esc } from './utils.js'
import { icon } from './icons.js'
import { hqConfirm } from './hq-dialog.js'

async function call(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(apiUrl('/api/sync-status'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
    body: JSON.stringify(payload),
  })
  let body = null
  try { body = await res.json() } catch { /* not JSON */ }
  if (!res.ok) throw new Error(body?.error || 'Something went wrong. Try again.')
  return body
}

const STATUS = {
  todo: ['To do', 'grey'], doing: ['Being built', 'blue'], release: ['Waiting for release', 'amb'], you: ['Waiting on you', 'red'],
  live: ['Live', 'grn'], parked: ['Parked', 'grey'], dropped: ['Dropped', 'grey'],
}
// Chips in this order; "Open" = everything not live / dropped.
const CHIPS = [['open', 'Open'], ['you', 'Waiting on you'], ['release', 'Waiting for release'], ['todo', 'To do'], ['doing', 'Being built'], ['parked', 'Parked'], ['live', 'Live'], ['dropped', 'Dropped'], ['all', 'All']]
const OPEN = new Set(['todo', 'doing', 'release', 'you', 'parked'])
const AREAS = ['HQ general', 'Look & layout', 'Phone app', 'Customer Card', 'Quotations', 'Payment Follow-up', 'GST', 'Purchase Summary', 'Orders / Warehouse', 'Stock', 'Red Alerts', 'WhatsApp', 'Invoice Portal', 'Order Plan', 'Items Management', 'Users & access', 'JCM Sync (server)']
const IST = { timeZone: 'Asia/Kolkata' }
const day = iso => iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', ...IST }) : ''

export function renderTracker(container) {
  const st = { rows: [], kinds: [], q: '', chip: 'open', area: '' }
  container.innerHTML = `
    <div class="app-layout tr-page">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="trMenu" aria-label="Menu">☰</button>
          <span class="logo-small">Requests Tracker</span>
        </div>
        <button class="btn-primary btn-small" id="trNew">${icon('plus', 14)} New request</button>
      </header>
      <main class="app-main tr-main">
        <div class="tr-tools">
          <div class="tr-search">${icon('search', 16)}<input type="search" id="trQ" placeholder="Search requests, notes, area, chat…" autocomplete="off"></div>
          <select id="trArea"><option value="">All areas</option></select>
        </div>
        <div class="tr-chips" id="trChips"></div>
        <div id="trList"><div class="loading-state">Loading…</div></div>
      </main>
    </div>`
  const $ = id => container.querySelector('#' + id)
  $('trMenu').addEventListener('click', () => openSidebar())
  $('trNew').addEventListener('click', () => edit(null))
  $('trQ').addEventListener('input', () => { st.q = $('trQ').value.trim().toLowerCase(); draw() })
  $('trArea').addEventListener('change', () => { st.area = $('trArea').value; draw() })
  $('trChips').addEventListener('click', e => { const b = e.target.closest('[data-chip]'); if (b) { st.chip = b.dataset.chip; draw() } })
  $('trList').addEventListener('click', e => {
    if (e.target.closest('#trReleased')) return markReleased()
    const r = e.target.closest('[data-id]'); if (r) edit(st.rows.find(x => x.id === Number(r.dataset.id)))
  })

  async function load() {
    try {
      const d = await call({ action: 'tracker-list' })
      st.rows = d.rows; st.kinds = d.kinds
      const areas = [...new Set([...AREAS, ...st.rows.map(r => r.area).filter(Boolean)])].sort()
      $('trArea').innerHTML = `<option value="">All areas</option>${areas.map(a => `<option ${a === st.area ? 'selected' : ''}>${esc(a)}</option>`).join('')}`
      draw()
    } catch (err) { $('trList').innerHTML = `<div class="empty-state">${esc(err.message)}</div>` }
  }

  const matchText = r => !st.q || st.q.split(/\s+/).every(w => `${r.title} ${r.detail || ''} ${r.area || ''} ${r.kind || ''} ${r.owner || ''} ${r.source || ''} ${STATUS[r.status]?.[0] || ''} #${r.id}`.toLowerCase().includes(w))
  const inChip = (r, c) => c === 'all' || (c === 'open' ? OPEN.has(r.status) : r.status === c)

  function draw() {
    const base = st.rows.filter(r => matchText(r) && (!st.area || r.area === st.area))
    $('trChips').innerHTML = CHIPS.map(([c, label]) => {
      const n = base.filter(r => inChip(r, c)).length
      return `<button type="button" class="tr-chip ${c === st.chip ? 'is-on' : ''} ${c === 'you' && n ? 'is-alert' : ''}" data-chip="${c}">${esc(label)} <span>${n}</span></button>`
    }).join('')
    const list = base.filter(r => inChip(r, st.chip))
    // Waiting on you first, then waiting for release, then the rest; newest change first inside each.
    const order = { you: 0, release: 1, doing: 2, todo: 3, parked: 4, live: 5, dropped: 6 }
    list.sort((a, b) => (order[a.status] - order[b.status]) || String(b.updated_at).localeCompare(String(a.updated_at)))
    const relN = st.rows.filter(r => r.status === 'release').length
    $('trList').innerHTML = (st.chip === 'release' && relN ? `<div class="tr-bar"><span>After a release, mark these ${relN} as Live in one go.</span><button type="button" class="btn-ghost btn-small" id="trReleased">Mark all ${relN} as Live</button></div>` : '') +
      (list.length ? `<div class="tr-list">${list.map(r => {
        const [label, tone] = STATUS[r.status] || [r.status, 'grey']
        return `<button type="button" class="tr-row tr-st-${r.status}" data-id="${r.id}">
          <span class="tr-main">
            <span class="tr-title">${esc(r.title)}</span>
            ${r.detail ? `<span class="tr-detail">${esc(r.detail)}</span>` : ''}
            <span class="tr-meta">${[r.area, r.kind, r.source].filter(Boolean).map(esc).join(' · ')}</span>
          </span>
          <span class="tr-side">
            <span class="pf-pill pf-tone-${tone}">${esc(label)}</span>
            <span class="tr-meta">${r.owner ? `${esc(r.owner)} · ` : ''}${esc(day(r.done_at || r.updated_at))}</span>
          </span>
        </button>`
      }).join('')}</div>` : `<div class="empty-state">${st.q ? 'Nothing matches your search.' : 'Nothing here.'}</div>`)
  }

  async function markReleased() {
    const n = st.rows.filter(r => r.status === 'release').length
    if (!await hqConfirm(`Mark all ${n} "Waiting for release" requests as Live?`)) return
    try { await call({ action: 'tracker-released' }); load() } catch (err) { alert(err.message) }
  }

  function edit(r) {
    const ov = document.createElement('div')
    ov.className = 'modal-overlay'
    const areas = [...new Set([...AREAS, ...st.rows.map(x => x.area).filter(Boolean)])].sort()
    ov.innerHTML = `
      <div class="modal tr-modal" role="dialog" aria-modal="true">
        <div class="modal-header"><h2>${r ? `Request #${r.id}` : 'New request'}</h2><button type="button" class="btn-ghost btn-small" data-x aria-label="Close">✕</button></div>
        <label class="tr-f">What is it<input data-f="title" maxlength="200" value="${esc(r?.title || '')}" placeholder="e.g. Ledger PDF shows wrong balance"></label>
        <label class="tr-f">Details<textarea data-f="detail" rows="4" maxlength="4000" placeholder="What happens, where, what it should do">${esc(r?.detail || '')}</textarea></label>
        <div class="tr-grid">
          <label class="tr-f">Status<select data-f="status">${Object.entries(STATUS).map(([k, [l]]) => `<option value="${k}" ${(r?.status || 'todo') === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label class="tr-f">Type<select data-f="kind">${st.kinds.map(k => `<option ${(r?.kind || 'Change') === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></label>
          <label class="tr-f">Area<input data-f="area" list="trAreas" value="${esc(r?.area || '')}" placeholder="e.g. WhatsApp"><datalist id="trAreas">${areas.map(a => `<option value="${esc(a)}">`).join('')}</datalist></label>
          <label class="tr-f">Who is on it<input data-f="owner" value="${esc(r?.owner || '')}" placeholder="Claude / Shishir / staff name"></label>
        </div>
        <label class="tr-f">Which chat<input data-f="source" value="${esc(r?.source || 'HQ Requests')}" placeholder="e.g. HQ Requests"></label>
        ${r ? `<div class="tr-meta">Added ${esc(day(r.created_at))}${r.created_by ? ` by ${esc(r.created_by)}` : ''} · last change ${esc(day(r.updated_at))}${r.updated_by ? ` by ${esc(r.updated_by)}` : ''}${r.done_at ? ` · done ${esc(day(r.done_at))}` : ''}</div>` : ''}
        <p class="cu-error" data-err hidden></p>
        <div class="tr-actions">
          ${r ? '<button type="button" class="btn-ghost btn-small tr-del" data-del>Delete</button>' : '<span></span>'}
          <span><button type="button" class="btn-ghost btn-small" data-x>Cancel</button> <button type="button" class="btn-primary btn-small" data-save>Save</button></span>
        </div>
      </div>`
    document.body.appendChild(ov)
    const close = () => ov.remove()
    const err = ov.querySelector('[data-err]')
    ov.querySelector('[data-f="title"]').focus()
    ov.addEventListener('click', async e => {
      if (e.target === ov || e.target.closest('[data-x]')) return close()
      if (e.target.closest('[data-del]')) {
        if (!await hqConfirm('Delete this request for good?')) return
        try { await call({ action: 'tracker-remove', id: r.id }); close(); load() } catch (x) { err.textContent = x.message; err.hidden = false }
        return
      }
      if (e.target.closest('[data-save]')) {
        const v = Object.fromEntries([...ov.querySelectorAll('[data-f]')].map(el => [el.dataset.f, el.value]))
        const b = e.target.closest('[data-save]'); b.disabled = true; b.textContent = 'Saving…'
        try { await call({ action: 'tracker-save', id: r?.id, ...v }); close(); load() }
        catch (x) { err.textContent = x.message; err.hidden = false; b.disabled = false; b.textContent = 'Save' }
      }
    })
  }

  load()
}
