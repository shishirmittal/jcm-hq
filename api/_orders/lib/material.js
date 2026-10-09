import { must } from './db.js'
import { selectTolerant } from './columns.js'
import { nameMap } from './auth.js'

// Waiting for material — ONE picture of it, used by /owner, the TV board's
// WAITING FOR MATERIAL column, the tablet's PENDING MATERIAL card and the 17:30 email.
//
//   parties  every open order waiting for material: invoiced (at least partly)
//            with pending lines, or parked before picking (stage 'waiting': WAIT
//            FOR MATERIAL on the tablet, or all lines short — the sync).
//            RED while any pending item is not yet marked
//            ordered; GREEN once every pending item is ordered (or Busy stock
//            already covers it), with the latest expected date.
//   items    the pending-material list (table procurement, kept by the sync:
//            what open orders need beyond the stock in Busy), grouped by
//            supplier / item group, with MARK ORDERED + expected date per item.
//
// "Pending" always leaves out lines cleared in the portal (openQty below).
const TZ_OFFSET_MIN = 330
const CHUNK = 200
export const todayIST = (now = new Date()) => new Date(now.getTime() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10)
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
export const ORDERED_AMBER_DAYS = 7
// Stages where an order's pending lines are "waiting for material". NEW and
// PICKING orders have simply not been billed yet; NEW also holds orders that
// came back because the material arrived.
export const WAITING_STAGES = ['invoiced', 'checked', 'in_bay', 'dispatched', 'waiting']

const r3 = n => Math.round(Number(n) * 1000) / 1000
// Still to send on a line: Busy's pending minus what was cleared in the portal.
export const openQty = l => Math.max(0, r3(Number(l.pending_qty ?? (Number(l.ordered_qty) - Number(l.invoiced_qty))) - (l.cleared_at ? Number(l.cleared_qty) || 0 : 0)))

const LINE_BASE = 'order_id, line_no, item_code, item_name, ordered_qty, invoiced_qty, pending_qty'
const LINE_FULL = `${LINE_BASE}, cleared_at, cleared_qty`
const PROC_BASE = 'id, item_code, item_name, item_group, supplier_name, pending_qty, so_refs, for_parties, ordered_at'
const PROC_FULL = `${PROC_BASE}, expected_date`

const chunked = (list, n = CHUNK) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n))

export async function readLines(dbc, ids, { pendingOnly = true } = {}) {
  const parts = await Promise.all(chunked(ids).map(part => must(selectTolerant(cols => {
    let q = dbc.from('order_lines').select(cols).in('order_id', part)
    if (pendingOnly) q = q.gt('pending_qty', 0)
    return q.order('order_id').order('line_no')
  }, LINE_FULL, LINE_BASE), 'reading lines')))
  return parts.flat()
}

// How an order entered waiting (orders.waiting_via; Phase 9). Older orders
// that wait because of a partial invoice have none recorded: same thing.
export const VIA_TEXT = { partial_invoice: 'Partial invoice', button: 'Wait for material button', all_short: 'All lines short (system)' }

// The tablet's item list: for each line, does Busy's stock (stock_cache, kept
// fresh by the 3-minute sync) cover what is still to send? Stock for an item is
// shared out over that item's lines in line order — the same rule the sync uses
// to park an order whose lines are all short.
//   cleared  cleared in the portal, nothing left to send
//   billed   fully invoiced, nothing left to send
//   in_stock stock covers it
//   short    stock covers only part (or none): short = how many are missing
export function lineStock(lines, stockByItem) {
  const left = new Map()
  const out = lines.map(l => {
    const need = openQty(l)
    const base = { lineNo: l.line_no, itemCode: l.item_code, item: l.item_name || `Item ${l.item_code}`, ordered: Number(l.ordered_qty), need }
    if (need <= 0) return { ...base, status: l.cleared_at ? 'cleared' : 'billed', short: 0, stock: null }
    if (!left.has(l.item_code)) left.set(l.item_code, Math.max(Number(stockByItem.get(l.item_code)) || 0, 0))
    const have = left.get(l.item_code)
    const take = Math.min(have, need)
    left.set(l.item_code, r3(have - take))
    const stock = stockByItem.has(l.item_code) ? Number(stockByItem.get(l.item_code)) || 0 : null
    return { ...base, status: take >= need ? 'in_stock' : 'short', short: r3(need - take), available: r3(take), stock }
  })
  const short = out.filter(l => l.status === 'short').length
  const cleared = out.filter(l => l.status === 'cleared').length
  const open = out.filter(l => l.status === 'in_stock' || l.status === 'short').length
  return { lines: out, summary: { lines: out.length, short, cleared, open, allShort: open > 0 && short === open } }
}

