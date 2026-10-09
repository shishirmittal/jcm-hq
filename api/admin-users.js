import { applyCors } from './_cors.js'
import { createClient } from '@supabase/supabase-js'
import { NAV_CONFIG } from '../src/nav-config.js'
import { randomBytes } from 'crypto'

// Same project as src/supabase.js — this is the public project URL, not a secret.
const SUPABASE_URL = 'https://cmtnzmfuasniicsdxyle.supabase.co'

// The same nav definition the client renders from, so the set of grantable
// tabs has exactly one source. Anything not in it is dropped rather than
// stored -- the column should never hold an id that no longer exists, whether
// that came from a stale tab left open or a hand-made request.
const VALID_TAB_IDS = new Set(NAV_CONFIG.flatMap(section => section.items).map(item => item.id))

function sanitizeTabs(value) {
  if (!Array.isArray(value)) return null
  return [...new Set(value.filter(v => typeof v === 'string' && VALID_TAB_IDS.has(v)))]
}

const PIN_RE = /^\d{4}$/

// Staff details kept on profiles (added 2026-10-10 so every person lives in
// one place): employee_id, whatsapp (10-digit Indian mobile, used for staff
// WhatsApp messages such as Red Alerts questions) and busy_login (their login
// name in Busy, which is how Busy's audit log names them). Each is only
// written when the request carries it, so an older form cannot blank them.
const MOBILE_RE = /^[6-9]\d{9}$/
function readStaffFields(body) {
  const out = {}
  const errors = []
  if (typeof body?.employee_id === 'string') out.employee_id = body.employee_id.trim().slice(0, 30) || null
  if (typeof body?.whatsapp === 'string') {
    const digits = body.whatsapp.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '')
    if (digits && !MOBILE_RE.test(digits)) errors.push('WhatsApp number should be a 10-digit mobile number')
    out.whatsapp = digits || null
  }
  if (typeof body?.busy_login === 'string') out.busy_login = body.busy_login.trim().slice(0, 40) || null
  return { fields: out, error: errors[0] || null }
}

// Two people cannot share a Busy login: Busy's log only has the login, so
// it would be impossible to tell whose entry it was.
async function busyLoginTaken(supabaseAdmin, login, exceptId) {
  if (!login) return false
  const { data } = await supabaseAdmin.from('profiles').select('id').ilike('busy_login', login.replace(/[%_\\]/g, m => `\\${m}`))
  return (data || []).some(r => r.id !== exceptId)
}

// The new columns may not exist until the Supabase update has been run.
function columnHint(err) {
  return /employee_id|whatsapp|busy_login/.test(err?.message || '') ? 'Run the latest Supabase update for Manage Users first (new staff columns).' : null
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Never returned to the client or logged anywhere -- accounts created here
// are only ever reached via PIN login (see mintSessionForUser in
// pin-login.js), which mints a session through a magic-link/OTP exchange and
// never touches the password at all. This just satisfies createUser's
// required field with something nobody could plausibly need or guess.
function randomPassword() {
  return randomBytes(24).toString('base64url') // ~32 chars, well over a 20-char minimum
}

export default async function handler(req, res) {
  // Must run before the method check: the app's cross-origin POST is
  // preceded by an OPTIONS, which that check would answer with a 405.
  if (applyCors(req, res)) return
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY is not set')
    res.status(500).json({ error: 'Admin user management is not configured yet' })
    return
  }

  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })

  // ---- Auth check, before anything else touches auth.users or user_pins.
  // Every action below is admin-only, no exceptions -- this is the ONLY
  // gate; the frontend's own admin check is a UX convenience, never trusted
  // here. ----
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) {
    res.status(401).json({ error: 'Missing Authorization header' })
    return
  }

  const { data: callerData, error: callerErr } = await supabaseAdmin.auth.getUser(token)
  if (callerErr || !callerData?.user) {
    res.status(401).json({ error: 'Invalid or expired session' })
    return
  }

  const { data: callerProfile, error: callerProfileErr } = await supabaseAdmin
    .from('profiles')
    .select('is_admin')
    .eq('id', callerData.user.id)
    .maybeSingle()
  if (callerProfileErr) {
    console.error('Failed to check caller admin status:', callerProfileErr)
    res.status(500).json({ error: 'Something went wrong. Try again.' })
    return
  }
  if (!callerProfile?.is_admin) {
    res.status(403).json({ error: 'Admin access required' })
    return
  }

  const { action } = req.body || {}

  try {
    if (action === 'list') { await handleList(supabaseAdmin, res); return }
    if (action === 'create') { await handleCreate(supabaseAdmin, req.body, res); return }
    if (action === 'update') { await handleUpdate(supabaseAdmin, req.body, res); return }
    res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    console.error('admin-users handler error:', err)
    res.status(500).json({ error: 'Something went wrong. Try again.' })
  }
}

