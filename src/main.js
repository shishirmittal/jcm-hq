import './style.css'
import { initTheme } from './theme.js'
import { supabase, getCurrentProfile } from './supabase.js'
import { renderLogin } from './login.js'
import { renderDashboard } from './dashboard.js'
import { renderAdmin } from './admin.js'
import { renderProfileSetup } from './profile-setup.js'
import { renderProfileEdit } from './profile-edit.js'
import { renderQuotations } from './quotations.js'
import { renderProjectLeads } from './project-leads.js'
import { renderIndustryContacts } from './industry-contacts.js'
import { renderOrderPlanning } from './order-planning.js'
import { renderPayments } from './payments.js'
import { renderItemsManagement } from './items-management.js'
import { renderPriceUpdate } from './price-update.js'
import { renderRedAlerts } from './red-alerts.js'
import { renderTaskBoard, unmountTaskBoard } from './task-board.js'
import { mountPinnedSidebar, unmountPinnedSidebar } from './sidebar.js'
import { renderStock, unmountStock } from './stock.js'
import { getCurrentProfile as loadProfileForOrders } from './supabase.js'
import { IS_NATIVE } from './native.js'
import { mountNativeShell, unmountNativeShell, syncNativeShell, NATIVE_HOME } from './native-shell.js'
import { setPermissions, clearPermissions, routeDecision, hasAnyTab, fallbackHash, isAdminProfile } from './permissions.js'

const app = document.getElementById('app')
let pendingLoginMessage = null
let hasSession = false
// Control Centre pulls in React + Recharts, which every other page has no
// use for — dynamically imported so that weight only ships to browsers that
// actually navigate to #dashboard, and cached here (once loaded) so leaving
// the page can unmount its React root without re-fetching the chunk.
let ccModule = null
// The JCM Orders screens (React) load the same way, only when first opened.
let ordersModule = null
const ORDERS_HASHES = { '#material': 'material', '#order-log': 'order-log', '#warehouse': 'warehouse' }

async function init() {
  const { data: { session } } = await supabase.auth.getSession()
  if (session) {
    await enterApp()
  } else {
    renderLogin(app)
  }
  // Supabase fires this for far more than just login/logout. Two events in
  // particular are not real navigation moments but used to be treated as one:
  //  - TOKEN_REFRESHED, roughly hourly in the background as the access token
  //    nears expiry.
  //  - SIGNED_IN, re-emitted with the SAME session whenever the tab regains
  //    focus/visibility (GoTrueClient re-validates the session on focus and
  //    dispatches SIGNED_IN again even though the user never logged out).
  //    Simply alt-tabbing away from a long form and back was enough to fire
  //    this and wipe unsaved work.
  // For any screen reached via a direct function call rather than a hash
  // route (quotation-form.js, project detail, etc.), re-running route() here
  // always fell through to renderDashboard(app), silently discarding whatever
  // the user was in the middle of. So SIGNED_IN only triggers enterApp() when
  // we weren't already signed in (a genuine login); a redundant same-session
  // SIGNED_IN is ignored and the existing page keeps using the session on its
  // next request. Only SIGNED_OUT touches what's on screen otherwise.
  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN') {
      if (!hasSession) await enterApp()
    } else if (event === 'SIGNED_OUT') {
      hasSession = false
      clearPermissions()
      ccModule?.unmountControlCentre()
      ordersModule?.unmountOrdersPage()
      unmountTaskBoard()
      unmountStock()
      unmountPinnedSidebar()
      unmountNativeShell()
      renderLogin(app, pendingLoginMessage)
      pendingLoginMessage = null
    }
  })
  window.addEventListener('hashchange', () => {
    if (hasSession) route()
  })
}

async function enterApp() {
  const profile = await getCurrentProfile()
  if (profile && profile.active === false) {
    pendingLoginMessage = 'Your account has been deactivated. Contact your administrator.'
    await supabase.auth.signOut()
    return
  }
  hasSession = true
  // Loaded once here and held for the session — route() and the sidebar both
  // read it, so they can never disagree about what this user may open.
  setPermissions(profile)
  if (profile && !profile.name) {
    renderProfileSetup(app, route)
    return
  }
  if (!hasAnyTab()) {
    renderNoAccess()
    return
  }
  if (IS_NATIVE) {
    mountNativeShell()
    // The app opens on the Task Board. '' is the Dashboard, which the
    // three-tab shell has no tab for — landing there would show a page with
    // no tab lit and no way back to one except the drawer.
    if (!window.location.hash) {
      window.location.hash = NATIVE_HOME
      return // the hashchange above calls route()
    }
  } else {
    mountPinnedSidebar({ isAdmin: isAdminProfile(profile), profile })
  }
  route()
}

