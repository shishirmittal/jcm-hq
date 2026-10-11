// Sync status — what JCM Sync on JCM-Server is doing with every Busy → Supabase job.
// Server: api/sync-status.js. Classes ss-*. Refreshes every 20 s while open.
import './sync-status.css'
import { supabase } from './supabase.js'
import { apiUrl } from './native.js'
import { openSidebar } from './sidebar.js'
import { esc } from './utils.js'
import { icon } from './icons.js'

let timer = null
export function unmountSyncStatus() { clearInterval(timer); timer = null }

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

const IST = { timeZone: 'Asia/Kolkata' }
function when(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', ...IST })
  const sameDay = d.toLocaleDateString('en-IN', IST) === new Date().toLocaleDateString('en-IN', IST)
  return sameDay ? time : `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', ...IST })}, ${time}`
}
function ago(iso) {
  if (!iso) return ''
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} hr ago` : `${Math.round(h / 24)} days ago`
}
const secs = ms => ms == null ? '' : ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60000)} min`

// Late = no successful run for much longer than its timetable allows.
function lateness(j) {
  const okAt = j.last_ok_at ? Date.parse(j.last_ok_at) : 0
  const limit = j.daily_at ? 26 * 3600e3 : Math.max(3 * (Number(j.every_minutes) || 15) * 60e3, 20 * 60e3)
  return Date.now() - okAt > limit
}

function statusOf(j) {
  if (j.running) return ['run', 'Running']
  if (j.last_ok === false) return ['bad', 'Failed']
  if (!j.last_started_at) return ['idle', 'Not run yet']
  if (lateness(j)) return ['late', 'Late']
  return ['ok', 'OK']
}

