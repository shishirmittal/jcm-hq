import { must } from './db.js'
import { displayName } from './auth.js'
import { readThresholds } from './config.js'
import { selectTolerant } from './columns.js'
import { openQty } from './material.js'

// The logs page ("JCM Orders - Admin Logs.dc.html"): one row per order and a
// per-person summary, worked out from the order history (order_events).
//
// Stage times:
//   UNASSIGNED  Sales Order made in Busy → someone taps I'M PICKING THIS
//   PICKING     picked → invoice made in Busy (the invoice's own time when known)
//   CHECKING    invoiced → CHECKED AGAINST INVOICE
//   READY       READY FOR DISPATCH → DISPATCHED
// A time over that stage's limit (orders_config) is flagged for red.
const CHUNK = 200
const HIDDEN = new Set(['invoiced_before_tracking', 'deleted_in_busy', 'cancelled_in_busy', 'closed_at_go_live', 'closed_by_admin'])
const minutes = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000)) : null)

// How an order entered waiting for material ('waiting' history entries, Phase 9).
// Orders from before then that waited because of a partial invoice have only
// the 'partial' entry: same thing.
const VIA = { partial_invoice: 'Partial invoice', button: 'Button', all_short: 'All lines short (system)' }
export function waitingVia(events, name) {
  const out = []
  for (const e of events) {
    let text = ''
    if (e.event === 'waiting') {
      const via = e.payload && e.payload.via
      text = VIA[via] || via || ''
      if (via === 'button' && name(e.profile_id)) text += ` · ${name(e.profile_id)}`
    } else if (e.event === 'partial' && !events.some(x => x.event === 'waiting' && x.payload && x.payload.via === 'partial_invoice')) {
      text = VIA.partial_invoice
    }
    if (text && !out.includes(text)) out.push(text)
  }
  return out.join(', ')
}

export async function readLogs(dbc, { from, to, staff, customer }) {
  const thresholds = await readThresholds(dbc)
  const orders = (await must(dbc.from('orders')
    .select('id, so_vch_no, so_date, so_created_at, party_name, party_city, invoice_vch_no, invoice_value, boxes, picker_id, checker_id, dispatcher_id, stage, closed_reason')
    .gte('so_date', from).lte('so_date', to), 'reading orders'))
    .filter(o => !HIDDEN.has(o.closed_reason))
  const ids = orders.map(o => o.id)
  const events = []
  const lines = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK)
    events.push(...await must(dbc.from('order_events').select('order_id, event, profile_id, payload, at').in('order_id', part).in('event', ['pick', 'invoiced', 'checked', 'in_bay', 'dispatched', 'label_printed', 'partial', 'waiting']).order('at'), 'reading history'))
    lines.push(...await must(selectTolerant(cols => dbc.from('order_lines').select(cols).in('order_id', part), 'order_id, item_group, pending_qty, cleared_at, cleared_qty', 'order_id, item_group, pending_qty'), 'reading lines'))
  }
  return buildLogs({ orders, events, lines, thresholds, staff, customer, names: await nameMap(dbc, events, orders) })
}

async function nameMap(dbc, events, orders) {
  const ids = [...new Set([...events.map(e => e.profile_id), ...orders.flatMap(o => [o.picker_id, o.checker_id, o.dispatcher_id])].filter(Boolean))]
  const map = new Map()
  for (let i = 0; i < ids.length; i += CHUNK) {
    for (const p of await must(dbc.from('profiles').select('id, name, email').in('id', ids.slice(i, i + CHUNK)), 'reading names')) map.set(p.id, displayName(p))
  }
  return map
}

