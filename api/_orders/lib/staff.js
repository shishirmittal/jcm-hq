import { must } from './db.js'
import { hashToken, isAdminProfile, displayName, SESSION_CACHE_MS } from './auth.js'
import { cached, remember, forget } from './cache.js'

// Who is on the tablet, and which jobs each person may do, is kept in
// orders_config 'tablet_staff' = { staff: [profile ids], access: { <profile id>: [jobs] } }
// and set on /admin → Tablet staff. The CRM has no such roles and lists sales
// people too, so this is an explicit choice rather than "every CRM user".
//
// Jobs (each one is a tick box on /admin, and a card on the tablet home):
//   pick      NEW and PICKING cards; I'M PICKING THIS
//   check     INVOICED card; CHECKED AGAINST INVOICE
//   ready     READY FOR DISPATCH card: boxes + PRINT/SKIP LABELS
//   dispatch  READY FOR DISPATCH card: DISPATCHED (with the LR photo)
//   material  PENDING MATERIAL card; the ORDERED tick
// Admins can do everything.
export const STAFF_SESSION_MINUTES = 15
export const JOBS = ['pick', 'check', 'ready', 'dispatch', 'material']

// Before the per-job ticks existed there was one "Supervisor" tick. A person
// saved that way keeps what they could do then: everyone picked, packed and
// dispatched; supervisors also checked.
const LEGACY = ['pick', 'ready', 'dispatch']

export async function readTabletStaff(dbc) {
  const row = await must(dbc.from('orders_config').select('value').eq('key', 'tablet_staff').maybeSingle(), 'reading tablet staff')
  const v = row && row.value && typeof row.value === 'object' ? row.value : {}
  const ids = x => (Array.isArray(x) ? x.filter(s => typeof s === 'string') : [])
  const access = {}
  if (v.access && typeof v.access === 'object') {
    for (const [id, jobs] of Object.entries(v.access)) access[id] = cleanJobs(jobs)
  }
  return { staff: ids(v.staff), supervisors: ids(v.supervisors), access }
}

export const cleanJobs = jobs => JOBS.filter(j => Array.isArray(jobs) && jobs.includes(j))

export function jobsOf(profile, cfg) {
  if (isAdminProfile(profile)) return [...JOBS]
  if (cfg.access[profile.id]) return cfg.access[profile.id]
  return cfg.supervisors.includes(profile.id) ? cleanJobs([...LEGACY, 'check']) : [...LEGACY]
}

export const roleOf = profile => (isAdminProfile(profile) ? 'admin' : 'staff')
export const can = (me, job) => me.role === 'admin' || me.jobs.includes(job)

// Which order stages a person sees. Packers also see orders already Ready for
// dispatch (to reprint labels); the dispatcher does not see orders still to pack.
export function stagesFor(me) {
  const s = new Set()
  if (can(me, 'pick')) { s.add('new'); s.add('picking') }
  if (can(me, 'check')) s.add('invoiced')
  if (can(me, 'ready')) { s.add('checked'); s.add('in_bay') }
  if (can(me, 'dispatch')) s.add('in_bay')
  return s
}

export const initials = name => {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  // One name → one letter ("A"); first and last name → two ("RK"), as in the design.
  return (words.length === 1 ? words[0][0] : words[0][0] + words[words.length - 1][0]).toUpperCase()
}

export const staffView = (p, cfg) => {
  const name = displayName(p)
  return { id: p.id, name, initials: initials(name), role: roleOf(p), jobs: jobsOf(p, cfg) }
}

// The tablet sends "Authorization: Bearer <staff session>" along with its
// device key. A session belongs to one device, lasts 15 minutes from the last
// action, and ends if the person is taken off the tablet roster.
//
// Speed: the session (with the person's profile) is remembered for 30 s per
// server instance, and the device and roster are read at the same time as it
// (their promises are passed in), so most taps make no extra database wait for
// it. The device and the roster are always read fresh: switching a tablet off
// or taking someone off the list works at once. The 15-minute expiry is pushed
// on at most once a minute.
const staffKey = hash => `staff:${hash}`
async function readStaffSession(dbc, hash) {
  const s = await must(dbc.from('staff_sessions').select('id, profile_id, device_id, expires_at').eq('token_hash', hash).maybeSingle(), 'reading staff session')
  if (!s) return null
  const profile = await must(dbc.from('profiles').select('id, name, email, role, is_admin, active').eq('id', s.profile_id).maybeSingle(), 'reading profile')
  if (!profile) return null
  return { id: s.id, deviceId: s.device_id, expiresAt: s.expires_at, extendedAt: Date.parse(s.expires_at) - STAFF_SESSION_MINUTES * 60000, profile }
}

export function rememberStaffSession(token, { id, deviceId, expiresAt, profile }) {
  remember(staffKey(hashToken(token)), { id, deviceId, expiresAt, extendedAt: Date.now(), profile }, SESSION_CACHE_MS)
}
export const forgetStaffSession = token => forget(staffKey(hashToken(token)))

export async function findStaff(dbc, req, device, cfg) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i)
  if (!m) return null
  const hash = hashToken(m[1])
  const hit = cached(staffKey(hash))
  const [dev, conf, fresh] = await Promise.all([device, cfg || readTabletStaff(dbc), hit ? null : readStaffSession(dbc, hash)])
  const s = hit || fresh
  if (!s || !dev || s.deviceId !== dev.id || Date.parse(s.expiresAt) <= Date.now()) return null
  if (!conf.staff.includes(s.profile.id) || s.profile.active === false) return null
  if (!hit) remember(staffKey(hash), s, SESSION_CACHE_MS)
  if (Date.now() - s.extendedAt > 60000) {
    s.extendedAt = Date.now()
    s.expiresAt = new Date(Date.now() + STAFF_SESSION_MINUTES * 60000).toISOString()
    await must(dbc.from('staff_sessions').update({ expires_at: s.expiresAt }).eq('id', s.id), 'extending session')
  }
  return { ...staffView(s.profile, conf), sessionId: s.id }
}