export async function readStock(dbc, itemCodes) {
  const map = new Map()
  const codes = [...new Set(itemCodes.filter(c => c !== null && c !== undefined))]
  const parts = await Promise.all(chunked(codes).map(part => must(dbc.from('stock_cache').select('item_code, qty').in('item_code', part), 'reading stock')))
  for (const s of parts.flat()) map.set(s.item_code, s.qty === null ? 0 : Number(s.qty))
  return map
}

const WAIT_BASE = 'id, so_vch_no, so_date, so_created_at, party_name, party_city, stage, stage_since, invoice_vch_no, invoice_date, line_count'
const WAIT_FULL = `${WAIT_BASE}, waiting_since, waiting_via, waiting_by`
// Orders still on the floor before billing: in /owner's list 1 (amber band) only
// when one of their items is short — so every item on list 2 traces to an order on list 1.
export const FLOOR_STAGES = ['new', 'picking']
// The three bands of /owner list 1, in this order.
export const BAND_ORDER = { red: 0, amber: 1, green: 2 }

export async function materialOverview(dbc, now = new Date()) {
  const today = todayIST(now)
  // Two waits on the database: orders + pending material together, then their lines + names.
  const [orders, proc] = await Promise.all([
    must(selectTolerant(cols => dbc.from('orders').select(cols).is('closed_at', null).in('stage', [...WAITING_STAGES, ...FLOOR_STAGES]), WAIT_FULL, WAIT_BASE), 'reading orders'),
    must(selectTolerant(cols => dbc.from('procurement').select(cols).is('closed_at', null), PROC_FULL, PROC_BASE), 'reading pending material'),
  ])
  const [lines, people] = await Promise.all([readLines(dbc, orders.map(o => o.id)), nameMap(dbc, orders.map(o => o.waiting_by))])
  const procByItem = new Map(proc.map(p => [p.item_code, p]))

  const linesBy = new Map()
  for (const l of lines) {
    const open = openQty(l)
    if (open <= 0) continue
    const p = procByItem.get(l.item_code)
    const status = !p ? 'in_stock' : p.ordered_at ? 'ordered' : 'not_ordered'
    const list = linesBy.get(l.order_id) || []
    list.push({
      lineNo: l.line_no, itemCode: l.item_code, item: l.item_name || `Item ${l.item_code}`,
      ordered: Number(l.ordered_qty), invoiced: Number(l.invoiced_qty), short: open,
      status, orderedAt: p?.ordered_at || null, expectedDate: p?.expected_date || null,
    })
    linesBy.set(l.order_id, list)
  }

  // A line is short when its item is on the pending-material list (list 2): open
  // orders together need more than Busy's stock.
  const isShort = l => l.status !== 'in_stock'
  const parties = orders.filter(o => linesBy.has(o.id) && (!FLOOR_STAGES.includes(o.stage) || linesBy.get(o.id).some(isShort))).map(o => {
    const pending = linesBy.get(o.id)
    const red = pending.some(l => l.status === 'not_ordered')
    const floor = FLOOR_STAGES.includes(o.stage)
    const dates = pending.map(l => l.expectedDate).filter(Boolean).sort()
    const via = floor ? '' : o.waiting_via || (o.stage === 'waiting' ? '' : 'partial_invoice')
    return {
      id: o.id, name: o.party_name || o.so_vch_no, city: o.party_city || '', soNo: o.so_vch_no, soDate: o.so_date,
      stage: o.stage, invoiceNo: o.invoice_vch_no || '', invoiceDate: o.invoice_date, stageSince: o.stage_since,
      lineCount: o.line_count, createdAt: o.so_created_at,
      // Since when, how and (for the tablet button) by whom it entered waiting.
      waitingSince: o.waiting_since || (o.invoice_date ? `${o.invoice_date}T00:00:00+05:30` : o.stage_since),
      via, viaText: VIA_TEXT[via] || '', waitingBy: people.get(o.waiting_by) || '',
      // PICK ANYWAY on /owner: only for orders not on the floor right now.
      canPickAnyway: o.stage === 'waiting' || o.stage === 'dispatched',
      // WAIT FOR MATERIAL on /owner: as on the tablet, for NEW orders only (a PICKING one has someone on it).
      canWait: o.stage === 'new',
      //   red    waiting, not every short item ordered
      //   amber  still in NEW / PICKING, with short items ("IN NEW · 2 of 9 short")
      //   green  waiting, every short item ordered (or Busy's stock covers it)
      pending, status: floor ? 'amber' : red ? 'red' : 'green', floor,
      shortLines: pending.filter(isShort).length, openLines: pending.length,
      expectedDate: red ? null : dates[dates.length - 1] || null,
      overdue: !red && !!dates.length && dates[dates.length - 1] < today,
    }
  }).sort((a, b) => BAND_ORDER[a.status] - BAND_ORDER[b.status] || String(a.soDate).localeCompare(String(b.soDate)) || a.name.localeCompare(b.name))

  // Who is waiting for each item (from the open orders above, cleared lines left out).
  const waitingFor = new Map()
  for (const p of parties) for (const l of p.pending) {
    const list = waitingFor.get(l.itemCode) || []
    list.push({ id: p.id, name: p.name, soNo: p.soNo, soDate: p.soDate, short: l.short })
    waitingFor.set(l.itemCode, list)
  }
  const groups = new Map()
  for (const r of proc) {
    const supplier = r.supplier_name || r.item_group || 'Other'
    const days = r.ordered_at ? Math.floor((now.getTime() - Date.parse(r.ordered_at)) / 86400000) : null
    const list = groups.get(supplier) || []
    list.push({
      id: r.id, itemCode: r.item_code, item: r.item_name || `Item ${r.item_code}`, short: Number(r.pending_qty),
      // Parties: those with an invoiced order waiting; otherwise the names the sync noted (orders not billed yet).
      orders: waitingFor.get(r.item_code) || [],
      forParties: r.for_parties || [], soRefs: r.so_refs || [],
      orderedAt: r.ordered_at, orderedDays: days, expectedDate: r.expected_date || null,
      late: !!r.expected_date && r.expected_date < today,
      amber: days !== null && days > ORDERED_AMBER_DAYS,
    })
    groups.set(supplier, list)
  }
  const items = [...groups].map(([supplier, list]) => ({
    supplier, items: list.sort((a, b) => (a.orderedAt ? 1 : 0) - (b.orderedAt ? 1 : 0) || a.item.localeCompare(b.item)),
  })).sort((a, b) => a.supplier.localeCompare(b.supplier))
  return { today, parties, items }
}

