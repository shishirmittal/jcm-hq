import { NAV_CONFIG } from './nav-config.js'

// Per-user tab access. One rule, read by both the sidebar (what to draw) and
// the router (what to let you open), so the two can never disagree about what
// you are allowed to see.
//
// This is access tidying, not a security boundary: a hidden tab is removed
// from the nav and blocked at the router, but the Supabase data behind it is
// not separately locked. That is a deliberate, accepted call for a small
// trusted team — anything that genuinely must not be read by a given user
// needs an RLS policy, not an unticked box here.

let profile = null

// Set once per sign-in from main.js, cleared on sign-out. Everything below
// falls back to this when no profile is passed explicitly.
export function setPermissions(nextProfile) {
  profile = nextProfile || null
}

export function clearPermissions() {
  profile = null
}

// `is_admin` is the column the server-side gate in api/admin-users.js checks;
// `role` is what every client-side check in this codebase has always read.
// admin.js notes the two are kept in sync — accepting either means a lag
// between them can never lock an admin out of their own app.
export function isAdminProfile(p = profile) {
  return p?.is_admin === true || p?.role === 'admin'
}

// Admins see everything regardless of what allowed_tabs happens to hold, so
// their row never needs maintaining. For everyone else allowed_tabs is the
// only thing consulted: a missing or null column reads as "nothing granted
// yet", never as "everything" — the failure direction has to be locked out,
// not wide open.
const OPEN_TABS = new Set(NAV_CONFIG.flatMap(section => section.items.filter(item => item.open).map(item => item.id)))

export function canSee(tabId, p = profile) {
  if (isAdminProfile(p)) return true
  if (OPEN_TABS.has(tabId)) return true
  const allowed = Array.isArray(p?.allowed_tabs) ? p.allowed_tabs : []
  return allowed.includes(tabId)
}

// NAV_CONFIG with unpermitted items dropped from the arrays entirely rather
// than hidden with CSS, and sections that end up empty dropped with them so
// no orphan section header is drawn.
export function visibleNav(p = profile) {
  return NAV_CONFIG
    .map(section => ({ ...section, items: section.items.filter(item => canSee(item.id, p)) }))
    .filter(section => section.items.length > 0)
}

export function hasAnyTab(p = profile) {
  return visibleNav(p).length > 0
}

// ---------------------------------------------------------------------------
// Hash -> tab
// ---------------------------------------------------------------------------
// Exact match first, and that ordering is the whole trick: Dashboard's hash is
// the empty string while Control Centre's is literally '#dashboard'. They are
// two different routes that read like the same word, so any prefix- or
// name-based resolution silently grants one when you asked about the other.
// Order matters for the same reason — '#order-planning' belongs to `orders`,
// not to anything beginning "#order".
const ITEM_BY_HASH = new Map()
for (const section of NAV_CONFIG) {
  for (const item of section.items) ITEM_BY_HASH.set(item.hash, item)
}

const DASHBOARD_ITEM = ITEM_BY_HASH.get('')

// Routes that exist outside the nav and belong to the signed-in user rather
// than to a grantable tab — your own profile page is not something an admin
// ticks or unticks.
const UNGATED_HASHES = new Set(['#profile'])

export function tabForHash(hash) {
  const h = hash || ''
  if (ITEM_BY_HASH.has(h)) return ITEM_BY_HASH.get(h)
  // Detail routes hang off a tab's hash with a slash — #architects/<uuid>,
  // #order-planning/<id>, #payments/feedback — and inherit that tab's access.
  // Requiring the separator is what stops '#dashboard' being read as a child
  // of Dashboard's own ''.
  for (const [hashKey, item] of ITEM_BY_HASH) {
    if (hashKey && h.startsWith(`${hashKey}/`)) return item
  }
  return null
}

// Where to send someone who asked for a page they cannot open. Dashboard
// normally, but a user who was never granted Dashboard would bounce straight
// back out of it, so fall through to whatever their first real tab is.
export function fallbackHash(p = profile) {
  if (canSee('dashboard', p)) return ''
  return visibleNav(p)[0]?.items[0]?.hash ?? ''
}

// The router's single question. `item` comes back for logging/diagnostics;
// `allowed` is the only thing route() acts on.
export function routeDecision(hash, p = profile) {
  const h = hash || ''
  if (UNGATED_HASHES.has(h)) return { allowed: true, item: null }

  const item = tabForHash(h)
  if (item) return { allowed: canSee(item.id, p), item }

  // An unrecognised hash falls through to renderDashboard() in main.js's
  // route(), so it has to be judged as Dashboard rather than waved past as
  // "not a tab" — otherwise #anything-at-all is an open door to the one page
  // the fallback actually renders.
  return { allowed: canSee('dashboard', p), item: DASHBOARD_ITEM }
}