// profiles LEFT JOIN user_pins on profiles.id = user_pins.user_id -- done as
// two queries + an in-memory join rather than a PostgREST embed, since
// user_pins has zero client-facing RLS policies by design (confirmed: even
// an authenticated anon-key request returns nothing for it) and this is the
// one place with a service-role client able to read it at all. Users with no
// PIN assigned yet still show up, with pin: null, not silently excluded.
async function handleList(supabaseAdmin, res) {
  const { data: profiles, error: profErr } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: true })
  if (profErr) { res.status(500).json({ error: profErr.message }); return }

  const { data: pins, error: pinErr } = await supabaseAdmin
    .from('user_pins')
    .select('user_id, pin')
  if (pinErr) { res.status(500).json({ error: pinErr.message }); return }

  const pinByUser = {}
  ;(pins || []).forEach(p => { pinByUser[p.user_id] = p.pin })

  const users = (profiles || []).map(p => ({
    id: p.id,
    name: p.name,
    email: p.email,
    is_admin: !!p.is_admin,
    active: p.active !== false,
    allowed_tabs: Array.isArray(p.allowed_tabs) ? p.allowed_tabs : [],
    hide_from_roster: !!p.hide_from_roster,
    employee_id: p.employee_id ?? null,
    whatsapp: p.whatsapp ?? null,
    busy_login: p.busy_login ?? null,
    pin: pinByUser[p.id] ?? null,
  }))
  res.status(200).json({ users })
}

async function handleCreate(supabaseAdmin, body, res) {
  const name = String(body?.name || '').trim()
  const email = String(body?.email || '').trim().toLowerCase()
  const pin = String(body?.pin || '').trim()
  // New users start with nothing granted unless the form says otherwise --
  // never a default set, and never "everything".
  const allowedTabs = sanitizeTabs(body?.allowed_tabs) || []
  const hideFromRoster = body?.hide_from_roster === true
  const staff = readStaffFields(body)

  if (!name) { res.status(400).json({ error: 'Name is required' }); return }
  if (staff.error) { res.status(400).json({ error: staff.error }); return }
  if (await busyLoginTaken(supabaseAdmin, staff.fields.busy_login, null)) { res.status(400).json({ error: 'That Busy login is already linked to someone else' }); return }
  if (!EMAIL_RE.test(email)) { res.status(400).json({ error: 'Enter a valid email address' }); return }
  if (!PIN_RE.test(pin)) { res.status(400).json({ error: 'PIN must be exactly 4 digits' }); return }

  const { data: existingPin, error: pinCheckErr } = await supabaseAdmin
    .from('user_pins').select('user_id').eq('pin', pin).maybeSingle()
  if (pinCheckErr) { res.status(500).json({ error: pinCheckErr.message }); return }
  if (existingPin) { res.status(400).json({ error: 'PIN already in use' }); return }

  // email_confirm: true so the account is immediately usable -- these users
  // never go through email verification themselves, they only ever sign in
  // via PIN (see pin-login.js's mintSessionForUser).
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: randomPassword(),
    email_confirm: true,
  })
  if (createErr || !created?.user) {
    res.status(400).json({ error: createErr?.message || 'Could not create user' })
    return
  }
  const newUserId = created.user.id

  // upsert, not insert: supabase/setup.sql's on_auth_user_created trigger
  // already auto-inserted a stub profiles row (id, email) the instant
  // createUser wrote to auth.users, so a plain insert here always collides
  // on the pkey. is_admin: false is hardcoded, not just defaulted -- this
  // endpoint must never be able to grant admin rights, by design (see the
  // frontend's own comment on why that stays a manual, deliberate action).
  const { error: profileInsertErr } = await supabaseAdmin
    .from('profiles')
    .upsert({ id: newUserId, name, email, is_admin: false, role: 'staff', active: true, allowed_tabs: allowedTabs, hide_from_roster: hideFromRoster, ...staff.fields }, { onConflict: 'id' })
  if (profileInsertErr) {
    const hint = columnHint(profileInsertErr)
    // Partial failure: the auth user exists but has no profile. Clean it up
    // rather than leaving an orphaned, broken account behind.
    await supabaseAdmin.auth.admin.deleteUser(newUserId)
    res.status(400).json({ error: hint || `Could not save profile: ${profileInsertErr.message}` })
    return
  }

  const { error: pinInsertErr } = await supabaseAdmin
    .from('user_pins')
    .insert({ user_id: newUserId, pin })
  if (pinInsertErr) {
    await supabaseAdmin.from('profiles').delete().eq('id', newUserId)
    await supabaseAdmin.auth.admin.deleteUser(newUserId)
    res.status(400).json({ error: `Could not save PIN: ${pinInsertErr.message}` })
    return
  }

  res.status(200).json({ user: { id: newUserId, name, email, is_admin: false, active: true, pin } })
}

