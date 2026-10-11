import { applyCors } from './_cors.js'
import { createClient } from '@supabase/supabase-js'
import { waConfigured, sendTemplate, toWaNumber } from './_wa-cloud.js'
import { bannerPng, buildMismatchPdf, BUCKET_LABEL } from './_gst-report.js'

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
//   sequence      odd numbering in a supplier's invoices as booked in Busy: the same number
//                 twice, or a later bill with a smaller number (within one series; no gaps)
//   zero          ₹0 purchase vouchers in Busy (FOC / replacement / scheme documents)
//
// Data: gst_2a_rows / gst_purchase_rows / gst_parties in the JCM-Busysql project, written
// every 30 minutes by busy-sync/sync-gst.js on JCM-Server (RLS-closed, read here with the
// Busy service key after the HQ session is checked). Matching happens here, per request:
// the whole year is matched (a bill booked a month late still finds its 2A row) and the
// chosen month is reported.
//
// Access: admins, or anyone with 'gst-recon' in profiles.allowed_tabs.
// GET  ?banner=YYYY-MM                 the "GST MISMATCH <month>" banner PNG (public; the header
//                                      image of the supplier reminder template)
// Actions (POST JSON):
//   recon  month                         everything for one month ('YYYY-MM') + month list
//   mark   month, bucket, row_key, state ('ignored' | 'done' | ''), note
//   remind-party  month, gstin, row_keys[]   WhatsApp template to the supplier (not_in_2a)
//   people                               HQ users (for "Send to staff")
//   send-staff  month, kinds[], user_ids[]   PDF summary of the chosen red flags → WhatsApp
//                                      template (document header) to the chosen people
//   wa-status                            is the Meta sender configured, template names
//   log    month                         what was sent for this month

export const config = { maxDuration: 60 }

const SUPABASE_URL = 'https://cmtnzmfuasniicsdxyle.supabase.co'      // HQ / CRM project (profiles)
const SUPABASE_BUSY_URL = 'https://jlkjjqnmhsgefpluemyz.supabase.co' // Busy-data project (gst_*)
const HQ_URL = 'https://hq.jcmretails.com'
const PAGE_URL = `${HQ_URL}/#gst-recon`