// MARK ORDERED: "When will it arrive?" — in 2, 4 or 7 days, or a picked date.
// Every party waiting for this item turns green once all their items are ordered.
// Answers with the fresh overview, so the page needs no second call.
// "When will it arrive?": 2 / 4 / 7 days from today, or a picked date (today … six months).
function arrivalDay({ days, date }, now) {
  const today = todayIST(now)
  let day = date
  if (days !== undefined) {
    const n = Number(days)
    if (!Number.isInteger(n) || n < 0 || n > 180) return { error: 'Choose 2, 4 or 7 days, or pick a date.' }
    day = addDays(today, n)
  }
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || isNaN(Date.parse(day))) return { error: 'Pick the date it will arrive.' }
  if (day < today || day > addDays(today, 180)) return { error: 'Pick a date from today up to six months ahead.' }
  return { day }
}
const UUID = /^[0-9a-f-]{36}$/i

export async function markOrdered(dbc, { id, days, date }, profileId, now = new Date()) {
  const { day, error: dayError } = arrivalDay({ days, date }, now)
  if (dayError) return { status: 400, error: dayError }
  const key = String(id || '')
  if (!/^[0-9a-f-]{36}$/i.test(key)) return { status: 404, error: 'That item is no longer on the list (the stock may have arrived).' }
  // Both at once: the date (and who), and "ordered on" — only if not already set
  // (Change date keeps the day it was first ordered).
  const [rows] = await Promise.all([
    must(dbc.from('procurement').update({ ordered_by: profileId, expected_date: day }).eq('id', key).is('closed_at', null).select('id, item_code, item_name, ordered_at'), 'saving ordered item'),
    must(dbc.from('procurement').update({ ordered_at: now.toISOString() }).eq('id', key).is('closed_at', null).is('ordered_at', null).select('id'), 'saving ordered day'),
  ])
  const row = rows[0]
  if (!row) return { status: 404, error: 'That item is no longer on the list (the stock may have arrived).' }
  const orderedAt = row.ordered_at || now.toISOString()
  // History on each order waiting for it.
  const overview = await materialOverview(dbc, now)
  const affected = overview.parties.filter(p => p.pending.some(l => l.itemCode === row.item_code))
  if (affected.length) {
    await must(dbc.from('order_events').insert(affected.map(p => ({
      order_id: p.id, event: 'material_ordered', profile_id: profileId,
      payload: { item_code: row.item_code, item: row.item_name, expected_date: day, all_ordered: p.status === 'green' },
    }))), 'recording material ordered')
  }
  return { status: 200, orderedAt, expectedDate: day, parties: affected.map(p => ({ name: p.name, status: p.status })), overview }
}

