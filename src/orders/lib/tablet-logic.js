// What the staff tablet shows, from "JCM Orders - Staff Tablet.dc.html".
// No React here, so it can be tested on its own.
import { formatElapsed, shortSo, shortInv } from './board-logic.js'

const TZ = 'Asia/Kolkata'
export const STAGE_COLOR = { new: '#D98E2B', picking: '#2E7D5B', invoiced: '#2F5FA3', checked: '#2F5FA3', in_bay: '#12213B' }
const STEP_KEYS = ['new', 'picking', 'invoiced', 'checked', 'in_bay']
const STEP_LABELS = ['New', 'Picking', 'Invoiced', 'Checked', 'Ready']

// Jobs ticked for this person on /admin (admins can do everything); the server checks them too.
export const can = (me, job) => !!me && (me.role === 'admin' || (me.jobs || []).includes(job))
export const roleLabel = role => (role === 'admin' ? 'Admin' : '')

export const shortDate = iso => {
  if (!iso) return ''
  const d = new Date(String(iso).length === 10 ? `${iso}T12:00:00+05:30` : iso)
  return isNaN(d) ? '' : new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' }).format(d)
}

export const firstName = n => String(n || '').trim().split(/\s+/)[0] || ''

// The home screen: one big card per job this person has.
//   NEW (to pick) · PICKING · INVOICED (to check) · READY FOR DISPATCH · PENDING MATERIAL
// READY FOR DISPATCH holds orders to pack (checked, "ready" job) and orders
// packed and waiting to leave (in bay, "ready" or "dispatch" job).
export const CARDS = [
  { key: 'new', title: 'NEW', sub: 'to pick', color: STAGE_COLOR.new, jobs: ['pick'] },
  { key: 'picking', title: 'PICKING', sub: 'waiting for invoice', color: STAGE_COLOR.picking, jobs: ['pick'] },
  { key: 'invoiced', title: 'INVOICED', sub: 'to check', color: STAGE_COLOR.invoiced, jobs: ['check'] },
  { key: 'ready', title: 'READY FOR DISPATCH', sub: '', color: STAGE_COLOR.in_bay, jobs: ['ready', 'dispatch'] },
  { key: 'material', title: 'PENDING MATERIAL', sub: 'to order', color: '#9A5F10', jobs: ['material'] },
]

export function cardOrders(orders, key, me) {
  const want = o => {
    if (key === 'new' || key === 'picking' || key === 'invoiced') return o.stage === key
    if (key === 'ready') return (o.stage === 'checked' && can(me, 'ready')) || (o.stage === 'in_bay' && (can(me, 'ready') || can(me, 'dispatch')))
    return false
  }
  return orders.filter(want).sort((a, b) => Date.parse(a.stageSince) - Date.parse(b.stageSince))
}

// The cards this person sees, with counts and the oldest wait.
export function homeCards(orders, me, materialCount, nowMs) {
  return CARDS.filter(c => c.jobs.some(j => can(me, j))).map(c => {
    if (c.key === 'material') return { ...c, count: materialCount ?? null, sub: 'items to order', oldest: '' }
    const list = cardOrders(orders, c.key, me)
    let sub = c.sub
    if (c.key === 'ready') {
      const pack = list.filter(o => o.stage === 'checked').length, go = list.filter(o => o.stage === 'in_bay').length
      sub = [can(me, 'ready') && `${pack} to pack`, `${go} to dispatch`].filter(Boolean).join(' · ')
    }
    return { ...c, count: list.length, sub, oldest: list.length ? formatElapsed(nowMs - Date.parse(list[0].stageSince)) : '' }
  })
}

// The search box above a stage list: party name (or city / SO number), any part, any case.
export function searchOrders(list, text) {
  const q = String(text || '').trim().toLowerCase()
  if (!q) return list
  return list.filter(o => [o.name, o.city, o.soNo].some(v => String(v || '').toLowerCase().includes(q)))
}

