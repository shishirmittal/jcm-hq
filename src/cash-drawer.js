// Cash Drawer (#cash-drawer) — the counter's daily cash register, open on the counter PC all day.
//
// Like a POS screen: type the amount on the keypad (left, or the keyboard), click the card on the
// right (Transfer to Admin Office, COD Parcel, Transport Bill …), press Enter — saved. Cash sales and
// dues receipts are NOT typed here: they are read from Busy's cash book for Cash (Retail).
//
//   A opening (last night's counted cash) + B cash in = C cash out + D counted tonight
//
// At 8 PM a banner asks to count the drawer: Print → A4 sheet (black-and-white document look) with
// every entry and a hand-fill note-count box in the bottom-right corner → then the page asks for
// the closing balance (D) and shows whether it tallies. D carries forward as tomorrow's A.
//
// Data: /api/purchases actions cash-* (api/_cash-drawer.js), tables cash_* in the Busy project.
import { openSidebar } from './sidebar.js'
import { canSee, isAdminProfile } from './permissions.js'
import { esc } from './utils.js'
import { icon } from './icons.js'
import { hqAlert, hqConfirm, hqPrompt } from './hq-dialog.js'
import { callPurchases as call } from './purchases.js'
import { supabase } from './supabase.js'
import './cash-drawer.css'

const TAB_ID = 'cash-drawer'
const DENOMS = [500, 200, 100, 50, 20, 10]

