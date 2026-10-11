import { applyCors } from './_cors.js'
import { createClient } from '@supabase/supabase-js'

// GSTR-2A Reconciliation — Busy purchases vs the 2A data Busy downloaded through its GSP,
// party-wise, showing ONLY the red flags (Ruchir's rules, 12 Oct 2026):
//
//   missing_busy  invoice in 2A, nothing like it in Busy  → JCM team's job: get the bill to
//                 the accountant (list goes to admins by WhatsApp + email)
//   not_in_2a     invoice in Busy, nothing like it in 2A  → supplier has not filed it
//                 (WhatsApp reminder to the party from here)
//   amount        same invoice both sides, taxable or tax differs by more than ₹1
//   docno         same invoice both sides (amounts match), invoice number written differently
//                 (e.g. 100037I11234102 vs 11234102, 769/2026-27 vs 769/26-27) — low priority
//   sequence      something odd in a supplier's invoice numbers as booked in Busy: the same
//                 number twice, a later bill with a smaller number, or a gap in the numbers
//   zero          ₹0 purchase vouchers in Busy (FOC / replacement / scheme documents)
//
// Data: gst_2a_rows / gst_purchase_rows / gst_parties in the JCM-Busysql project, written
// every 30 minutes by busy-sync/sync-gst.js on JCM-Server (RLS-closed, read here with the
// Busy service key after the HQ session is checked). Matching happens here, per request:
// the whole year is matched (a bill booked a month late still finds its 2A row) and the
// chosen month is reported.
//
// Access: admins, or anyone with 'gst-recon' in profiles.allowed_tabs.
// Actions (POST JSON):
//   recon  month                         everything for one month ('YYYY-MM') + month list
//   mark   month, bucket, row_key, state ('ignored' | 'done' | ''), note
//   remind-party  month, gstin, row_keys[], message   WhatsApp to the supplier (not_in_2a)
//   notify-admins month                  missing_busy list → every admin, WhatsApp + email
//   log    month                         what was sent for this month

export const config = { maxDuration: 60 }

const SUPABASE_URL = 'https://cmtnzmfuasniicsdxyle.supabase.co'      // HQ / CRM project (profiles)
const SUPABASE_BUSY_URL = 'https://jlkjjqnmhsgefpluemyz.supabase.co' // Busy-data project (gst_*)
const HQ_URL = 'https://hq.jcmretails.com'
const PAGE_URL = `${HQ_URL}/#gst-recon`

const TAB_ID = 'gst-recon'
const TOL = 1            // rupees; a difference above this is a red flag
const MAX_MESSAGE = 1500 // characters per WhatsApp

