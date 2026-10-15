// Signify Cash Discount — what Signify owes JCM under its Cash Discount scheme
// (trade circular CD-CIRC-001, effective 1 Aug 2026): pay an invoice digitally within
// 0–5 days of the invoice date → 1.5% back, within 6–10 days → 1.0%, later → nothing.
// Signify applies payments FIFO (oldest invoice first) and gives the discount only on
// invoices that are fully cleared; the discount is on the GST-inclusive invoice value.
//
// Served from api/purchases.js (actions starting with "cd-") so no extra Vercel function is
// needed. Tables cd_ledger / cd_accounts / cd_settings in the Busy project, filled every
// 30 min by busy-sync/sync-cd-ledger.js on JCM-Server. All closed to the browser.
//
// Access: admins only (the page is grantable: false).
// Actions (POST JSON, via /api/purchases):
//   cd-summary  from, to, codes[]        invoices dated from–to on the chosen accounts, each with the
//                                        payment that cleared it (FIFO), days, slab and CD amount; totals
//   cd-settings-save  scheme_from, slab_a_days, slab_a_pct, slab_b_days, slab_b_pct, count_notes, name_match, name_exclude
//   cd-account-save   party_code, included, opening_balance, opening_note
//   cd-adjust-save    vch_no, excess, note      part of a payment paid by mistake → stays as credit
//   cd-adjust-remove  vch_code
//
// The dates here are Busy voucher dates. Signify decides the slab by the day the money
// reached ITS bank — a NEFT typed on the 5th and credited on the 6th is Slab B for them.

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
const ADVANCE_DAYS = 15
const r2 = n => Math.round(Number(n || 0) * 100) / 100
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
function fyStart(d = new Date(Date.now() + 5.5 * 3600e3)) {
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1
  return `${y}-04-01`
}

function check({ data, error }, what) {
  if (error) { const e = new Error(`${what}: ${error.message}`); e.db = true; throw e }
  return data
}
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e }

