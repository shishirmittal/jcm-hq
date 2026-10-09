import { db, must } from '../lib/db.js'
import { findAdmin, send, fail } from '../lib/auth.js'

// GET /api/orders?h=sync — when the Busy → orders sync on JCM-Server last
// finished (orders_sync_log, every 3 minutes), for the sync time chip at the
// top of the HQ orders pages. Anyone who may open one of those pages may ask.
const TABS = ['floor-orders', 'material', 'order-log', 'warehouse']

export default async function sync(req, res) {
  try {
    const dbc = db()
    let who = null
    for (const tab of TABS) {
      req.hqTab = tab
      who = await findAdmin(dbc, req)
      if (who) break
    }
    if (!who) return send(res, 401, { error: 'signed_out' })
    const rows = await must(dbc.from('orders_sync_log').select('run_at').eq('status', 'success').order('run_at', { ascending: false }).range(0, 0), 'reading last sync')
    return send(res, 200, { lastSync: rows[0] ? rows[0].run_at : null })
  } catch (err) {
    return fail(res, err)
  }
}
