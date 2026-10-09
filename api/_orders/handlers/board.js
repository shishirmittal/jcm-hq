import { db, must } from '../lib/db.js'
import { findAdmin, send, fail, nameMap } from '../lib/auth.js'
import { withTiming } from '../lib/timing.js'
import { readThresholds } from '../lib/config.js'
import { selectTolerant } from '../lib/columns.js'
import { materialOverview } from '../lib/material.js'

// JCM HQ copy of jcm-orders api/board.js for the live preview on Warehouse &
// Devices → TV display: the same answer the TV gets, but for a signed-in HQ
// admin instead of a registered screen. Keep in step with api/board.js.
// GET /api/orders?h=board
//
// Columns: new · picking · invoiced (invoiced + checked) · ready (in_bay) · waiting.
// "Waiting for material" is the same list as /owner's parties waiting
// (_lib/material.js): every open order whose invoice left lines pending — from
// the moment the invoice is partial, so an order can show in its own column
// AND as a small waiting card for the part still to come — and every order
// parked before picking (stage 'waiting': WAIT FOR MATERIAL on the tablet, or all
// lines short), which shows only here. NOT ORDERED (red) until all its pending
// items are marked ordered, then ORDERED with the expected date.
// Also sent: the TV display settings (orders_config 'tv_display', v2 design:
// cards per column, text size, scroll speed, late style, SO / invoice numbers;
// null = defaults) and when the Busy sync last finished (BUSY SYNC marker).
const COLUMN_OF_STAGE = { new: 'new', picking: 'picking', invoiced: 'invoiced', checked: 'invoiced', in_bay: 'ready' }
// grown_reason comes with Phase 6's database script; the board works without it.
const BOARD_COLS = 'id, so_vch_no, invoice_vch_no, so_created_at, party_name, party_city, line_count, stage, stage_since, picker_id, checker_id, boxes, hidden_until'

const istMidnight = now => {
  const day = new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10)
  return new Date(`${day}T00:00:00+05:30`)
}

async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' })
  try {
    const dbc = db()
    // Keep-warm (JCM-Server): no device needed, answers { ok }.
    if (new URL(req.url || '/', 'http://x').searchParams.get('ping')) {
      await readThresholds(dbc)
      return send(res, 200, { ok: true })
    }
    const now = new Date()
    // Everything at once; nothing is sent unless the device checks out.
    const [device, thresholds, orders, dispatchedEvents, { parties }, display, lastSync] = await Promise.all([
      findAdmin(dbc, req),
      readThresholds(dbc),
      must(selectTolerant(cols => dbc.from('orders').select(cols).is('closed_at', null), `${BOARD_COLS}, grown_reason`, BOARD_COLS), 'reading orders'),
      must(dbc.from('order_events').select('order_id').eq('event', 'dispatched').gte('at', istMidnight(now).toISOString()), 'reading dispatches'),
      materialOverview(dbc, now),
      // How the board looks (v2 design): cards per column, text size, speed… (defaults when not set).
      must(dbc.from('orders_config').select('value').eq('key', 'tv_display').maybeSingle(), 'reading TV display settings').then(r => (r && r.value) || null),
      // When the Busy sync last finished, for the header's BUSY SYNC marker.
      must(dbc.from('orders_sync_log').select('run_at').eq('status', 'success').order('run_at', { ascending: false }).range(0, 0), 'reading last sync').then(r => (r[0] ? r[0].run_at : null)),
    ])
    if (!device) return send(res, 401, { error: 'Please sign in again.' })

    // Every open order shows. (orders.hidden_until is ignored: nothing sets it, and
    // hiding on the TV what /owner and the tablet show made them disagree — SO 763.)
    const visible = orders

    // First names for the PICKING / CHECKED tags.
    const full = await nameMap(dbc, visible.flatMap(o => [o.picker_id, o.checker_id]))
    const names = new Map([...full].map(([id, n]) => [id, n.split(/\s+/)[0]]))

    const cards = []
    for (const o of visible) {
      const column = COLUMN_OF_STAGE[o.stage]
      if (!column) continue
      cards.push({
        id: o.id,
        column,
        stage: o.stage,
        name: o.party_name || o.so_vch_no,
        soNo: o.so_vch_no,
        invoiceNo: o.invoice_vch_no || '',
        lines: o.line_count,
        createdAt: o.so_created_at,
        stageSince: o.stage_since,
        picker: o.picker_id ? names.get(o.picker_id) || '' : '',
        checker: o.checker_id ? names.get(o.checker_id) || '' : '',
        boxes: o.boxes,
        grownReason: o.stage === 'new' ? o.grown_reason || '' : '',
      })
    }
    // Waiting cards: red and green only. Amber (short items, still in NEW / PICKING)
    // is on /owner but not here — those orders already have their card in NEW / PICKING.
    for (const p of parties.filter(x => !x.floor)) {
      cards.push({
        id: `${p.id}#waiting`, column: 'waiting', stage: p.stage, name: p.name, soNo: p.soNo, invoiceNo: p.invoiceNo,
        lines: p.lineCount, stageSince: p.waitingSince,
        createdAt: p.createdAt, pendingLines: p.pending.length, waitingStatus: p.status, expectedDate: p.expectedDate, overdue: p.overdue,
      })
    }

    // Oldest first: longest in its stage at the top. Waiting: soonest expected first.
    const byAge = (a, b) => Date.parse(a.stageSince) - Date.parse(b.stageSince)
    // Each column is sorted on its own (one rule per column keeps the sort consistent).
    cards.sort((a, b) => {
      if (a.column !== b.column) return a.column.localeCompare(b.column)
      if (a.column === 'waiting') {
        // Not all ordered (red) first, then soonest expected.
        const ea = a.expectedDate || '0000-00-00', eb = b.expectedDate || '0000-00-00'
        return ea.localeCompare(eb) || byAge(a, b)
      }
      return byAge(a, b)
    })

    const open = cards.filter(c => c.column !== 'waiting').length
    send(res, 200, {
      now: now.toISOString(),
      device: { name: 'Preview' },
      thresholds,
      display,
      lastSyncAt: lastSync,
      counters: {
        open,
        dispatchedToday: new Set(dispatchedEvents.map(e => e.order_id)).size,
        waiting: cards.length - open,  // orders waiting for material (some also still in a column above)
      },
      cards,
    })
  } catch (err) {
    fail(res, err)
  }
}

export default withTiming('board-preview', handler)
