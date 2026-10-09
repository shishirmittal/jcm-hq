import { db, must } from '../lib/db.js'
import { send, fail, findAdmin } from '../lib/auth.js'
import { readLogs } from '../lib/logs.js'
import { photoLink } from '../lib/lrphoto.js'
import { clearedLines } from '../lib/material.js'
import { withTiming } from '../lib/timing.js'

// Admin only — the /logs page.
//   GET /api/admin/logs?from=YYYY-MM-DD&to=YYYY-MM-DD[&staff=<profile id>][&customer=<text>]
// Dates are Sales Order dates; at most one year at a time.
//   GET /api/admin/logs?photo=<order id>   → { url } a 10-minute link to that order's LR photo
//   GET /api/admin/logs?cleared=1&from=…&to=…  → { rows } every line cleared in the portal in that range (by clearing date)
const DAY = /^\d{4}-\d{2}-\d{2}$/

async function handler(req, res) {
  try {
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' })
    const dbc = db()
    const admin = await findAdmin(dbc, req)
    if (!admin) return send(res, 401, { error: 'Please sign in again.' })
    const q = new URL(req.url || '/', 'http://x').searchParams
    if (q.get('photo')) {
      const ev = await must(dbc.from('order_events').select('payload').eq('order_id', q.get('photo')).eq('event', 'dispatched').order('at'), 'reading dispatch')
      const path = ev.map(e => e.payload && e.payload.lr_photo).find(Boolean)
      const url = path ? await photoLink(dbc, path, 600) : null
      return url ? send(res, 200, { url }) : send(res, 404, { error: 'No LR photo for this order.' })
    }
    const from = q.get('from'), to = q.get('to')
    if (!DAY.test(from || '') || !DAY.test(to || '') || from > to) return send(res, 400, { error: 'Choose a date range (from, then to).' })
    if (Date.parse(to) - Date.parse(from) > 366 * 86400000) return send(res, 400, { error: 'Choose at most one year at a time.' })
    if (q.get('cleared')) return send(res, 200, { rows: await clearedLines(dbc, { from, to }) })
    send(res, 200, await readLogs(dbc, { from, to, staff: q.get('staff') || '', customer: q.get('customer') || '' }))
  } catch (err) {
    fail(res, err)
  }
}

export default withTiming('logs', handler)