// ---------- formatting ----------
const IST_MS = 5.5 * 3600 * 1000
const todayIST = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10)
const nowHHMM = () => new Date(Date.now() + IST_MS).toISOString().slice(11, 16)
function fmtDate(s, long = false) {
  if (!s) return ''
  const d = new Date(`${s}T00:00:00+05:30`)
  return d.toLocaleDateString('en-IN', long
    ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }
    : { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}
function fmtTime(s) {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
}
function ago(s) {
  if (!s) return 'never'
  const mins = Math.round((Date.now() - new Date(s).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const h = Math.floor(mins / 60)
  return h < 24 ? `${h} hr ${mins % 60} min ago` : fmtDate(new Date(new Date(s).getTime() + IST_MS).toISOString().slice(0, 10))
}
const r2 = n => Math.round(Number(n || 0) * 100) / 100
const money = (n, sign = false) => {
  const v = r2(n)
  const s = '₹' + Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })
  return v < 0 ? '−' + s : (sign && v > 0 ? '+' + s : s)
}
const hm = t => { // "20:00" → "8:00 PM"
  const [h, m] = String(t || '20:00').split(':').map(Number)
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}

// ---------- page ----------
export async function renderCashDrawer(container) {
  if (!canSee(TAB_ID)) {
    container.innerHTML = '<div class="empty-state">You do not have access to this page.</div>'
    setTimeout(() => { window.location.hash = '' }, 1500)
    return
  }
  const { data: { session } } = await supabase.auth.getSession()
  const myId = session?.user?.id || null
  const isAdmin = isAdminProfile()

  const state = { day: todayIST(), data: null, amount: '', mode: 'out', busy: false, seq: 0 }

  container.innerHTML = `
    <div class="app-layout pur-page cw-page">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="cwHamburgerBtn" aria-label="Menu">☰</button>
          <span class="logo-small pur-title">${icon('rupee', 18)} Cash Drawer</span>
        </div>
        <div class="pur-header-actions">
          <input type="date" id="cwDay" class="cw-dayinput" max="${todayIST()}" value="${state.day}" title="See another day">
          <button class="btn-ghost btn-small" id="cwCardsBtn" ${isAdmin ? '' : 'hidden'}>${icon('pencil', 14)} Cards</button>
          <button class="btn-ghost btn-small" id="cwRefreshBtn">${icon('refresh', 14)} Refresh</button>
          <button class="btn-primary btn-small cw-printbtn" id="cwPrintBtn">${icon('file', 14)} Print & close day</button>
        </div>
      </header>
      <main class="app-main cw-main" id="cwBody"><div class="cw-loading">Loading the drawer…</div></main>
    </div>`

  const $ = sel => container.querySelector(sel)
  $('#cwHamburgerBtn').addEventListener('click', openSidebar)
  $('#cwRefreshBtn').addEventListener('click', () => load())
  $('#cwPrintBtn').addEventListener('click', () => printAndClose())
  $('#cwCardsBtn').addEventListener('click', () => editCards())
  $('#cwDay').addEventListener('change', e => {
    state.day = e.target.value || todayIST()
    state.amount = ''
    load()
  })

  // ---------- data ----------
  async function load(quiet = false) {
    const seq = ++state.seq
    if (!quiet && !state.data) $('#cwBody').innerHTML = '<div class="cw-loading">Loading the drawer…</div>'
    try {
      const d = await call({ action: 'cash-day', day: state.day })
      if (seq !== state.seq) return
      state.data = d
      draw()
    } catch (err) {
      if (seq !== state.seq) return
      $('#cwBody').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`
    }
  }

  // ---------- drawing ----------
  function draw() {
    const d = state.data
    const body = $('#cwBody')
    if (!d.start_day) { body.innerHTML = setupHtml(); wireSetup(); return }
    const isToday = d.day === d.today
    const f = d.flows
    const A = d.opening.amount
    const closed = d.closing
    const dueBanner = isToday && !closed && nowHHMM() >= (d.print_at || '20:00')
    const busyLate = d.busy_sync?.last_ok_at && (Date.now() - new Date(d.busy_sync.last_ok_at).getTime()) > 45 * 60000

    body.innerHTML = `
      ${dueBanner ? `
        <div class="cw-banner">
          <div><strong>${esc(hm(d.print_at))} — time to count the drawer.</strong>
          <span>Print the sheet, count the notes, then type the closing balance.</span></div>
          <button class="btn-primary" data-act="print">${icon('file', 16)} Print & close day</button>
        </div>` : ''}
      ${!isToday ? `<div class="cw-pastnote">${icon('calendar', 14)} You are looking at <strong>${esc(fmtDate(d.day, true))}</strong>. New entries can only be made for today. <button class="btn-ghost btn-small" data-act="today">Back to today</button></div>` : ''}

      <section class="cw-tiles">
        <div class="cw-tile cw-a">
          <div class="cw-tile-k">A · Opening</div>
          <div class="cw-tile-v">${A == null ? '—' : money(A)}</div>
          <div class="cw-tile-s">${openingHint(d)}${isAdmin ? ` <button class="cw-link" data-act="opening">change</button>` : ''}</div>
        </div>
        <div class="cw-tile cw-b">
          <div class="cw-tile-k">B · Cash in</div>
          <div class="cw-tile-v">${money(f.totalIn)}</div>
          <div class="cw-tile-s">Busy ${money(f.busyIn)}${f.manualIn ? ` · typed ${money(f.manualIn)}` : ''}</div>
        </div>
        <div class="cw-tile cw-c">
          <div class="cw-tile-k">C · Cash out</div>
          <div class="cw-tile-v">${money(f.totalOut)}</div>
          <div class="cw-tile-s">typed ${money(f.manualOut)}${f.busyOut ? ` · Busy ${money(f.busyOut)}` : ''}</div>
        </div>
        <div class="cw-tile cw-exp">
          <div class="cw-tile-k">Should be in drawer</div>
          <div class="cw-tile-v">${d.expected == null ? '—' : money(d.expected)}</div>
          <div class="cw-tile-s">A + B − C</div>
        </div>
        ${closed ? `
        <div class="cw-tile cw-d ${Math.abs(closed.difference) < 1 ? 'is-ok' : 'is-bad'}">
          <div class="cw-tile-k">D · Counted</div>
          <div class="cw-tile-v">${money(closed.counted)}</div>
          <div class="cw-tile-s">${Math.abs(closed.difference) < 1 ? '✓ Tallied' : (closed.difference < 0 ? `Short ${money(-closed.difference)}` : `Extra ${money(closed.difference)}`)}
            · ${esc(closed.by)} ${esc(fmtTime(closed.at))}</div>
        </div>` : ''}
      </section>

      ${isToday ? `
      <section class="cw-pos">
        <div class="cw-pad">
          <div class="cw-mode">
            <button class="cw-mode-btn ${state.mode === 'out' ? 'is-on' : ''}" data-mode="out">− Cash OUT</button>
            <button class="cw-mode-btn ${state.mode === 'in' ? 'is-on' : ''}" data-mode="in">+ Cash IN</button>
          </div>
          <div class="cw-display ${state.mode === 'in' ? 'is-in' : 'is-out'}" id="cwDisplay">${displayText()}</div>
          <div class="cw-keys">
            ${['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0', 'back'].map(k =>
              `<button class="cw-key ${k === 'back' ? 'is-back' : ''}" data-key="${k}">${k === 'back' ? icon('backspace', 22) : k}</button>`).join('')}
          </div>
          <button class="cw-clear" data-key="clear">Clear</button>
          <div class="cw-padhint">Type the amount (keypad or keyboard), then click a card →</div>
        </div>
        <div class="cw-cards">
          ${cardsHtml(d)}
        </div>
      </section>` : ''}

      <section class="cw-lists">
        <div class="cw-list cw-list-out">
          <h3>Cash out <span>${money(f.totalOut)}</span></h3>
          ${outListHtml(d)}
        </div>
        <div class="cw-list cw-list-in">
          <h3>Cash in <span>${money(f.totalIn)}</span></h3>
          ${inListHtml(d)}
        </div>
      </section>

      <div class="cw-foot">
        <span class="cw-sync ${busyLate ? 'is-late' : ''}">Busy (${esc(d.account.name)}) copied ${esc(ago(d.busy_sync?.last_ok_at))}${d.busy_sync?.running ? ' · copying now…' : ''}</span>
        <button class="btn-ghost btn-small" data-act="busy-now">${icon('refresh', 13)} Get Busy entries now</button>
        ${d.printed_at ? `<span class="cw-printed">Sheet printed ${esc(fmtTime(d.printed_at))}</span>` : ''}
      </div>`
    wire()
  }

  function openingHint(d) {
    const o = d.opening
    if (o.amount == null) return 'not set'
    if (o.source === 'typed') return esc(o.note || 'typed')
    if (o.gaps && o.gaps.length) return `carried — ${o.gaps.length} day${o.gaps.length > 1 ? 's' : ''} not counted`
    return 'last night’s counted cash'
  }

  function displayText() {
    const a = state.amount
    return a ? money(Number(a)) : '<span class="cw-zero">₹0</span>'
  }

  function cardsHtml(d) {
    const cats = d.categories.filter(c => c.active && c.kind === state.mode)
    if (!cats.length) return '<div class="cw-nocards">No cards for this side yet.</div>'
    // how often each card was used today
    const used = new Map()
    for (const e of d.entries) if (!e.deleted_at) used.set(e.category_id, (used.get(e.category_id) || 0) + e.amount)
    return cats.map(c => `
      <button class="cw-card ${state.mode === 'in' ? 'is-in' : 'is-out'}" data-cat="${c.id}">
        <span class="cw-card-emoji">${esc(c.emoji || '•')}</span>
        <span class="cw-card-label">${esc(c.label)}</span>
        ${used.get(c.id) ? `<span class="cw-card-used">today ${money(used.get(c.id))}</span>` : ''}
      </button>`).join('')
  }

  function entryRow(e, d) {
    const canDel = !e.deleted_at && (isAdmin || (e.by_id === myId && d.day === d.today))
    const delBtn = canDel ? `<button class="cw-del" data-del="${e.id}" title="Remove this entry">${icon('x', 14)}</button>` : ''
    return `
      <div class="cw-row ${e.deleted_at ? 'is-deleted' : ''}">
        <span class="cw-row-time">${esc(fmtTime(e.at))}</span>
        <span class="cw-row-main">
          <strong>${esc(e.label)}</strong>${e.note ? ` — ${esc(e.note)}` : ''}
          <small>${esc(e.by)}${e.deleted_at ? ` · removed by ${esc(e.deleted_by)}: ${esc(e.delete_reason)}` : ''}</small>
        </span>
        <span class="cw-row-amt">${money(e.amount)}</span>
        ${delBtn}
      </div>`
  }
  function busyRow(r, amt) {
    return `
      <div class="cw-row is-busy">
        <span class="cw-row-time"><span class="cw-busytag">Busy</span></span>
        <span class="cw-row-main"><strong>${esc(r.type)}</strong> ${esc(r.vch_no)}${r.party ? ` — ${esc(r.party)}` : ''}</span>
        <span class="cw-row-amt">${money(amt)}</span>
      </div>`
  }
  function outListHtml(d) {
    const typed = d.entries.filter(e => e.kind === 'out')
    const busy = d.busy.filter(r => r.out)
    if (!typed.length && !busy.length) return '<div class="cw-empty">Nothing paid out yet.</div>'
    return typed.slice().reverse().map(e => entryRow(e, d)).join('') + busy.map(r => busyRow(r, r.out)).join('')
      + (busy.length ? '<div class="cw-busynote">Rows marked Busy were entered in Busy from Cash (Retail) — already counted. Don’t tap a card for them too.</div>' : '')
  }
  function inListHtml(d) {
    const typed = d.entries.filter(e => e.kind === 'in')
    const busy = d.busy.filter(r => r.in)
    if (!typed.length && !busy.length) return `<div class="cw-empty">No cash in yet. Cash bills and receipts made in Busy show here (copied every 30 min).</div>`
    return typed.slice().reverse().map(e => entryRow(e, d)).join('') + busy.map(r => busyRow(r, r.in)).join('')
  }

  // ---------- first day ----------
  function setupHtml() {
    return `
      <div class="cw-setup">
        <h2>${icon('rupee', 22)} Start the cash register</h2>
        <p>Count the cash in the drawer right now and type it below. That is today’s <strong>opening balance (A)</strong>.
        From tonight, the cash you count at closing carries forward as the next day’s opening by itself.</p>
        <div class="cw-setup-row">
          <span class="cw-rupee">₹</span>
          <input type="number" inputmode="decimal" min="0" step="1" id="cwOpenAmt" placeholder="Cash in the drawer now">
          <button class="btn-primary" id="cwOpenBtn">Start today</button>
        </div>
        <p class="cw-setup-small">Cash sales and receipts already made in Busy today (Cash (Retail)) will be added automatically.</p>
      </div>`
  }
  function wireSetup() {
    const inp = $('#cwOpenAmt')
    inp.focus()
    const go = async () => {
      const v = inp.value.trim()
      if (v === '' || Number(v) < 0) { hqAlert('Type the cash in the drawer right now.'); return }
      if (!(await hqConfirm(`Opening balance for today: ${money(v)}?`, { okText: 'Yes, start' }))) return
      try {
        await call({ action: 'cash-opening', day: todayIST(), amount: Number(v) })
        load()
      } catch (err) { hqAlert(err.message) }
    }
    $('#cwOpenBtn').addEventListener('click', go)
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') go() })
  }

  // ---------- actions ----------
  function wire() {
    const body = $('#cwBody')
    body.querySelectorAll('[data-key]').forEach(b => b.addEventListener('click', () => press(b.dataset.key)))
    body.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { state.mode = b.dataset.mode; draw() }))
    body.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => pickCard(Number(b.dataset.cat), b)))
    body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => removeEntry(b.dataset.del)))
    body.querySelector('[data-act="print"]')?.addEventListener('click', () => printAndClose())
    body.querySelector('[data-act="today"]')?.addEventListener('click', () => { state.day = todayIST(); $('#cwDay').value = state.day; load() })
    body.querySelector('[data-act="opening"]')?.addEventListener('click', () => changeOpening())
    body.querySelector('[data-act="busy-now"]')?.addEventListener('click', async e => {
      const btn = e.currentTarget
      btn.disabled = true
      try {
        await call({ action: 'cash-refresh' })
        hqAlert('Asked the office server to copy Busy now. It takes about 4–5 minutes — press Refresh after that.')
      } catch (err) { hqAlert(err.message) } finally { btn.disabled = false }
    })
  }

  function press(k) {
    if (state.data?.day !== state.data?.today) return
    let a = state.amount
    if (k === 'back') a = a.slice(0, -1)
    else if (k === 'clear') a = ''
    else if (k === '.') { if (!a.includes('.')) a = (a || '0') + '.' }
    else {
      if (a.includes('.') && a.split('.')[1].length >= 2) return
      if (a.replace('.', '').length >= 9) return
      a = (a === '0' ? '' : a) + k
      if (/^0+$/.test(a)) a = ''
    }
    state.amount = a
    const el = $('#cwDisplay')
    if (el) el.innerHTML = displayText()
  }

  async function pickCard(id, btn) {
    if (state.busy) return
    const d = state.data
    const cat = d.categories.find(c => c.id === id)
    if (!cat) return
    const amount = Number(state.amount)
    if (!(amount > 0)) {
      const el = $('#cwDisplay')
      el?.classList.remove('is-shake'); void el?.offsetWidth; el?.classList.add('is-shake')
      return
    }
    const verb = cat.kind === 'out' ? 'Paid out' : 'Cash in'
    let note = await hqPrompt(
      cat.needs_note ? 'Write what it was for (needed for this card):' : 'Note (optional) — who / what for. Press Enter to save.',
      '', { title: `${verb} ${money(amount)} — ${cat.label}`, okText: 'Save' })
    if (note === null) return
    note = note.trim()
    while (cat.needs_note && !note) {
      note = await hqPrompt('This card needs a short note. What was it for?', '', { title: `${verb} ${money(amount)} — ${cat.label}`, okText: 'Save' })
      if (note === null) return
      note = note.trim()
    }
    state.busy = true
    btn.classList.add('is-saving')
    try {
      await call({ action: 'cash-add', kind: cat.kind, category_id: cat.id, amount, note })
      state.amount = ''
      flash(`${money(amount)} · ${cat.label} saved`)
      await load(true)
    } catch (err) {
      hqAlert(err.message)
    } finally {
      state.busy = false
      btn.classList.remove('is-saving')
    }
  }

  async function removeEntry(id) {
    const e = state.data.entries.find(x => x.id === id)
    if (!e) return
    const reason = await hqPrompt(`Why remove ${money(e.amount)} · ${e.label}? (It stays on the list, struck out.)`, '', { title: 'Remove entry', okText: 'Remove' })
    if (reason === null) return
    if (!reason.trim()) { hqAlert('Write a short reason.'); return }
    try {
      await call({ action: 'cash-delete', id, reason: reason.trim() })
      load(true)
    } catch (err) { hqAlert(err.message) }
  }

  async function changeOpening() {
    const d = state.data
    const v = await hqPrompt(`Opening balance (A) for ${fmtDate(d.day)}. Only change it if last night's count was wrong.`,
      d.opening.amount == null ? '' : String(d.opening.amount), { title: 'Change opening balance', okText: 'Save' })
    if (v === null) return
    const n = Number(String(v).replace(/[₹,\s]/g, ''))
    if (!Number.isFinite(n) || n < 0) { hqAlert('Type a number.'); return }
    try {
      await call({ action: 'cash-opening', day: d.day, amount: n })
      load(true)
    } catch (err) { hqAlert(err.message) }
  }

  function flash(text) {
    const t = document.createElement('div')
    t.className = 'cw-flash'
    t.textContent = '✓ ' + text
    document.body.appendChild(t)
    setTimeout(() => t.classList.add('is-out'), 1600)
    setTimeout(() => t.remove(), 2000)
  }

  // ---------- keyboard ----------
  function onKey(e) {
    if (!document.body.contains(container) || !container.querySelector('.cw-page')) return
    if (document.querySelector('.modal-overlay')) return
    const tag = (e.target?.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (/^[0-9]$/.test(e.key)) { press(e.key); e.preventDefault() }
    else if (e.key === '.' ) { press('.'); e.preventDefault() }
    else if (e.key === 'Backspace') { press('back'); e.preventDefault() }
    else if (e.key === 'Escape' || e.key === 'Delete') { press('clear'); e.preventDefault() }
  }
  document.addEventListener('keydown', onKey)

  // quiet refresh every 2 min (picks up Busy entries + the 8 PM banner), stops when leaving the page
  const timer = setInterval(() => {
    if (!container.querySelector('.cw-page')) return stop()
    if (document.hidden || state.busy || document.querySelector('.modal-overlay')) return
    load(true)
  }, 120000)
  function stop() {
    clearInterval(timer)
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('hashchange', onHash)
  }
  function onHash() { if (!location.hash.startsWith('#cash-drawer')) stop() }
  window.addEventListener('hashchange', onHash)

  // ---------- print + close ----------
  async function printAndClose() {
    let d = state.data
    if (!d) return
    if (!d.start_day) { hqAlert('Set the opening balance first.'); return }
    // fresh numbers for the sheet
    try { d = state.data = await call({ action: 'cash-day', day: state.day }); draw() } catch { /* print what we have */ }
    const late = d.busy_sync?.last_ok_at && (Date.now() - new Date(d.busy_sync.last_ok_at).getTime()) > 35 * 60000
    if (late && d.day === d.today) {
      const go = await hqConfirm(`Busy entries were last copied ${ago(d.busy_sync.last_ok_at)}. Bills made after that are not on the sheet yet. Print anyway?`,
        { okText: 'Print anyway', cancelText: 'Wait' })
      if (!go) return
    }
    const sheet = document.createElement('div')
    sheet.className = 'print-sheet cw-sheet'
    sheet.innerHTML = sheetHtml(d)
    container.appendChild(sheet)
    const after = () => {
      sheet.remove()
      call({ action: 'cash-printed', day: d.day }).catch(() => {})
      closeDialog(d)
    }
    let done = false
    const once = () => { if (done) return; done = true; window.removeEventListener('afterprint', once); setTimeout(after, 100) }
    window.addEventListener('afterprint', once)
    setTimeout(() => { window.print(); once() }, 50)
  }

  function sheetHtml(d) {
    const f = d.flows
    const A = d.opening.amount
    const outTyped = d.entries.filter(e => e.kind === 'out' && !e.deleted_at)
    const inTyped = d.entries.filter(e => e.kind === 'in' && !e.deleted_at)
    const busyIn = d.busy.filter(r => r.in)
    const busyOut = d.busy.filter(r => r.out)
    const den = d.closing?.denominations || null
    const line = (a, b, c, amt) => `<tr><td>${a}</td><td>${b}</td><td class="sh-r">${c}</td><td class="sh-amt">${amt}</td></tr>`
    const outRows = [
      ...outTyped.map(e => line(esc(fmtTime(e.at)), `<strong>${esc(e.label)}</strong>${e.note ? ` — ${esc(e.note)}` : ''}`, esc(e.by), money(e.amount))),
      ...busyOut.map(r => line('Busy', `<strong>${esc(r.type)}</strong> ${esc(r.vch_no)}${r.party ? ` — ${esc(r.party)}` : ''}`, '', money(r.out))),
    ]
    const inRows = [
      ...busyIn.map(r => line('Busy', `<strong>${esc(r.type)}</strong> ${esc(r.vch_no)}${r.party ? ` — ${esc(r.party)}` : ''}`, '', money(r.in))),
      ...inTyped.map(e => line(esc(fmtTime(e.at)), `<strong>${esc(e.label)}</strong>${e.note ? ` — ${esc(e.note)}` : ''}`, esc(e.by), money(e.amount))),
    ]
    // totals per out card, for a quick look
    const byCard = new Map()
    for (const e of outTyped) byCard.set(e.label, (byCard.get(e.label) || 0) + e.amount)
    if (f.busyOut) byCard.set('Paid in Busy', f.busyOut)
    const denRow = v => {
      const n = den ? den[String(v)] : null
      return `<tr><td class="sh-den">${v}</td><td>×</td><td class="sh-blank">${n ? n : ''}</td><td>=</td><td class="sh-blank sh-wide">${n ? money(n * v) : ''}</td></tr>`
    }
    const counted = d.closing ? money(d.closing.counted) : ''
    const diff = d.closing ? money(d.closing.difference, true) : ''
    return `
      <div class="print-page cw-pp">
        <div class="sh-head">
          <div>
            <div class="sh-firm">J.C. MITTAL &amp; SONS</div>
            <div class="sh-sub">Cash Register · ${esc(d.account.name)}</div>
          </div>
          <div class="sh-date">
            <div class="sh-day">${esc(fmtDate(d.day, true))}</div>
            <div class="sh-sub">Printed ${esc(new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }))}</div>
          </div>
        </div>

        <table class="sh-sum">
          <tr><td>A · Opening balance (${d.opening.source === 'typed' ? 'typed in' : d.opening.gaps?.length ? 'carried — a day was not counted' : 'last night’s counted cash'})</td><td class="sh-amt">${A == null ? '' : money(A)}</td></tr>
          <tr><td>B · Cash in today (Busy ${money(f.busyIn)}${f.manualIn ? ` + typed ${money(f.manualIn)}` : ''})</td><td class="sh-amt">+ ${money(f.totalIn)}</td></tr>
          <tr><td>C · Cash out today (typed ${money(f.manualOut)}${f.busyOut ? ` + Busy ${money(f.busyOut)}` : ''})</td><td class="sh-amt">− ${money(f.totalOut)}</td></tr>
          <tr class="sh-total"><td>Should be in the drawer (A + B − C)</td><td class="sh-amt">${d.expected == null ? '' : money(d.expected)}</td></tr>
        </table>

        <div class="sh-cols">
          <div>
            <h4>C · Cash out — ${money(f.totalOut)}</h4>
            <table class="sh-tab">${outRows.join('') || '<tr><td colspan="4">Nothing paid out.</td></tr>'}</table>
            ${byCard.size ? `<table class="sh-tab sh-bycard">${[...byCard].map(([k, v]) => `<tr><td>${esc(k)}</td><td class="sh-amt">${money(v)}</td></tr>`).join('')}</table>` : ''}
          </div>
          <div>
            <h4>B · Cash in — ${money(f.totalIn)}</h4>
            <table class="sh-tab">${inRows.join('') || '<tr><td colspan="4">No cash in.</td></tr>'}</table>
          </div>
        </div>

        <div class="sh-bottom">
          <div class="sh-sign">
            <div>A + B = C + D</div>
            <div class="sh-sigline">Counted by</div>
            <div class="sh-sigline">Checked by</div>
          </div>
          <div class="sh-count">
            <div class="sh-count-h">Note count (D)</div>
            <table>
              ${DENOMS.map(denRow).join('')}
              <tr><td class="sh-den">Coins</td><td></td><td></td><td>=</td><td class="sh-blank sh-wide">${den?.coins ? money(den.coins) : ''}</td></tr>
              <tr class="sh-ctot"><td colspan="4">Total counted (D)</td><td class="sh-blank sh-wide">${counted}</td></tr>
              <tr><td colspan="4">Should be (A + B − C)</td><td class="sh-wide sh-r">${d.expected == null ? '' : money(d.expected)}</td></tr>
              <tr class="sh-ctot"><td colspan="4">Short (−) / Extra (+)</td><td class="sh-blank sh-wide">${diff}</td></tr>
            </table>
          </div>
        </div>
      </div>`
  }

  // the closing-balance pop-up that follows the print
  function closeDialog(d) {
    const ov = document.createElement('div')
    ov.className = 'modal-overlay cw-close-ov'
    const prev = d.closing
    ov.innerHTML = `
      <div class="cw-close" role="dialog" aria-modal="true">
        <div class="cw-close-h">
          <div>
            <div class="cw-close-t">Closing balance · ${esc(fmtDate(d.day))}</div>
            <div class="cw-close-s">Count the drawer and type what is there. Notes are optional — they add up for you.</div>
          </div>
          <button class="cw-close-x" aria-label="Close">${icon('x', 18)}</button>
        </div>
        <div class="cw-close-grid">
          ${DENOMS.map(v => `
            <label class="cw-den"><span>₹${v} ×</span>
              <input type="number" min="0" step="1" inputmode="numeric" data-den="${v}" value="${prev?.denominations?.[v] || ''}">
              <em data-den-amt="${v}"></em></label>`).join('')}
          <label class="cw-den"><span>Coins ₹</span>
            <input type="number" min="0" step="1" inputmode="numeric" data-den="coins" value="${prev?.denominations?.coins || ''}">
            <em></em></label>
        </div>
        <label class="cw-total-l">Total cash counted (D)
          <div class="cw-total-row"><span>₹</span><input type="number" min="0" step="1" inputmode="decimal" id="cwCounted" value="${prev ? prev.counted : ''}"></div>
        </label>
        <div class="cw-check" id="cwCheck"></div>
        <label class="cw-note-l">Note (optional)<input type="text" id="cwCloseNote" maxlength="300" value="${esc(prev?.note || '')}" placeholder="e.g. ₹500 short — checking with Ruchir"></label>
        <div class="cw-close-a">
          <button class="hq-dlg-btn hq-dlg-cancel" data-x>Later</button>
          <button class="hq-dlg-btn hq-dlg-ok" id="cwSaveClose">Save closing balance</button>
        </div>
      </div>`
    document.body.appendChild(ov)
    const q = s => ov.querySelector(s)
    const counted = q('#cwCounted')
    let typedByHand = !!prev && !prev.denominations
    const expected = d.expected
    const sumDen = () => {
      let t = 0, any = false
      ov.querySelectorAll('[data-den]').forEach(i => {
        const n = Number(i.value || 0)
        if (n > 0) any = true
        const k = i.dataset.den
        const amt = k === 'coins' ? n : n * Number(k)
        t += amt
        const em = ov.querySelector(`[data-den-amt="${k}"]`)
        if (em) em.textContent = n > 0 ? money(amt) : ''
      })
      return { t: r2(t), any }
    }
    const showCheck = () => {
      const v = counted.value === '' ? null : Number(counted.value)
      const el = q('#cwCheck')
      if (v == null || expected == null) { el.innerHTML = expected == null ? '' : `Should be in drawer: <strong>${money(expected)}</strong>`; el.className = 'cw-check'; return }
      const diff = r2(v - expected)
      el.className = 'cw-check ' + (Math.abs(diff) < 1 ? 'is-ok' : 'is-bad')
      el.innerHTML = `Should be <strong>${money(expected)}</strong> · counted <strong>${money(v)}</strong> → ${Math.abs(diff) < 1 ? '<strong>✓ Tallied</strong>' : (diff < 0 ? `<strong>Short ${money(-diff)}</strong>` : `<strong>Extra ${money(diff)}</strong>`)}`
    }
    ov.querySelectorAll('[data-den]').forEach(i => i.addEventListener('input', () => {
      const { t, any } = sumDen()
      if (any || !typedByHand) { counted.value = any ? String(t) : ''; typedByHand = false }
      showCheck()
    }))
    counted.addEventListener('input', () => { typedByHand = true; showCheck() })
    sumDen(); showCheck()
    const close = () => ov.remove()
    q('.cw-close-x').addEventListener('click', close)
    q('[data-x]').addEventListener('click', close)
    ov.addEventListener('click', e => { if (e.target === ov) close() })
    setTimeout(() => (prev ? counted : ov.querySelector('[data-den="500"]')).focus(), 30)
    q('#cwSaveClose').addEventListener('click', async () => {
      if (counted.value === '') { hqAlert('Type the total cash counted.'); return }
      const den = {}
      ov.querySelectorAll('[data-den]').forEach(i => { if (Number(i.value) > 0) den[i.dataset.den] = Number(i.value) })
      const btn = q('#cwSaveClose')
      btn.disabled = true
      try {
        const r = await call({ action: 'cash-close', day: d.day, counted: Number(counted.value), denominations: den, note: q('#cwCloseNote').value })
        close()
        const ok = Math.abs(r.difference) < 1
        await hqAlert(ok
          ? `Tallied. ${money(r.counted)} in the drawer — this is tomorrow's opening balance.`
          : `${r.difference < 0 ? 'Short' : 'Extra'} by ${money(Math.abs(r.difference))}. Should be ${money(r.expected)}, counted ${money(r.counted)}. Saved — ${money(r.counted)} carries forward as tomorrow's opening.`,
          { title: ok ? '✓ Cash tallied' : 'Cash does not tally' })
        load(true)
      } catch (err) {
        btn.disabled = false
        hqAlert(err.message)
      }
    })
  }

  // ---------- cards editor (admins) ----------
  function editCards() {
    const d = state.data
    if (!d) return
    const ov = document.createElement('div')
    ov.className = 'modal-overlay cw-close-ov'
    const rowHtml = c => `
      <div class="cw-cat" data-id="${c.id || ''}">
        <input class="cw-cat-emoji" value="${esc(c.emoji || '')}" maxlength="4" placeholder="🙂">
        <input class="cw-cat-label" value="${esc(c.label || '')}" maxlength="40" placeholder="Card name">
        <select class="cw-cat-kind"><option value="out" ${c.kind !== 'in' ? 'selected' : ''}>Cash out</option><option value="in" ${c.kind === 'in' ? 'selected' : ''}>Cash in</option></select>
        <input class="cw-cat-sort" type="number" value="${c.sort ?? 100}" title="Order (small first)">
        <label title="Ask for a note every time"><input type="checkbox" class="cw-cat-note" ${c.needs_note ? 'checked' : ''}> note</label>
        <label title="Show this card"><input type="checkbox" class="cw-cat-on" ${c.active !== false ? 'checked' : ''}> show</label>
      </div>`
    ov.innerHTML = `
      <div class="cw-close cw-cats" role="dialog" aria-modal="true">
        <div class="cw-close-h">
          <div><div class="cw-close-t">Cards on the Cash Drawer</div>
          <div class="cw-close-s">Rename, reorder (small number first), hide, or add a card. Old entries keep their name.</div></div>
          <button class="cw-close-x" aria-label="Close">${icon('x', 18)}</button>
        </div>
        <div class="cw-cat-list">${d.categories.map(rowHtml).join('')}</div>
        <button class="btn-ghost btn-small" id="cwAddCat">${icon('plus', 14)} Add a card</button>
        <div class="cw-close-a">
          <button class="hq-dlg-btn hq-dlg-cancel" data-x>Cancel</button>
          <button class="hq-dlg-btn hq-dlg-ok" id="cwSaveCats">Save cards</button>
        </div>
      </div>`
    document.body.appendChild(ov)
    const close = () => ov.remove()
    ov.querySelector('.cw-close-x').addEventListener('click', close)
    ov.querySelector('[data-x]').addEventListener('click', close)
    ov.querySelector('#cwAddCat').addEventListener('click', () => {
      ov.querySelector('.cw-cat-list').insertAdjacentHTML('beforeend', rowHtml({ kind: state.mode, sort: 100, active: true }))
      ov.querySelector('.cw-cat-list .cw-cat:last-child .cw-cat-label').focus()
    })
    ov.querySelector('#cwSaveCats').addEventListener('click', async () => {
      const btn = ov.querySelector('#cwSaveCats')
      btn.disabled = true
      try {
        for (const row of ov.querySelectorAll('.cw-cat')) {
          const id = row.dataset.id ? Number(row.dataset.id) : null
          const next = {
            label: row.querySelector('.cw-cat-label').value.trim(),
            emoji: row.querySelector('.cw-cat-emoji').value.trim(),
            kind: row.querySelector('.cw-cat-kind').value,
            sort: Number(row.querySelector('.cw-cat-sort').value || 100),
            needs_note: row.querySelector('.cw-cat-note').checked,
            active: row.querySelector('.cw-cat-on').checked,
          }
          if (!next.label) continue
          const old = id ? d.categories.find(c => c.id === id) : null
          const same = old && old.label === next.label && (old.emoji || '') === next.emoji && old.kind === next.kind
            && old.sort === next.sort && old.needs_note === next.needs_note && old.active === next.active
          if (same) continue
          await call({ action: 'cash-cat-save', id, ...next })
        }
        close()
        load(true)
      } catch (err) {
        btn.disabled = false
        hqAlert(err.message)
      }
    })
  }

  await load()
}
