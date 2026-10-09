import { db, must } from '../lib/db.js'
import { send, fail, findAdmin, isAdminProfile, displayName } from '../lib/auth.js'
import { readThresholds, THRESHOLD_KEYS, MAX_THRESHOLD_MINUTES } from '../lib/config.js'
import { readTabletStaff, jobsOf, cleanJobs } from '../lib/staff.js'
import { previewOld, closeOld } from '../lib/cleanup.js'
import { withTiming } from '../lib/timing.js'

// Admin only.
//   GET  /api/admin/settings                         → { thresholds, people, tabletStaff }
//   POST /api/admin/settings { thresholds }          → saves the stage time limits (minutes)
//   POST /api/admin/settings { tabletStaff: { staff, access: { <id>: [jobs] } } }
//        → who appears on the tablet, and which jobs (cards) each person gets
//   POST /api/admin/settings { closeOld: { days, confirm } }
//        → without confirm: how many open orders are older than N days; with confirm: close them
const body = req => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {})

async function handler(req, res) {
  try {
    const dbc = db()
    const admin = await findAdmin(dbc, req)
    if (!admin) return send(res, 401, { error: 'Please sign in again.' })

    if (req.method === 'GET') {
      const [thresholds, tabletStaff, profiles] = await Promise.all([
        readThresholds(dbc),
        readTabletStaff(dbc),
        must(dbc.from('profiles').select('id, name, email, role, is_admin, active'), 'reading people'),
      ])
      const people = profiles.filter(p => p.active !== false)
        .map(p => ({ id: p.id, name: displayName(p), email: p.email || '', isAdmin: isAdminProfile(p) }))
        .sort((a, b) => a.name.localeCompare(b.name))
      // Each person's ticks as they stand now (people saved before the ticks existed get their old rights).
      const access = Object.fromEntries(profiles.filter(p => tabletStaff.staff.includes(p.id)).map(p => [p.id, jobsOf(p, tabletStaff)]))
      return send(res, 200, { thresholds, people, tabletStaff: { staff: tabletStaff.staff, access } })
    }

    if (req.method === 'POST') {
      const b = body(req)
      if (b.thresholds) {
        const value = {}
        for (const k of THRESHOLD_KEYS) {
          const v = Number(b.thresholds[k])
          if (!Number.isInteger(v) || v < 1 || v > MAX_THRESHOLD_MINUTES) {
            return send(res, 400, { error: `Each time limit must be a whole number of minutes from 1 to ${MAX_THRESHOLD_MINUTES} (7 days).` })
          }
          value[k] = v
        }
        await must(dbc.from('orders_config').upsert({ key: 'threshold_minutes', value, updated_at: new Date().toISOString() }, { onConflict: 'key' }), 'saving time limits')
        return send(res, 200, { thresholds: value })
      }
      if (b.closeOld) {
        const r = b.closeOld.confirm === true
          ? await closeOld(dbc, b.closeOld.days, admin.id)
          : await previewOld(dbc, b.closeOld.days)
        const { status, ...rest } = r
        return send(res, status, rest)
      }
      if (b.tabletStaff) {
        const known = new Set((await must(dbc.from('profiles').select('id'), 'reading people')).map(p => p.id))
        const clean = x => [...new Set(Array.isArray(x) ? x : [])].filter(id => typeof id === 'string' && known.has(id))
        const staff = clean(b.tabletStaff.staff)
        // Ticks only for people on the tablet; unknown jobs dropped.
        const given = b.tabletStaff.access && typeof b.tabletStaff.access === 'object' ? b.tabletStaff.access : {}
        const access = Object.fromEntries(staff.map(id => [id, cleanJobs(given[id])]))
        await must(dbc.from('orders_config').upsert({ key: 'tablet_staff', value: { staff, access }, note: 'Who appears on the tablet, and which jobs each person may do', updated_at: new Date().toISOString() }, { onConflict: 'key' }), 'saving tablet staff')
        return send(res, 200, { tabletStaff: { staff, access } })
      }
      return send(res, 400, { error: 'Nothing to save.' })
    }

    send(res, 405, { error: 'Method not allowed' })
  } catch (err) {
    fail(res, err)
  }
}

export default withTiming('settings', handler)