export function badge(o) {
  const label = o.stage === 'in_bay' ? (o.boxes ? `READY · ${o.boxes} ${o.boxes === 1 ? 'BOX' : 'BOXES'}` : 'READY') : o.stage.toUpperCase()
  return { label, bg: STAGE_COLOR[o.stage] || '#8A8F99', fg: o.stage === 'new' ? '#0C111B' : '#FFFFFF' }
}

export function steps(stage) {
  const i = STEP_KEYS.indexOf(stage)
  return STEP_LABELS.map((l, j) => j < i
    ? { label: `✓ ${l}`, bd: '#12213B', bg: 'transparent', fg: '#12213B' }
    : j === i ? { label: l, bd: STAGE_COLOR[stage], bg: STAGE_COLOR[stage], fg: i === 0 ? '#0C111B' : '#FFFFFF' }
      : { label: l, bd: '#C9C4B8', bg: 'transparent', fg: '#7A7F89' })
}

export function meta(o, full) {
  const parts = [shortSo(o.soNo)]
  if (o.invoiceNo && o.stage !== 'new' && o.stage !== 'picking') parts.push(`Invoice ${shortInv(o.invoiceNo)}`)
  else if (o.soDate) parts.push(full ? `Ordered ${shortDate(o.soDate)}` : shortDate(o.soDate))
  parts.push(`${o.lines} ${o.lines === 1 ? 'line' : 'lines'}`)
  return parts.filter(Boolean).join(' · ')
}

export function who(o) {
  switch (o.stage) {
    case 'new': return 'Not assigned yet'
    case 'picking': return o.picker || ''
    case 'invoiced': return o.picker ? `Picked by ${firstName(o.picker)}` : ''
    case 'checked': return o.checker ? `Checked by ${firstName(o.checker)}` : ''
    case 'in_bay': return o.packer ? `Packed by ${firstName(o.packer)}` : ''
    default: return ''
  }
}

export function helper(o) {
  switch (o.stage) {
    case 'new': return 'Take the printed Busy sales order sheet for this order. Tapping the button puts your name on it. If the material is not there, tap WAIT FOR MATERIAL instead.'
    case 'picking': return 'When picking is done, hand the sheet to the billing desk. This order moves on by itself once the invoice is made in Busy.'
    case 'invoiced': return `Check the goods against printed invoice ${o.invoiceNo || ''}.`.replace(' .', '.')
    case 'checked': return 'Pack the goods. Next you will say how many boxes, and the labels will print.'
    case 'in_bay': return 'When the boxes are loaded, tap UPLOAD LR and photograph the LR / transport receipt (or pick it from the gallery) — sending it marks the order dispatched. For a self-pickup, use “Dispatch without photo”.'
    default: return ''
  }
}

// Exactly one main button per screen, if this person has that job.
// UPLOAD LR asks for the LR photo (camera or gallery); sending it marks the order dispatched.
export function action(o, me) {
  switch (o.stage) {
    case 'new': return can(me, 'pick') ? { label: "I'M PICKING THIS", kind: 'primary', op: 'pick' } : { label: 'NOT YOUR JOB', kind: 'off' }
    case 'picking': return { label: 'WAITING FOR INVOICE', kind: 'off' }
    case 'invoiced': return can(me, 'check') ? { label: 'CHECKED AGAINST INVOICE', kind: 'primary', op: 'check' } : { label: 'CHECKER CHECKS THIS', kind: 'off' }
    case 'checked': return can(me, 'ready') ? { label: 'READY FOR DISPATCH', kind: 'primary', op: 'boxes' } : { label: 'BEING PACKED', kind: 'off' }
    case 'in_bay': return can(me, 'dispatch') ? { label: 'UPLOAD LR', kind: 'confirm', op: 'photo' } : { label: 'DISPATCH PERSON SENDS THIS', kind: 'off' }
    default: return { label: 'NOTHING TO DO', kind: 'off' }
  }
}

// Under the main button on a NEW order: park it until the material arrives.
export const secondary = (o, me) => (o.stage === 'new' && can(me, 'pick') ? { label: 'WAIT FOR MATERIAL', op: 'wait' } : null)

