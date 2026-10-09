// What /owner shows the moment an action is confirmed, before the server answers,
// and how the server's answer is put on screen. No React here, so it can be tested.
//
// Nothing moves while you work: a changed row changes IN PLACE (colour, labels),
// and a row that leaves the list (cleared, back to NEW, stock arrived) stays where
// it was, greyed, with a short note ("Cleared") — rows never jump under a finger.
// The page re-sorts and drops those rows only on a full reload (opening the page,
// switching tabs, the once-a-minute refresh when idle).
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)

const isShort = l => l.status !== 'in_stock'
const live = l => !l.gone

// A party's band and counts from its lines (in place, no sorting):
//   red    waiting, not every short item ordered · amber  in NEW / PICKING with short items
//   green  waiting, every short item ordered (latest expected date) or stock in
export function recompute(p) {
  if (p.gone) return p
  const lines = p.pending.filter(live)
  const red = lines.some(l => l.status === 'not_ordered')
  const dates = lines.map(l => l.expectedDate).filter(Boolean).sort()
  return { ...p, status: p.floor ? 'amber' : red ? 'red' : 'green', shortLines: lines.filter(isShort).length, openLines: lines.length, expectedDate: red ? null : dates[dates.length - 1] || null }
}
const eachParty = (data, fn) => ({ ...data, parties: data.parties.map(p => (p.gone ? p : recompute(fn(p)))) })

// MARK ORDERED (one item, or several at once): "Ordered · expected …" on the items,
// and every party waiting for them turns green once all its short items are ordered.
export function markOrdered(data, itemIds, choice, at = new Date().toISOString()) {
  const ids = new Set([].concat(itemIds))
  const day = choice.date || addDays(data.today, Number(choice.days))
  const codes = new Set()
  const items = data.items.map(g => ({ ...g, items: g.items.map(it => {
    if (!ids.has(it.id) || it.gone) return it
    codes.add(it.itemCode)
    return { ...it, orderedAt: it.orderedAt || at, orderedDays: it.orderedDays ?? 0, expectedDate: day, late: false }
  }) }))
  const next = eachParty({ ...data, items }, p => ({ ...p, pending: p.pending.map(l => (codes.has(l.itemCode) && l.status !== 'in_stock' && !l.gone ? { ...l, status: 'ordered', orderedAt: l.orderedAt || at, expectedDate: day } : l)) }))
  return { data: next, expectedDate: day }
}

export function unmarkOrdered(data, itemId) {
  let code = null
  const items = data.items.map(g => ({ ...g, items: g.items.map(it => {
    if (it.id !== itemId) return it
    code = it.itemCode
    return { ...it, orderedAt: null, orderedDays: null, expectedDate: null, late: false, amber: false }
  }) }))
  return eachParty({ ...data, items }, p => ({ ...p, pending: p.pending.map(l => (l.itemCode === code && l.status === 'ordered' ? { ...l, status: 'not_ordered', orderedAt: null, expectedDate: null } : l)) }))
}

// CLEAR (one order or several): the lines stay in place, struck through, "Cleared";
// an order with nothing left to wait for is greyed "Cleared" in place.
export function clearMany(data, orders) {
  const want = new Map(orders.map(o => [o.orderId, new Set(o.lineNos)]))
  return eachParty(data, p => {
    const drop = want.get(p.id)
    if (!drop) return p
    const pending = p.pending.map(l => (drop.has(l.lineNo) ? { ...l, gone: 'Cleared' } : l))
    const left = pending.filter(live)
    const done = !left.length || (p.floor && !left.some(isShort))
    return done ? { ...p, pending, gone: 'Cleared' } : { ...p, pending }
  })
}
export const clearLines = (data, partyId, lineNos) => clearMany(data, [{ orderId: partyId, lineNos }])

// PICK ANYWAY: back to NEW — amber in place while something is short, else greyed "Back to NEW".
export const pickAnyway = (data, partyId) => eachParty(data, p => {
  if (p.id !== partyId) return p
  const moved = { ...p, stage: 'new', floor: true, canPickAnyway: false, canWait: true }
  return moved.pending.filter(live).some(isShort) ? moved : { ...moved, gone: 'Back to NEW' }
})

// WAIT FOR MATERIAL (amber band, NEW orders): it now waits — red or green, in place.
export const waitForMaterial = (data, partyId) => eachParty(data, p => (p.id === partyId
  ? { ...p, stage: 'waiting', floor: false, canWait: false, canPickAnyway: true, via: 'button', viaText: 'Wait for material button' }
  : p))

// The server's answer, put on screen WITHOUT moving anything: what is shown keeps
// its place; what the server no longer lists stays greyed in place; new rows go last.
export function mergeStable(shown, server) {
  if (!shown) return server
  const byId = new Map(server.parties.map(p => [p.id, p]))
  const parties = shown.parties.map(old => {
    const fresh = byId.get(old.id)
    if (!fresh) return { ...old, gone: old.gone || 'Done' }
    byId.delete(old.id)
    const lines = new Map(fresh.pending.map(l => [l.lineNo, l]))
    const pending = old.pending.map(l => {
      const f = lines.get(l.lineNo)
      if (!f) return { ...l, gone: l.gone || 'Cleared' }
      lines.delete(l.lineNo)
      return f
    }).concat([...lines.values()])
    return { ...fresh, pending }
  }).concat([...byId.values()])
  const itemsById = new Map(server.items.flatMap(g => g.items.map(it => [it.id, it])))
  const seen = new Set()
  const groups = shown.items.map(g => ({
    ...g,
    items: g.items.map(it => {
      const f = itemsById.get(it.id)
      if (!f) return { ...it, gone: it.gone || 'Off the list' }
      seen.add(it.id)
      return f
    }),
  }))
  for (const g of server.items) {
    const extra = g.items.filter(it => !seen.has(it.id))
    if (!extra.length) continue
    const mine = groups.find(x => x.supplier === g.supplier)
    if (mine) mine.items = mine.items.concat(extra)
    else groups.push({ ...g, items: extra })
  }
  return { ...server, parties, items: groups }
}

// Counts for the tabs and bars: rows still on the list.
export const liveParties = data => data.parties.filter(p => !p.gone)
export const liveItems = data => data.items.flatMap(g => g.items).filter(it => !it.gone)
// What CLEAR ALL PENDING clears on an order: its short lines when it is still on the
// floor (NEW / PICKING: the rest is being picked), else every pending line.
export const clearableLines = p => p.pending.filter(live).filter(l => !p.floor || isShort(l))