const opts = { auth: { autoRefreshToken: false, persistSession: false } }

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json(body)
}
function check({ data, error }, what) {
  if (error) { const e = new Error(`${what}: ${error.message}`); e.db = true; throw e }
  return data
}
const isMonth = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''))
const r2 = n => Math.round(Number(n || 0) * 100) / 100
const rupees = n => {
  const v = r2(n)
  return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })
}
function niceDate(s) {
  if (!s) return ''
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00+05:30`)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}
const monthName = m => {
  const d = new Date(`${m}-01T00:00:00+05:30`)
  return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })
}

// ---------- handler ----------
export default async function handler(req, res) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const busyServiceRoleKey = process.env.SUPABASE_BUSY_SERVICE_ROLE_KEY
  if (!serviceRoleKey || !busyServiceRoleKey) {
    console.error('gst is missing env vars', { hq: !!serviceRoleKey, busy: !!busyServiceRoleKey })
    return send(res, 500, { error: 'GST reconciliation is not configured yet.' })
  }
  const hq = createClient(SUPABASE_URL, serviceRoleKey, opts)
  const busy = createClient(SUPABASE_BUSY_URL, busyServiceRoleKey, opts)

  const body = req.body || {}
  const action = String(body.action || '')
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return send(res, 401, { error: 'Please sign in again.' })

  try {
    const { data: userData, error: userErr } = await hq.auth.getUser(token)
    if (userErr || !userData?.user) return send(res, 401, { error: 'Please sign in again.' })
    const profile = check(await hq.from('profiles')
      .select('id, name, email, role, is_admin, active, allowed_tabs, whatsapp')
      .eq('id', userData.user.id).maybeSingle(), 'profile')
    if (!profile || profile.active === false) return send(res, 403, { error: 'Your account is not active.' })
    const isAdmin = profile.is_admin === true || profile.role === 'admin'
    const granted = Array.isArray(profile.allowed_tabs) && profile.allowed_tabs.includes(TAB_ID)
    if (!isAdmin && !granted) return send(res, 403, { error: 'You do not have access to GST reconciliation.' })
    const who = profile.name || profile.email || 'HQ user'

    if (action === 'recon') {
      const month = isMonth(body.month) ? body.month : null
      return send(res, 200, await loadRecon(busy, month))
    }
    if (action === 'mark') {
      const { month, bucket, row_key } = body
      if (!isMonth(month) || !BUCKETS.includes(bucket) || !row_key) return send(res, 400, { error: 'Bad request.' })
      const state = ['ignored', 'done'].includes(body.state) ? body.state : ''
      if (!state) check(await busy.from('gst_marks').delete().match({ month, bucket, row_key }), 'mark')
      else check(await busy.from('gst_marks').upsert({ month, bucket, row_key, state, note: String(body.note || '').slice(0, 300) || null, by_name: who, marked_at: new Date().toISOString() }, { onConflict: 'month,bucket,row_key' }), 'mark')
      return send(res, 200, { ok: true })
    }
    if (action === 'remind-party') {
      const month = isMonth(body.month) ? body.month : null
      const gstin = String(body.gstin || '').trim()
      const keys = Array.isArray(body.row_keys) ? body.row_keys.map(String).slice(0, 50) : []
      if (!month || !gstin || !keys.length) return send(res, 400, { error: 'Pick the invoices to remind about.' })
      return send(res, 200, await remindParty(busy, { month, gstin, keys, message: body.message, who }))
    }
    if (action === 'notify-admins') {
      const month = isMonth(body.month) ? body.month : null
      if (!month) return send(res, 400, { error: 'Pick a month.' })
      return send(res, 200, await notifyAdmins(busy, hq, { month, who }))
    }
    if (action === 'log') {
      const month = isMonth(body.month) ? body.month : null
      const rows = check(await busy.from('gst_log').select('*').eq('month', month).order('sent_at', { ascending: false }).limit(200), 'log')
      return send(res, 200, { rows })
    }
    return send(res, 400, { error: 'Unknown action.' })
  } catch (err) {
    console.error('gst error:', err)
    return send(res, 500, { error: err.db ? 'Could not read the GST data. Is supabase/gst-setup.sql run?' : (err.message || 'Something went wrong.') })
  }
}

// ---------- data ----------
async function all(busy, table, select) {
  const out = []
  for (let from = 0; from < 200000; from += 1000) {
    const rows = check(await busy.from(table).select(select).range(from, from + 999), table)
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

async function loadRecon(busy, month) {
  const [rows2a, rowsPur, parties, settings] = await Promise.all([
    all(busy, 'gst_2a_rows', 'row_key, db_name, gstin, trade_name, tran_type, vch_no, vch_date, inv_month, filed_period, supplier_filed_on, taxable, cgst, sgst, igst, cess, total, pulled_at'),
    all(busy, 'gst_purchase_rows', 'vch_key, db_name, vch_code, vch_no, vch_date, inv_month, party_code, party_name, gstin, series, taxable, cgst, sgst, igst, cess, total, entered_by, entered_at'),
    all(busy, 'gst_parties', 'party_code, party_name, gstin, mobile, whatsapp, email, station'),
    busy.from('gst_settings').select('*').eq('id', 1).maybeSingle().then(r => check(r, 'settings')),
  ])
  const months = [...new Set([...rows2a, ...rowsPur].map(r => r.inv_month).filter(Boolean))].sort().reverse()
  if (!month) month = months[0] || null
  const marks = month ? check(await busy.from('gst_marks').select('*').eq('month', month), 'marks') : []
  const result = month ? reconcile(rows2a, rowsPur, parties, marks, month) : emptyResult()
  return {
    month, months,
    lastSyncAt: settings?.last_sync_at || null,
    pulledAt: settings?.pulled_at || null,
    ...result,
  }
}

export const BUCKETS = ['missing_busy', 'not_in_2a', 'amount', 'docno', 'sequence', 'zero']
const emptyResult = () => ({ rows: [], counts: {}, totals: {}, matchedOk: 0, contacts: {}, notes: [] })

// ---------- matching ----------
const normNo = s => String(s || '').toUpperCase().replace(/\s+/g, '')
const alnum = s => normNo(s).replace(/[^A-Z0-9]/g, '')
// Financial-year bits in an invoice number ('/2026-27', '/26-27', '2627', 'FY26') are not
// part of the running number, so they are dropped before the digits are compared.
const stripFy = s => String(s || '').replace(/20\d\d\s*-\s*(20)?\d\d/g, '').replace(/(^|[^0-9])\d\d\s*-\s*\d\d(?![0-9])/g, '$1').replace(/(^|[^0-9])2[5-9]2[6-9](?![0-9])/g, '$1')
const digitsOf = s => stripFy(s).replace(/\D/g, '').replace(/^0+/, '')
// The LONGEST run of digits left is the running number, ties → the last one.
// 'NL/26-27/7507' → 7507, 'INV092608005352' → 92608005352, '769/2026-27' → 769, '2307-FAN' → 2307.
function runningNo(s) {
  const runs = stripFy(s).match(/\d+/g) || []
  let best = null
  for (const r of runs) if (!best || r.length >= best.length) best = r
  return best ? parseInt(best, 10) : null
}
const tax = r => r2((r.cgst || 0) + (r.sgst || 0) + (r.igst || 0))
const near = (a, b) => Math.abs(r2(a) - r2(b)) <= TOL
const amountsMatch = (p, b) => near(p.taxable, b.taxable) && near(tax(p), tax(b))
const sameNumber = (a, b) => {
  const x = alnum(a), y = alnum(b)
  if (x && x === y) return true
  const dx = digitsOf(a), dy = digitsOf(b)
  if (dx.length >= 3 && dx === dy) return true
  if (dx.length >= 4 && dy.length >= 4 && (dx.endsWith(dy) || dy.endsWith(dx))) return true
  return false
}

export function reconcile(rows2a, rowsPur, parties, marks, month) {
  const portal = rows2a.filter(r => r.gstin && r.vch_no)
  const invoices = portal.filter(r => r.tran_type === 1 || r.tran_type == null)
  const notes2a = portal.filter(r => !(r.tran_type === 1 || r.tran_type == null) && r.inv_month === month)
  const zero = rowsPur.filter(b => r2(b.total) === 0)
  const books = rowsPur.filter(b => r2(b.total) !== 0 && b.gstin && b.vch_no)

  const byG2a = groupBy(invoices, r => r.gstin)
  const byGb = groupBy(books, r => r.gstin)
  const pairs = []            // { p, b, how }
  const unP = new Set(invoices.map(r => r.row_key))
  const unB = new Set(books.map(r => r.vch_key))

  const gstins = new Set([...byG2a.keys(), ...byGb.keys()])
  for (const g of gstins) {
    const ps = byG2a.get(g) || []
    const bs = byGb.get(g) || []
    if (!ps.length || !bs.length) continue
    // 1. exact number
    const exact = new Map()
    for (const p of ps) { const k = alnum(p.vch_no); if (k && !exact.has(k)) exact.set(k, p) }
    for (const b of bs) {
      const p = exact.get(alnum(b.vch_no))
      if (p && unP.has(p.row_key) && unB.has(b.vch_key)) { pairs.push({ p, b, how: 'exact' }); unP.delete(p.row_key); unB.delete(b.vch_key) }
    }
    // 2. same running number written differently (prefix / year suffix), closest amounts win
    for (const b of bs) {
      if (!unB.has(b.vch_key)) continue
      const cands = ps.filter(p => unP.has(p.row_key) && sameNumber(p.vch_no, b.vch_no))
      if (!cands.length) continue
      cands.sort((x, y) => Math.abs(r2(x.total) - r2(b.total)) - Math.abs(r2(y.total) - r2(b.total)))
      const p = cands[0]
      pairs.push({ p, b, how: 'number' }); unP.delete(p.row_key); unB.delete(b.vch_key)
    }
    // 3. amounts match exactly, number unrelated (e.g. 2350-APP vs 2350-SDA, 7514 vs NS-25/CR 7514)
    for (const b of bs) {
      if (!unB.has(b.vch_key)) continue
      const cands = ps.filter(p => unP.has(p.row_key) && amountsMatch(p, b))
      if (cands.length !== 1) continue
      const p = cands[0]
      // only when this 2A row has no other Busy candidate either
      const others = bs.filter(o => o !== b && unB.has(o.vch_key) && amountsMatch(p, o))
      if (others.length) continue
      pairs.push({ p, b, how: 'amount' }); unP.delete(p.row_key); unB.delete(b.vch_key)
    }
  }

  const rows = []
  let matchedOk = 0
  const partyOf = b => b.party_name || null
  for (const { p, b, how } of pairs) {
    const m = p.inv_month || b.inv_month
    if (m !== month) continue
    const base = {
      gstin: p.gstin, party: partyOf(b) || p.trade_name, party_code: b.party_code,
      p_no: p.vch_no, p_date: p.vch_date, b_no: b.vch_no, b_date: b.vch_date,
      p_taxable: r2(p.taxable), p_tax: tax(p), p_total: r2(p.total),
      b_taxable: r2(b.taxable), b_tax: tax(b), b_total: r2(b.total),
      diff_taxable: r2(r2(b.taxable) - r2(p.taxable)), diff_tax: r2(tax(b) - tax(p)),
      filed_period: p.filed_period, supplier_filed_on: p.supplier_filed_on, entered_by: b.entered_by, how,
    }
    if (!amountsMatch(p, b)) rows.push({ ...base, bucket: 'amount', row_key: `${p.row_key}~${b.vch_key}`, note: alnum(p.vch_no) === alnum(b.vch_no) ? '' : `Invoice no. also differs: 2A ${p.vch_no} / Busy ${b.vch_no}` })
    else if (alnum(p.vch_no) !== alnum(b.vch_no)) rows.push({ ...base, bucket: 'docno', row_key: `${p.row_key}~${b.vch_key}`, note: how === 'amount' ? 'Matched by amount only — numbers look unrelated' : 'Same number, written differently' })
    else matchedOk++
  }
  for (const p of invoices) {
    if (!unP.has(p.row_key) || p.inv_month !== month) continue
    rows.push({
      bucket: 'missing_busy', row_key: p.row_key, gstin: p.gstin, party: p.trade_name || p.gstin, party_code: null,
      p_no: p.vch_no, p_date: p.vch_date, p_taxable: r2(p.taxable), p_tax: tax(p), p_total: r2(p.total),
      filed_period: p.filed_period, supplier_filed_on: p.supplier_filed_on, note: '',
    })
  }
  for (const b of books) {
    if (!unB.has(b.vch_key) || b.inv_month !== month) continue
    rows.push({
      bucket: 'not_in_2a', row_key: b.vch_key, gstin: b.gstin, party: partyOf(b), party_code: b.party_code,
      b_no: b.vch_no, b_date: b.vch_date, b_taxable: r2(b.taxable), b_tax: tax(b), b_total: r2(b.total),
      entered_by: b.entered_by, note: '',
    })
  }
  for (const b of zero) {
    if (b.inv_month !== month) continue
    rows.push({
      bucket: 'zero', row_key: b.vch_key, gstin: b.gstin, party: partyOf(b), party_code: b.party_code,
      b_no: b.vch_no, b_date: b.vch_date, b_taxable: 0, b_tax: 0, b_total: 0, entered_by: b.entered_by,
      note: b.series ? `Series ${b.series}` : '',
    })
  }
  rows.push(...sequenceFlags(books, month))

  // Busy party names for 2A-only rows, when the GSTIN is known in the party master.
  const nameByGstin = new Map()
  for (const b of books) if (b.gstin && b.party_name && !nameByGstin.has(b.gstin)) nameByGstin.set(b.gstin, b.party_name)
  for (const p of parties) if (p.gstin && p.party_name && !nameByGstin.has(p.gstin)) nameByGstin.set(p.gstin, p.party_name)
  for (const r of rows) {
    if (r.bucket !== 'missing_busy') continue
    if (nameByGstin.has(r.gstin)) r.party = nameByGstin.get(r.gstin)
    else if (!r.party || r.party === r.gstin) { r.party = null; r.new_party = true; r.note = 'Not in Busy party master — new party to be created' }
  }

  // Marks
  const markMap = new Map(marks.map(m => [`${m.bucket}|${m.row_key}`, m]))
  for (const r of rows) {
    const m = markMap.get(`${r.bucket}|${r.row_key}`)
    if (m) r.mark = { state: m.state, note: m.note, by: m.by_name, at: m.marked_at }
  }

  // Contacts for suppliers that have not filed.
  const contacts = {}
  const partyByCode = new Map(parties.map(p => [p.party_code, p]))
  const partyByGstin = groupBy(parties, p => p.gstin)
  for (const r of rows) {
    if (r.bucket !== 'not_in_2a' || contacts[r.gstin]) continue
    const c = partyByCode.get(r.party_code) || (partyByGstin.get(r.gstin) || [])[0]
    if (c) contacts[r.gstin] = { name: c.party_name, mobile: c.mobile, whatsapp: c.whatsapp, email: c.email, station: c.station }
  }

  const counts = {}, totals = {}
  for (const k of BUCKETS) { counts[k] = 0; totals[k] = 0 }
  for (const r of rows) {
    if (r.mark) continue
    counts[r.bucket]++
    totals[r.bucket] = r2(totals[r.bucket] + (r.bucket === 'missing_busy' ? r.p_total : r.bucket === 'amount' ? Math.abs(r.diff_taxable) + Math.abs(r.diff_tax) : r.b_total || 0))
  }
  rows.sort((a, b) => (a.party || '').localeCompare(b.party || '') || String(a.p_date || a.b_date || '').localeCompare(String(b.p_date || b.b_date || '')))
  const notes = notes2a.map(n => ({ gstin: n.gstin, party: nameByGstin.get(n.gstin) || n.trade_name, no: n.vch_no, date: n.vch_date, taxable: r2(n.taxable), tax: tax(n), tran_type: n.tran_type }))
  return { rows, counts, totals, matchedOk, contacts, notes }
}

// Something odd in a supplier's invoice numbers as booked in Busy. Numbers are compared
// over the whole year; only problems touching the chosen month are reported.
function sequenceFlags(books, month) {
  const out = []
  for (const [gstin, list] of groupBy(books, b => b.gstin)) {
    const rows = list.map(b => ({ b, n: runningNo(b.vch_no), k: alnum(b.vch_no) })).filter(x => x.n != null)
    if (rows.length < 2) continue
    const flag = (x, kind, note, extra = {}) => {
      if (x.b.inv_month !== month) return
      out.push({ bucket: 'sequence', row_key: `${x.b.vch_key}|${kind}`, gstin, party: x.b.party_name, party_code: x.b.party_code,
        b_no: x.b.vch_no, b_date: x.b.vch_date, b_taxable: r2(x.b.taxable), b_tax: tax(x.b), b_total: r2(x.b.total), entered_by: x.b.entered_by, kind, note, ...extra })
    }
    // same number twice
    const seen = new Map()
    for (const x of rows) {
      if (seen.has(x.k)) { flag(x, 'duplicate', `Same invoice number as bill dated ${niceDate(seen.get(x.k).b.vch_date)} (${rupees(seen.get(x.k).b.total)})`) }
      else seen.set(x.k, x)
    }
    // later date, smaller number
    const byDate = [...rows].sort((a, b) => String(a.b.vch_date).localeCompare(String(b.b.vch_date)) || a.n - b.n)
    let maxSoFar = null
    for (const x of byDate) {
      if (maxSoFar && x.n < maxSoFar.n && String(x.b.vch_date) > String(maxSoFar.b.vch_date)) flag(x, 'backward', `Number ${x.n} is smaller than ${maxSoFar.b.vch_no} dated ${niceDate(maxSoFar.b.vch_date)}`)
      if (!maxSoFar || x.n > maxSoFar.n) maxSoFar = x
    }
    // gaps between consecutive numbers (supplier bills other customers too — expected, but asked for)
    const byNo = [...rows].sort((a, b) => a.n - b.n)
    for (let i = 1; i < byNo.length; i++) {
      const gap = byNo[i].n - byNo[i - 1].n - 1
      if (gap > 0 && byNo[i].k !== byNo[i - 1].k) flag(byNo[i], 'gap', `${gap} number${gap === 1 ? '' : 's'} missing between ${byNo[i - 1].b.vch_no} (${niceDate(byNo[i - 1].b.vch_date)}) and this bill`, { gap })
    }
  }
  return out
}

function groupBy(list, keyFn) {
  const m = new Map()
  for (const x of list) { const k = keyFn(x); if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(x) }
  return m
}

// ---------- WhatsApp (Whatshub360, same settings as the other modules) ----------
function cleanPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '')
  return /^[6-9]\d{9}$/.test(d) ? d : null
}
async function sendWhatsApp(mobile, message) {
  const template = process.env.WHATSHUB_SEND_URL
  if (!template) return 'not_set_up'
  const digits = cleanPhone(mobile)
  if (!digits) return 'no_number'
  const url = template
    .replace('{vid}', encodeURIComponent(process.env.WHATSHUB_VID || ''))
    .replace('{mobile}', digits)
    .replace('{msg}', encodeURIComponent(message))
  try {
    const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) })
    const text = (await r.text()).slice(0, 300)
    if (!r.ok || /error|fail|invalid/i.test(text)) { console.error('Whatshub360 GST message failed:', r.status, text); return 'failed' }
    return 'sent'
  } catch (err) {
    console.error('Whatshub360 GST message error:', err)
    return 'failed'
  }
}
function fitLines(head, list, tail) {
  const out = []
  let used = head.length + tail.length + 40
  for (let i = 0; i < list.length; i++) {
    if (used + list[i].length + 1 > MAX_MESSAGE) { out.push(`…and ${list.length - i} more`); break }
    out.push(list[i]); used += list[i].length + 1
  }
  return `${head}\n${out.join('\n')}\n${tail}`.trim()
}

const DEFAULT_PARTY_MESSAGE =
  'Namaste {name},\n\nJ.C. Mittal & Sons (JCM Retails), Ratlam — GSTIN 23AAPFJ0607D1ZT.\n' +
  'Our GSTR-2A for {month} does not show these invoices of yours:\n{list}\n' +
  'Please check your GSTR-1 and file / amend it so that we can claim the input credit. Thank you.'

async function remindParty(busy, { month, gstin, keys, message, who }) {
  const [rows, parties] = await Promise.all([
    all(busy, 'gst_purchase_rows', 'vch_key, vch_no, vch_date, party_code, party_name, gstin, taxable, cgst, sgst, igst, total'),
    busy.from('gst_parties').select('*').eq('gstin', gstin).then(r => check(r, 'parties')),
  ])
  const bills = rows.filter(r => keys.includes(r.vch_key) && r.gstin === gstin)
  if (!bills.length) return { status: 'failed', detail: 'Those bills were not found.' }
  const contact = parties.find(p => p.party_code === bills[0].party_code) || parties[0]
  const number = contact?.whatsapp || contact?.mobile
  const name = bills[0].party_name || contact?.party_name || 'Sir/Madam'
  const list = bills.map(b => `• ${b.vch_no} dt ${niceDate(b.vch_date)} — ${rupees(b.total)}`)
  const tpl = String(message || DEFAULT_PARTY_MESSAGE).slice(0, 1200)
  const text = tpl.replace('{name}', name).replace('{month}', monthName(month)).replace('{list}', fitLines('', list, ''))
  const status = await sendWhatsApp(number, text)
  check(await busy.from('gst_log').insert({ month, kind: 'party_reminder', channel: 'whatsapp', gstin, recipient: number ? String(number) : null, status, detail: `${bills.length} bill(s): ${bills.map(b => b.vch_no).join(', ')}`.slice(0, 500), by_name: who }), 'log')
  return { status, number: number || null, name, count: bills.length }
}

// ---------- admins: the "missing in Busy" list ----------
async function notifyAdmins(busy, hq, { month, who }) {
  const data = await loadRecon(busy, month)
  const missing = data.rows.filter(r => r.bucket === 'missing_busy' && !r.mark)
  const admins = check(await hq.from('profiles').select('id, name, email, whatsapp, role, is_admin, active'), 'admins')
    .filter(p => p.active !== false && (p.is_admin === true || p.role === 'admin'))
  const results = []
  const total = missing.reduce((s, r) => s + (r.p_total || 0), 0)

  // WhatsApp
  const lines = missing.map(r => `• ${r.party || r.gstin} — ${r.p_no} dt ${niceDate(r.p_date)} — ${rupees(r.p_total)}`)
  const head = `JCM HQ — GSTR-2A ${monthName(month)}\n${missing.length} invoice(s) in 2A are NOT entered in Busy (total ${rupees(total)}). Please get these bills to the accountant:`
  const text = fitLines(head, lines, `Full list + Excel: ${PAGE_URL}`)
  for (const a of admins) {
    const status = await sendWhatsApp(a.whatsapp, text)
    results.push({ name: a.name || a.email, channel: 'whatsapp', status })
    check(await busy.from('gst_log').insert({ month, kind: 'admin_list', channel: 'whatsapp', recipient: a.whatsapp ? String(a.whatsapp) : null, status, detail: `${missing.length} missing in Busy`, by_name: who }), 'log')
  }

  // Email (Resend), when set up
  const to = [...new Set([...admins.map(a => a.email), ...String(process.env.GST_REPORT_EMAIL || '').split(/[,;\s]+/)].filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x || '')))]
  const apiKey = process.env.RESEND_API_KEY
  let emailStatus = 'not_set_up', emailDetail = apiKey ? (to.length ? '' : 'no admin has an email') : 'RESEND_API_KEY is not set in Vercel'
  if (apiKey && to.length) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.GST_EMAIL_FROM || 'JCM HQ <onboarding@resend.dev>', to, subject: `GSTR-2A ${monthName(month)} — ${missing.length} invoice(s) not entered in Busy (${rupees(total)})`, html: adminEmailHtml(month, missing, total) }),
      })
      const t = (await r.text()).slice(0, 300)
      emailStatus = r.ok ? 'sent' : 'failed'; emailDetail = r.ok ? `to ${to.join(', ')}` : `Resend said ${r.status}: ${t}`
    } catch (err) { emailStatus = 'failed'; emailDetail = err.message }
  }
  results.push({ name: to.join(', ') || '—', channel: 'email', status: emailStatus, detail: emailDetail })
  check(await busy.from('gst_log').insert({ month, kind: 'admin_list', channel: 'email', recipient: to.join(', ') || null, status: emailStatus, detail: emailDetail.slice(0, 500), by_name: who }), 'log')
  return { count: missing.length, total, results }
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
function adminEmailHtml(month, missing, total) {
  const th = 'style="text-align:left;padding:6px 10px;background:#F1ECE0;font-size:12px;letter-spacing:.04em;color:#3E4553"'
  const td = 'style="padding:6px 10px;border-top:1px solid #ECE6D8;font-size:14px;vertical-align:top"'
  const tdr = td.replace('text-align:left;', '') + ' align="right"'
  const byParty = groupBy(missing, r => `${r.party || ''}|${r.gstin}`)
  const parts = [`<div style="font-family:Arial,sans-serif;color:#0C111B;max-width:760px">
    <div style="background:#12213B;color:#FFFFFF;padding:14px 18px;border-bottom:3px solid #D9AE55;font-size:20px;font-weight:bold">GSTR-2A ${esc(monthName(month))} — not entered in Busy</div>
    <p style="font-size:14px">${missing.length} invoice(s) are in the GST portal's 2A but have no matching purchase entry in Busy, total ${esc(rupees(total))}. Please get these bills to the accountant for entry.</p>`]
  for (const [, list] of byParty) {
    const r0 = list[0]
    parts.push(`<p style="font-size:15px;font-weight:bold;margin:14px 0 4px">${esc(r0.party || r0.gstin)} <span style="font-weight:normal;color:#5A606C">${esc(r0.gstin)}</span></p>
      <table style="border-collapse:collapse;width:100%;border:1px solid #E2DCCD"><tr><th ${th}>INVOICE</th><th ${th}>DATE</th><th ${th}>TAXABLE</th><th ${th}>TAX</th><th ${th}>TOTAL</th><th ${th}>FILED IN</th></tr>
      ${list.map(r => `<tr><td ${td}>${esc(r.p_no)}</td><td ${td}>${esc(niceDate(r.p_date))}</td><td ${tdr}>${esc(rupees(r.p_taxable))}</td><td ${tdr}>${esc(rupees(r.p_tax))}</td><td ${tdr}><b>${esc(rupees(r.p_total))}</b></td><td ${td}>${esc(r.filed_period || '')}</td></tr>`).join('')}
      </table>`)
  }
  parts.push(`<p style="font-size:14px;margin-top:18px">Open the page for the full picture and the Excel: <a href="${PAGE_URL}">${PAGE_URL}</a></p>
    <p style="font-size:12px;color:#5A606C;margin-top:24px">Sent by JCM HQ — GSTR-2A Reconciliation.</p></div>`)
  return parts.join('\n')
}
