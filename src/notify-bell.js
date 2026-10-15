// Notification bell — one place that says "this is waiting for you", on every page.
//
// It reuses the sidebar's own badge counts (loadNavBadges in sidebar.js), so
// the bell and the sidebar can never disagree, and every module that adds a
// sidebar badge shows up here by itself. Only pages this person may open are
// listed (visibleNav). The bell is put into whatever .app-header the current
// page draws, so no page has to know about it.
//
// Red dot = something went UP since this person last opened the bell
// (remembered per browser); the number = everything waiting right now.
import { loadNavBadges } from './sidebar.js'
import { visibleNav } from './permissions.js'
import { esc } from './utils.js'
import { icon } from './icons.js'
import './notify-bell.css'

// What each sidebar badge means, in words. A badge missing here still shows,
// with its page name.
const MEANING = {
  openTasks: n => `task${n === 1 ? '' : 's'} assigned to you`,
  paymentFollowup: n => `payment follow-up${n === 1 ? '' : 's'} due today`,
  redAlerts: n => `red alert${n === 1 ? '' : 's'} to review`,
  myExplain: n => `question${n === 1 ? '' : 's'} waiting for your answer`,
  waUnread: n => `unread WhatsApp message${n === 1 ? '' : 's'}`,
  purchasesToday: n => `purchase bill${n === 1 ? '' : 's'} entered today`,
  emailBillsToday: n => `invoice mail${n === 1 ? '' : 's'} received today`,
  openLeads: n => `new project lead${n === 1 ? '' : 's'}`,
  pendingQuotes: n => `quotation${n === 1 ? '' : 's'} waiting for the customer`,
}
// Most urgent first.
const ORDER = ['redAlerts', 'myExplain', 'paymentFollowup', 'openTasks', 'waUnread', 'purchasesToday', 'emailBillsToday', 'openLeads', 'pendingQuotes']
// Counts that are information rather than work: listed, but not in the bell's number.
const INFO_ONLY = new Set(['purchasesToday', 'emailBillsToday', 'openLeads', 'pendingQuotes'])

const POLL_MS = 2 * 60 * 1000
let observer = null
let timer = null
let counts = {}
let open = false

function seenKey() { return 'nb.seen' }
function readSeen() {
  try { return JSON.parse(localStorage.getItem(seenKey()) || '{}') } catch { return {} }
}
function writeSeen(c) {
  try { localStorage.setItem(seenKey(), JSON.stringify(c)) } catch { /* private window */ }
}

function items() {
  const out = []
  for (const section of visibleNav()) {
    for (const item of section.items) {
      if (!item.badge) continue
      const n = Number(counts[item.badge]) || 0
      if (n > 0) out.push({ key: item.badge, n, label: item.label, hash: item.hash, icon: item.icon })
    }
  }
  const rank = k => (ORDER.includes(k) ? ORDER.indexOf(k) : 99)
  return out.sort((a, b) => rank(a.key) - rank(b.key))
}

function totals() {
  const list = items()
  const seen = readSeen()
  return {
    list,
    total: list.filter(i => !INFO_ONLY.has(i.key)).reduce((s, i) => s + i.n, 0),
    fresh: list.some(i => i.n > (Number(seen[i.key]) || 0)),
  }
}

function paint() {
  const { list, total, fresh } = totals()
  document.querySelectorAll('.nb-bell').forEach(btn => {
    const badge = btn.querySelector('.nb-count')
    badge.textContent = total > 99 ? '99+' : String(total)
    badge.hidden = !total
    btn.classList.toggle('has-new', fresh)
    btn.setAttribute('aria-label', total ? `Notifications: ${total} waiting` : 'Notifications')
  })
  const panel = document.getElementById('nbPanel')
  if (panel && open) panel.innerHTML = panelHtml(list)
}