// Shown instead of the app when a non-admin has been granted nothing at all.
// Sign out is the one control offered: without it the account is a dead end
// with no way back to the login screen.
function renderNoAccess() {
  unmountPinnedSidebar()
  app.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <span class="logo-small">JCM Retails</span>
      </header>
      <main class="app-main">
        <div class="no-access">
          <p>No access has been set up for your account yet — ask an admin.</p>
          <button class="btn-ghost" id="noAccessSignOutBtn">Sign out</button>
        </div>
      </main>
    </div>
  `
  document.getElementById('noAccessSignOutBtn').addEventListener('click', () => supabase.auth.signOut())
}

// Brief, self-dismissing message for a blocked navigation. Deliberately not a
// blocking alert() — being bounced off a page you clicked is a nudge, not
// something to acknowledge.
let noticeTimer = null
function showNotice(message) {
  document.querySelectorAll('.app-notice').forEach(el => el.remove())
  const el = document.createElement('div')
  el.className = 'app-notice'
  el.setAttribute('role', 'status')
  el.textContent = message
  document.body.appendChild(el)
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => el.remove(), 3000)
}

function route() {
  const hash = window.location.hash
  // The React root Control Centre mounts into #app doesn't know when another
  // route's render*() wipes #app's innerHTML out from under it, so it has to
  // be torn down explicitly on the way to anywhere else.
  if (hash !== '#dashboard') ccModule?.unmountControlCentre()
  // The Task Board holds an open Realtime channel; leaving the page has to
  // close it, or every visit stacks another subscription on the same socket.
  if (hash !== '#tasks') unmountTaskBoard()
  // Stock holds a debounce and a one-minute ticker for its freshness line.
  if (hash !== '#stock') unmountStock()
  if (!ORDERS_HASHES[hash]) ordersModule?.unmountOrdersPage()

  if (IS_NATIVE) syncNativeShell()

  if (hash === '#stock') {
    renderStock(app)
    return
  }

  // Reached via renderProfileSetup's callback as well as normal navigation,
  // so the zero-tab case is caught here too, not only in enterApp.
  if (!hasAnyTab()) {
    renderNoAccess()
    return
  }

  // Access is decided before a single render*() call below, so a blocked page
  // never paints and then yanks itself away.
  if (!routeDecision(hash).allowed) {
    const target = IS_NATIVE && routeDecision(NATIVE_HOME).allowed ? NATIVE_HOME : fallbackHash()
    showNotice("You don't have access to that page.")
    // Assigning the hash we are already on fires no hashchange, which would
    // leave the blocked page on screen. Only reachable if the fallback itself
    // is barred, which hasAnyTab() above has already ruled out.
    if (hash === target) return
    window.location.hash = target
    return
  }
  // #architects and #electricians optionally carry a contact id after a slash
  // (e.g. #architects/<uuid>), for linking straight to one contact's page —
  // both share the same handler, parameterized by contact type.
  if (hash === '#admin') {
    renderAdmin(app, () => { window.location.hash = '' })
  } else if (hash === '#profile') {
    renderProfileEdit(app, () => { window.location.hash = '' })
  } else if (hash === '#quotations') {
    renderQuotations(app)
  } else if (hash === '#leads') {
    renderProjectLeads(app)
  } else if (hash === '#architects' || hash.startsWith('#architects/')) {
    renderIndustryContacts(app, 'architect', hash.split('/')[1] || null)
  } else if (hash === '#electricians' || hash.startsWith('#electricians/')) {
    renderIndustryContacts(app, 'electrician', hash.split('/')[1] || null)
  } else if (hash === '#order-planning' || hash.startsWith('#order-planning/')) {
    renderOrderPlanning(app, hash.split('/')[1] || null)
  } else if (hash === '#payments' || hash.startsWith('#payments/')) {
    renderPayments(app, hash.split('/')[1] || null)
  } else if (hash === '#tasks') {
    renderTaskBoard(app)
  } else if (hash === '#items-management') {
    renderItemsManagement(app)
  } else if (hash === '#red-alerts') {
    renderRedAlerts(app)
  } else if (hash === '#price-update') {
    renderPriceUpdate(app, () => { window.location.hash = '' })
  } else if (ORDERS_HASHES[hash]) {
    const which = ORDERS_HASHES[hash]
    Promise.all([import('./orders/mount.jsx'), loadProfileForOrders()]).then(([m, profile]) => {
      ordersModule = m
      // Still on the same page? (a fast second click elsewhere wins)
      if (window.location.hash === hash) m.renderOrdersPage(app, which, profile)
    })
  } else if (hash === '#dashboard') {
    import('./control-centre.js').then(m => { ccModule = m; m.renderControlCentre(app) })
  } else {
    renderDashboard(app)
  }
}

// The app loads the live site rather than a copy bundled in the APK, so with
// no connection there is nothing to show at all — that case is caught before
// any of this runs, by Capacitor's errorPath, which falls back to the
// offline.html inside the APK.
//
// This is the other half: the connection dropping while the app is already
// open. The screen on display keeps working and the next thing to need the
// network fails on its own, so without a standing banner the app just looks
// broken. Deliberately not a blocking dialog — most of what is on screen is
// still readable, and a stock figure or a task list that is a few minutes old
// is better than a modal in the way of it.
function syncOnlineBanner() {
  const existing = document.getElementById('offlineBanner')
  if (navigator.onLine) { existing?.remove(); return }
  if (existing) return
  const el = document.createElement('div')
  el.id = 'offlineBanner'
  el.className = 'offline-banner'
  el.setAttribute('role', 'status')
  el.textContent = 'No internet connection — showing what was already loaded'
  document.body.appendChild(el)
}

window.addEventListener('online', syncOnlineBanner)
window.addEventListener('offline', syncOnlineBanner)
syncOnlineBanner()

initTheme()
init()