// WAIT FOR MATERIAL on a NEW order (tablet, anyone who can pick): out of NEW at
// once so nobody else picks it, into the waiting column / owner list. It comes
// back to NEW by itself (the sync) when stock or the expected date arrives, or
// with PICK ANYWAY on /owner. Recorded exactly as the sync records the other two
// ways into waiting (partial invoice, all lines short).
// source: 'tablet' or 'owner' (the same button on /owner's amber band), noted in the history.
export async function waitForMaterial(dbc, id, profileId, deviceId, now = new Date(), source = 'tablet') {
  const at = now.toISOString()
  const [moved, lines] = await Promise.all([
    must(dbc.from('orders')
      .update({ stage: 'waiting', stage_since: at, waiting_since: at, waiting_via: 'button', waiting_by: profileId })
      .eq('id', id).eq('stage', 'new').is('closed_at', null).select('id'), 'moving order to waiting'),
    readLines(dbc, [id], { pendingOnly: false }),
  ])
  if (!moved.length) return { status: 409, error: 'This order has already been moved on by someone else.' }
  const { summary } = lineStock(lines, await readStock(dbc, lines.map(l => l.item_code)))
  await must(dbc.from('order_events').insert({
    order_id: id, event: 'waiting', profile_id: profileId, device_id: deviceId,
    payload: { via: 'button', source, short_lines: summary.short, open_lines: summary.open },
  }), 'recording waiting')
  return { status: 200, stage: 'waiting', short: summary.short }
}

// PICK ANYWAY on /owner: a waiting order (or one dispatched with lines still to
// come) back to NEW now — the customer wants what is in stock sent. It is not
// parked again by the sync (grown_at is set).
export async function pickAnyway(dbc, { orderId }, profileId, now = new Date()) {
  const at = now.toISOString()
  const o = await must(dbc.from('orders').select('id, party_name, stage, closed_at').eq('id', String(orderId || '')).maybeSingle(), 'reading order')
  if (!o || o.closed_at) return { status: 404, error: 'That order is no longer open.' }
  if (o.stage !== 'waiting' && o.stage !== 'dispatched') return { status: 409, error: 'This order is already on the floor (new, picking or being packed) — nothing to pull back.' }
  const moved = await must(dbc.from('orders').update({ stage: 'new', stage_since: at, grown_at: at, grown_reason: 'manual' })
    .eq('id', o.id).eq('stage', o.stage).is('closed_at', null).select('id'), 'moving order to NEW')
  if (!moved.length) return { status: 409, error: 'This order has just changed — reload and try again.' }
  const [, overview] = await Promise.all([
    must(dbc.from('order_events').insert({ order_id: o.id, event: 'grown', profile_id: profileId, payload: { reason: 'manual', from: o.stage, note: 'PICK ANYWAY on the owner page' } }), 'recording pick anyway'),
    materialOverview(dbc, now),
  ])
  return { status: 200, stage: 'new', name: o.party_name || '', overview }
}

