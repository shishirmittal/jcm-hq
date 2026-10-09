import { db, must } from '../lib/db.js'
import { findAdmin, send, fail, nameMap } from '../lib/auth.js'
import { readTabletStaff, staffView, can, stagesFor } from '../lib/staff.js'
import { afterDispatch } from '../lib/dispatch.js'
import { whatsappSettings, whatsappNumber, showNumber } from '../lib/whatsapp.js'
import { materialOverview, markOrdered, unmarkOrdered, waitForMaterial, lineStock, readStock } from '../lib/material.js'
import { queueLabels, jobStatus } from '../lib/labeljobs.js'
import { selectTolerant } from '../lib/columns.js'
import { decodePhoto, photoPath, savePhoto, removePhoto } from '../lib/lrphoto.js'
import { withTiming } from '../lib/timing.js'

// JCM HQ copy of jcm-orders api/tablet.js: the Orders tab (pick, check, ready,
// dispatch with LR photo, labels, wait for material) for people signed in to HQ.
// No registered device and no second PIN: the HQ sign-in says who it is
// (findAdmin with req.hqTab = 'floor-orders': admins, or people given the
// Orders tab in Manage Users), and the jobs ticked for them under Warehouse &
// Devices → Tablet staff decide what they may do, exactly as on the tablet.
// Keep the rules in step with jcm-orders api/tablet.js while both run.
// Reached as /api/orders?h=floor&op=… (GET) or { op } (POST).
//
//   GET  ?op=ping                         keep-warm (JCM-Server, every few minutes): no device needed
//   GET  ?op=orders                       open orders this person may see (home cards and lists)
//   GET  ?op=order&id=…                   one order, with its lines and Busy's stock for each
//                                         (item list on the order screen, dispatch sheet)
//   POST { op: 'pick' | 'check' | 'ready' | 'dispatch', id, boxes?, labels?, photo? }
//   POST { op: 'wait', id }               WAIT FOR MATERIAL on a NEW order (the pick job)
//        Every move answers with the fresh home lists too, so the screen needs no second call.
//        ready: labels 'print' (default) or 'skip' — recorded on the history entry
//        dispatch: photo = the LR photo as a data URL (none = dispatch without photo);
//        it is saved to storage before the order moves, then goes out on the WhatsApp
//        ready + PRINT LABELS also queues a label job → { labelJob } (or { labelError })
//   POST { op: 'print_labels', id, boxNumbers? }  REPRINT: a new job for the network label printer → { jobId }
//                                         boxNumbers = only those boxes (e.g. [2, 5]); none = all
//   GET  ?op=label_job&id=…               that job: queued / printing / printed / failed (+ error)
//   GET  ?op=material                     items to order, by supplier
//   POST { op: 'material_ordered', id, days | date }   MARK ORDERED + when it will arrive (→ fresh items)
//   POST { op: 'material_unordered', id }  undo (→ fresh items)
//
// The rules are enforced here, not only in the screen: each person may only see
// and do the jobs ticked for them on /admin (see _lib/staff.js). Each move is
// conditional on the stage it moves from, so two taps at once cannot both win,
// and each records who, on which device, and when.
//
// Speed: the database is far from the tablet, so reads that do not depend on
// each other are made at the same time (Promise.all), and the session is
// remembered for 30 s (_lib/staff.js). test/latency.mjs counts the waits per tap.
const WINDOW_MINUTES = 15
const MAX_WRONG = 5
const ORDER_COLS = 'id, so_vch_no, so_date, party_name, party_city, party_address, party_mobile, party_gstin, line_count, stage, stage_since, picker_id, checker_id, dispatcher_id, invoice_vch_no, invoice_value, boxes, expected_date, hidden_until'
// Phase 6 / Phase 5 columns: used when the database has them (see _lib/columns.js).
const ORDER_COLS_NEW = `${ORDER_COLS}, grown_at, grown_reason`
const LINE_COLS = 'line_no, item_code, item_name, ordered_qty, invoiced_qty, pending_qty'

const MOVES = {
  pick: { from: 'new', to: 'picking', who: 'picker_id', event: 'pick', job: 'pick', no: 'Picking is not ticked for you on the admin page.' },
  check: { from: 'invoiced', to: 'checked', who: 'checker_id', event: 'checked', job: 'check', no: 'Checking against the invoice is not ticked for you on the admin page.' },
  ready: { from: 'checked', to: 'in_bay', event: 'in_bay', job: 'ready', no: 'Ready for dispatch is not ticked for you on the admin page.' },
  dispatch: { from: 'in_bay', to: 'dispatched', who: 'dispatcher_id', event: 'dispatched', job: 'dispatch', no: 'Dispatch is not ticked for you on the admin page.' },
}
const meView = me => ({ id: me.id, name: me.name, initials: me.initials, role: me.role, jobs: me.jobs })

const body = req => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {})
const query = req => new URL(req.url || '/', 'http://x').searchParams

