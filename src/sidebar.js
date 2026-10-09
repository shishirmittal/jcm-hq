import { supabase } from './supabase.js'
import { loadRedAlertsBadge, loadMyExplainBadge } from './red-alerts.js'
import { esc } from './utils.js'
import { icon } from './icons.js'
import { visibleNav } from './permissions.js'
import { isDarkMode, toggleTheme } from './theme.js'
import logoUrl from './assets/jcm-logo.png'

const AVATAR_COLORS = ['#2563eb', '#7c3aed', '#0f9d6c', '#d97706', '#dc2626', '#0891b2', '#db2777']

export function avatarColor(seed) {
  let hash = 0
  for (const ch of String(seed)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

// Same badge counts feed both the pinned sidebar (mounted once per session)
// and the mobile drawer (opened fresh on every hamburger tap) — each just
// calls this itself rather than sharing a cache, consistent with how the
// rest of the app re-fetches small counts per-mount instead of caching them.
// openLeads/pendingQuotes intentionally reuse the exact same status
// definitions as the Dashboard's own "New leads this week" priority tile and
// "Pending Quotations" KPI, so the same number never reads two different
// ways in two different places.
// openTasks is deliberately "open AND assigned to me", not every open task on
// the board: the badge is a nudge about the viewer's own pendency, and the
// Task Board's header already carries the per-person counts for everyone
// else. getSession() (local, cached) rather than getUser() (a round-trip to
// the auth server) — this runs on every sidebar mount.
async function loadNavBadges() {
  const { data: { session } } = await supabase.auth.getSession()
  const myId = session?.user?.id
  const [{ count: openLeads }, { count: pendingQuotes }, { count: openTasks }, redAlerts, myExplain] = await Promise.all([
    supabase.from('projects').select('id', { count: 'exact', head: true }).eq('status', 'New Lead'),
    supabase.from('projects').select('id', { count: 'exact', head: true }).eq('status', 'Quotation Given'),
    myId
      ? supabase.from('team_tasks').select('id', { count: 'exact', head: true }).eq('status', 'open').eq('assigned_to', myId)
      : Promise.resolve({ count: 0 }),
    // Red Alerts lives behind /api/red-alerts (its tables are closed to the
    // browser); loadRedAlertsBadge asks only when this person can open the page.
    loadRedAlertsBadge(),
    loadMyExplainBadge(),
  ])
  return { openLeads: openLeads || 0, pendingQuotes: pendingQuotes || 0, openTasks: openTasks || 0, redAlerts: redAlerts || 0, myExplain: myExplain || 0 }
}

// The single markup source for BOTH the desktop rail and the mobile drawer —
// same NAV_CONFIG, same classes, same icons, so there is no second nav tree
// to keep in sync. What each user may see is decided in one place
// (permissions.js), and visibleNav() has already dropped both the items they
// cannot see and any section left empty by that — so a user's DOM never
// contains a tab they were not granted, rather than hiding it with CSS.
function renderNavHtml() {
  return visibleNav().map(section => {
    return `
      <div class="nav-section">${esc(section.section)}</div>
      ${section.items.map(item => `
          <button type="button" class="nav-row" data-hash="${esc(item.hash)}" title="${esc(item.label)}">
            <span class="nav-row-icon">${icon(item.icon, 18)}</span>
            <span class="nav-row-label">${esc(item.label)}</span>
            ${item.badge ? `<span class="nav-badge" data-badge="${esc(item.badge)}" hidden>0</span>` : ''}
          </button>
        `).join('')}
    `
  }).join('')
}

// Counts are painted into the placeholder spans above rather than
// re-rendering the nav. Re-rendering meant rebuilding the markup and
// re-attaching every click handler a second time once the counts landed —
// a lot of ceremony for two numbers, duplicated at both mount sites.
function paintNavBadges(root, badges) {
  root.querySelectorAll('.nav-badge[data-badge]').forEach(el => {
    const count = badges[el.dataset.badge] || 0
    el.hidden = count === 0
    el.textContent = count > 99 ? '99+' : String(count)
  })
}

// For a page that changes one of the counted things while it's on screen
// (the Task Board marking a task done, say) — without this the rail sits on
// a stale number right beside the live screen that just changed it.
// Repaints whichever nav trees are mounted; a no-op when none are.
export async function refreshNavBadges() {
  const navs = document.querySelectorAll('.pinned-nav, .sidebar-menu')
  if (!navs.length) return
  const badges = await loadNavBadges()
  navs.forEach(nav => paintNavBadges(nav, badges))
}

// Shared dark-mode switch markup/wiring -- same control, same behavior,
// wherever it's rendered (the pinned rail and the mobile drawer each mount
// their own copy, since they're two separate DOM trees).
function themeToggleHtml(idPrefix) {
  const dark = isDarkMode()
  return `
    <button type="button" class="theme-toggle${dark ? ' on' : ''}" id="${idPrefix}ThemeToggle" role="switch" aria-checked="${dark}" title="${dark ? 'Switch to light mode' : 'Switch to dark mode'}">
      <span class="theme-toggle-icon theme-toggle-sun">${icon('sun', 12)}</span>
      <span class="theme-toggle-icon theme-toggle-moon">${icon('moon', 12)}</span>
      <span class="theme-toggle-thumb"></span>
    </button>
  `
}

function wireThemeToggle(idPrefix) {
  const btn = document.getElementById(`${idPrefix}ThemeToggle`)
  if (!btn) return
  btn.addEventListener('click', () => {
    const dark = toggleTheme()
    btn.classList.toggle('on', dark)
    btn.setAttribute('aria-checked', String(dark))
    btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode'
  })
}

function setActiveNav(container) {
  const hash = window.location.hash
  container.querySelectorAll('.nav-row[data-hash]').forEach(btn => {
    // Prefix match too, so e.g. #architects/<id> (a specific contact's page)
    // still highlights the Architects row, not just the bare list route.
    const navHash = btn.dataset.hash
    const active = navHash !== '' ? (hash === navHash || hash.startsWith(`${navHash}/`)) : hash === ''
    btn.classList.toggle('active', active)
  })
}

// ---- Desktop pinned rail (≥800px — see the media query in style.css) ----
// Mounted once per session as a sibling of #app rather than inside it, so it
// survives every route()'s full re-render of #app's innerHTML. Below 800px
// this stays hidden entirely and openSidebar()'s overlay further down this
// file is what every page's hamburger button opens instead.
let pinnedEl = null

// Callers still pass { isAdmin, profile }; only `profile` is read now. Which
// tabs get drawn is no longer an admin/not-admin question — permissions.js
// answers it from the profile main.js already handed it at sign-in.
export function mountPinnedSidebar({ profile }) {
  // Checked against the live DOM, not just the in-memory pinnedEl flag — a
  // guard that only lives in module state can't catch every way a second
  // mount could occur, and every element inside is wired up by id
  // (document.getElementById), so two copies of this sidebar existing at once
  // means clicks silently resolve to whichever copy's ids the browser matches
  // first, not necessarily the one that was actually clicked. Removing any
  // stray copy first makes this idempotent no matter why it got called twice.
  document.querySelectorAll('.pinned-sidebar').forEach(stale => stale.remove())
  pinnedEl = null

  const app = document.getElementById('app')
  const collapsed = localStorage.getItem('sidebarCollapsed') === 'true'

  const displayName = profile?.name || profile?.email || 'Account'
  const initial = (profile?.name || profile?.email || '?').trim().charAt(0).toUpperCase()
  const avatarBg = avatarColor(profile?.id || displayName)

  const el = document.createElement('div')
  el.className = `pinned-sidebar${collapsed ? ' collapsed' : ''}`
  el.innerHTML = `
    <div class="pinned-sidebar-top">
      <img src="${logoUrl}" alt="JCM Retails" class="pinned-logo" />
      <div class="pinned-sidebar-brand">
        <div class="pinned-sidebar-name">JCM HQ</div>
        <div class="pinned-sidebar-sub">J.C. Mittal &amp; Sons</div>
      </div>
    </div>
    <nav class="pinned-nav">${renderNavHtml()}</nav>
    <div class="pinned-account">
      <div class="pinned-theme-row">${themeToggleHtml('pinned')}</div>
      <button class="pinned-account-chip" id="pinnedAccountChip" title="${esc(displayName)}">
        <span class="pinned-avatar" style="background:${avatarBg}">${esc(initial)}</span>
        <span class="pinned-account-name">${esc(displayName)}</span>
        <span class="pinned-account-chevron">${icon('chevron-down', 14)}</span>
      </button>
      <div class="pinned-account-menu" id="pinnedAccountMenu" hidden>
        <button class="pinned-account-menu-item" id="pinnedProfileBtn">${icon('user', 15)} Edit profile</button>
        <button class="pinned-signout-btn" id="pinnedSignoutBtn">Sign out</button>
      </div>
    </div>
    <button class="pinned-collapse-btn" id="pinnedCollapseBtn" aria-label="${collapsed ? 'Expand sidebar' : 'Collapse sidebar'}" title="${collapsed ? 'Expand sidebar' : 'Collapse sidebar'}">
      ${icon(collapsed ? 'chevron-right' : 'chevron-left', 13)}
    </button>
  `
  document.body.insertBefore(el, app)
  pinnedEl = el

  setActiveNav(el)
  window.addEventListener('hashchange', () => setActiveNav(el))

  el.querySelectorAll('.nav-row[data-hash]').forEach(btn => {
    btn.addEventListener('click', () => { window.location.hash = btn.dataset.hash })
  })

  loadNavBadges().then(badges => {
    if (el.isConnected) paintNavBadges(el, badges)
  })

  const collapseBtn = document.getElementById('pinnedCollapseBtn')
  collapseBtn.addEventListener('click', () => {
    const nowCollapsed = !el.classList.contains('collapsed')
    el.classList.toggle('collapsed', nowCollapsed)
    collapseBtn.innerHTML = icon(nowCollapsed ? 'chevron-right' : 'chevron-left', 13)
    collapseBtn.title = nowCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
    collapseBtn.setAttribute('aria-label', collapseBtn.title)
    localStorage.setItem('sidebarCollapsed', String(nowCollapsed))
    document.getElementById('pinnedAccountMenu').hidden = true
  })

  wireThemeToggle('pinned')

  const chip = document.getElementById('pinnedAccountChip')
  const menu = document.getElementById('pinnedAccountMenu')
  chip.addEventListener('click', e => {
    e.stopPropagation()
    menu.hidden = !menu.hidden
  })
  document.addEventListener('click', () => { menu.hidden = true })
  document.getElementById('pinnedProfileBtn').addEventListener('click', () => {
    window.location.hash = '#profile'
  })
  document.getElementById('pinnedSignoutBtn').addEventListener('click', () => {
    supabase.auth.signOut()
  })
}

export function unmountPinnedSidebar() {
  pinnedEl?.remove()
  pinnedEl = null
}

// ---- Mobile drawer (<800px) — same nav config/markup as the pinned rail,
// just a slide-in overlay instead of a fixed rail, and no collapse control. ----
// Every page calls this as openSidebar({ isAdmin }). That argument is now
// ignored — see mountPinnedSidebar above — and the call sites are left as they
// are rather than editing ten files to drop a harmless parameter.
export function openSidebar() {
  const overlay = document.createElement('div')
  overlay.className = 'sidebar-overlay'
  overlay.innerHTML = `
    <div class="sidebar-panel">
      <div class="sidebar-panel-top">
        <img src="${logoUrl}" alt="JCM Retails" class="sidebar-logo" />
        <button class="btn-ghost sidebar-close" id="sidebarCloseBtn" aria-label="Close menu">${icon('chevron-left', 16)}</button>
      </div>
      <nav class="sidebar-menu">${renderNavHtml()}</nav>
      <div class="sidebar-theme-row">
        <span>Dark mode</span>
        ${themeToggleHtml('sidebar')}
      </div>
      <button class="btn-ghost nav-row" id="sidebarProfileBtn">${icon('user', 18)}<span class="nav-row-label">Edit profile</span></button>
      <button class="btn-ghost sidebar-signout" id="sidebarSignoutBtn">Sign out</button>
    </div>
  `
  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('open'))

  const close = () => {
    overlay.classList.remove('open')
    setTimeout(() => overlay.remove(), 250)
  }

  setActiveNav(overlay)
  wireThemeToggle('sidebar')
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.getElementById('sidebarCloseBtn').addEventListener('click', close)
  overlay.querySelectorAll('.nav-row[data-hash]').forEach(btn => {
    btn.addEventListener('click', () => {
      close()
      window.location.hash = btn.dataset.hash
    })
  })
  document.getElementById('sidebarProfileBtn').addEventListener('click', () => {
    close()
    window.location.hash = '#profile'
  })
  document.getElementById('sidebarSignoutBtn').addEventListener('click', () => {
    close()
    supabase.auth.signOut()
  })

  loadNavBadges().then(badges => {
    if (overlay.isConnected) paintNavBadges(overlay, badges)
  })
}
