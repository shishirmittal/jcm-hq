import { applyCors } from './_cors.js'
import { createClient } from '@supabase/supabase-js'

// Same project as src/supabase.js — this is the public project URL, not a secret.
const SUPABASE_URL = 'https://cmtnzmfuasniicsdxyle.supabase.co'
const RATE_LIMIT_WINDOW_MINUTES = 15
const RATE_LIMIT_MAX_ATTEMPTS = 5

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) return String(forwarded).split(',')[0].trim()
  return req.socket?.remoteAddress || 'unknown'
}

// Mints a real Supabase session for an existing user without their password:
// generate a magic-link OTP for their email (admin-only, doesn't send anything),
// then immediately redeem it server-side. This is the documented way to create a
// session for a specific user from a trusted server context — verifyOtp returns a
// normal session (access_token/refresh_token) exactly like signInWithPassword
// would, so everything downstream (RLS, auth.uid()) is unaffected by how the
// session was established.
async function mintSessionForUser(supabaseAdmin, userId) {
  const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.getUserById(userId)
  if (userErr || !userData?.user?.email) throw userErr || new Error('User not found')

  const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: userData.user.email
  })
  if (linkErr || !linkData?.properties?.hashed_token) throw linkErr || new Error('Could not generate login link')

  const { data: verifyData, error: verifyErr } = await supabaseAdmin.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink'
  })
  if (verifyErr || !verifyData?.session) throw verifyErr || new Error('Could not verify login link')

  return verifyData.session
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
    res.status(500).json({ error: 'PIN login is not configured yet' })
    return
  }

  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })

  const ip = getClientIp(req)
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60 * 1000).toISOString()

  // Rate limit first, before touching the PIN at all — an attacker shouldn't be
  // able to tell "still checking" from "locked out" by timing, and a locked-out
  // IP should never cause a user_pins lookup.
  const { count: recentAttempts, error: rateErr } = await supabaseAdmin
    .from('pin_login_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('ip_address', ip)
    .gte('attempted_at', windowStart)

  if (rateErr) {
    console.error('Rate limit check failed:', rateErr)
    res.status(500).json({ error: 'Something went wrong. Try again.' })
    return
  }

  if ((recentAttempts || 0) >= RATE_LIMIT_MAX_ATTEMPTS) {
    res.status(429).json({ error: 'Too many attempts, try again later' })
    return
  }

  const pin = typeof req.body?.pin === 'string' ? req.body.pin.trim() : ''

  const { data: pinRow, error: pinErr } = await supabaseAdmin
    .from('user_pins')
    .select('user_id')
    .eq('pin', pin)
    .maybeSingle()

  if (pinErr) {
    console.error('PIN lookup failed:', pinErr)
    res.status(500).json({ error: 'Something went wrong. Try again.' })
    return
  }

  if (!pinRow) {
    // Failures only — a correct PIN never adds to the lockout count.
    await supabaseAdmin.from('pin_login_attempts').insert({ ip_address: ip })
    res.status(401).json({ error: 'Incorrect PIN' })
    return
  }

  try {
    const session = await mintSessionForUser(supabaseAdmin, pinRow.user_id)
    res.status(200).json({
      access_token: session.access_token,
      refresh_token: session.refresh_token
    })
  } catch (err) {
    console.error('Failed to mint session for PIN login:', err)
    res.status(500).json({ error: 'Something went wrong. Try again.' })
  }
}