// Undo MARK ORDERED (tapped by mistake).
export async function unmarkOrdered(dbc, { id }, now = new Date()) {
  const rows = await must(dbc.from('procurement').update({ ordered_at: null, ordered_by: null, expected_date: null }).eq('id', String(id || '')).is('closed_at', null).select('id'), 'undoing ordered')
  if (!rows.length) return { status: 404, error: 'That item is no longer on the list.' }
  return { status: 200, ordered: false, overview: await materialOverview(dbc, now) }
}

// MARK N ORDERED on /owner: several items, one arrival date, saved together.
export async function markManyOrdered(dbc, { ids, days, date }, profileId, now = new Date()) {
  const { day, error: dayError } = arrivalDay({ days, date }, now)
  if (dayError) return { status: 400, error: dayError }
  const list = [...new Set(Array.isArray(ids) ? ids.map(String) : [])].filter(x => UUID.test(x))
  if (!list.length) return { status: 400, error: 'Tick the items to mark ordered.' }
  if (list.length > 300) return { status: 400, error: 'At most 300 items at a time.' }
  const [rows] = await Promise.all([
    must(dbc.from('procurement').update({ ordered_by: profileId, expected_date: day }).in('id', list).is('closed_at', null).select('id, item_code, item_name'), 'saving ordered items'),
    must(dbc.from('procurement').update({ ordered_at: now.toISOString() }).in('id', list).is('closed_at', null).is('ordered_at', null).select('id'), 'saving ordered day'),
  ])
  if (!rows.length) return { status: 404, error: 'None of those items is still on the list (the stock may have arrived).' }
  const overview = await materialOverview(dbc, now)
  const events = []
  for (const row of rows) {
    for (const p of overview.parties.filter(x => x.pending.some(l => l.itemCode === row.item_code))) {
      events.push({ order_id: p.id, event: 'material_ordered', profile_id: profileId, payload: { item_code: row.item_code, item: row.item_name, expected_date: day, all_ordered: p.status === 'green', bulk: true } })
    }
  }
  if (events.length) await must(dbc.from('order_events').insert(events), 'recording material ordered')
  return { status: 200, count: rows.length, skipped: list.length - rows.length, expectedDate: day, overview }
}

// CLEAR pending lines in the portal (admins): Busy's sales order is not changed.
// The lines stop counting as pending everywhere; if nothing else is pending and
// the goods have left, the order closes.
export async function clearLines(dbc, { orderId, lineNos }, profileId, now = new Date(), { overview = true } = {}) {
  const key = String(orderId || '')
  const [o, lines] = await Promise.all([
    must(dbc.from('orders').select('id, party_name, stage, closed_at').eq('id', key).maybeSingle(), 'reading order'),
    readLines(dbc, [key], { pendingOnly: false }),
  ])
  if (!o || o.closed_at) return { status: 404, error: 'That order is no longer open.' }
  const want = Array.isArray(lineNos) && lineNos.length ? new Set(lineNos.map(Number)) : null
  const targets = lines.filter(l => openQty(l) > 0 && (!want || want.has(l.line_no)))
  if (!targets.length) return { status: 400, error: 'Nothing pending to clear on this order.' }
  const at = now.toISOString()
  const left = lines.filter(l => !targets.includes(l) && openQty(l) > 0)
  // Every line and the history entry at the same time.
  await Promise.all([
    // cleared_qty covers everything pending now (including anything cleared before).
    ...targets.map(l => must(dbc.from('order_lines').update({ cleared_at: at, cleared_by: profileId, cleared_qty: Number(l.pending_qty) })
      .eq('order_id', o.id).eq('line_no', l.line_no), 'clearing line')),
    must(dbc.from('order_events').insert({
      order_id: o.id, event: 'lines_cleared', profile_id: profileId,
      payload: { lines: targets.map(l => ({ line_no: l.line_no, item: l.item_name, qty: openQty(l) })), note: "cleared in the portal; Busy's sales order not changed" },
    }), 'recording cleared lines'),
  ])
  let closed = false
  if (!left.length && (o.stage === 'dispatched' || o.stage === 'waiting')) {
    const done = await must(dbc.from('orders').update({ closed_at: at, closed_reason: 'complete' }).eq('id', o.id).is('closed_at', null).select('id'), 'closing order')
    if (done.length) {
      closed = true
      await must(dbc.from('order_events').insert({ order_id: o.id, event: 'closed', profile_id: profileId, payload: { reason: 'complete', note: 'pending lines cleared in the portal' } }), 'recording close')
    }
  }
  return { status: 200, cleared: targets.length, closed, stillPending: left.length, ...(overview ? { overview: await materialOverview(dbc, now) } : {}) }
}

