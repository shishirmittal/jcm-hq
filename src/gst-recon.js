// GSTR-2A Reconciliation — Busy purchases vs the 2A data Busy downloaded through its GSP,
// party-wise, one month at a time, showing ONLY the red flags:
//   Missing in Busy · Not in 2A · Amount mismatch · Doc no. mismatch · Sequence · ₹0 value
// Data: gst_2a_rows / gst_purchase_rows / gst_parties (JCM-Busysql project), filled every
// 30 minutes by busy-sync/sync-gst.js on JCM-Server; the matching is done by /api/gst.
// Actions: Download Excel (all tabs), WhatsApp reminder to a supplier that has not filed,
// "Send to admins" (the missing-in-Busy list by WhatsApp + email), Done / Ignore per row.
import { supabase } from './supabase.js'
import { openSidebar } from './sidebar.js'
import { canSee } from './permissions.js'
import { apiUrl } from './native.js'
import { esc } from './utils.js'
import { icon } from './icons.js'
import * as XLSX from 'xlsx'
import './gst-recon.css'

const TAB_ID = 'gst-recon'

async function call(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(apiUrl('/api/gst'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
    body: JSON.stringify(payload),
  })
  let body = null
  try { body = await res.json() } catch { /* empty or non-JSON answer */ }
  if (!res.ok) throw new Error(body?.error || 'Something went wrong. Try again.')
  return body
}

// ---------- formatting ----------
function fmtDate(s) {
  if (!s) return ''
  const d = new Date(String(s).length === 10 ? `${s}T00:00:00+05:30` : s)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}
function fmtWhen(s) {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
}
function ago(s) {
  if (!s) return 'never'
  const mins = Math.round((Date.now() - new Date(s).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const h = Math.round(mins / 60)
  return h < 48 ? `${h} hr ago` : fmtDate(s)
}
const monthName = m => new Date(`${m}-01T00:00:00+05:30`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })
const money = n => {
  const v = Math.round(Number(n || 0) * 100) / 100
  return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })
}
const signed = n => (Number(n) > 0 ? '+' : '') + money(n)

const BUCKETS = [
  { id: 'missing_busy', label: 'Missing in Busy', short: 'Missing in Busy', tone: 'red', hint: 'In the GST portal (2A) but not entered in Busy — get these bills to the accountant.' },
  { id: 'not_in_2a', label: 'Not in 2A', short: 'Not in 2A', tone: 'red', hint: 'Booked in Busy but the supplier has not filed it in GSTR-1 — send a WhatsApp reminder.' },
  { id: 'amount', label: 'Amount mismatch', short: 'Amount', tone: 'amber', hint: 'Same invoice both sides, but taxable or tax differs by more than ₹1.' },
  { id: 'docno', label: 'Doc no. mismatch', short: 'Doc no.', tone: 'amber', hint: 'Same invoice both sides (amounts match), invoice number written differently. Low priority.' },
  { id: 'sequence', label: 'Sequence', short: 'Sequence', tone: 'quiet', hint: 'Odd invoice numbers from a supplier as booked in Busy: duplicates, a later bill with a smaller number, or gaps (suppliers bill other customers too, so gaps are normal).' },
  { id: 'zero', label: '₹0 value', short: '₹0', tone: 'quiet', hint: 'Purchase vouchers of ₹0 in Busy — FOC, replacement or scheme documents.' },
]

const STATUS_WORD = { sent: 'sent', failed: 'failed', no_number: 'no number', not_set_up: 'WhatsApp not set up' }