export function renderSyncStatus(container) {
  unmountSyncStatus()
  container.innerHTML = `
    <div class="app-layout ss-page">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="ssMenu" aria-label="Menu">☰</button>
          <span class="logo-small">Sync status</span>
        </div>
        <button class="btn-ghost btn-small" id="ssRefresh">Refresh</button>
      </header>
      <main class="app-main ss-main">
        <div id="ssRunner"></div>
        <div id="ssJobs"><div class="loading-state">Loading…</div></div>
      </main>
    </div>`
  const $ = id => container.querySelector('#' + id)
  $('ssMenu').addEventListener('click', () => openSidebar())
  $('ssRefresh').addEventListener('click', () => load())
  const open = new Set()

  $('ssJobs').addEventListener('click', async e => {
    const run = e.target.closest('[data-run]')
    if (run) {
      run.disabled = true
      run.textContent = 'Asked…'
      try { await call({ action: 'run-now', job_id: run.dataset.run }); setTimeout(load, 4000) }
      catch (err) { run.textContent = err.message }
      return
    }
    const head = e.target.closest('[data-toggle]')
    if (head) {
      const id = head.dataset.toggle
      if (open.has(id)) open.delete(id); else open.add(id)
      const box = $('ssJobs').querySelector(`[data-runs="${id}"]`)
      box.hidden = !open.has(id)
      head.setAttribute('aria-expanded', open.has(id))
      if (open.has(id)) loadRuns(id, box)
    }
  })

  load()
  timer = setInterval(() => { if (document.visibilityState === 'visible') load() }, 20000)

  async function load() {
    let d
    try { d = await call({ action: 'list' }) } catch (err) {
      $('ssJobs').innerHTML = `<div class="ss-empty ss-bad">${esc(err.message)}</div>`
      return
    }
    if (!d.ready || !d.jobs.length) {
      $('ssRunner').innerHTML = ''
      $('ssJobs').innerHTML = `<div class="ss-empty">JCM Sync has not reported in yet. Once it runs on JCM-Server, every job shows here.</div>`
      return
    }
    const alive = d.runnerSeenAt && Date.now() - Date.parse(d.runnerSeenAt) < 15 * 60e3
    const counts = d.jobs.reduce((c, j) => { const s = statusOf(j)[0]; c[s] = (c[s] || 0) + 1; return c }, {})
    $('ssRunner').innerHTML = `
      <section class="ss-runner ${alive ? 'is-ok' : 'is-bad'}">
        <span class="ss-dot"></span>
        <div>
          <b>${alive ? 'JCM Sync is running on JCM-Server' : 'JCM Sync is not responding'}</b>
          <div class="ss-sub">${alive ? `Last check-in ${esc(ago(d.runnerSeenAt))}` : `Last heard from ${esc(d.runnerSeenAt ? ago(d.runnerSeenAt) : 'never')} — check that JCM-Server is on and the JCM Sync task is running.`}</div>
        </div>
        <div class="ss-counts">
          ${counts.ok ? `<span class="ss-pill ss-ok">${counts.ok} OK</span>` : ''}
          ${counts.run ? `<span class="ss-pill ss-run">${counts.run} running</span>` : ''}
          ${counts.late ? `<span class="ss-pill ss-late">${counts.late} late</span>` : ''}
          ${counts.bad ? `<span class="ss-pill ss-bad">${counts.bad} failed</span>` : ''}
        </div>
      </section>`
    $('ssJobs').innerHTML = `<div class="ss-list">${d.jobs.map(j => {
      const [cls, label] = statusOf(j)
      const isOpen = open.has(j.job_id)
      return `
      <section class="ss-job ss-job-${cls}">
        <div class="ss-job-top">
          <div class="ss-job-name">
            <b>${esc(j.name || j.job_id)}</b>
            <span class="ss-sub">${esc(j.schedule || '')}</span>
          </div>
          <span class="ss-pill ss-${cls}">${esc(label)}</span>
        </div>
        <div class="ss-facts">
          <span>Last run <b>${esc(when(j.last_started_at))}</b>${j.last_started_at ? ` · ${esc(ago(j.last_started_at))}` : ''}${j.last_duration_ms != null && !j.running ? ` · took ${esc(secs(j.last_duration_ms))}` : ''}</span>
          ${j.last_ok === false && j.last_ok_at ? `<span>Last OK <b>${esc(when(j.last_ok_at))}</b></span>` : ''}
        </div>
        ${j.last_message ? `<div class="ss-msg">${esc(j.last_message)}</div>` : ''}
        <div class="ss-actions">
          <button type="button" class="btn-ghost btn-small ss-hist" data-toggle="${esc(j.job_id)}" aria-expanded="${isOpen}">${icon('history', 14)} Recent runs</button>
          <button type="button" class="btn-ghost btn-small" data-run="${esc(j.job_id)}" ${j.running ? 'disabled' : ''}>${icon('send', 14)} Run now</button>
        </div>
        <div class="ss-runs" data-runs="${esc(j.job_id)}" ${isOpen ? '' : 'hidden'}><div class="ss-sub">Loading…</div></div>
      </section>`
    }).join('')}</div>`
    for (const id of open) {
      const box = $('ssJobs').querySelector(`[data-runs="${id}"]`)
      if (box) loadRuns(id, box)
    }
  }

  async function loadRuns(id, box) {
    try {
      const { runs } = await call({ action: 'runs', job_id: id })
      box.innerHTML = runs.length ? runs.map(r => `
        <details class="ss-run">
          <summary>
            <span class="ss-mini ${r.ok ? 'ss-ok' : 'ss-bad'}">${r.ok ? 'OK' : 'Failed'}</span>
            <span>${esc(when(r.started_at))}</span>
            <span class="ss-sub">${esc(r.reason || '')}${r.finished_at ? ` · ${esc(secs(Date.parse(r.finished_at) - Date.parse(r.started_at)))}` : ''}</span>
            <span class="ss-run-msg">${esc(r.message || '')}</span>
          </summary>
          ${r.output ? `<pre class="ss-out">${esc(r.output)}</pre>` : ''}
        </details>`).join('') : '<div class="ss-sub">No runs yet.</div>'
    } catch (err) { box.innerHTML = `<div class="ss-sub">${esc(err.message)}</div>` }
  }
}
