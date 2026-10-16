// Cash Drawer — the counter's daily cash register, kept on the counter PC all day.
//
//   A (opening, last night's counted cash) + B (today's cash in) = C (today's cash out) + D (counted tonight)
//
// B and C have two sources:
//   • Busy — party_ledger rows of the drawer's cash account (cash_settings.account_code, default
//     56680 Cash (Retail)), copied every 30 min by busy-sync/sync-ledger.js. Debit = cash came in
//     (cash sales, dues receipts), credit = cash went out (payments, journals, sales returns,
//     contra/bank deposits that someone entered in Busy).
//   • The page — cash_entries typed on the keypad + a category card (transfer to admin office,
//     COD, transport, chartered bus, auto freight, tea …). These are things Busy never sees.
// Tonight's D becomes tomorrow's A. A day nobody closed carries its EXPECTED closing forward
// (flagged "not counted") so one missed night never breaks the chain.
//
// Served from api/purchases.js (actions starting with "cash-") so no extra Vercel function.
// Tables cash_settings / cash_categories / cash_entries / cash_days in the Busy project
// (supabase/cash-drawer-setup.sql, migration cash_drawer_setup), closed to the browser.
//
// Access: admins, or 'cash-drawer' in profiles.allowed_tabs (checked in purchases.js).
// Actions (POST JSON, via /api/purchases):
//   cash-day        day                 everything for one day: A, B, C, expected, entries, Busy rows, closing
//   cash-add        kind, category_id, amount, note      log one cash in / out for TODAY
//   cash-delete     id, reason          strike out an entry (own entries today, admins any time); kept, shown struck
//   cash-opening    day, amount, note   set the opening balance (first day, or a correction — admins after day one)
//   cash-close      day, counted, denominations, note    D for the day → difference; can be done again (admins)
//   cash-printed    day                 remember when the sheet was printed
//   cash-refresh                        ask JCM-Server to copy Busy's ledger now (JCM Sync job 'ledger')
//   cash-cat-save   id?, kind, label, emoji, needs_note, sort, active   (admins) add / change a card

const TAB_ID = 'cash-drawer'
export const cashTabId = () => TAB_ID

