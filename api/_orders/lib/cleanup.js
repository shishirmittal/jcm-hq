import { must } from './db.js'
import { todayIST, addDays } from './material.js'

// "Close orders older than N days" on /admin. Closes every OPEN order whose
// order date is more than N days before today (India time): marked dispatched
// and closed, reason 'closed_by_admin', with a history note saying who did it.
// The sync never reopens these (NEVER_REOPEN in busy-sync/sync-orders.js).
export const MAX_DAYS = 365
const CHUNK = 200

export function cutoffFor(days, now = new Date()) {
  const n = Number(days)
  if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) return null
  return addDays(todayIST(now), -n) // orders dated before this day are closed
}

export async function previewOld(dbc, days, now = new Date()) {
  const cutoff = cutoffFor(days, now)
  if (!cutoff) return { status: 400, error: `Enter a number of days from 1 to ${MAX_DAYS}.` }
  const rows = await must(dbc.from('orders').select('id, so_vch_no, so_date, party_name, stage').is('closed_at', null).lt('so_date', cutoff).order('so_date'), 'reading old orders')
  return { status: 200, cutoff, count: rows.length, sample: rows.slice(0, 8).map(r => ({ name: r.party_name || r.so_vch_no, soNo: r.so_vch_no, soDate: r.so_date, stage: r.stage })) }
}

export async function closeOld(dbc, days, profileId, now = new Date()) {
  const cutoff = cutoffFor(days, now)
  if (!cutoff) return { status: 400, error: `Enter a number of days from 1 to ${MAX_DAYS}.` }
  const targets = await must(dbc.from('orders').select('id, stage').is('closed_at', null).lt('so_date', cutoff), 'reading old orders')
  const at = now.toISOString()
  const closed = []
  for (let i = 0; i < targets.length; i += CHUNK) {
    const part = targets.slice(i, i + CHUNK)
    // Conditional on still being open, so nothing is closed twice.
    const rows = await must(dbc.from('orders')
      .update({ stage: 'dispatched', stage_since: at, closed_at: at, closed_reason: 'closed_by_admin', needs_partial_notice: false })
      .in('id', part.map(t => t.id)).is('closed_at', null).select('id'), 'closing old orders')
    const was = new Map(part.map(t => [t.id, t.stage]))
    for (const r of rows) closed.push({ id: r.id, previous: was.get(r.id) })
  }
  for (let i = 0; i < closed.length; i += 500) {
    await must(dbc.from('order_events').insert(closed.slice(i, i + 500).map(c => ({
      order_id: c.id, event: 'closed', profile_id: profileId,
      payload: { reason: 'closed_by_admin', note: `closed by admin: order older than ${days} days`, previous_stage: c.previous },
    }))), 'recording closes')
  }
  return { status: 200, cutoff, closed: closed.length }
}