// Who tapped READY FOR DISPATCH is in the event history, not on the order row.
async function packers(dbc, orderIds) {
  const map = new Map()
  if (!orderIds.length) return map
  const rows = await must(dbc.from('order_events').select('order_id, profile_id, at').eq('event', 'in_bay').in('order_id', orderIds).order('at'), 'reading packers')
  for (const r of rows) map.set(r.order_id, r.profile_id)
  return map
}

function view(o, who) {
  return {
    id: o.id, soNo: o.so_vch_no, soDate: o.so_date, name: o.party_name || o.so_vch_no, city: o.party_city || '',
    lines: o.line_count, stage: o.stage, stageSince: o.stage_since,
    invoiceNo: o.invoice_vch_no || '', invoiceValue: o.invoice_value, boxes: o.boxes,
    pickerId: o.picker_id, picker: who.get(o.picker_id) || '', checker: who.get(o.checker_id) || '',
    packer: who.get(o.packerId) || '', expectedDate: o.expected_date, grownAt: o.grown_at, grownReason: o.grown_reason,
  }
}

// The home cards and stage lists: { me, orders, materialCount }.
async function homeData(dbc, me) {
  const stages = [...stagesFor(me)]
  const [all, materialCount] = await Promise.all([
    stages.length ? must(selectTolerant(cols => dbc.from('orders').select(cols).is('closed_at', null).in('stage', stages), ORDER_COLS_NEW, ORDER_COLS), 'reading orders') : [],
    // The PENDING MATERIAL card's count: items still to order.
    can(me, 'material') ? dbc.from('procurement').select('id').is('closed_at', null).is('ordered_at', null).then(r => (Array.isArray(r.data) ? r.data.length : null)) : null,
  ])
  // Every open order in this person's stages (orders.hidden_until is ignored, as on the TV and /owner).
  const rows = all
  const pk = await packers(dbc, rows.filter(o => o.stage === 'in_bay').map(o => o.id))
  for (const o of rows) o.packerId = pk.get(o.id)
  const who = await nameMap(dbc, rows.flatMap(o => [o.picker_id, o.checker_id, o.packerId]))
  return { me: meView(me), orders: rows.map(o => view(o, who)), materialCount }
}