// ---------- page ----------
export async function renderGstRecon(container) {
  if (!canSee(TAB_ID)) {
    container.innerHTML = '<div class="empty-state">You do not have access to this page.</div>'
    setTimeout(() => { window.location.hash = '' }, 1500)
    return
  }

  const state = { month: null, months: [], data: null, tab: 'missing_busy', showMarked: false, loading: false, log: null, seq: 0 }

  container.innerHTML = `
    <div class="app-layout gst-page">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="gstHamburgerBtn" aria-label="Menu">☰</button>
          <span class="logo-small gst-title">${icon('file', 18)} GSTR-2A Reconciliation</span>
        </div>
        <div class="gst-header-actions">
          <button class="btn-ghost btn-small" id="gstExcelBtn">${icon('clipboard', 14)} Download Excel</button>
          <button class="btn-ghost btn-small" id="gstAdminBtn">${icon('send', 14)} Send to admins</button>
          <button class="btn-ghost btn-small" id="gstRefreshBtn">Refresh</button>
        </div>
      </header>
      <main class="app-main">
        <div class="gst-toolbar">
          <label class="gst-month"><span>Month</span><select id="gstMonth" class="gst-select"></select></label>
          <span class="gst-sync" id="gstSync"></span>
          <label class="gst-check"><input type="checkbox" id="gstShowMarked" /> Show done / ignored</label>
        </div>
        <div class="gst-warn" id="gstWarn" hidden></div>
        <div class="gst-tiles" id="gstTiles"></div>
        <p class="gst-hint" id="gstHint"></p>
        <div id="gstList"><div class="loading-state">Loading…</div></div>
        <div class="gst-logbar"><button class="gst-link" id="gstLogBtn">What was sent for this month</button></div>
        <div id="gstLog" hidden></div>
      </main>

      <div class="gst-drawer-backdrop" id="gstDrawerBackdrop" hidden></div>
      <aside class="gst-drawer" id="gstDrawer" hidden aria-label="WhatsApp reminder">
        <div class="gst-drawer-head">
          <strong id="gstDrawerTitle">WhatsApp reminder</strong>
          <button class="btn-ghost btn-small" id="gstDrawerClose" aria-label="Close">${icon('x', 16)}</button>
        </div>
        <div id="gstDrawerBody"></div>
      </aside>
    </div>
  `
  const $ = id => document.getElementById(id)
  $('gstHamburgerBtn').addEventListener('click', () => openSidebar())
  $('gstRefreshBtn').addEventListener('click', () => load())
  $('gstMonth').addEventListener('change', e => { state.month = e.target.value; load() })
  $('gstShowMarked').addEventListener('change', e => { state.showMarked = e.target.checked; paintList() })
  $('gstExcelBtn').addEventListener('click', () => downloadExcel())
  $('gstAdminBtn').addEventListener('click', () => sendToAdmins())
  $('gstLogBtn').addEventListener('click', () => toggleLog())
  $('gstDrawerClose').addEventListener('click', closeDrawer)
  $('gstDrawerBackdrop').addEventListener('click', closeDrawer)

  // ---- load
  async function load() {
    const seq = ++state.seq
    state.loading = true
    $('gstList').innerHTML = '<div class="loading-state">Matching Busy against the 2A data…</div>'
    try {
      const data = await call({ action: 'recon', month: state.month })
      if (seq !== state.seq) return
      state.data = data
      state.month = data.month
      state.months = data.months
      paintToolbar()
      paintTiles()
      paintList()
      if (!$('gstLog').hidden) loadLog()
    } catch (err) {
      if (seq !== state.seq) return
      $('gstList').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`
    } finally { state.loading = false }
  }

  function paintToolbar() {
    const d = state.data
    const sel = $('gstMonth')
    sel.innerHTML = d.months.length
      ? d.months.map(m => `<option value="${m}"${m === d.month ? ' selected' : ''}>${esc(monthName(m))}</option>`).join('')
      : '<option value="">No data yet</option>'
    $('gstSync').innerHTML = d.lastSyncAt
      ? `${icon('history', 12)} Busy data synced ${esc(ago(d.lastSyncAt))} · 2A last downloaded in Busy ${d.pulledAt ? esc(fmtWhen(d.pulledAt)) : '<b>never</b>'}`
      : 'Nothing synced yet — run sync-gst.js on JCM-Server'
    // Warn when the newest 2A download in Busy is older than the end of the chosen month.
    const warn = $('gstWarn')
    if (d.month && d.pulledAt) {
      const [y, mo] = d.month.split('-').map(Number)
      const monthEnd = new Date(Date.UTC(y, mo, 1) - 5.5 * 3600e3) // first instant of the next month, IST
      if (new Date(d.pulledAt) < monthEnd) {
        warn.hidden = false
        warn.textContent = `The 2A data in Busy was last downloaded on ${fmtWhen(d.pulledAt)}, before ${monthName(d.month)} ended. Download it again in Busy (GST → Miscellaneous Utilities → Download GSTR JSON Data), wait for the next sync, then refresh.`
      } else warn.hidden = true
    } else if (d.month && !d.pulledAt) {
      warn.hidden = false
      warn.textContent = 'No 2A data has been downloaded into Busy yet (GST → Miscellaneous Utilities → Download GSTR JSON Data).'
    } else warn.hidden = true
  }

  function paintTiles() {
    const d = state.data
    $('gstTiles').innerHTML = BUCKETS.map(b => `
      <button class="gst-tile tone-${b.tone}${state.tab === b.id ? ' active' : ''}" data-tab="${b.id}">
        <div class="gst-tile-value">${d.counts[b.id] || 0}</div>
        <div class="gst-tile-label">${esc(b.label)}</div>
        <div class="gst-tile-sub">${d.counts[b.id] ? esc(money(d.totals[b.id])) : '—'}</div>
      </button>`).join('') + `
      <div class="gst-tile tone-ok"><div class="gst-tile-value">${d.matchedOk}</div><div class="gst-tile-label">Matched OK</div><div class="gst-tile-sub">no action</div></div>`
    $('gstTiles').querySelectorAll('[data-tab]').forEach(el => el.addEventListener('click', () => { state.tab = el.dataset.tab; paintTiles(); paintList() }))
  }

  // ---- list
  function rowsFor(tab, includeMarked = state.showMarked) {
    return (state.data?.rows || []).filter(r => r.bucket === tab && (includeMarked || !r.mark))
  }
  function groupByParty(rows) {
    const m = new Map()
    for (const r of rows) { const k = `${r.gstin}|${r.party || ''}`; if (!m.has(k)) m.set(k, []); m.get(k).push(r) }
    return [...m.entries()].sort((a, b) => (a[1][0].party || '').localeCompare(b[1][0].party || ''))
  }

  function paintList() {
    const d = state.data
    if (!d) return
    const b = BUCKETS.find(x => x.id === state.tab)
    $('gstHint').textContent = b.hint
    const rows = rowsFor(state.tab)
    if (!rows.length) {
      $('gstList').innerHTML = `<div class="empty-state">Nothing in "${esc(b.label)}" for ${esc(monthName(d.month))}.${state.showMarked ? '' : ' (Done / ignored rows are hidden.)'}</div>`
      return
    }
    const groups = groupByParty(rows)
    $('gstList').innerHTML = `<div class="gst-list">${groups.map(([, list]) => partyCard(list)).join('')}</div>`
    $('gstList').querySelectorAll('[data-mark]').forEach(el => el.addEventListener('click', onMark))
    $('gstList').querySelectorAll('[data-remind]').forEach(el => el.addEventListener('click', () => openRemind(el.dataset.remind)))
  }

  function partyCard(list) {
    const r0 = list[0]
    const tab = state.tab
    const total = list.reduce((s, r) => s + (tab === 'missing_busy' ? r.p_total : tab === 'amount' ? Math.abs(r.diff_taxable) + Math.abs(r.diff_tax) : r.b_total || 0), 0)
    const contact = state.data.contacts[r0.gstin]
    const number = contact?.whatsapp || contact?.mobile
    const remind = tab === 'not_in_2a'
      ? `<button class="btn-ghost btn-small gst-remind" data-remind="${esc(r0.gstin)}">${icon('message', 13)} WhatsApp reminder${number ? '' : ' (no number)'}</button>` : ''
    return `
      <section class="gst-party tone-${BUCKETS.find(x => x.id === tab).tone}">
        <div class="gst-party-head">
          <div class="gst-party-main">
            <div class="gst-party-name">${esc(r0.party || r0.gstin)}${r0.new_party ? ' <span class="gst-flag gst-flag-bad">Not in Busy party master</span>' : ''}</div>
            <div class="gst-party-sub">${esc(r0.gstin)}${contact?.station ? ` · ${esc(contact.station)}` : ''}${number ? ` · ${esc(String(number))}` : ''}</div>
          </div>
          <div class="gst-party-side">
            <span class="gst-party-total">${list.length} ${list.length === 1 ? 'bill' : 'bills'} · ${esc(money(total))}</span>
            ${remind}
          </div>
        </div>
        <div class="gst-table-wrap">${table(tab, list)}</div>
      </section>`
  }

  const th = (t, r) => `<th${r ? ' class="gst-r"' : ''}>${t}</th>`
  const td = (t, r) => `<td${r ? ' class="gst-r"' : ''}>${t}</td>`
  function markCell(r) {
    const m = r.mark
    if (m) return td(`<span class="gst-flag gst-flag-${m.state === 'done' ? 'ok' : 'quiet'}" title="${esc(m.note || '')} — ${esc(m.by || '')}, ${esc(fmtDate(m.at))}">${m.state === 'done' ? 'Done' : 'Ignored'}</span> <button class="gst-link" data-mark="" data-key="${esc(r.row_key)}">undo</button>`)
    return td(`<button class="gst-link" data-mark="done" data-key="${esc(r.row_key)}">Done</button> · <button class="gst-link" data-mark="ignored" data-key="${esc(r.row_key)}">Ignore</button>`)
  }
  function table(tab, list) {
    let head = '', body = ''
    if (tab === 'missing_busy') {
      head = th('Invoice (2A)') + th('Date') + th('Taxable', 1) + th('Tax', 1) + th('Total', 1) + th('Filed in') + th('')
      body = list.map(r => `<tr${r.mark ? ' class="is-marked"' : ''}>${td(esc(r.p_no))}${td(esc(fmtDate(r.p_date)))}${td(money(r.p_taxable), 1)}${td(money(r.p_tax), 1)}${td(`<b>${money(r.p_total)}</b>`, 1)}${td(esc(r.filed_period || ''))}${markCell(r)}</tr>`).join('')
    } else if (tab === 'not_in_2a') {
      head = th('Bill (Busy)') + th('Date') + th('Taxable', 1) + th('Tax', 1) + th('Total', 1) + th('Entered by') + th('')
      body = list.map(r => `<tr${r.mark ? ' class="is-marked"' : ''}>${td(esc(r.b_no))}${td(esc(fmtDate(r.b_date)))}${td(money(r.b_taxable), 1)}${td(money(r.b_tax), 1)}${td(`<b>${money(r.b_total)}</b>`, 1)}${td(esc(r.entered_by || ''))}${markCell(r)}</tr>`).join('')
    } else if (tab === 'amount') {
      head = th('Invoice') + th('Date') + th('2A taxable', 1) + th('Busy taxable', 1) + th('Diff', 1) + th('2A tax', 1) + th('Busy tax', 1) + th('Diff', 1) + th('')
      body = list.map(r => `<tr${r.mark ? ' class="is-marked"' : ''}>${td(esc(r.p_no) + (r.note ? `<br><small>${esc(r.note)}</small>` : ''))}${td(esc(fmtDate(r.p_date || r.b_date)))}${td(money(r.p_taxable), 1)}${td(money(r.b_taxable), 1)}${td(`<b class="${Math.abs(r.diff_taxable) > 1 ? 'gst-bad' : ''}">${signed(r.diff_taxable)}</b>`, 1)}${td(money(r.p_tax), 1)}${td(money(r.b_tax), 1)}${td(`<b class="${Math.abs(r.diff_tax) > 1 ? 'gst-bad' : ''}">${signed(r.diff_tax)}</b>`, 1)}${markCell(r)}</tr>`).join('')
    } else if (tab === 'docno') {
      head = th('In 2A') + th('In Busy') + th('Date') + th('Taxable', 1) + th('Tax', 1) + th('Note') + th('')
      body = list.map(r => `<tr${r.mark ? ' class="is-marked"' : ''}>${td(esc(r.p_no))}${td(esc(r.b_no))}${td(esc(fmtDate(r.p_date || r.b_date)))}${td(money(r.p_taxable), 1)}${td(money(r.p_tax), 1)}${td(`<small>${esc(r.note || '')}</small>`)}${markCell(r)}</tr>`).join('')
    } else if (tab === 'sequence') {
      head = th('Bill (Busy)') + th('Date') + th('Total', 1) + th('Issue') + th('')
      body = list.map(r => `<tr${r.mark ? ' class="is-marked"' : ''}>${td(esc(r.b_no))}${td(esc(fmtDate(r.b_date)))}${td(money(r.b_total), 1)}${td(`<span class="gst-flag gst-flag-${r.kind === 'gap' ? 'quiet' : 'bad'}">${esc(r.kind)}</span> <small>${esc(r.note || '')}</small>`)}${markCell(r)}</tr>`).join('')
    } else {
      head = th('Bill (Busy)') + th('Date') + th('Series') + th('Entered by') + th('')
      body = list.map(r => `<tr${r.mark ? ' class="is-marked"' : ''}>${td(esc(r.b_no))}${td(esc(fmtDate(r.b_date)))}${td(esc((r.note || '').replace(/^Series /, '')))}${td(esc(r.entered_by || ''))}${markCell(r)}</tr>`).join('')
    }
    return `<table class="gst-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
  }

  // ---- marks
  async function onMark(e) {
    const el = e.currentTarget
    const key = el.dataset.key, st = el.dataset.mark
    const row = state.data.rows.find(r => r.bucket === state.tab && r.row_key === key)
    if (!row) return
    let note = ''
    if (st) {
      note = window.prompt(st === 'done' ? 'Mark as done. Any note? (optional)' : 'Ignore this row. Why? (optional)', '')
      if (note === null) return
    }
    el.disabled = true
    try {
      await call({ action: 'mark', month: state.month, bucket: state.tab, row_key: key, state: st, note })
      if (st) row.mark = { state: st, note, by: 'you', at: new Date().toISOString() }
      else delete row.mark
      recount(); paintTiles(); paintList()
    } catch (err) { flash(err.message); el.disabled = false }
  }
  function recount() {
    const d = state.data
    for (const b of BUCKETS) { d.counts[b.id] = 0; d.totals[b.id] = 0 }
    for (const r of d.rows) {
      if (r.mark) continue
      d.counts[r.bucket]++
      d.totals[r.bucket] += r.bucket === 'missing_busy' ? r.p_total : r.bucket === 'amount' ? Math.abs(r.diff_taxable) + Math.abs(r.diff_tax) : r.b_total || 0
    }
  }

  // ---- supplier reminder
  const DEFAULT_MESSAGE =
    'Namaste {name},\n\nJ.C. Mittal & Sons (JCM Retails), Ratlam — GSTIN 23AAPFJ0607D1ZT.\n' +
    'Our GSTR-2A for {month} does not show these invoices of yours:\n{list}\n' +
    'Please check your GSTR-1 and file / amend it so that we can claim the input credit. Thank you.'
  function openRemind(gstin) {
    const rows = rowsFor('not_in_2a', false).filter(r => r.gstin === gstin)
    if (!rows.length) return flash('Nothing to remind about for this party.')
    const contact = state.data.contacts[gstin]
    const number = contact?.whatsapp || contact?.mobile
    const saved = localStorage.getItem('gst-remind-message') || DEFAULT_MESSAGE
    $('gstDrawerTitle').textContent = `WhatsApp — ${rows[0].party || gstin}`
    $('gstDrawerBody').innerHTML = `
      <p class="gst-hint">To <b>${number ? esc(String(number)) : '— no mobile in Busy party master —'}</b>${contact?.name ? ` (${esc(contact.name)})` : ''}. The number comes from Busy; change it there if it is wrong.</p>
      <div class="gst-pick">${rows.map(r => `<label><input type="checkbox" checked data-key="${esc(r.row_key)}" /> ${esc(r.b_no)} · ${esc(fmtDate(r.b_date))} · ${esc(money(r.b_total))}</label>`).join('')}</div>
      <p class="gst-hint">Message — {name}, {month} and {list} are filled in automatically:</p>
      <textarea id="gstMsg" class="gst-textarea" rows="9">${esc(saved)}</textarea>
      <div class="gst-drawer-actions">
        <button class="btn-ghost btn-small" id="gstMsgReset">Reset message</button>
        <button class="btn-primary btn-small" id="gstSendRemind" ${number ? '' : 'disabled'}>${icon('send', 13)} Send WhatsApp</button>
      </div>`
    $('gstDrawer').hidden = false; $('gstDrawerBackdrop').hidden = false
    $('gstMsgReset').addEventListener('click', () => { $('gstMsg').value = DEFAULT_MESSAGE })
    $('gstSendRemind').addEventListener('click', async e => {
      const keys = [...$('gstDrawerBody').querySelectorAll('input[data-key]:checked')].map(i => i.dataset.key)
      if (!keys.length) return flash('Tick at least one bill.')
      const message = $('gstMsg').value
      localStorage.setItem('gst-remind-message', message)
      e.currentTarget.disabled = true
      try {
        const r = await call({ action: 'remind-party', month: state.month, gstin, row_keys: keys, message })
        flash(r.status === 'sent' ? `Sent to ${r.name} (${r.number}) for ${r.count} bill(s).` : `Not sent: ${STATUS_WORD[r.status] || r.status}.`)
        if (r.status === 'sent') closeDrawer()
      } catch (err) { flash(err.message) } finally { e.currentTarget && (e.currentTarget.disabled = false) }
    })
  }
  function closeDrawer() { $('gstDrawer').hidden = true; $('gstDrawerBackdrop').hidden = true }

  // ---- admins
  async function sendToAdmins() {
    const n = rowsFor('missing_busy', false).length
    if (!n) return flash('Nothing is missing in Busy for this month.')
    if (!window.confirm(`Send the ${n} "missing in Busy" invoice(s) for ${monthName(state.month)} to every admin by WhatsApp and email?`)) return
    $('gstAdminBtn').disabled = true
    try {
      const r = await call({ action: 'notify-admins', month: state.month })
      flash(r.results.map(x => `${x.channel === 'email' ? 'Email' : x.name}: ${STATUS_WORD[x.status] || x.status}`).join(' · '))
      if (!$('gstLog').hidden) loadLog()
    } catch (err) { flash(err.message) } finally { $('gstAdminBtn').disabled = false }
  }

  // ---- log
  async function toggleLog() {
    const box = $('gstLog')
    box.hidden = !box.hidden
    if (!box.hidden) loadLog()
  }
  async function loadLog() {
    const box = $('gstLog')
    box.innerHTML = '<div class="loading-state">Loading…</div>'
    try {
      const { rows } = await call({ action: 'log', month: state.month })
      box.innerHTML = rows.length
        ? `<table class="gst-table gst-logtable"><thead><tr><th>When</th><th>What</th><th>To</th><th>Result</th><th>By</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(fmtWhen(r.sent_at))}</td><td>${esc(r.kind === 'party_reminder' ? `Supplier reminder (${r.gstin || ''})` : `Admin list by ${r.channel}`)}<br><small>${esc(r.detail || '')}</small></td><td>${esc(r.recipient || '—')}</td><td><span class="gst-flag gst-flag-${r.status === 'sent' ? 'ok' : 'bad'}">${esc(STATUS_WORD[r.status] || r.status)}</span></td><td>${esc(r.by_name || '')}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty-state">Nothing sent for this month yet.</div>'
    } catch (err) { box.innerHTML = `<div class="empty-state">${esc(err.message)}</div>` }
  }

  // ---- Excel: one sheet per red-flag type, only mismatches
  function downloadExcel() {
    const d = state.data
    if (!d || !d.month) return
    const wb = XLSX.utils.book_new()
    const summary = BUCKETS.map(b => ({ 'Red flag': b.label, Count: d.counts[b.id] || 0, Amount: d.totals[b.id] || 0, What: b.hint }))
    summary.push({ 'Red flag': 'Matched OK', Count: d.matchedOk, Amount: '', What: 'Invoices found on both sides with matching amounts' })
    const ws0 = XLSX.utils.json_to_sheet(summary)
    XLSX.utils.sheet_add_aoa(ws0, [[`GSTR-2A reconciliation — ${monthName(d.month)}`], [`Busy data synced ${fmtWhen(d.lastSyncAt)} · 2A downloaded in Busy ${d.pulledAt ? fmtWhen(d.pulledAt) : 'never'}`], []], { origin: 'A1' })
    XLSX.utils.sheet_add_json(ws0, summary, { origin: 'A4' })
    ws0['!cols'] = [{ wch: 18 }, { wch: 8 }, { wch: 14 }, { wch: 90 }]
    XLSX.utils.book_append_sheet(wb, ws0, 'Summary')
    for (const b of BUCKETS) {
      const rows = rowsFor(b.id, true).map(r => sheetRow(b.id, r))
      const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Party: '(none)' }])
      ws['!cols'] = Object.keys(rows[0] || { Party: 1 }).map(k => ({ wch: /GSTIN/.test(k) ? 17 : /Party|Issue|Note/.test(k) ? 36 : 14 }))
      XLSX.utils.book_append_sheet(wb, ws, b.short.replace(/[^\w ₹.]/g, '').slice(0, 30))
    }
    XLSX.writeFile(wb, `GSTR2A_Recon_${d.month}.xlsx`)
  }
  function sheetRow(tab, r) {
    const base = { Party: r.party || '', GSTIN: r.gstin || '' }
    const mark = r.mark ? `${r.mark.state}${r.mark.note ? ': ' + r.mark.note : ''}` : ''
    if (tab === 'missing_busy') return { ...base, Party: r.party || (r.new_party ? '(not in Busy party master)' : r.gstin), 'Invoice (2A)': r.p_no, Date: r.p_date, Taxable: r.p_taxable, Tax: r.p_tax, Total: r.p_total, 'Filed in': r.filed_period || '', 'Supplier filed on': r.supplier_filed_on || '', Status: mark }
    if (tab === 'not_in_2a') return { ...base, 'Bill (Busy)': r.b_no, Date: r.b_date, Taxable: r.b_taxable, Tax: r.b_tax, Total: r.b_total, 'Entered by': r.entered_by || '', Status: mark }
    if (tab === 'amount') return { ...base, Invoice: r.p_no, 'Busy bill': r.b_no, Date: r.p_date || r.b_date, '2A taxable': r.p_taxable, 'Busy taxable': r.b_taxable, 'Taxable diff': r.diff_taxable, '2A tax': r.p_tax, 'Busy tax': r.b_tax, 'Tax diff': r.diff_tax, Note: r.note || '', Status: mark }
    if (tab === 'docno') return { ...base, 'In 2A': r.p_no, 'In Busy': r.b_no, Date: r.p_date || r.b_date, Taxable: r.p_taxable, Tax: r.p_tax, Note: r.note || '', Status: mark }
    if (tab === 'sequence') return { ...base, 'Bill (Busy)': r.b_no, Date: r.b_date, Total: r.b_total, Kind: r.kind, Issue: r.note || '', Status: mark }
    return { ...base, 'Bill (Busy)': r.b_no, Date: r.b_date, Series: (r.note || '').replace(/^Series /, ''), 'Entered by': r.entered_by || '', Status: mark }
  }

  load()
}

function flash(message) {
  document.querySelectorAll('.app-notice').forEach(el => el.remove())
  const el = document.createElement('div')
  el.className = 'app-notice'
  el.setAttribute('role', 'status')
  el.textContent = message
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 5000)
}
