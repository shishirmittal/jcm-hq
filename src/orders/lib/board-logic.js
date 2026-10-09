// What the TV board shows, worked out from /api/board's answer. No React here,
// so it can be tested on its own. Colours, sizes and wording follow the v2
// design: "TV board v2 design/TVBoardScreen.dc.html" and its README.
// The look is driven by the display settings (orders_config 'tv_display'):
// cards per column (3–7 → Large / Medium / Compact), text size, scroll speed,
// late style (red timer, or red timer + red edge) and SO / invoice numbers on or off.

const TZ = 'Asia/Kolkata'

export const COLUMNS = [
  { key: 'new', title: 'NEW', color: '#D98E2B', loc: '' },
  { key: 'picking', title: 'PICKING', color: '#2E7D5B', loc: 'Dispatch tables' },
  { key: 'invoiced', title: 'INVOICED / CHECKING', color: '#2F5FA3', loc: 'Dispatch tables' },
  { key: 'ready', title: 'READY FOR DISPATCH', color: '#12213B', loc: 'Dispatch bay' },
  { key: 'waiting', title: 'WAITING FOR MATERIAL', color: '#8A8F99', loc: '' },
]
const TAG_COLOR = { new: '#9A5F10', picking: '#2E7D5B', invoiced: '#2F5FA3', ready: '#12213B', notOrdered: '#C2452D', ordered: '#4A505C' }
const RED = '#C2452D'
const INK = '#0C111B'

export const DISPLAY_DEFAULTS = { cardsPerColumn: 3, textScale: 1, scrollSpeed: 'normal', lateStyle: 'timer', showRefs: true }
const SPEED = { slow: 16, normal: 26, fast: 40 } // px per second
// Column body height on the 1920 × 1080 board: 1080 − header 99 − padding 40 − column header 76 − gap 12.
export const BODY = 852, MARK = 48
// Busy sync older than this shows amber in the header.
export const SYNC_STALE_MINUTES = 10

// Settings as saved, made safe: anything missing or odd falls back to the default.
export function displaySettings(v) {
  const d = v && typeof v === 'object' ? v : {}
  const n = Math.round(Number(d.cardsPerColumn))
  const s = Number(d.textScale)
  return {
    cardsPerColumn: Number.isFinite(n) ? Math.max(3, Math.min(7, n)) : DISPLAY_DEFAULTS.cardsPerColumn,
    textScale: Number.isFinite(s) && s >= 0.8 && s <= 1.4 ? s : DISPLAY_DEFAULTS.textScale,
    scrollSpeed: SPEED[d.scrollSpeed] ? d.scrollSpeed : DISPLAY_DEFAULTS.scrollSpeed,
    lateStyle: d.lateStyle === 'edge' ? 'edge' : 'timer',
    showRefs: d.showRefs !== false,
  }
}

// Card size and text sizes for a number of cards per column.
//   3 → Large · 4–5 → Medium · 6–7 → Compact. Every card in a column is the same height.
export function layoutFor(settings) {
  const s = displaySettings(settings)
  const per = s.cardsPerColumn
  const kind = per <= 3 ? 'large' : per <= 5 ? 'medium' : 'compact'
  const gap = kind === 'compact' ? 8 : 14
  const base = kind === 'large' ? [40, 30, 22] : kind === 'medium' ? [30, 24, 20] : [24, 19, 17]
  const [name, mid, small] = base.map(v => Math.round(v * s.textScale))
  return { ...s, per, kind, gap, cardHeight: Math.floor((BODY - (per - 1) * gap) / per), fs: { name, mid, small }, speed: SPEED[s.scrollSpeed] }
}

// Browsers put a narrow no-break space before am/pm; the design has a plain one.
const tidy = s => s.replace(/[  ]/g, ' ').replace(/\b(AM|PM)\b/g, m => m.toLowerCase())

export const formatClock = d => tidy(new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(d))
export const formatDay = d => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(d).replace(/^(\w+) /, '$1, ')

export function formatCreated(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d)) return ''
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' }).format(d)
  return `${day} · ${formatClock(d)}`
}

export function formatExpected(dateStr) {
  if (!dateStr) return 'Exp. date not set'
  const d = new Date(`${dateStr}T12:00:00+05:30`)
  if (isNaN(d)) return 'Exp. date not set'
  const s = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(d)
  return `Exp. ${s.replace(',', '')}`
}