async function handler(req, res) {
  try {
    const dbc = db()
    const b = req.method === 'POST' ? body(req) : {}
    const op = req.method === 'GET' ? query(req).get('op') : b.op

    // Keep-warm from JCM-Server: wakes this function and its database connection.
    if (req.method === 'GET' && op === 'ping') {
      await readTabletStaff(dbc)
      return send(res, 200, { ok: true })
    }

    // Who is asking: their HQ sign-in, and the jobs ticked for them. There is no
    // device here; events are recorded with device_id null (allowed by the table).
    const device = { id: null, name: 'JCM HQ' }
    const [profile, cfg] = await Promise.all([findAdmin(dbc, req), readTabletStaff(dbc)])
    if (!profile) return send(res, 401, { error: 'signed_out' })
    const me = staffView(profile, cfg)
    // Someone given the Orders tab but not put on the tablet staff list gets no
    // jobs until an admin ticks them (otherwise the old default jobs would apply).
    if (me.role !== 'admin' && !cfg.staff.includes(profile.id)) me.jobs = []

    if (req.method === 'GET' && op === 'orders') return send(res, 200, await homeData(dbc, me))

    if (req.method === 'GET' && op === 'order') {
      const id = query(req).get('id')
      const [o, lines, pk] = await Promise.all([
        must(selectTolerant(cols => dbc.from('orders').select(cols).eq('id', id).maybeSingle(), ORDER_COLS_NEW, ORDER_COLS), 'reading order'),
        must(selectTolerant(cols => dbc.from('order_lines').select(cols).eq('order_id', id).order('line_no'), `${LINE_COLS}, line_value, cleared_at, cleared_qty`, LINE_COLS), 'reading lines'),
        packers(dbc, [id]),
      ])
      if (!o) return send(res, 404, { error: 'That order is no longer open.' })
      if (!stagesFor(me).has(o.stage)) return send(res, 403, { error: 'This order is not in one of your jobs.' })
      o.packerId = pk.get(o.id)
      // Busy's stock per line (stock_cache, kept fresh by the 3-minute sync).
      const [who, stockByItem] = await Promise.all([nameMap(dbc, [o.picker_id, o.checker_id, o.packerId]), readStock(dbc, lines.map(l => l.item_code))])
      const stock = lineStock(lines, stockByItem)
      return send(res, 200, {
        order: {
          ...view(o, who), address: o.party_address || '', mobile: o.party_mobile || '', gstin: o.party_gstin || '',
          whatsapp: { live: whatsappSettings().live, to: showNumber(whatsappNumber(o.party_mobile)) },
          lines: lines.map((l, i) => ({
            lineNo: l.line_no, itemCode: l.item_code, item: l.item_name || '', ordered: l.ordered_qty, invoiced: l.invoiced_qty,
            pending: stock.lines[i].need, value: l.line_value,
            stock: stock.lines[i].status, short: stock.lines[i].short, available: stock.lines[i].available ?? null,
          })),
          stockSummary: stock.summary,
        },
      })
    }

    if (req.method === 'POST' && op === 'wait') {
      if (!can(me, 'pick')) return send(res, 403, { error: MOVES.pick.no })
      const { status, ...rest } = await waitForMaterial(dbc, String(b.id || ''), me.id, device.id)
      if (status !== 200) return send(res, status, rest)
      return send(res, 200, { ok: true, ...rest, ...await homeData(dbc, me) })
    }

    if (req.method === 'POST' && MOVES[op]) {
      const move = MOVES[op]
      if (!can(me, move.job)) return send(res, 403, { error: move.no })
      const id = String(b.id || '')
      const change = { stage: move.to, stage_since: new Date().toISOString() }
      if (move.who) change[move.who] = me.id
      const payload = {}
      if (op === 'ready') {
        const boxes = Number(b.boxes)
        if (!Number.isInteger(boxes) || boxes < 1 || boxes > 99) return send(res, 400, { error: 'Enter the number of boxes (1 to 99).' })
        change.boxes = boxes
        payload.boxes = boxes
        // PRINT LABELS or SKIP LABELS: either way the boxes are saved and the order is ready.
        payload.labels = b.labels === 'skip' ? 'skipped' : 'print'
      }
      // DISPATCHED with the LR photo: the photo is saved first, so a dispatch never
      // claims a photo that is not there. If saving fails, nothing moves.
      let lrPath = null
      if (op === 'dispatch' && b.photo) {
        const photo = decodePhoto(b.photo)
        if (photo.error) return send(res, 400, { error: photo.error })
        const o = await must(dbc.from('orders').select('so_vch_no, stage').eq('id', id).maybeSingle(), 'reading order')
        if (!o || o.stage !== move.from) return send(res, 409, { error: 'This order has already been moved on by someone else.' })
        lrPath = photoPath(o.so_vch_no)
        const problem = await savePhoto(dbc, lrPath, photo)
        if (problem) {
          console.error('LR photo upload failed:', problem)
          return send(res, 502, { error: 'The photo could not be saved, so the order was NOT dispatched. Check the internet and tap SEND again.' })
        }
      }
      if (op === 'dispatch') payload.lr_photo = lrPath
      const moved = await must(dbc.from('orders').update(change).eq('id', id).eq('stage', move.from).is('closed_at', null).select('id'), 'moving order')
      if (!moved.length) {
        if (lrPath) await removePhoto(dbc, lrPath)
        return send(res, 409, { error: 'This order has already been moved on by someone else.' })
      }
      // The history entry, what follows the move, and the fresh home lists — at the same time.
      const [, extra, home] = await Promise.all([
        must(dbc.from('order_events').insert({ order_id: id, event: move.event, profile_id: me.id, device_id: device.id, payload }), 'recording event'),
        (async () => {
          // After a dispatch: the WhatsApp to the customer, with the LR photo when there is one
          // (recorded, sent only when switched on).
          if (op === 'dispatch') return afterDispatch(dbc, id, me, device, { photoPath: lrPath })
          // PRINT LABELS: straight into the printer queue (the move above stands either way).
          if (op === 'ready' && payload.labels === 'print') {
            const q = await queueLabels(dbc, id, me, device)
            return q.jobId ? { labelJob: q.jobId } : { labelError: q.error }
          }
          return {}
        })(),
        homeData(dbc, me),
      ])
      return send(res, 200, { ok: true, stage: move.to, ...extra, ...home })
    }

    // Labels: (re)print through the network printer queue, and follow the job.
    if (req.method === 'POST' && op === 'print_labels') {
      if (!can(me, 'ready') && !can(me, 'dispatch')) return send(res, 403, { error: 'Labels are part of the Ready for dispatch job.' })
      const { status, ...rest } = await queueLabels(dbc, String(b.id || ''), me, device, { reprint: b.reprint !== false, boxNumbers: b.boxNumbers })
      return send(res, status, rest)
    }
    if (req.method === 'GET' && op === 'label_job') {
      const { status, ...rest } = await jobStatus(dbc, query(req).get('id'))
      return send(res, status, rest)
    }

    if (op === 'material' || op === 'material_ordered' || op === 'material_unordered') {
      if (!can(me, 'material')) return send(res, 403, { error: 'Pending material is not ticked for you on the admin page.' })
      if (req.method === 'GET') { const { items, today } = await materialOverview(dbc); return send(res, 200, { items, today }) }
      const { status, overview, ...rest } = op === 'material_unordered' ? await unmarkOrdered(dbc, b) : await markOrdered(dbc, b, me.id)
      return send(res, status, overview ? { ...rest, items: overview.items, today: overview.today } : rest)
    }

    send(res, 400, { error: 'Unknown request.' })
  } catch (err) {
    fail(res, err)
  }
}

export default withTiming('floor', handler)
