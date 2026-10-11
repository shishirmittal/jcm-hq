import { applyCors } from './_cors.js'
import { createClient } from '@supabase/supabase-js'
import { waConfigured, sendTemplate } from './_wa-cloud.js'

// WhatsApp via Meta's Cloud API (page src/whatsapp-test.js at #whatsapp-test).
// Admins only. Existing Whatshub360 sending (collections, purchases, red-alerts, orders)
// is untouched; this is the new direct route we can move modules to one at a time.
//
// Actions (POST JSON):
//   status                      { configured }  — are the Vercel env vars present?
//   test   { phone }            sends the approved "hello_world" template (en_US) to that number

const SUPABASE_URL = 'https://cmtnzmfuasniicsdxyle.supabase.co'

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json(body)
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) return send(res, 500, { error: 'HQ is not configured yet.' })

  const hq = createClient(SUPABASE_URL, key, { auth: { autoRefreshToken: false, persistSession: false } })
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return send(res, 401, { error: 'Please sign in again.' })
  const { data: u, error: uErr } = await hq.auth.getUser(token)
  if (uErr || !u?.user) return send(res, 401, { error: 'Please sign in again.' })
  const { data: profile } = await hq.from('profiles')
    .select('id, role, is_admin, active').eq('id', u.user.id).maybeSingle()
  if (!profile || profile.active === false) return send(res, 403, { error: 'Your account is not active.' })
  const isAdmin = profile.is_admin === true || profile.role === 'admin'
  if (!isAdmin) return send(res, 403, { error: 'Only admins can use this page.' })

  const body = req.body || {}
  try {
    if (body.action === 'status') return send(res, 200, { configured: waConfigured() })
    if (body.action === 'test') {
      const out = await sendTemplate(body.phone, 'hello_world', 'en_US', [])
      return send(res, 200, { ok: true, messageId: out?.messages?.[0]?.id || null })
    }
    return send(res, 400, { error: 'Unknown request.' })
  } catch (err) {
    // Messages from sendTemplate are plain-language and never contain the token.
    return send(res, 502, { error: err.message || 'Something went wrong. Try again.' })
  }
}
