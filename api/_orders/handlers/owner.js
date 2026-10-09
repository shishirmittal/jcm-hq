import { db, must } from '../lib/db.js'
import { send, fail, findAdmin, nameMap } from '../lib/auth.js'
import { withTiming } from '../lib/timing.js'
import { materialOverview, markOrdered, markManyOrdered, unmarkOrdered, clearLines, clearManyOrders, pickAnyway, waitForMaterial, readLines, openQty } from '../lib/material.js'

// Admin only — the /owner page.
//   GET  /api/admin/owner                       → { today, parties, items } (see _lib/material.js)
//   GET  /api/admin/owner?ping=1                keep-warm (JCM-Server): no sign-in needed, answers { ok }
//   Every POST answers with { overview } too (the fresh lists), so the page needs no second call.
//   GET  /api/admin/owner?order=<id>            → one order in full: every line, cleared lines, history
//   POST { op: 'ordered', id, days } | { op: 'ordered', id, date }   MARK ORDERED + when it will arrive
//   POST { op: 'unordered', id }                undo MARK ORDERED
//   POST { op: 'clear', orderId, lineNos? }     clear pending lines (all pending when lineNos is left out)
//   POST { op: 'pick_anyway', orderId }         a waiting order back to NEW now (send what is in stock)
//   POST { op: 'wait', orderId }                WAIT FOR MATERIAL on a NEW order (amber band), as on the tablet
//   POST { op: 'ordered_many', ids, days | date }   MARK N ORDERED: ticked items, one arrival date
//   POST { op: 'clear_many', orders: [{ orderId, lineNos }] }   CLEAR ALL PENDING on ticked orders
const body = req => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {})

async function handler(req, res) {
  try {
    const dbc = db()
    if (req.method === 'GET' && new URL(req.url || '/', 'http://x').searchParams.get('ping')) {
      await must(dbc.from('orders_config').select('key').eq('key', 'threshold_minutes'), 'ping')
      return send(res, 200, { ok: true })
    }
    const admin = await findAdmin(dbc, req)
    if (!admin) return send(res, 401, { error: 'Please sign in again.' })
    if (req.method === 'GET') {
      const id = new URL(req.url || '/', 'http://x').searchParams.get('order')
      if (id) return send(res, ...await orderDetail(dbc, id))
      return send(res, 200, await materialOverview(dbc))
    }
    if (req.method === 'POST') {
      const b = body(req)
      const OPS = {
        ordered: () => markOrdered(dbc, b, admin.id),
        ordered_many: () => markManyOrdered(dbc, b, admin.id),
        unordered: () => unmarkOrdered(dbc, b),
        clear: () => clearLines(dbc, b, admin.id),
        clear_many: () => clearManyOrders(dbc, b, admin.id),
        pick_anyway: () => pickAnyway(dbc, b, admin.id),
        wait: () => waitFromOwner(dbc, b, admin.id),
      }
      const result = OPS[b.op] ? await OPS[b.op]() : { status: 400, error: 'Unknown request.' }
      const { status, ...rest } = result
      return send(res, status, rest)
    }
    send(res, 405, { error: 'Method not allowed' })
  } catch (err) {
    fail(res, err)
  }
}

export default withTiming('owner', handler)

async function waitFromOwner(dbc, { orderId }, profileId) {
  const r = await waitForMaterial(dbc, String(orderId || ''), profileId, null, new Date(), 'owner')
  return r.status === 200 ? { ...r, overview: await materialOverview(dbc) } : r
}

// One order in full: the order, its lines and its history in one answer
// (read at the same time), then the names.
async function orderDetail(dbc, id) {
  const [o, lines, events] = await Promise.all([
    must(dbc.from('orders').select('id, so_vch_no, so_date, party_name, party_city, party_mobile, stage, invoice_vch_no, invoice_vch_nos, invoice_value, boxes, closed_at, closed_reason').eq('id', id).maybeSingle(), 'reading order'),
    readLines(dbc, [id], { pendingOnly: false }),
    must(dbc.from('order_events').select('event, profile_id, payload, at').eq('order_id', id).order('at'), 'reading history'),
  ])
  if (!o) return [404, { error: 'That order was not found.' }]
  const names = await nameMap(dbc, events.map(e => e.profile_id))
  return [200, {
    order: {
      id: o.id, name: o.party_name || o.so_vch_no, city: o.party_city || '', soNo: o.so_vch_no, soDate: o.so_date, stage: o.stage,
      invoices: o.invoice_vch_nos || [], invoiceValue: o.invoice_value, boxes: o.boxes, closed: !!o.closed_at, closedReason: o.closed_reason,
      lines: lines.map(l => ({
        lineNo: l.line_no, item: l.item_name || `Item ${l.item_code}`, ordered: Number(l.ordered_qty), invoiced: Number(l.invoiced_qty),
        short: openQty(l), cleared: l.cleared_at ? { at: l.cleared_at, qty: Number(l.cleared_qty) } : null,
      })),
      history: events.map(e => ({ event: e.event, at: e.at, who: names.get(e.profile_id) || '', payload: e.payload || {} })),
    },
  }]
}