// 2m · 48m · 1h 20m · 2h 05m · 1d 03h
export function formatElapsed(ms) {
  const mins = Math.max(0, Math.floor(ms / 60000))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h ${String(mins % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h`
}

// The header's BUSY SYNC marker: when the 3-minute Busy sync last finished.
// Green while fresh; amber once it is over SYNC_STALE_MINUTES old (or never seen).
export function syncMarker(lastSyncAt, nowMs) {
  const t = lastSyncAt ? Date.parse(lastSyncAt) : NaN
  if (isNaN(t)) return { text: 'not yet', stale: true }
  const mins = Math.max(0, Math.floor((nowMs - t) / 60000))
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${formatElapsed(nowMs - t)} ago`
  return { text: `${formatClock(new Date(t))} · ${ago}`, stale: mins > SYNC_STALE_MINUTES }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

// Invoice numbers carry the financial year ("Godrej/2627/6189"), the same on
// every invoice this year. Dropped so the part that differs fits the card:
// Godrej/6189 · JCM/14400 · INV 187 (when only a number is left).
export const shortInv = vchNo => {
  const parts = String(vchNo || '').trim().split('/').filter(Boolean)
  if (!parts.length) return ''
  const kept = parts.filter((p, i) => i === parts.length - 1 || !/^(\d{4}|\d{2}-\d{2})$/.test(p))
  const out = kept.join('/')
  return /^\d+$/.test(out) ? `INV ${out}` : out
}

// Busy numbers look like "SO/2627/754"; the card has room for "SO 754", as in the design.
export const shortSo = vchNo => {
  const m = String(vchNo || '').match(/(\d+)\s*$/)
  return m ? `SO ${m[1]}` : String(vchNo || '')
}

function tagFor(c) {
  switch (c.column) {
    // Back from waiting for material (the design's NEW cards have no tag; these carry news).
    // DUE TODAY (red): the expected date came but Busy has no stock yet. PICK ANYWAY: sent back from /owner.
    case 'new': return c.grownReason === 'stock' ? 'STOCK IN' : c.grownReason === 'date' ? 'DUE TODAY' : c.grownReason === 'manual' ? 'PICK ANYWAY' : ''
    case 'picking': return (c.picker || '').toUpperCase()
    case 'invoiced': return c.stage === 'checked' ? (c.checker ? `✓ ${c.checker.toUpperCase()}` : '✓ CHECKED') : 'INVOICED'
    case 'ready': return c.boxes ? plural(c.boxes, 'BOX', 'BOXES') : 'READY'
    default: return ''
  }
}

export function isOverdue(c, thresholds, nowMs) {
  if (c.column === 'waiting') return false
  const limit = thresholds && thresholds[c.stage]
  if (!limit || !c.stageSince) return false
  return nowMs - Date.parse(c.stageSince) > limit * 60000
}

// One card as the v2 design draws it. Same fields in every layout; the layout
// decides which rows show (Board.jsx).
//   ref     Medium / Compact: the invoice number if there is one, else the SO number
//   edge    the left border: red only for late orders when the late style is "edge"
export function viewCard(c, thresholds, nowMs, settings = DISPLAY_DEFAULTS) {
  const s = displaySettings(settings)
  const soRef = shortSo(c.soNo), invRef = shortInv(c.invoiceNo)
  const refs = s.showRefs ? { soRef, invRef, ref: invRef || soRef } : { soRef: '', invRef: '', ref: '' }
  const timer = c.stageSince ? formatElapsed(nowMs - Date.parse(c.stageSince)) : ''
  if (c.column === 'waiting') {
    // NOT ORDERED (red text) until every pending item is marked ordered on /owner;
    // then ORDERED with the expected date (or IN STOCK when Busy already has it all).
    const red = c.waitingStatus === 'red'
    const border = '1px dashed #B5B0A5'
    return {
      key: c.id, waiting: true, name: c.name, ...refs,
      // 'pending', not 'lines': the count is the lines still to come (short, so the tag fits).
      lines: `${c.pendingLines || 0} pending`,
      tag: red ? 'NOT ORDERED' : c.expectedDate ? 'ORDERED' : 'IN STOCK',
      tagColor: red ? TAG_COLOR.notOrdered : TAG_COLOR.ordered,
      created: red ? formatCreated(c.createdAt) : c.expectedDate ? formatExpected(c.expectedDate) : formatCreated(c.createdAt),
      // How long it has waited (since the invoice, the tap, or the sync parked it).
      timer, timerColor: INK, overdue: false,
      bg: '#EFEDE8', border, edge: border,
    }
  }
  const od = isOverdue(c, thresholds, nowMs)
  const border = '1px solid #E4DED0'
  return {
    key: c.id, waiting: false, name: c.name, ...refs,
    lines: plural(c.lines || 0, 'line', 'lines'),
    tag: tagFor(c), tagColor: c.column === 'new' && c.grownReason === 'date' ? RED : TAG_COLOR[c.column],
    created: formatCreated(c.createdAt), timer,
    timerColor: od ? RED : INK, overdue: od,
    bg: '#FFFFFF', border, edge: od && s.lateStyle === 'edge' ? `6px solid ${RED}` : border,
  }
}

// The five columns, each with its cards and — when there are more cards than
// fit (cards per column) — the slow looping scroll with a "TOP OF LIST · N"
// marker, pausing on the marker for the first tenth of each loop.
export function buildColumns(cards, thresholds, nowMs, settings = DISPLAY_DEFAULTS) {
  const lay = layoutFor(settings)
  return COLUMNS.map(col => {
    const list = cards.filter(c => c.column === col.key).map(c => viewCard(c, thresholds, nowMs, lay))
    const n = list.length
    const loop = n > lay.per
    const cycle = MARK + lay.gap + n * (lay.cardHeight + lay.gap)
    const marker = k => ({ key: `marker-${k}`, marker: true })
    return {
      ...col, count: n, empty: n === 0,
      items: loop
        ? [marker('a'), ...list.map(c => ({ ...c, key: `a-${c.key}` })), marker('b'), ...list.map(c => ({ ...c, key: `b-${c.key}` }))]
        : list,
      loop,
      cycle: `${cycle}px`,
      animation: loop ? `tvloop ${Math.round(cycle / lay.speed / 0.9)}s linear infinite` : 'none',
      mask: loop ? 'linear-gradient(to bottom, transparent 0, #000 20px, #000 calc(100% - 56px), transparent 100%)' : 'none',
    }
  })
}