async function fetchAll(client, table, build) {
  const out = []
  for (let from = 0; from < 200000; from += 1000) {
    const q = build(client.from(table).select('*')).range(from, from + 999)
    const rows = check(await q, table)
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

// ---------------------------------------------------------------------------
// The calculation for ONE POOL of accounts. Pure: ledger rows in, invoice rows out.
//   rows     : cd_ledger rows of every account in the pool (any order; each carries party_code/name)
//   opening  : payable at the start of the year for the whole pool (positive = we owe them)
//   s        : cd_settings row
//   from, to : the invoice dates wanted in the answer (the FIFO always runs over the whole year)
// JCM moves the lighting accounts' bills into TR / MP by journal and pays from there, so a
// "pool" is the set of accounts joined by such transfers (see poolsOf below). Inside a pool a
// two-sided journal (debit one account, credit another) cancels out and is dropped; a one-sided
// journal (the other side is outside the pool — a credit note account, TDS …) stays as a note.
// ---------------------------------------------------------------------------
// Indexes of entries (amounts in paise, oldest first) that add up to target exactly, preferring
// the oldest entries; null when there is no such set. Bounded search so a long list cannot hang.
export function exactSet(amounts, target) {
  const n = Math.min(amounts.length, 120)
  let budget = 400000
  const pick = []
  const suffix = new Array(n + 1).fill(0)
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + amounts[i]
  const go = (i, left) => {
    if (left === 0) return true
    if (i >= n || left < 0 || suffix[i] < left || --budget < 0) return false
    if (amounts[i] <= left) { pick.push(i); if (go(i + 1, left - amounts[i])) return true; pick.pop() }
    return go(i + 1, left)
  }
  return go(0, target) ? pick.slice() : null
}

export function calcAccount(rowsIn, opening, s, from, to, hub = null) {
  const countNotes = s.count_notes !== false
  const start = fyStart()
  const members = [...new Set(rowsIn.map(r => String(r.party_code)))]
  // The paying account. In a pool it is the one the payments are made from; everything the FIFO
  // sees is ITS ledger, exactly as Busy shows it: its own bills, the bills moved into it by
  // journal (queued on the day they are moved, days counted from the invoice date), its
  // payments, credit notes and returns. Bills still sitting on another account are "not moved yet".
  if (!hub) {
    const payCount = new Map()
    for (const r of rowsIn) if (r.vch_type === 19 && Number(r.debit) > 0) payCount.set(String(r.party_code), (payCount.get(String(r.party_code)) || 0) + 1)
    hub = [...payCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || members[0]
  }
  const byVch = new Map()
  for (const r of rowsIn) { if (!byVch.has(r.vch_code)) byVch.set(r.vch_code, []); byVch.get(r.vch_code).push(r) }
  // Busy's ledger order within a day (as on Dilip's printout): bills by number, then the other
  // vouchers in the order they were entered.
  const sortKey = (a, b) => String(a.date).localeCompare(String(b.date)) || ((a.type === 2 ? 0 : 1) - (b.type === 2 ? 0 : 1)) || (a.type === 2 && b.type === 2 ? String(a.no || '').localeCompare(String(b.no || '')) : 0) || (a.vch_code || 0) - (b.vch_code || 0) || (a.sr_no || 0) - (b.sr_no || 0)

  // Every purchase bill in the pool (any account) — the rows the answer is made of.
  const bills = []
  for (const r of rowsIn) if (r.vch_type === 2 && Number(r.credit) > 0) bills.push({ party_code: String(r.party_code), party_name: r.party_name, kind: 'purchase', date: r.vch_date, no: r.vch_no || '', amount: r2(r.credit), vch_code: r.vch_code, sr_no: r.sr_no, type: 2, typeName: r.vch_type_name })
  bills.sort(sortKey)

  // The hub's ledger → queue (what we owe) and pays (what reduces it).
  const queue = []   // { bill?, date (queued), amount, remaining }
  const pays = []
  const ignored = []
  const schemeFrom = String(s.scheme_from || '2026-08-01')
  const hubRows = rowsIn.filter(r => String(r.party_code) === hub).sort((a, b) => sortKey({ date: a.vch_date, no: a.vch_no, vch_code: a.vch_code, sr_no: a.sr_no, type: a.vch_type }, { date: b.vch_date, no: b.vch_no, vch_code: b.vch_code, sr_no: b.sr_no, type: b.vch_type }))
  // Everything before the scheme start is ONE opening figure — the ledger balance that day,
  // as on Dilip's working — not a queue of old bills. Bills before the scheme earn nothing anyway.
  const before = hubRows.filter(r => r.vch_date < schemeFrom)
  const op = r2((opening || 0) + before.reduce((t, r) => t + Number(r.credit || 0) - Number(r.debit || 0), 0))
  const opLabel = `Opening balance (${schemeFrom.slice(8, 10)}-${schemeFrom.slice(5, 7)}-${schemeFrom.slice(0, 4)})`
  if (op > 0) queue.push({ kind: 'opening', date: schemeFrom, no: opLabel, amount: op, remaining: op })
  if (op < 0) pays.push({ kind: 'opening', date: schemeFrom, no: opLabel.replace('balance', 'advance'), amount: -op, remaining: -op, party_code: hub })

  for (const r of hubRows) {
    if (r.vch_date < schemeFrom) continue
    const cr = r2(r.credit), dr = r2(r.debit)
    if (cr > 0) {
      if (r.vch_type === 2) {
        const bill = bills.find(b => b.vch_code === r.vch_code && b.party_code === hub && !b.entry)
        const e = { kind: 'bill', bill, date: r.vch_date, no: r.vch_no || '', amount: cr, remaining: cr, vch_code: r.vch_code, type: 2 }
        if (bill) bill.entry = e
        queue.push(e)
      } else if (r.vch_type === 16) {
        // A bill moved in from another account in the pool: the debited side names the account.
        const other = (byVch.get(r.vch_code) || []).find(x => String(x.party_code) !== hub && Number(x.debit) > 0 && Math.abs(Number(x.debit) - cr) < 0.01)
        const from = other ? String(other.party_code) : null
        // The bill it moved: same account, same amount, dated on or before the move — the nearest one.
        const bill = from ? bills.filter(b => b.party_code === from && !b.entry && Math.abs(b.amount - cr) < 0.01 && b.date <= r.vch_date).sort((a, b) => b.date.localeCompare(a.date))[0] || null : null
        const e = { kind: bill ? 'bill' : 'moved', bill, date: r.vch_date, no: bill ? bill.no : (r.vch_no || ''), amount: cr, remaining: cr, from: other ? other.party_name : null, vch_code: r.vch_code }
        if (bill) { bill.entry = e; bill.movedOn = r.vch_date }
        queue.push(e)
      } else queue.push({ kind: 'other', date: r.vch_date, no: r.vch_no || '', amount: cr, remaining: cr, typeName: r.vch_type_name, vch_code: r.vch_code })
    }
    if (dr > 0) {
      const p = { kind: r.vch_type === 19 ? 'payment' : 'note', date: r.vch_date, no: r.vch_no || '', amount: dr, remaining: dr, type: r.vch_type, typeName: r.vch_type_name, vch_code: r.vch_code, party_code: hub, party_name: r.party_name }
      // Part (or all) of this payment marked on the page as paid by mistake: it stays as a
      // credit with Signify and never pays a bill.
      const adj = (s.adjustments || {})[r.vch_code]
      if (adj && p.kind === 'payment') { p.held = r2(Math.min(dr, Number(adj.excess) || 0)); p.heldNote = adj.note || ''; p.remaining = r2(dr - p.held) }
      if (p.kind === 'payment' || countNotes) pays.push(p); else ignored.push(p)
    }
  }
  queue.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'opening' ? -1 : b.kind === 'opening' ? 1 : 0) || ((a.type === 2 ? 0 : 1) - (b.type === 2 ? 0 : 1)) || (a.type === 2 && b.type === 2 ? String(a.no).localeCompare(String(b.no)) : 0) || (a.vch_code || 0) - (b.vch_code || 0))
  pays.sort((a, b) => a.date.localeCompare(b.date) || (a.vch_code || 0) - (b.vch_code || 0))

  // Two ways to decide which bills a payment clears:
  //   'amount' (how JCM pays): a payment is made for particular invoices, from the PDF mails,
  //            sometimes before the bill is even typed into Busy. So a payment clears exactly
  //            the bills its amount adds up to — nothing else. A payment that fits nothing is
  //            an ADVANCE waiting for its bill (never "the oldest open bill"). A payment made in
  //            parts is found by trying it together with the next one or two payments.
  //   'fifo'   (Signify's rule): every payment goes to the oldest open entry, full stop.
  // Credit notes / returns, when counted, always go oldest-first (they are not made out for bills).
  const byAmount = (s.match_mode || 'amount') === 'amount'
  const apply = (p, e) => {
    const take = r2(Math.min(p.remaining, e.remaining))
    e.remaining = r2(e.remaining - take)
    p.remaining = r2(p.remaining - take)
    ;(e.parts ||= []).push({ date: p.date, no: p.no, amount: p.amount, applied: take, kind: p.kind })
    if (e.remaining <= 0.004) e.settledBy = p
  }
  const fifo = p => { for (const e of queue) { if (p.remaining <= 0.004) break; if (e.remaining > 0.004) apply(p, e) } }
  const windowDays = Number(s.slab_b_days ?? 10)
  if (!byAmount) {
    for (const p of pays) fifo(p)
  } else {
    for (const p of pays) {
      if (p.kind === 'payment') {
        // Bills up to ADVANCE_DAYS after the payment count too: JCM often pays from the PDF mail
        // before the bill is typed into Busy.
        const open = queue.filter(e => e.remaining > 0.004 && dayDiff(p.date, e.date) <= ADVANCE_DAYS)
        const set = exactSet(open.map(e => Math.round(e.remaining * 100)), Math.round(p.remaining * 100))
        if (set) { for (const i of set) apply(p, open[i]); p.matched = true; continue }
        // Paid in parts (e.g. ₹300 sent two days later to make up a short payment): this payment
        // together with the next one or two within a week.
        const later = pays.filter(q => q !== p && q.kind === 'payment' && q.remaining > 0.004 && q.date >= p.date && dayDiff(p.date, q.date) <= 7 && pays.indexOf(q) > pays.indexOf(p)).slice(0, 2)
        let grouped = false
        for (let n = 1; n <= later.length && !grouped; n++) {
          const group = [p, ...later.slice(0, n)]
          const total = group.reduce((t, g) => t + Math.round(g.remaining * 100), 0)
          const gs = exactSet(open.map(e => Math.round(e.remaining * 100)), total)
          if (gs) {
            for (const i of gs) for (const g of group) { if (open[i].remaining <= 0.004) break; if (g.remaining > 0.004) apply(g, open[i]) }
            for (const g of group) g.matched = true
            grouped = true
          }
        }
        if (grouped) continue
        // No exact set: the payment goes in order to bills inside its discount window or later
        // (an advance for bills not in Busy yet) — never back to an older bill: a payment made
        // in October is not for an August bill.
        for (const e of queue) {
          if (p.remaining <= 0.004) break
          if (e.remaining <= 0.004 || e.kind === 'opening') continue
          if (dayDiff(e.date, p.date) > windowDays) continue
          apply(p, e)
        }
        continue
      }
      fifo(p) // opening advance, and credit notes / returns when the switch is on
    }
  }

  const aDays = Number(s.slab_a_days ?? 5), bDays = Number(s.slab_b_days ?? 10)
  const aPct = Number(s.slab_a_pct ?? 1.5), bPct = Number(s.slab_b_pct ?? 1.0)

  const out = []
  for (const b of bills) {
    if (b.date < from || b.date > to) continue
    const e = b.entry
    const row = {
      party_code: b.party_code, party_name: b.party_name,
      date: b.date, vch_no: b.no, amount: b.amount, kind: 'purchase', type_name: b.typeName,
      settled: !!(e && e.settledBy), remaining: e ? e.remaining : b.amount,
      pay_date: e?.settledBy ? e.settledBy.date : null,
      pay_no: e?.settledBy ? e.settledBy.no : null,
      pay_amount: e?.settledBy ? e.settledBy.amount : null,
      pay_kind: e?.settledBy ? e.settledBy.kind : null,
      pay_exact: e?.settledBy ? !!e.settledBy.matched : null,
      pay_account: e?.settledBy && b.party_code !== hub ? e.settledBy.party_name : null,
      moved_on: b.movedOn || null,
      parts: e ? (e.parts || []).length : 0,
      days: e?.settledBy ? dayDiff(b.date, e.settledBy.date) : null,
      pct: 0, cd: 0, slab: null, status: '',
    }
    if (b.date < schemeFrom) row.status = 'Before the scheme'
    else if (!e) row.status = `Not yet moved to the paying account`
    else if (!e.settledBy) row.status = e.parts ? `Part paid — ${e.remaining.toFixed(2)} still open` : (byAmount ? 'No matching payment' : 'Not paid yet')
    // Paid before the bill date = advance pay term (Category C): only Slab A applies.
    else if (row.days < 0) { row.slab = 'A'; row.pct = aPct; row.status = `Slab A — paid in advance (${aPct}%)` }
    else if (row.days <= aDays) { row.slab = 'A'; row.pct = aPct; row.status = `Slab A (${aPct}%)` }
    else if (row.days <= bDays) { row.slab = 'B'; row.pct = bPct; row.status = `Slab B (${bPct}%)` }
    else row.status = `Paid after day ${bDays} — no CD`
    row.cd = r2(b.amount * row.pct / 100)
    out.push(row)
  }
  // Amounts moved into the paying account that could not be matched to a bill (lumped
  // transfers, part amounts): listed so they can be checked; they earn no CD by themselves.
  const unmatched = queue.filter(e => e.kind === 'moved' && e.date >= from && e.date <= to).map(e => ({ date: e.date, amount: e.amount, from: e.from, settled: !!e.settledBy, pay_date: e.settledBy?.date || null }))

  const after = hubRows.filter(r => r.vch_date >= schemeFrom)
  const totalCr = r2(after.reduce((t, r) => t + Number(r.credit || 0), 0))
  const totalDr = r2(after.reduce((t, r) => t + Number(r.debit || 0), 0))
  const openEntries = queue.filter(e => e.remaining > 0.004 && e.kind !== 'opening')
  return {
    rows: out,
    hub,
    opening: op, opening_date: schemeFrom,
    totals: { credits: totalCr, debits: totalDr, closing: r2(op + totalCr - totalDr) },
    open_bills: openEntries.length, open_amount: r2(openEntries.reduce((t, e) => t + e.remaining, 0)),
    unapplied: r2(pays.reduce((t, p) => t + p.remaining, 0)),
    advances: pays.filter(p => (p.remaining > 0.004 || p.held > 0) && p.kind === 'payment').map(p => ({ date: p.date, no: p.no, amount: p.amount, remaining: r2((p.remaining || 0) + (p.held || 0)), held: p.held || 0, note: p.heldNote || '', vch_code: p.vch_code })),
    ignored: ignored.map(p => ({ date: p.date, no: p.no, amount: p.amount, type_name: p.typeName, party_name: p.party_name })),
    unmatched,
    entries: hubRows.length,
  }
}

// Which accounts belong together: two accounts joined by a two-sided journal (a bill moved
// from one to the other) are in the same pool. 'per_account' mode = every account alone.
export function poolsOf(accounts, ledger, mode) {
  const codes = accounts.map(a => String(a.party_code))
  const parent = new Map(codes.map(c => [c, c]))
  const find = c => { while (parent.get(c) !== c) { parent.set(c, parent.get(parent.get(c))); c = parent.get(c) } return c }
  if (mode !== 'per_account') {
    const byVch = new Map()
    for (const r of ledger) if (r.vch_type === 16 && parent.has(String(r.party_code))) { if (!byVch.has(r.vch_code)) byVch.set(r.vch_code, new Set()); byVch.get(r.vch_code).add(String(r.party_code)) }
    for (const set of byVch.values()) { const [first, ...rest] = [...set]; for (const c of rest) parent.set(find(c), find(first)) }
  }
  const groups = new Map()
  for (const c of codes) { const root = find(c); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(c) }
  return [...groups.values()]
}

// ---------------------------------------------------------------------------
async function summary(busy, body) {
  const from = isDate(body.from) ? body.from : null
  const to = isDate(body.to) ? body.to : null
  if (!from || !to || from > to) fail(400, 'Pick a from and to date.')
  const s = check(await busy.from('cd_settings').select('*').eq('id', 1).maybeSingle(), 'cd_settings') || {}
  const adjRows = check(await busy.from('cd_payment_adjust').select('*').order('vch_date'), 'cd_payment_adjust')
  s.adjustments = Object.fromEntries(adjRows.map(a => [a.vch_code, a]))
  const accounts = check(await busy.from('cd_accounts').select('*').order('party_name'), 'cd_accounts')
  const wanted = Array.isArray(body.codes) && body.codes.length
    ? accounts.filter(a => body.codes.map(String).includes(String(a.party_code)))
    : accounts.filter(a => a.included !== false)
  const codes = wanted.map(a => String(a.party_code))
  const byName = new Map(wanted.map(a => [String(a.party_code), a]))

  const anchors = codes.length ? check(await busy.from('party_anchor_balance').select('party_code, anchor_balance, anchor_date').in('party_code', codes.map(Number).filter(n => !Number.isNaN(n))), 'party_anchor_balance') : []
  const anchorOf = new Map(anchors.map(a => [String(a.party_code), a]))
  const ledger = codes.length ? await fetchAll(busy, 'cd_ledger', q => q.in('party_code', codes)) : []
  const byCode = new Map()
  for (const r of ledger) { if (!byCode.has(r.party_code)) byCode.set(r.party_code, []); byCode.get(r.party_code).push(r) }

  const openingOf = code => {
    const a = byName.get(code), anchor = anchorOf.get(code)
    // party_anchor_balance is receivable-positive; for a supplier a negative figure = we owe them.
    if (a?.opening_balance != null) return { opening: Number(a.opening_balance), source: 'typed' }
    if (anchor) return { opening: -Number(anchor.anchor_balance || 0), source: 'busy' }
    return { opening: 0, source: 'none' }
  }

  const pools = []
  const result = []
  for (const members of poolsOf(wanted, ledger, s.fifo_mode || 'auto')) {
    const rows = members.flatMap(c => byCode.get(c) || [])
    // The account the payments come from is the pool's ledger; its opening is the pool's opening.
    const payCount = new Map()
    for (const r of rows) if (r.vch_type === 19 && Number(r.debit) > 0) payCount.set(String(r.party_code), (payCount.get(String(r.party_code)) || 0) + 1)
    const hub = [...payCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || members[0]
    const openings = members.map(c => ({ code: c, ...openingOf(c) }))
    const opening = openingOf(hub).opening
    const calc = calcAccount(rows, opening, s, from, to, hub)
    const poolId = `pool-${hub}`
    pools.push({
      id: poolId, hub_code: hub, hub_name: byName.get(hub)?.party_name || hub, members: members.map(c => ({ party_code: c, party_name: byName.get(c)?.party_name || c })),
      opening: calc.opening, opening_date: calc.opening_date, opening_1apr: opening, openings: openings.map(o => ({ ...o, party_name: byName.get(o.code)?.party_name || o.code })),
      totals: calc.totals, open_bills: calc.open_bills, open_amount: calc.open_amount, unapplied: calc.unapplied, advances: calc.advances, ignored: calc.ignored, unmatched: calc.unmatched, entries: calc.entries,
      cd: r2(calc.rows.reduce((t, r) => t + r.cd, 0)), invoices: calc.rows.filter(r => r.kind === 'purchase').length,
    })
    for (const c of members) {
      const a = byName.get(c)
      const mine = calc.rows.filter(r => String(r.party_code) === c)
      const o = openings.find(x => x.code === c)
      result.push({ party_code: c, party_name: a?.party_name || c, included: a?.included !== false, opening_note: a?.opening_note || '', opening: o.opening, opening_source: o.source, pool: poolId, rows: mine, entries: (byCode.get(c) || []).length })
    }
  }
  result.sort((a, b) => a.pool.localeCompare(b.pool) || (b.rows.length - a.rows.length) || a.party_name.localeCompare(b.party_name))
  const all = result.flatMap(a => a.rows)
  const totals = {
    invoices: all.filter(r => r.kind === 'purchase').length,
    amount: r2(all.filter(r => r.kind === 'purchase').reduce((t, r) => t + r.amount, 0)),
    cd: r2(all.reduce((t, r) => t + r.cd, 0)),
    slab_a: all.filter(r => r.slab === 'A').length, slab_a_cd: r2(all.filter(r => r.slab === 'A').reduce((t, r) => t + r.cd, 0)),
    slab_b: all.filter(r => r.slab === 'B').length, slab_b_cd: r2(all.filter(r => r.slab === 'B').reduce((t, r) => t + r.cd, 0)),
    none: all.filter(r => r.kind === 'purchase' && r.settled && !r.slab).length,
    unpaid: all.filter(r => r.kind === 'purchase' && !r.settled).length,
  }
  return { from, to, settings: s, adjustments: adjRows, accounts, pools, result, totals, lastSyncAt: s.last_sync_at || null, lastSyncNote: s.last_sync_note || null, fyStart: fyStart() }
}

async function settingsSave(busy, body) {
  const patch = {}
  if (isDate(body.scheme_from)) patch.scheme_from = body.scheme_from
  for (const k of ['slab_a_days', 'slab_b_days']) if (body[k] != null && Number.isInteger(Number(body[k]))) patch[k] = Number(body[k])
  for (const k of ['slab_a_pct', 'slab_b_pct']) if (body[k] != null && !Number.isNaN(Number(body[k]))) patch[k] = Number(body[k])
  if (typeof body.count_notes === 'boolean') patch.count_notes = body.count_notes
  if (body.fifo_mode === 'auto' || body.fifo_mode === 'per_account') patch.fifo_mode = body.fifo_mode
  if (body.match_mode === 'amount' || body.match_mode === 'fifo') patch.match_mode = body.match_mode
  for (const k of ['name_match', 'name_exclude']) if (typeof body[k] === 'string') patch[k] = body[k].trim().slice(0, 200)
  if (typeof body.email_signature === 'string' && body.email_signature.trim()) patch.email_signature = body.email_signature.trim().slice(0, 300)
  if (!Object.keys(patch).length) fail(400, 'Nothing to save.')
  check(await busy.from('cd_settings').update(patch).eq('id', 1), 'cd_settings')
  return { ok: true }
}

// Mark part (or all) of a payment as paid by mistake / standing credit. Found by its Busy number.
async function adjustSave(busy, body, me) {
  const vchNo = String(body.vch_no || '').trim()
  const excess = Number(body.excess)
  if (!vchNo) fail(400, 'Type the payment number, e.g. BANK/767.')
  if (!(excess > 0)) fail(400, 'Type the extra amount.')
  const rows = check(await busy.from('cd_ledger').select('party_code, vch_code, vch_no, vch_date, debit').eq('vch_type', 19).ilike('vch_no', vchNo).gt('debit', 0), 'cd_ledger')
  if (!rows.length) fail(404, `No payment ${vchNo} found on the Signify accounts.`)
  if (rows.length > 1) fail(400, `More than one payment is numbered ${vchNo} — tell Claude which one.`)
  const r = rows[0]
  if (excess > Number(r.debit)) fail(400, `The payment is only ₹${Number(r.debit).toLocaleString('en-IN')}.`)
  check(await busy.from('cd_payment_adjust').upsert({ vch_code: r.vch_code, party_code: r.party_code, vch_no: r.vch_no, vch_date: r.vch_date, excess, note: String(body.note || '').trim().slice(0, 300), created_by: me?.name || null }, { onConflict: 'vch_code' }), 'cd_payment_adjust')
  return { ok: true }
}
async function adjustRemove(busy, body) {
  const code = Number(body.vch_code)
  if (!code) fail(400, 'Which payment?')
  check(await busy.from('cd_payment_adjust').delete().eq('vch_code', code), 'cd_payment_adjust')
  return { ok: true }
}

async function accountSave(busy, body) {
  const code = String(body.party_code || '')
  if (!code) fail(400, 'Which account?')
  const patch = {}
  if (typeof body.included === 'boolean') patch.included = body.included
  if ('opening_balance' in body) patch.opening_balance = body.opening_balance === null || body.opening_balance === '' ? null : Number(body.opening_balance)
  if (typeof body.opening_note === 'string') patch.opening_note = body.opening_note.trim().slice(0, 300)
  if (!Object.keys(patch).length) fail(400, 'Nothing to save.')
  check(await busy.from('cd_accounts').update(patch).eq('party_code', code), 'cd_accounts')
  return { ok: true }
}

// ---------------------------------------------------------------------------
// "Send to Signify": the same calculation as an Excel attachment + a short summary in the
// mail body, through Resend (RESEND_API_KEY, from CD_EMAIL_FROM or ORDERS_EMAIL_FROM — the
// same values the 17:30 orders email uses). To = cd_settings.email_to (edited on the page),
// CC = cd_settings.email_cc (jc.mittal@hotmail.com, always). Every attempt is logged.
// ---------------------------------------------------------------------------
const RESEND_URL = 'https://api.resend.com/emails'
const isEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim())
const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const niceDate = s => s ? new Date(`${s}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : ''
const inr = n => '₹' + (Math.round(Number(n || 0) * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const monthOf = (from, to) => {
  const f = new Date(`${from}T00:00:00Z`), t = new Date(`${to}T00:00:00Z`)
  const lastDay = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 0)).getUTCDate()
  const whole = f.getUTCDate() === 1 && t.getUTCMonth() === f.getUTCMonth() && t.getUTCFullYear() === f.getUTCFullYear() && t.getUTCDate() === lastDay
  return whole ? f.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : `${niceDate(from)} to ${niceDate(to)}`
}

export function emailReady(env = process.env) {
  return { ready: !!env.RESEND_API_KEY, from: env.CD_EMAIL_FROM || env.ORDERS_EMAIL_FROM || 'JCM HQ <onboarding@resend.dev>' }
}

async function buildExcelBase64(d) {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  const lines = []
  for (const a of d.result.filter(x => x.rows.length)) {
    for (const r of a.rows) lines.push({ Account: a.party_name, 'Invoice date': niceDate(r.date), 'Invoice no.': r.vch_no || '', 'Invoice amount (incl. GST)': r.amount, 'Payment date': r.pay_date ? niceDate(r.pay_date) : '', 'Payment no.': r.pay_no || '', 'Payment amount': r.pay_amount ?? '', 'Paid from': r.pay_account || '', Days: r.days ?? '', 'CD %': r.pct, 'CD amount': r.cd, Status: r.status })
    const purchases = a.rows.filter(r => r.kind === 'purchase')
    lines.push({ Account: `Total — ${a.party_name}`, 'Invoice no.': `${purchases.length} invoices`, 'Invoice amount (incl. GST)': r2(purchases.reduce((s, r) => s + r.amount, 0)), 'CD amount': r2(a.rows.reduce((s, r) => s + r.cd, 0)) })
    lines.push({})
  }
  const t = d.totals
  lines.push({ Account: 'GRAND TOTAL', 'Invoice no.': `${t.invoices} invoices`, 'Invoice amount (incl. GST)': t.amount, 'CD amount': t.cd, Status: `Slab A ${t.slab_a} · Slab B ${t.slab_b} · late ${t.none} · unpaid ${t.unpaid}` })
  const ws = XLSX.utils.json_to_sheet([])
  XLSX.utils.sheet_add_aoa(ws, [[`Signify Cash Discount claim — ${monthOf(d.from, d.to)}`], ['J.C. Mittal & Sons, Ratlam — as per circular CD-CIRC-001 (Slab A 0–5 days 1.5%, Slab B 6–10 days 1.0%, FIFO, GST-inclusive)'], [`Figures from Busy as of ${d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}`], []], { origin: 'A1' })
  XLSX.utils.sheet_add_json(ws, lines, { origin: 'A5' })
  ws['!cols'] = [{ wch: 44 }, { wch: 13 }, { wch: 20 }, { wch: 22 }, { wch: 13 }, { wch: 20 }, { wch: 16 }, { wch: 6 }, { wch: 6 }, { wch: 14 }, { wch: 34 }]
  XLSX.utils.book_append_sheet(wb, ws, 'CD claim')
  const sum = d.result.filter(x => x.rows.length).map(a => ({ Account: a.party_name, 'Busy code': a.party_code, Invoices: a.rows.filter(r => r.kind === 'purchase').length, 'Invoice total': r2(a.rows.filter(r => r.kind === 'purchase').reduce((t, r) => t + r.amount, 0)), 'CD amount': r2(a.rows.reduce((t, r) => t + r.cd, 0)), 'Paid through': d.pools.find(p => p.id === a.pool)?.hub_name || '' }))
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sum), 'Summary')
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' })
}

function buildMail(d, message, signature) {
  const t = d.totals
  const period = monthOf(d.from, d.to)
  const th = 'style="text-align:left;padding:6px 10px;background:#F6F7FB;font-size:12px;color:#6B7280"'
  const td = 'style="padding:6px 10px;border-top:1px solid #E5E7EB;font-size:14px"'
  const tdr = td.replace('font-size', 'text-align:right;font-size')
  const rows = d.result.filter(x => x.rows.length).map(a => {
    const p = a.rows.filter(r => r.kind === 'purchase')
    return `<tr><td ${td}>${escHtml(a.party_name)}</td><td ${tdr}>${p.length}</td><td ${tdr}>${inr(p.reduce((s, r) => s + r.amount, 0))}</td><td ${tdr}>${inr(a.rows.reduce((s, r) => s + r.cd, 0))}</td></tr>`
  }).join('')
  const sig = String(signature || '').split('\n').map(l => escHtml(l)).join('<br>')
  const html = `<div style="font-family:Arial,sans-serif;color:#111;max-width:720px;font-size:14px;line-height:1.5">
    <p>Dear Sir,</p>
    <p>Please find attached our Cash Discount calculation for <b>${escHtml(period)}</b> under the Cash Discount Scheme (Ref. CD-CIRC-001), worked out invoice-wise on FIFO basis from our books.</p>
    ${message ? `<p>${escHtml(message).replace(/\n/g, '<br>')}</p>` : ''}
    <table style="border-collapse:collapse;width:100%;border:1px solid #E5E7EB"><tr><th ${th}>ACCOUNT</th><th ${th} align="right">INVOICES</th><th ${th} align="right">INVOICE VALUE</th><th ${th} align="right">CASH DISCOUNT</th></tr>${rows}
    <tr><td ${td}><b>Total</b></td><td ${tdr}><b>${t.invoices}</b></td><td ${tdr}><b>${inr(t.amount)}</b></td><td ${tdr}><b>${inr(t.cd)}</b></td></tr></table>
    <p style="font-size:13px;color:#5A606C">Slab A (0–5 days, 1.5%): ${t.slab_a} invoices, ${inr(t.slab_a_cd)} · Slab B (6–10 days, 1.0%): ${t.slab_b} invoices, ${inr(t.slab_b_cd)}. Invoice-wise details, payment dates and days are in the attached Excel.</p>
    <p>Kindly verify and pass the credit entries accordingly. Do let us know of any difference so it can be reconciled.</p>
    <p>Thanks &amp; regards,<br>${sig}<br>J.C. Mittal &amp; Sons, Ratlam</p>
  </div>`
  return { subject: `Cash Discount claim — ${period} — J.C. Mittal & Sons, Ratlam (${inr(t.cd)})`, html, period }
}

async function sendMail(busy, body, me) {
  const d = await summary(busy, body)
  const s = d.settings
  const to = (Array.isArray(s.email_to) ? s.email_to : []).filter(isEmail)
  const cc = String(s.email_cc || '').split(/[,;\s]+/).filter(isEmail)
  if (!to.length) fail(400, 'Add at least one email address to send to.')
  if (!d.totals.invoices) fail(400, 'There are no Signify invoices in this date range — nothing to send.')
  const { ready, from } = emailReady()
  const mail = buildMail(d, String(body.message || '').trim().slice(0, 2000), s.email_signature)
  const logRow = { sent_by: me?.name || null, from_date: d.from, to_date: d.to, to_emails: to, cc_emails: cc, subject: mail.subject, total_cd: d.totals.cd, invoices: d.totals.invoices }
  if (!ready) {
    check(await busy.from('cd_email_log').insert({ ...logRow, status: 'not_sent', detail: 'RESEND_API_KEY is not set in Vercel' }), 'cd_email_log')
    fail(500, 'Email is not set up in Vercel yet (RESEND_API_KEY). Nothing was sent.')
  }
  const file = await buildExcelBase64(d)
  let status = 'failed', detail = ''
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, cc, subject: mail.subject, html: mail.html, attachments: [{ filename: `Signify_CD_${d.from}_to_${d.to}.xlsx`, content: file }] }),
    })
    const text = (await res.text()).slice(0, 300)
    status = res.ok ? 'sent' : 'failed'
    detail = res.ok ? `to ${to.join(', ')}${cc.length ? ` cc ${cc.join(', ')}` : ''}` : `Resend said ${res.status}: ${text}`
  } catch (err) { detail = err.message }
  check(await busy.from('cd_email_log').insert({ ...logRow, status, detail }), 'cd_email_log')
  if (status !== 'sent') fail(500, `The email could not be sent — ${detail}`)
  return { ok: true, to, cc, subject: mail.subject }
}

async function emailLog(busy) {
  const rows = check(await busy.from('cd_email_log').select('*').order('sent_at', { ascending: false }).limit(20), 'cd_email_log')
  return { rows, email: emailReady() }
}

async function emailsSave(busy, body) {
  const list = (Array.isArray(body.email_to) ? body.email_to : []).map(x => String(x).trim().toLowerCase()).filter(isEmail)
  check(await busy.from('cd_settings').update({ email_to: [...new Set(list)] }).eq('id', 1), 'cd_settings')
  return { ok: true, email_to: [...new Set(list)] }
}

export async function handleCdAction(action, body, { busy, send, res, me }) {
  if (action === 'cd-summary') { const d = await summary(busy, body); return send(res, 200, { ...d, email: emailReady() }) }
  if (action === 'cd-settings-save') return send(res, 200, await settingsSave(busy, body))
  if (action === 'cd-account-save') return send(res, 200, await accountSave(busy, body))
  if (action === 'cd-adjust-save') return send(res, 200, await adjustSave(busy, body, me))
  if (action === 'cd-adjust-remove') return send(res, 200, await adjustRemove(busy, body))
  if (action === 'cd-emails-save') return send(res, 200, await emailsSave(busy, body))
  if (action === 'cd-send') return send(res, 200, await sendMail(busy, body, me))
  if (action === 'cd-email-log') return send(res, 200, await emailLog(busy))
  return send(res, 400, { error: 'Unknown request.' })
}
