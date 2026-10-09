import { db, must } from '../lib/db.js'
import { newToken, hashToken, send, fail, findAdmin } from '../lib/auth.js'
import { withTiming } from '../lib/timing.js'

// Admin only.
//   GET   /api/admin/devices                    → list of registered screens
//   POST  /api/admin/devices { name, kind }     → registers THIS browser; the key is returned once
//   PATCH /api/admin/devices { id, active }     → switch a screen off or back on
const COLS = 'id, name, kind, active, created_at, last_seen_at'
const body = req => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {})

async function handler(req, res) {
  try {
    const dbc = db()
    const admin = await findAdmin(dbc, req)
    if (!admin) return send(res, 401, { error: 'Please sign in again.' })

    if (req.method === 'GET') {
      const devices = await must(dbc.from('devices').select(COLS).order('created_at', { ascending: false }), 'listing devices')
      return send(res, 200, { devices })
    }

    if (req.method === 'POST') {
      const { name, kind } = body(req)
      const clean = String(name ?? '').trim()
      if (!clean || clean.length > 60) return send(res, 400, { error: 'Give the screen a name (up to 60 letters).' })
      if (!['tv', 'tablet'].includes(kind)) return send(res, 400, { error: 'Choose TV board or Staff tablet.' })
      const token = newToken()
      const device = await must(dbc.from('devices').insert({ name: clean, kind, token_hash: hashToken(token) }).select(COLS).single(), 'registering device')
      return send(res, 200, { token, device })
    }

    if (req.method === 'PATCH') {
      const { id, active } = body(req)
      if (typeof id !== 'string' || typeof active !== 'boolean') return send(res, 400, { error: 'Bad request.' })
      const rows = await must(dbc.from('devices').update({ active }).eq('id', id).select(COLS), 'updating device')
      if (!rows.length) return send(res, 404, { error: 'That screen no longer exists.' })
      return send(res, 200, { device: rows[0] })
    }

    send(res, 405, { error: 'Method not allowed' })
  } catch (err) {
    fail(res, err)
  }
}

export default withTiming('devices', handler)