function panelHtml(list) {
  const seen = readSeen()
  if (!list.length) return '<div class="nb-head">Notifications</div><div class="nb-empty">Nothing waiting for you. 🎉</div>'
  return `
    <div class="nb-head">Waiting for you</div>
    ${list.map(i => `
      <a class="nb-item ${INFO_ONLY.has(i.key) ? 'is-info' : ''} ${i.n > (Number(seen[i.key]) || 0) ? 'is-new' : ''}" href="${esc(i.hash || '#')}">
        <span class="nb-icon">${icon(i.icon, 16)}</span>
        <span class="nb-text"><strong>${i.n}</strong> ${esc(MEANING[i.key] ? MEANING[i.key](i.n) : i.label)}<span class="nb-page">${esc(i.label)}</span></span>
        <span class="nb-go">${icon('chevron-right', 14)}</span>
      </a>`).join('')}
  `
}

function openPanel(btn) {
  closePanel()
  open = true
  const panel = document.createElement('div')
  panel.id = 'nbPanel'
  panel.className = 'nb-panel'
  panel.setAttribute('role', 'dialog')
  panel.innerHTML = panelHtml(items())
  document.body.appendChild(panel)
  const r = btn.getBoundingClientRect()
  panel.style.top = `${Math.round(r.bottom + 8)}px`
  // Keep the panel on screen: hug the bell's right edge, never past the left edge.
  const width = Math.min(360, window.innerWidth - 16)
  const right = Math.max(8, Math.min(Math.round(window.innerWidth - r.right), window.innerWidth - width - 8))
  panel.style.right = `${right}px`
  panel.addEventListener('click', e => { if (e.target.closest('.nb-item')) closePanel() })
  // Opening the bell = "I have seen these numbers".
  writeSeen(Object.fromEntries(items().map(i => [i.key, i.n])))
  paint()
  refresh()
}

function closePanel() {
  open = false
  document.getElementById('nbPanel')?.remove()
}

function onDocClick(e) {
  const bell = e.target.closest('.nb-bell')
  if (bell) { open ? closePanel() : openPanel(bell); return }
  if (open && !e.target.closest('#nbPanel')) closePanel()
}

// Put a bell into every page header that does not have one yet. Headers end
// with a right-hand control (Refresh, etc.); the bell goes just before it.
function attach() {
  let added = false
  document.querySelectorAll('.app-header').forEach(header => {
    if (header.querySelector('.nb-bell')) return
    added = true
    // A stacked header (Stock: title row, search, filters) marks its title row
    // with data-bell-row so the bell sits beside Refresh, not under the filters.
    const h = header.querySelector('[data-bell-row]') || header
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn-ghost nb-bell'
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg><span class="nb-count" hidden></span>`
    const kids = [...h.children]
    if (kids.length >= 2) {
      const last = kids[kids.length - 1]
      const wrap = document.createElement('div')
      wrap.className = 'nb-wrap'
      h.insertBefore(wrap, last)
      wrap.appendChild(btn)
      wrap.appendChild(last)
    } else {
      btn.classList.add('nb-solo')
      h.appendChild(btn)
    }
  })
  if (added) paint()
}

export async function refresh() {
  try {
    counts = await loadNavBadges()
  } catch {
    return
  }
  paint()
}

export function startNotifyBell() {
  stopNotifyBell()
  const app = document.getElementById('app') || document.body
  observer = new MutationObserver(() => attach())
  observer.observe(app, { childList: true, subtree: true })
  document.addEventListener('click', onDocClick)
  window.addEventListener('hashchange', closePanel)
  timer = setInterval(() => { if (!document.hidden) refresh() }, POLL_MS)
  document.addEventListener('visibilitychange', onVisible)
  attach()
  refresh()
}

function onVisible() { if (!document.hidden) refresh() }

export function stopNotifyBell() {
  observer?.disconnect()
  observer = null
  clearInterval(timer)
  timer = null
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('visibilitychange', onVisible)
  window.removeEventListener('hashchange', closePanel)
  closePanel()
  counts = {}
}