// On an order back from waiting for material:
//   stock   "Stock arrived 5 Oct — pick today"
//   date    red: the expected date came but Busy has no stock for it yet
//   manual  PICK ANYWAY on the owner page: send what is in stock
export function arrived(o) {
  if (o.stage !== 'new' || !o.grownReason) return ''
  if (o.grownReason === 'stock') return `Stock arrived ${shortDate(o.grownAt)} — pick today`
  if (o.grownReason === 'manual') return `Pick anyway — send what is in stock (${shortDate(o.grownAt)})`
  return `Expected ${shortDate(o.expectedDate || o.grownAt)} — not in Busy stock yet. Check and pick today`
}
export const arrivedRed = o => o.stage === 'new' && o.grownReason === 'date'

// The item list on the order screen: one marker per line from Busy's stock.
const fmtQ = q => (Number.isInteger(Number(q)) ? String(Number(q)) : String(Math.round(Number(q) * 1000) / 1000))
export function stockMarker(l) {
  switch (l.stock) {
    case 'in_stock': return { text: 'In stock', kind: 'green' }
    case 'short': return { text: `Short: ${fmtQ(l.short)} of ${fmtQ(l.pending)}`, kind: 'red', note: Number(l.available) > 0 ? `${fmtQ(l.available)} in stock` : 'none in stock' }
    case 'cleared': return { text: 'Cleared', kind: 'grey' }
    case 'billed': return { text: 'Billed', kind: 'grey' }
    default: return { text: '', kind: 'grey' }
  }
}
// "12 lines · 2 short" (and how many were cleared in the portal, when any).
export function stockLine(sum) {
  if (!sum) return ''
  const parts = [`${sum.lines} ${sum.lines === 1 ? 'line' : 'lines'}`, sum.short ? `${sum.short} short` : sum.open ? 'all in stock' : '']
  if (sum.cleared) parts.push(`${sum.cleared} cleared`)
  return parts.filter(Boolean).join(' · ')
}
export const qtyText = fmtQ

export const timer = (o, nowMs) => formatElapsed(nowMs - Date.parse(o.stageSince))

export const rupees = n => (n === null || n === undefined || n === '' ? '—'
  : '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Number(n))))

// The dispatch confirmation sheet's figures.
export function dispatchFacts(order) {
  const lines = order.lines || []
  const sent = lines.filter(l => Number(l.invoiced) > 0)
  const pieces = sent.reduce((s, l) => s + Number(l.invoiced), 0)
  const pending = lines.filter(l => Number(l.pending) > 0)
  const fmtQty = q => (Number.isInteger(Number(q)) ? String(Number(q)) : String(Math.round(Number(q) * 1000) / 1000))
  return {
    boxes: order.boxes || 0,
    sentLines: sent.length,
    pieces: fmtQty(pieces),
    pendingLines: pending.length,
    pendingList: pending.map(l => `${l.item || 'Item'} × ${fmtQty(l.pending)}`),
    total: order.invoiceValue,
  }
}

// Optimistic taps: the screen changes at once, the server confirms after (and
// the screen goes back, with a message, if it refuses). This is the order list
// as it will be once the server has saved the move.
export function applyMove(orders, id, op, me, extra = {}) {
  const at = new Date().toISOString()
  if (op === 'wait') return orders.filter(o => o.id !== id)
  return orders.map(o => {
    if (o.id !== id) return o
    switch (op) {
      case 'pick': return { ...o, stage: 'picking', stageSince: at, pickerId: me.id, picker: me.name, grownReason: null }
      case 'check': return { ...o, stage: 'checked', stageSince: at, checker: me.name }
      case 'ready': return { ...o, stage: 'in_bay', stageSince: at, boxes: extra.boxes, packer: me.name }
      default: return o
    }
  })
}

// Mark ordered on the tablet's pending-material list, before the server answers.
export function markItemOrdered(groups, itemId, expectedDate, at = new Date().toISOString()) {
  return groups.map(g => ({ ...g, items: g.items.map(it => (it.id === itemId ? { ...it, orderedAt: it.orderedAt || at, expectedDate, late: false } : it)) }))
}

export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