async function handleUpdate(supabaseAdmin, body, res) {
  const id = String(body?.id || '').trim()
  const name = String(body?.name || '').trim()
  const email = String(body?.email || '').trim().toLowerCase()
  const pin = String(body?.pin || '').trim()

  if (!id) { res.status(400).json({ error: 'Missing user id' }); return }
  const staff = readStaffFields(body)
  if (staff.error) { res.status(400).json({ error: staff.error }); return }
  if (await busyLoginTaken(supabaseAdmin, staff.fields.busy_login, id)) { res.status(400).json({ error: 'That Busy login is already linked to someone else' }); return }
  if (!name) { res.status(400).json({ error: 'Name is required' }); return }
  if (!EMAIL_RE.test(email)) { res.status(400).json({ error: 'Enter a valid email address' }); return }
  if (!PIN_RE.test(pin)) { res.status(400).json({ error: 'PIN must be exactly 4 digits' }); return }

  const { data: existingProfile, error: existingErr } = await supabaseAdmin
    .from('profiles').select('email, is_admin').eq('id', id).maybeSingle()
  if (existingErr) { res.status(500).json({ error: existingErr.message }); return }
  if (!existingProfile) { res.status(404).json({ error: 'User not found' }); return }

  // email_confirm: true here too -- per Supabase's admin API docs, changes
  // made through updateUserById take effect directly rather than going
  // through the double-opt-in "secure email change" flow a user-initiated
  // change would trigger; this makes that explicit rather than relying on
  // project-level defaults that could change.
  let emailChanged = false
  if (email !== existingProfile.email) {
    const { error: emailErr } = await supabaseAdmin.auth.admin.updateUserById(id, { email, email_confirm: true })
    if (emailErr) { res.status(400).json({ error: `Could not update email: ${emailErr.message}` }); return }
    emailChanged = true
  }

  // An admin's allowed_tabs is never written: they see every tab regardless,
  // so the column is meaningless for them, and writing [] would turn into a
  // silent lockout the day is_admin was cleared. Enforced here as well as in
  // the UI, so a stale form cannot do it either.
  const profileUpdate = { name, email, ...staff.fields }
  // Only written when the caller actually sent it, so a payload that predates
  // this field cannot silently un-hide someone.
  if (typeof body?.hide_from_roster === 'boolean') profileUpdate.hide_from_roster = body.hide_from_roster
  const allowedTabs = sanitizeTabs(body?.allowed_tabs)
  if (allowedTabs && !existingProfile.is_admin) profileUpdate.allowed_tabs = allowedTabs

  const { error: profileUpdateErr } = await supabaseAdmin
    .from('profiles').update(profileUpdate).eq('id', id)
  if (profileUpdateErr) { res.status(400).json({ error: columnHint(profileUpdateErr) || profileUpdateErr.message }); return }

  const { data: currentPinRow, error: currentPinErr } = await supabaseAdmin
    .from('user_pins').select('pin').eq('user_id', id).maybeSingle()
  if (currentPinErr) { res.status(500).json({ error: currentPinErr.message }); return }

  // No-op if the PIN wasn't actually changed; otherwise confirm the new one
  // isn't already someone else's before writing it.
  if (!currentPinRow || currentPinRow.pin !== pin) {
    const { data: pinOwner, error: pinOwnerErr } = await supabaseAdmin
      .from('user_pins').select('user_id').eq('pin', pin).maybeSingle()
    if (pinOwnerErr) { res.status(500).json({ error: pinOwnerErr.message }); return }
    if (pinOwner && pinOwner.user_id !== id) {
      res.status(400).json({ error: 'PIN already in use' })
      return
    }
    // Plain update-or-insert rather than an upsert -- user_pins has no unique
    // constraint on user_id for ON CONFLICT to target, and we already know
    // from currentPinRow above whether a row exists.
    const pinWriteErr = currentPinRow
      ? (await supabaseAdmin.from('user_pins').update({ pin }).eq('user_id', id)).error
      : (await supabaseAdmin.from('user_pins').insert({ user_id: id, pin })).error
    if (pinWriteErr) { res.status(400).json({ error: pinWriteErr.message }); return }
  }

  res.status(200).json({ user: { id, name, email, pin }, emailChanged })
}