// CLEAR ALL PENDING on several orders at once (/owner bulk): each order as Clear does it,
// then the fresh lists once. Orders that changed meanwhile are reported, not fatal.
export async function clearManyOrders(dbc, { orders }, profileId, now = new Date()) {
  const list = Array.isArray(orders) ? orders.filter(o => o && o.orderId).slice(0, 200) : []
  if (!list.length) return { status: 400, error: 'Tick the orders to clear.' }
  const results = []
  for (let i = 0; i < list.length; i += 5) {
    results.push(...await Promise.all(list.slice(i, i + 5).map(o => clearLines(dbc, o, profileId, now, { overview: false }).then(r => ({ orderId: o.orderId, ...r })))))
  }
  const ok = results.filter(r => r.status === 200)
  if (!ok.length) return { status: 409, error: results[0].error || 'Nothing could be cleared.' }
  return {
    status: 200, orders: ok.length, cleared: ok.reduce((s, r) => s + r.cleared, 0), closed: ok.filter(r => r.closed).length,
    failed: results.filter(r => r.status !== 200).map(r => ({ orderId: r.orderId, error: r.error })),
    overview: await materialOverview(dbc, now),
  }
}

// Every line cleared in the portal between two days (IST), for the Excel export.
export async function clearedLines(dbc, { from, to }) {
  const start = new Date(`${from}T00:00:00+05:30`).toISOString()
  const end = new Date(Date.parse(`${to}T00:00:00+05:30`) + 86400000).toISOString()
  const rows = await must(dbc.from('order_lines').select('order_id, line_no, item_name, ordered_qty, invoiced_qty, cleared_qty, cleared_at, cleared_by')
    .gte('cleared_at', start).lt('cleared_at', end).order('cleared_at'), 'reading cleared lines')
  const ids = [...new Set(rows.map(r => r.order_id))]
  const people = [...new Set(rows.map(r => r.cleared_by).filter(Boolean))]
  const orders = new Map(), names = new Map()
  for (let i = 0; i < ids.length; i += CHUNK) {
    for (const o of await must(dbc.from('orders').select('id, so_vch_no, so_date, party_name, party_city').in('id', ids.slice(i, i + CHUNK)), 'reading orders')) orders.set(o.id, o)
  }
  if (people.length) for (const p of await must(dbc.from('profiles').select('id, name, email').in('id', people), 'reading names')) names.set(p.id, p.name || String(p.email || '').split('@')[0])
  return rows.map(r => {
    const o = orders.get(r.order_id) || {}
    return {
      party: o.party_name || '', city: o.party_city || '', soNo: o.so_vch_no || '', soDate: o.so_date || '',
      lineNo: r.line_no, item: r.item_name || '', ordered: Number(r.ordered_qty), invoiced: Number(r.invoiced_qty),
      qty: r3(Number(r.cleared_qty)),
      clearedBy: names.get(r.cleared_by) || '', clearedAt: r.cleared_at,
    }
  })
}