const TAB_ID = 'gst-recon'
const TOL = 1            // rupees; a difference above this is a red flag

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
  if (req.method === 'GET' && isMonth(req.query?.banner)) {
    try {
      const png = await bannerPng(req.query.banner)
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Cache-Control', 'public, max-age=86400')
      return res.status(200).send(png)
    } catch (err) { console.error('gst banner:', err); return res.status(500).send('banner failed') }
  }
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
      return send(res, 200, await remindParty(busy, { month, gstin, keys, who }))
    }
    if (action === 'people') {
      const rows = check(await hq.from('profiles').select('id, name, email, role, is_admin, active, whatsapp').order('name'), 'people')
      return send(res, 200, { people: rows.filter(p => p.active !== false).map(p => ({ id: p.id, name: p.name || p.email, admin: p.is_admin === true || p.role === 'admin', hasNumber: !!toWaNumber(p.whatsapp) })) })
    }
    if (action === 'send-staff') {
      const month = isMonth(body.month) ? body.month : null
      const kinds = Array.isArray(body.kinds) ? body.kinds.filter(k => BUCKETS.includes(k)) : []
      const ids = Array.isArray(body.user_ids) ? body.user_ids.map(String).slice(0, 30) : []
      if (!month || !kinds.length || !ids.length) return send(res, 400, { error: 'Pick a month, at least one red flag and at least one person.' })
      return send(res, 200, await sendStaff(busy, hq, { month, kinds, ids, who }))
    }
    if (action === 'wa-status') return send(res, 200, { configured: waConfigured(), supplierTemplate: TPL_SUPPLIER, staffTemplate: TPL_STAFF, lang: TPL_LANG })
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
// Odd numbering in a supplier's invoices as booked in Busy: the same number twice, or a
// later-dated bill with a smaller number. Compared only within one series (the prefix
// before the running number: 'CCPLLT' and 'VL' from the same supplier are never compared),
// over the whole year; only problems touching the chosen month are reported. Gaps are NOT
// flagged — suppliers bill other customers in between, so every bill would show one.
function seriesOf(s) {
  const digits = String(runningNo(s) ?? '')
  const base = stripFy(s).toUpperCase()
  const i = base.lastIndexOf(digits)
  return (i > 0 ? base.slice(0, i) : '').replace(/[^A-Z]/g, '')
}
function sequenceFlags(books, month) {
  const out = []
  for (const [key, list] of groupBy(books, b => `${b.gstin}|${seriesOf(b.vch_no)}`)) {
    const gstin = key.split('|')[0]
    const rows = list.map(b => ({ b, n: runningNo(b.vch_no), k: alnum(b.vch_no) })).filter(x => x.n != null)
    if (rows.length < 2) continue
    const flag = (x, kind, note) => {
      if (x.b.inv_month !== month) return
      out.push({ bucket: 'sequence', row_key: `${x.b.vch_key}|${kind}`, gstin, party: x.b.party_name, party_code: x.b.party_code,
        b_no: x.b.vch_no, b_date: x.b.vch_date, b_taxable: r2(x.b.taxable), b_tax: tax(x.b), b_total: r2(x.b.total), entered_by: x.b.entered_by, kind, note })
    }
    // same number twice
    const seen = new Map()
    for (const x of [...rows].sort((a, b) => String(a.b.vch_date).localeCompare(String(b.b.vch_date)))) {
      if (seen.has(x.k)) flag(x, 'duplicate', `Same invoice number as bill dated ${niceDate(seen.get(x.k).b.vch_date)} (${rupees(seen.get(x.k).b.total)})`)
      else seen.set(x.k, x)
    }
    // later date, smaller number
    const byDate = [...rows].sort((a, b) => String(a.b.vch_date).localeCompare(String(b.b.vch_date)) || a.n - b.n)
    let maxSoFar = null
    for (const x of byDate) {
      if (maxSoFar && x.n < maxSoFar.n && String(x.b.vch_date) > String(maxSoFar.b.vch_date)) flag(x, 'backward', `Number ${x.b.vch_no} is smaller than ${maxSoFar.b.vch_no} dated ${niceDate(maxSoFar.b.vch_date)} — check the date or number typed`)
      if (!maxSoFar || x.n > maxSoFar.n) maxSoFar = x
    }
  }
  return out
}

function groupBy(list, keyFn) {
  const m = new Map()
  for (const x of list) { const k = keyFn(x); if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(x) }
  return m
}

// ---------- WhatsApp (Meta Cloud API, direct — api/_wa-cloud.js) ----------
// Business-started messages must be APPROVED TEMPLATES (free text only works within 24 h of
// the other side writing to us). Two Utility templates, submitted in WhatsApp Manager:
//   gstr1_filing_reminder  (to a supplier)  IMAGE header = GET /api/gst?banner=<month>;
//                          body {{1}} party name, {{2}} month, {{3}} invoice list, {{4}} JCM GSTIN
//   gst_mismatch_summary   (to staff)       DOCUMENT header = the PDF (public link in Supabase
//                          Storage bucket gst-reports); body {{1}} sender, {{2}} month, {{3}} deadline
// Names / language can be overridden with GST_TPL_SUPPLIER, GST_TPL_STAFF, GST_TPL_LANG.
// Template parameters may not contain new lines, so lists are one line, "; " separated.
const TPL_SUPPLIER = process.env.GST_TPL_SUPPLIER || 'gstr1_filing_reminder'
const TPL_STAFF = process.env.GST_TPL_STAFF || 'gst_mismatch_summary'
const TPL_LANG = process.env.GST_TPL_LANG || 'en'
const JCM_GSTIN = '23AAPFJ0607D1ZT'
const DEADLINE_DAYS = 2
const STORAGE_BUCKET = 'gst-reports'
const PARAM_MAX = 900 // characters per template parameter (Meta's body limit is 1024 in all)

function fitList(items) {
  const out = []
  let used = 0
  for (let i = 0; i < items.length; i++) {
    const piece = (out.length ? '; ' : '') + items[i]
    if (used + piece.length > PARAM_MAX) { out.push(`and ${items.length - i} more`); break }
    out.push(items[i]); used += piece.length
  }
  return out.join('; ').replace(/\s+/g, ' ')
}

