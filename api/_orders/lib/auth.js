import crypto from 'node:crypto'
import { must } from './db.js'
import { cached, remember } from './cache.js'

// Sessions are remembered for this long per server instance, so most taps do
// not wait on a database read to know who is signed in. Logging out on the
// same instance forgets at once; elsewhere it lags by at most this much.
export const SESSION_CACHE_MS = 30000

// Device keys and admin sessions are long random strings. Only their SHA-256
// hash is stored, so a copy of the database is not a copy of the keys.
export const newToken = () => crypto.randomBytes(32).toString('base64url')
export const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex')

export const ADMIN_SESSION_MINUTES = 30

export function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json(body)
}

// Every handler ends here on an unexpected error: log it, answer plainly.
export function fail(res, err) {
  console.error(err)
  send(res, err.status || 500, { error: err.status === 503 ? 'The server is not set up yet.' : 'Something went wrong. Try again.' })
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (fwd) return String(fwd).split(',')[0].trim()
  return req.socket?.remoteAddress || 'unknown'
}

function bearer(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i)
  return m ? m[1] : null
}

// The TV and tablets send their key in X-Device-Token. Returns the device, or
// null for a missing, unknown or deactivated key.
export async function findDevice(dbc, req) {
  const token = req.headers['x-device-token']
  if (!token || String(token).length < 20) return null
  const device = await must(
    dbc.from('devices').select('id, name, kind, active, last_seen_at').eq('token_hash', hashToken(token)).maybeSingle(),
    'reading device')
  if (!device || !device.active) return null
  // "Last seen" is for the admin page; once a minute is plenty.
  const seen = device.last_seen_at ? Date.parse(device.last_seen_at) : 0
  if (Date.now() - seen > 60000) {
    await must(dbc.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('id', device.id), 'touching device')
  }
  return device
}

export const isAdminProfile = p => !!p && p.active !== false && (p.is_admin === true || p.role === 'admin')

// JCM HQ: people are already signed in to HQ, so its pages send their
// Supabase access token (a JWT — three dot-separated parts) instead of an
// orders admin session. Supabase checks the token; then the person must be an
// admin, or have been given this page in Manage Users (profiles.allowed_tabs).
// api/orders.js puts the page's tab id on req.hqTab before calling a handler.
async function findHqUser(dbc, req, token) {
  const key = `hq:${hashToken(token)}:${req.hqTab || ''}`
  const hit = cached(key)
  if (hit !== undefined) return hit
  const { data, error } = await dbc.auth.getUser(token)
  const userId = !error && data?.user?.id
  let ok = null
  if (userId) {
    const profile = await must(
      dbc.from('profiles').select('id, name, email, role, is_admin, active, allowed_tabs').eq('id', userId).maybeSingle(),
      'reading profile')
    const granted = !!profile && profile.active !== false && Array.isArray(profile.allowed_tabs) && !!req.hqTab && profile.allowed_tabs.includes(req.hqTab)
    if (isAdminProfile(profile) || granted) {
      const { allowed_tabs, ...rest } = profile
      ok = rest
    }
  }
  return remember(key, ok, SESSION_CACHE_MS)
}

// /admin requests carry "Authorization: Bearer <admin session>". Returns the
// admin's profile, or null if the session is missing, expired or not an admin.
export async function findAdmin(dbc, req) {
  const token = bearer(req)
  if (!token) return null
  if (token.split('.').length === 3) return findHqUser(dbc, req, token)
  const key = `admin:${hashToken(token)}`
  let hit = cached(key)
  if (!hit) {
    const session = await must(
      dbc.from('admin_sessions').select('profile_id, expires_at').eq('token_hash', hashToken(token)).maybeSingle(),
      'reading admin session')
    if (!session) return null
    const profile = await must(
      dbc.from('profiles').select('id, name, email, role, is_admin, active').eq('id', session.profile_id).maybeSingle(),
      'reading profile')
    hit = remember(key, { expiresAt: session.expires_at, profile }, SESSION_CACHE_MS)
  }
  if (Date.parse(hit.expiresAt) <= Date.now()) return null
  return isAdminProfile(hit.profile) ? hit.profile : null
}

// People's names for the screens (picker, checker, packer…), remembered 5 minutes.
export async function nameMap(dbc, ids) {
  const map = new Map()
  const want = []
  for (const id of new Set(ids.filter(Boolean))) {
    const n = cached(`name:${id}`)
    if (n === undefined) want.push(id); else map.set(id, n)
  }
  for (let i = 0; i < want.length; i += 200) {
    for (const p of await must(dbc.from('profiles').select('id, name, email').in('id', want.slice(i, i + 200)), 'reading names')) {
      map.set(p.id, remember(`name:${p.id}`, displayName(p), 300000))
    }
  }
  return map
}

export const displayName = p => (p && (p.name || (p.email ? String(p.email).split('@')[0] : ''))) || ''