const IST_MS = 5.5 * 3600 * 1000
const todayIST = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10)
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
const r2 = n => Math.round(Number(n || 0) * 100) / 100
function addDays(d, n) {
  const t = new Date(`${d}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}
const MAX_CHAIN_DAYS = 400
const DENOMS = ['500', '200', '100', '50', '20', '10', 'coins']

function check({ data, error }, what) {
  if (error) { const e = new Error(`${what}: ${error.message}`); e.db = true; throw e }
  return data
}
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e }

async function settings(busy) {
  return check(await busy.from('cash_settings').select('*').eq('id', 1).maybeSingle(), 'cash_settings')
    || { account_code: '56680', account_name: 'Cash (Retail)', print_at: '20:00', start_day: null }
}

async function fetchAll(build, what) {
  const out = []
  for (let from = 0; from < 50000; from += 1000) {
    const rows = check(await build().range(from, from + 999), what)
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

// Busy cash-book rows for the account between two dates, inclusive.
async function busyRows(busy, code, from, to) {
  return fetchAll(() => busy.from('party_ledger')
    .select('vch_code, sr_no, vch_type, vch_type_name, vch_no, vch_date, debit, credit')
    .eq('party_code', String(code)).gte('vch_date', from).lte('vch_date', to)
    .order('vch_date').order('vch_code').order('sr_no'), 'party_ledger')
}
async function entryRows(busy, from, to, withDeleted = false) {
  return fetchAll(() => {
    let q = busy.from('cash_entries').select('*').gte('day', from).lte('day', to).order('created_at')
    if (!withDeleted) q = q.is('deleted_at', null)
    return q
  }, 'cash_entries')
}

// Totals for one day from its rows.
function flows(busyList, entries) {
  const busyIn = r2(busyList.reduce((s, r) => s + Number(r.debit || 0), 0))
  const busyOut = r2(busyList.reduce((s, r) => s + Number(r.credit || 0), 0))
  const live = entries.filter(e => !e.deleted_at)
  const manualIn = r2(live.filter(e => e.kind === 'in').reduce((s, e) => s + Number(e.amount), 0))
  const manualOut = r2(live.filter(e => e.kind === 'out').reduce((s, e) => s + Number(e.amount), 0))
  return { busyIn, busyOut, manualIn, manualOut, totalIn: r2(busyIn + manualIn), totalOut: r2(busyOut + manualOut) }
}

// A for `day`: the nearest earlier anchor (a closed day's counted cash, or a typed opening),
// then every day in between walked forward. Days between that were never counted carry
// their expected closing and are reported in `gaps`.
async function openingFor(busy, s, day) {
  const own = check(await busy.from('cash_days').select('day, opening, opening_note').eq('day', day).maybeSingle(), 'cash_days')
  if (own && own.opening != null) return { amount: r2(own.opening), source: 'typed', note: own.opening_note || '', gaps: [] }
  if (!s.start_day || day <= s.start_day) return { amount: null, source: 'none', gaps: [] }

  const anchor = check(await busy.from('cash_days').select('day, opening, counted')
    .lt('day', day).or('counted.not.is.null,opening.not.is.null')
    .order('day', { ascending: false }).limit(1).maybeSingle(), 'cash_days')
  if (!anchor) return { amount: null, source: 'none', gaps: [] }

  let walkFrom, base
  if (anchor.counted != null) { base = r2(anchor.counted); walkFrom = addDays(anchor.day, 1) }
  else { base = r2(anchor.opening); walkFrom = anchor.day }
  const walkTo = addDays(day, -1)
  const gaps = []
  if (walkFrom <= walkTo) {
    const [bl, el, days] = await Promise.all([
      busyRows(busy, s.account_code, walkFrom, walkTo),
      entryRows(busy, walkFrom, walkTo),
      busy.from('cash_days').select('day, opening, counted').gte('day', walkFrom).lte('day', walkTo).then(r => check(r, 'cash_days')),
    ])
    const dayMap = new Map(days.map(d => [d.day, d]))
    let d = walkFrom, n = 0
    while (d <= walkTo && n++ < MAX_CHAIN_DAYS) {
      const f = flows(bl.filter(r => r.vch_date === d), el.filter(e => e.day === d))
      const row = dayMap.get(d)
      if (row && row.opening != null && d !== anchor.day) base = r2(row.opening)
      const expected = r2(base + f.totalIn - f.totalOut)
      if (row && row.counted != null) base = r2(row.counted)
      else {
        if (f.totalIn || f.totalOut) gaps.push({ day: d, expected })
        base = expected
      }
      d = addDays(d, 1)
    }
  }
  return { amount: base, source: anchor.counted != null && !gaps.length ? 'counted' : 'carried', from: anchor.day, gaps }
}

// Party names for Busy rows: the transaction WhatsApp queue knows the billed party per voucher.
async function namesFor(busy, codes) {
  if (!codes.length) return new Map()
  const rows = check(await busy.from('wa_outbox').select('vch_code, party_name, ledger_name, kind')
    .in('vch_code', codes.slice(0, 500)), 'wa_outbox')
  const m = new Map()
  for (const r of rows) if (!m.has(r.vch_code)) m.set(r.vch_code, r.party_name || r.ledger_name || '')
  return m
}

async function dayData(busy, body) {
  const s = await settings(busy)
  const day = isDate(body.day) ? body.day : todayIST()
  const [opening, bl, entries, closeRow, cats, job] = await Promise.all([
    openingFor(busy, s, day),
    busyRows(busy, s.account_code, day, day),
    entryRows(busy, day, day, true),
    busy.from('cash_days').select('*').eq('day', day).maybeSingle().then(r => check(r, 'cash_days')),
    busy.from('cash_categories').select('*').order('sort').order('id').then(r => check(r, 'cash_categories')),
    busy.from('sync_jobs').select('last_ok_at, last_finished_at, running, run_requested_at').eq('job_id', 'ledger').maybeSingle().then(r => r.data || null),
  ])
  const names = await namesFor(busy, [...new Set(bl.map(r => r.vch_code))])
  const busyList = bl.map(r => ({
    vch_code: r.vch_code, type: r.vch_type_name || '', vch_no: r.vch_no || '',
    party: names.get(r.vch_code) || '',
    in: r2(r.debit), out: r2(r.credit),
  })).filter(r => r.in || r.out)
  const f = flows(bl, entries)
  const A = opening.amount
  const expected = A == null ? null : r2(A + f.totalIn - f.totalOut)
  return {
    day, today: todayIST(),
    account: { code: s.account_code, name: s.account_name },
    print_at: s.print_at, start_day: s.start_day,
    opening, flows: f, expected,
    busy: busyList,
    entries: entries.map(e => ({
      id: e.id, kind: e.kind, category_id: e.category_id, label: e.category_label, amount: r2(e.amount),
      note: e.note || '', by: e.created_by_name || '', by_id: e.created_by, at: e.created_at,
      deleted_at: e.deleted_at, deleted_by: e.deleted_by_name || '', delete_reason: e.delete_reason || '',
    })),
    // Difference is worked out LIVE against today's expected (Shishir, 16 Oct): Busy entries that
    // arrive after the day was closed change B / C, so the difference stored at closing goes stale.
    closing: closeRow && closeRow.counted != null ? {
      counted: r2(closeRow.counted), denominations: closeRow.denominations || null,
      expected: expected != null ? expected : (closeRow.expected == null ? null : r2(closeRow.expected)),
      difference: expected != null ? r2(Number(closeRow.counted) - expected) : (closeRow.difference == null ? null : r2(closeRow.difference)),
      expected_at_close: closeRow.expected == null ? null : r2(closeRow.expected),
      difference_at_close: closeRow.difference == null ? null : r2(closeRow.difference),
      note: closeRow.close_note || '', by: closeRow.closed_by_name || '', at: closeRow.closed_at,
    } : null,
    printed_at: closeRow?.printed_at || null,
    categories: cats,
    busy_sync: job,
  }
}

async function addEntry(busy, body, me) {
  const kind = body.kind === 'in' ? 'in' : body.kind === 'out' ? 'out' : null
  if (!kind) fail(400, 'Pick cash in or cash out.')
  const amount = r2(body.amount)
  if (!(amount > 0)) fail(400, 'Type the amount first.')
  if (amount > 10000000) fail(400, 'That amount looks too big — check it.')
  const cat = check(await busy.from('cash_categories').select('*').eq('id', Number(body.category_id)).maybeSingle(), 'cash_categories')
  if (!cat || !cat.active || cat.kind !== kind) fail(400, 'That card is not available any more. Refresh the page.')
  const note = String(body.note || '').trim().slice(0, 300)
  if (cat.needs_note && !note) fail(400, `Write a short note for "${cat.label}".`)
  const s = await settings(busy)
  if (!s.start_day) fail(400, 'Set the opening balance first.')
  const row = check(await busy.from('cash_entries').insert({
    day: todayIST(), kind, category_id: cat.id, category_label: cat.label, amount, note: note || null,
    created_by: me.id, created_by_name: me.name,
  }).select('id').single(), 'cash_entries')
  return { ok: true, id: row.id }
}

async function deleteEntry(busy, body, me) {
  const e = check(await busy.from('cash_entries').select('*').eq('id', String(body.id || '')).maybeSingle(), 'cash_entries')
  if (!e || e.deleted_at) fail(404, 'That entry is already gone.')
  const mine = e.created_by === me.id && e.day === todayIST()
  if (!me.isAdmin && !mine) fail(403, 'Only the person who made it (on the same day) or an admin can remove this entry.')
  const reason = String(body.reason || '').trim().slice(0, 200)
  if (!reason) fail(400, 'Say why it is being removed.')
  check(await busy.from('cash_entries').update({ deleted_at: new Date().toISOString(), deleted_by_name: me.name, delete_reason: reason })
    .eq('id', e.id), 'cash_entries')
  return { ok: true }
}

async function setOpening(busy, body, me) {
  const day = isDate(body.day) ? body.day : todayIST()
  const amount = r2(body.amount)
  if (!(amount >= 0) || body.amount === '' || body.amount == null) fail(400, 'Type the opening balance.')
  const s = await settings(busy)
  if (s.start_day && !me.isAdmin) fail(403, 'Only an admin can change an opening balance.')
  if (day > todayIST()) fail(400, 'That day has not come yet.')
  const note = String(body.note || '').trim().slice(0, 300) || (s.start_day ? `Changed by ${me.name}` : `Register started by ${me.name}`)
  check(await busy.from('cash_days').upsert({ day, opening: amount, opening_note: note, updated_at: new Date().toISOString() }, { onConflict: 'day' }), 'cash_days')
  if (!s.start_day || day < s.start_day) {
    check(await busy.from('cash_settings').update({ start_day: day, updated_at: new Date().toISOString() }).eq('id', 1), 'cash_settings')
  }
  return { ok: true }
}

async function closeDay(busy, body, me) {
  const day = isDate(body.day) ? body.day : todayIST()
  if (day > todayIST()) fail(400, 'That day has not come yet.')
  const counted = r2(body.counted)
  if (body.counted === '' || body.counted == null || !(counted >= 0)) fail(400, 'Type the cash counted in the drawer.')
  const existing = check(await busy.from('cash_days').select('counted').eq('day', day).maybeSingle(), 'cash_days')
  if (existing && existing.counted != null && !me.isAdmin) fail(403, 'This day is already closed. Ask an admin to change it.')
  let denominations = null
  if (body.denominations && typeof body.denominations === 'object') {
    denominations = {}
    for (const k of DENOMS) {
      const v = Number(body.denominations[k] || 0)
      if (v > 0) denominations[k] = k === 'coins' ? r2(v) : Math.round(v)
    }
    if (!Object.keys(denominations).length) denominations = null
  }
  const d = await dayData(busy, { day })
  if (d.opening.amount == null) fail(400, 'Set the opening balance first.')
  const expected = d.expected
  const difference = r2(counted - expected)
  check(await busy.from('cash_days').upsert({
    day, counted, denominations, expected, difference,
    summary: { A: d.opening.amount, opening_source: d.opening.source, ...d.flows },
    close_note: String(body.note || '').trim().slice(0, 300) || null,
    closed_by_name: me.name, closed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, { onConflict: 'day' }), 'cash_days')
  return { ok: true, expected, counted, difference }
}

async function markPrinted(busy, body) {
  const day = isDate(body.day) ? body.day : todayIST()
  check(await busy.from('cash_days').upsert({ day, printed_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'day' }), 'cash_days')
  return { ok: true }
}

async function requestRefresh(busy, me) {
  const { error } = await busy.from('sync_jobs')
    .update({ run_requested_at: new Date().toISOString(), run_requested_by: me.name || 'Cash Drawer' })
    .eq('job_id', 'ledger')
  if (error) fail(500, 'Could not ask the server to refresh.')
  return { ok: true }
}

async function saveCategory(busy, body, me) {
  if (!me.isAdmin) fail(403, 'Only admins can change the cards.')
  const label = String(body.label || '').trim().slice(0, 40)
  if (!label) fail(400, 'Give the card a name.')
  const row = {
    kind: body.kind === 'in' ? 'in' : 'out', label,
    emoji: String(body.emoji || '').trim().slice(0, 8) || null,
    needs_note: !!body.needs_note,
    sort: Number.isFinite(Number(body.sort)) ? Math.round(Number(body.sort)) : 100,
    active: body.active !== false,
  }
  if (body.id) check(await busy.from('cash_categories').update(row).eq('id', Number(body.id)), 'cash_categories')
  else check(await busy.from('cash_categories').insert(row), 'cash_categories')
  return { ok: true }
}

export async function handleCashAction(action, body, { busy, send, res, me }) {
  if (action === 'cash-day') return send(res, 200, await dayData(busy, body))
  if (action === 'cash-add') return send(res, 200, await addEntry(busy, body, me))
  if (action === 'cash-delete') return send(res, 200, await deleteEntry(busy, body, me))
  if (action === 'cash-opening') return send(res, 200, await setOpening(busy, body, me))
  if (action === 'cash-close') return send(res, 200, await closeDay(busy, body, me))
  if (action === 'cash-printed') return send(res, 200, await markPrinted(busy, body))
  if (action === 'cash-refresh') return send(res, 200, await requestRefresh(busy, me))
  if (action === 'cash-cat-save') return send(res, 200, await saveCategory(busy, body, me))
  return send(res, 400, { error: 'Unknown request.' })
}