// Returns { status, detail } — status: sent | failed | no_number | not_set_up.
async function sendWhatsApp(mobile, templateName, params, opts = {}) {
  if (!waConfigured()) return { status: 'not_set_up', detail: 'WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing in Vercel' }
  if (!toWaNumber(mobile)) return { status: 'no_number', detail: '' }
  try {
    const out = await sendTemplate(mobile, templateName, TPL_LANG, params, opts)
    return { status: 'sent', detail: out?.messages?.[0]?.id ? `id ${out.messages[0].id}` : '' }
  } catch (err) {
    console.error('GST WhatsApp failed:', err.message)
    return { status: 'failed', detail: String(err.message || '').slice(0, 300) }
  }
}

async function remindParty(busy, { month, gstin, keys, who }) {
  const [rows, parties] = await Promise.all([
    all(busy, 'gst_purchase_rows', 'vch_key, vch_no, vch_date, party_code, party_name, gstin, taxable, cgst, sgst, igst, total'),
    busy.from('gst_parties').select('*').eq('gstin', gstin).then(r => check(r, 'parties')),
  ])
  const bills = rows.filter(r => keys.includes(r.vch_key) && r.gstin === gstin)
  if (!bills.length) return { status: 'failed', detail: 'Those bills were not found.' }
  const contact = parties.find(p => p.party_code === bills[0].party_code) || parties[0]
  const number = contact?.whatsapp || contact?.mobile
  const name = bills[0].party_name || contact?.party_name || 'Sir/Madam'
  const list = fitList(bills.map(b => `${b.vch_no} dt ${niceDate(b.vch_date)} (${rupees(b.total)})`))
  const r = await sendWhatsApp(number, TPL_SUPPLIER, [name, monthName(month), list, JCM_GSTIN], { headerImageUrl: `${HQ_URL}/api/gst?banner=${month}` })
  check(await busy.from('gst_log').insert({ month, kind: 'party_reminder', channel: 'whatsapp', gstin, recipient: number ? String(number) : null, status: r.status, detail: `${bills.length} bill(s): ${bills.map(b => b.vch_no).join(', ')}${r.detail ? ` — ${r.detail}` : ''}`.slice(0, 500), by_name: who }), 'log')
  return { status: r.status, detail: r.detail, number: number || null, name, count: bills.length }
}

// ---------- staff: PDF summary of the chosen red flags ----------
async function sendStaff(busy, hq, { month, kinds, ids, who }) {
  const data = await loadRecon(busy, month)
  const rows = data.rows.filter(r => kinds.includes(r.bucket) && !r.mark)
  const people = check(await hq.from('profiles').select('id, name, email, whatsapp, active').in('id', ids), 'people')
    .filter(p => p.active !== false)
  if (!people.length) return { error: 'None of those people were found.' }

  const deadline = new Date(Date.now() + DEADLINE_DAYS * 86400000)
  const pdf = await buildMismatchPdf({ month, kinds, rows, counts: data.counts, totals: data.totals, sender: who, deadline, contacts: data.contacts })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
  const path = `${month}/GSTR2A-mismatch-${month}-${stamp}.pdf`
  const up = await busy.storage.from(STORAGE_BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: true })
  if (up.error) return { error: `Could not save the PDF: ${up.error.message}. Is the ${STORAGE_BUCKET} bucket created (supabase/gst-setup.sql)?` }
  const { data: pub } = busy.storage.from(STORAGE_BUCKET).getPublicUrl(path)
  const url = pub?.publicUrl
  const filename = `GSTR2A-mismatch-${monthName(month).replace(/\s+/g, '-')}.pdf`

  const results = []
  for (const p of people) {
    const r = await sendWhatsApp(p.whatsapp, TPL_STAFF, [who, monthName(month), niceDate(deadline.toISOString())], { headerDocumentUrl: url, headerDocumentName: filename })
    results.push({ name: p.name || p.email, status: r.status, detail: r.detail })
    check(await busy.from('gst_log').insert({ month, kind: 'staff_summary', channel: 'whatsapp', recipient: p.whatsapp ? String(p.whatsapp) : null, status: r.status,
      detail: `${p.name || p.email}: ${kinds.map(k => BUCKET_LABEL[k]).join(', ')} (${rows.length} items)${r.detail ? ` — ${r.detail}` : ''}`.slice(0, 500), by_name: who }), 'log')
  }
  return { count: rows.length, pdfUrl: url, results }
}