// Pure: everything the page and the Excel file show.
export function buildLogs({ orders, events, lines, thresholds, staff, customer, names }) {
  const first = new Map() // order → event → first event
  for (const e of events) {
    const k = `${e.order_id}|${e.event}`
    if (!first.has(k)) first.set(k, e)
  }
  const ev = (id, name) => first.get(`${id}|${name}`)
  const at = (id, name) => {
    const e = ev(id, name)
    if (!e) return null
    return name === 'invoiced' && e.payload && e.payload.invoiced_at ? e.payload.invoiced_at : e.at
  }
  const waitEvents = new Map() // order → its 'partial' / 'waiting' entries, oldest first
  for (const e of events) if (e.event === 'partial' || e.event === 'waiting') { const list = waitEvents.get(e.order_id) || []; list.push(e); waitEvents.set(e.order_id, list) }
  const linesBy = new Map()
  for (const l of lines) { const list = linesBy.get(l.order_id) || []; list.push(l); linesBy.set(l.order_id, list) }
  const name = id => (id ? names.get(id) || '' : '')
  const q = String(customer || '').trim().toLowerCase()

  const rows = []
  for (const o of orders) {
    const pick = ev(o.id, 'pick'), check = ev(o.id, 'checked'), bay = ev(o.id, 'in_bay'), disp = ev(o.id, 'dispatched')
    const people = { picker: o.picker_id || pick?.profile_id || null, checker: o.checker_id || check?.profile_id || null, packer: bay?.profile_id || null, dispatcher: o.dispatcher_id || disp?.profile_id || null }
    if (staff && !Object.values(people).includes(staff)) continue
    if (q && !String(o.party_name || '').toLowerCase().includes(q)) continue
    const t = {
      unassigned: minutes(o.so_created_at, at(o.id, 'pick')),
      picking: minutes(at(o.id, 'pick'), at(o.id, 'invoiced')),
      checking: minutes(at(o.id, 'invoiced'), at(o.id, 'checked')),
      ready: minutes(at(o.id, 'in_bay'), at(o.id, 'dispatched')),
    }
    const over = {
      unassigned: t.unassigned !== null && t.unassigned > thresholds.new,
      picking: t.picking !== null && t.picking > thresholds.picking,
      checking: t.checking !== null && t.checking > thresholds.invoiced,
      ready: t.ready !== null && t.ready > thresholds.in_bay,
    }
    const ls = linesBy.get(o.id) || []
    rows.push({
      id: o.id, customer: o.party_name || '', city: o.party_city || '', soDate: o.so_date, soNo: o.so_vch_no, invoiceNo: o.invoice_vch_no || '',
      pickedBy: name(people.picker), checkedBy: name(people.checker), checkedAt: at(o.id, 'checked'),
      dispatchedBy: name(people.dispatcher), dispatchedAt: at(o.id, 'dispatched'), packedBy: name(people.packer),
      times: t, over, boxes: o.boxes, value: o.invoice_value === null || o.invoice_value === undefined ? null : Number(o.invoice_value),
      pendingLines: ls.filter(l => openQty(l) > 0).length, stage: o.stage,
      // Pending lines cleared in the portal (Busy's sales order still shows them).
      clearedLines: ls.filter(l => l.cleared_at).length,
      // Printed if any label was printed (or reprinted); Skipped if SKIP LABELS was tapped and none printed since.
      labels: ev(o.id, 'label_printed') ? 'Printed' : bay && bay.payload && bay.payload.labels === 'skipped' ? 'Skipped' : '',
      pickToDispatch: minutes(at(o.id, 'pick'), at(o.id, 'dispatched')),
      // How it entered waiting for material: Partial invoice / Button · <who> / All lines short (system).
      waitingVia: waitingVia(waitEvents.get(o.id) || [], name),
      // The LR / transport-receipt photo taken at DISPATCHED (opened through /api/admin/logs?photo=<order id>).
      lrPhoto: !!(disp && disp.payload && disp.payload.lr_photo),
      people, groups: ls.map(l => l.item_group).filter(Boolean),
    })
  }
  rows.sort((a, b) => String(b.soDate).localeCompare(String(a.soDate)) || String(b.soNo).localeCompare(String(a.soNo)))

  // Per person: their own stage times (picker → PICKING, checker → CHECKING,
  // packer/dispatcher → READY), orders handled, invoice value, boxes, top category.
  const people = new Map()
  const person = id => {
    if (!people.has(id)) people.set(id, { id, name: name(id), orders: new Set(), minutes: 0, timed: 0, boxes: 0, roles: { pick: 0, check: 0, dispatch: 0 }, groups: new Map(), value: 0, pickToDispatch: [] })
    return people.get(id)
  }
  for (const r of rows) {
    const touch = (id, role, mins, extra) => {
      if (!id) return
      const p = person(id)
      if (!p.orders.has(r.id)) { p.orders.add(r.id); p.value += r.value || 0; for (const g of r.groups) p.groups.set(g, (p.groups.get(g) || 0) + 1) }
      p.roles[role]++
      if (mins !== null && mins !== undefined) { p.minutes += mins; p.timed++ }
      if (extra) extra(p)
    }
    touch(r.people.picker, 'pick', r.times.picking, p => { if (r.pickToDispatch !== null) p.pickToDispatch.push(r.pickToDispatch) })
    touch(r.people.checker, 'check', r.times.checking)
    if (r.people.packer) touch(r.people.packer, 'dispatch', null, p => { p.boxes += r.boxes || 0 })
    if (r.people.dispatcher) touch(r.people.dispatcher, 'dispatch', r.times.ready)
  }
  const roleName = roles => {
    const top = Object.entries(roles).sort((a, b) => b[1] - a[1])[0]
    return { pick: 'Picker', check: 'Supervisor', dispatch: 'Dispatch' }[top[0]]
  }
  const summary = [...people.values()].map(p => ({
    id: p.id, name: p.name, role: roleName(p.roles), orders: p.orders.size, value: Math.round(p.value),
    totalMinutes: p.timed ? p.minutes : null, avgMinutes: p.timed ? Math.round(p.minutes / p.timed) : null, boxes: p.boxes,
    topCategory: [...p.groups].sort((a, b) => b[1] - a[1])[0]?.[0] || '—',
    avgPickToDispatch: p.pickToDispatch.length ? Math.round(p.pickToDispatch.reduce((s, x) => s + x, 0) / p.pickToDispatch.length) : null,
  })).sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name))

  return {
    thresholds,
    rows: rows.map(({ people: _p, groups: _g, ...r }) => r),
    totals: { orders: rows.length, value: Math.round(rows.reduce((s, r) => s + (r.value || 0), 0)) },
    summary,
    staffList: summary.map(s => ({ id: s.id, name: s.name })),
  }
}
