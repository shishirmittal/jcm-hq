import { applyCors } from './_cors.js'
import { createClient } from '@supabase/supabase-js'

// Customer Card (JCM HQ → Sales → #customers) — page src/customers.js.
//
// One customer on one screen, made for the phone: name, mobiles, address,
// email, GSTIN, what they owe (with ageing), their bills, recent orders and
// the payment follow-up history. Read only — nothing here writes anything.
//
// Data (all already kept up to date by JCM-Server):
//   Busy-data project  customers (nightly sync.js), invoices (bills),
//                      party_dues (dues sync, every 30 min), sync_log,
//                      collections_ageing() + collection_followups (Payment
//                      Follow-up setup — used only if present),
//                      party_ledger (sync-ledger.js — used only if present)
//   CRM project        orders (JCM Orders; party_code = Busy account code)
// The customers / invoices column names are not fixed here: the first row is
// read once (select *) and the name / mobile / address … columns are picked
// from what exists, so a new column in the nightly sync never breaks this.
//
// Access: admins, or anyone given 'customers' in Manage Users.
//
// Actions (POST JSON):
//   search { q, page }        25 per page; q empty = everyone A–Z
//   card   { party_code }     everything for one customer
//   bills  { party_code, page }  20 bills per page, newest first
//   ledger { party_code, page }  50 entries per page (needs party_ledger)

const SUPABASE_URL = 'https://cmtnzmfuasniicsdxyle.supabase.co'
const SUPABASE_BUSY_URL = 'https://jlkjjqnmhsgefpluemyz.supabase.co'
const TAB_ID = 'customers'
const PAGE = 25
const BILL_PAGE = 20
const LEDGER_PAGE = 50

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json(body)
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const busyKey = process.env.SUPABASE_BUSY_SERVICE_ROLE_KEY
  if (!serviceRoleKey || !busyKey) return send(res, 500, { error: 'Customer Card is not configured yet.' })

  const opts = { auth: { autoRefreshToken: false, persistSession: false } }
  const hq = createClient(SUPABASE_URL, serviceRoleKey, opts)
  const busy = createClient(SUPABASE_BUSY_URL, busyKey, opts)

  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return send(res, 401, { error: 'Please sign in again.' })
  const { data: userData, error: userErr } = await hq.auth.getUser(token)
  if (userErr || !userData?.user) return send(res, 401, { error: 'Please sign in again.' })
  const { data: profile } = await hq.from('profiles')
    .select('id, role, is_admin, active, allowed_tabs').eq('id', userData.user.id).maybeSingle()
  if (!profile || profile.active === false) return send(res, 403, { error: 'Your account is not active.' })
  const isAdmin = profile.is_admin === true || profile.role === 'admin'
  const granted = Array.isArray(profile.allowed_tabs) && profile.allowed_tabs.includes(TAB_ID)
  if (!isAdmin && !granted) return send(res, 403, { error: 'You do not have access to Customer Card.' })
  const canFollowUp = isAdmin || (Array.isArray(profile.allowed_tabs) && profile.allowed_tabs.includes('payment-followup'))

  const body = req.body || {}
  try {
    if (body.action === 'search') return send(res, 200, await search(busy, body))
    if (body.action === 'card') return send(res, 200, { ...await card(busy, hq, body), canFollowUp })
    if (body.action === 'bills') return send(res, 200, await bills(busy, body))
    if (body.action === 'ledger') return send(res, 200, await ledger(busy, body))
    return send(res, 400, { error: 'Unknown request.' })
  } catch (err) {
    console.error('customers error:', err)
    return send(res, 500, { error: 'Something went wrong. Try again.' })
  }
}

// ---------------------------------------------------------------------------
function check(r, what) {
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r.data || []
}
const missing = r => r?.error && /does not exist|Could not find|schema cache/i.test(r.error.message || '')
const pick = (cols, names) => names.find(n => cols.includes(n)) || null

// Column names, read once per warm instance.
let COLS = null
async function columns(busy) {
  if (COLS) return COLS
  const [c, i] = await Promise.all([
    busy.from('customers').select('*').limit(1),
    busy.from('invoices').select('*').limit(1),
  ])
  const cc = Object.keys(check(c, 'customers')[0] || {})
  const ic = Object.keys(check(i, 'invoices')[0] || {})
  COLS = {
    cust: cc,
    name: pick(cc, ['party_name', 'name', 'customer_name', 'print_name', 'account_name']) || 'party_name',
    mobile: pick(cc, ['mobile', 'mobile_no', 'phone', 'phone_no']),
    whatsapp: pick(cc, ['whatsapp_no', 'whatsapp']),
    city: pick(cc, ['city', 'station', 'town']),
    group: pick(cc, ['group_name', 'parent_group', 'account_group']),
    inv: ic,
    invNo: pick(ic, ['vch_no', 'voucher_no', 'invoice_no', 'bill_no', 'vch_number']),
    invDate: pick(ic, ['vch_date', 'invoice_date', 'date']) || 'vch_date',
    invAmount: pick(ic, ['total_amount', 'amount', 'net_amount', 'invoice_value']),
  }
  return COLS
}

async function search(busy, body) {
  const C = await columns(busy)
  const page = Math.max(0, Number(body.page) || 0)
  const q = String(body.q || '').trim().slice(0, 60)
  const digits = q.replace(/\D/g, '')
  let query = busy.from('customers').select('*', { count: 'exact' })
  if (q && digits.length >= 4 && digits.length === q.replace(/[\s+-]/g, '').length) {
    const ors = [C.mobile, C.whatsapp].filter(Boolean).map(c => `${c}.ilike.%${digits}%`)
    if (digits.length <= 6) ors.push(`party_code.eq.${Number(digits)}`)
    query = query.or(ors.join(','))
  } else if (q) {
    for (const word of q.split(/\s+/).filter(Boolean).slice(0, 4)) {
      query = query.ilike(C.name, `%${word.replace(/[%_,()]/g, '')}%`)
    }
  }
  const r = await query.order(C.name, { ascending: true }).range(page * PAGE, page * PAGE + PAGE - 1)
  const rows = check(r, 'customers')
  const codes = rows.map(x => String(x.party_code))
  const dues = codes.length
    ? check(await busy.from('party_dues').select('party_code, outstanding_balance, synced_at').in('party_code', codes), 'party_dues')
    : []
  const latest = await duesRunAt(busy)
  const owe = new Map(dues.filter(d => fresh(d, latest)).map(d => [String(d.party_code), Number(d.outstanding_balance) || 0]))
  return {
    total: r.count ?? rows.length,
    page, pageSize: PAGE,
    rows: rows.map(x => ({
      code: x.party_code,
      name: x[C.name] || '',
      mobile: (C.mobile && x[C.mobile]) || (C.whatsapp && x[C.whatsapp]) || '',
      city: (C.city && x[C.city]) || '',
      due: owe.get(String(x.party_code)) || 0,
    })),
  }
}

// party_dues only gets rows for parties who still owe; a row older than the
// latest run means the party has since paid up (same rule as Payment Follow-up).
async function duesRunAt(busy) {
  const r = await busy.from('party_dues').select('synced_at').order('synced_at', { ascending: false }).limit(1)
  return r.error ? null : (r.data?.[0]?.synced_at || null)
}
function fresh(row, latest) {
  if (!latest || !row?.synced_at) return true
  return Date.parse(row.synced_at) >= Date.parse(latest) - 30 * 60 * 1000
}

const HIDE = new Set(['id', 'party_code', 'created_at', 'updated_at', 'synced_at', 'raw', 'search', 'fts'])

async function card(busy, hq, body) {
  const C = await columns(busy)
  const code = Number(body.party_code)
  if (!Number.isInteger(code)) throw new Error('bad party_code')
  const codeText = String(code)

  const [cust, dues, runAt, ageing, follow, nightly, orders, firstBills, hasLedger] = await Promise.all([
    busy.from('customers').select('*').eq('party_code', code).limit(1),
    busy.from('party_dues').select('*').eq('party_code', codeText).limit(1),
    duesRunAt(busy),
    busy.rpc('collections_ageing', { p_codes: [codeText] }),
    busy.from('collection_followups').select('*').eq('party_code', codeText).order('created_at', { ascending: false }).limit(10),
    busy.from('sync_log').select('*').order('run_at', { ascending: false }).limit(20),
    hq.from('orders').select('id, so_vch_no, so_date, stage, stage_since, line_count, order_value, invoice_vch_no, invoice_date, closed_at, closed_reason')
      .eq('party_code', code).order('so_date', { ascending: false }).limit(10),
    bills(busy, { party_code: code, page: 0 }),
    busy.from('party_ledger').select('party_code', { head: true, count: 'exact' }).eq('party_code', codeText),
  ])

  const row = check(cust, 'customers')[0]
  if (!row) return { found: false }
  const d = dues.error ? null : dues.data?.[0] || null
  const owes = d && fresh(d, runAt) ? Number(d.outstanding_balance) || 0 : 0

  // Everything else the nightly sync keeps for this customer, labelled.
  const known = new Set([C.name, C.mobile, C.whatsapp, C.city, C.group].filter(Boolean))
  const extra = Object.entries(row)
    .filter(([k, v]) => !known.has(k) && !HIDE.has(k) && v !== null && v !== '' && typeof v !== 'object' && String(v).trim() !== '0')
    .map(([k, v]) => ({ key: k, label: label(k), value: String(v) }))

  const ag = ageing.error ? null : (ageing.data || [])[0] || null
  const nightlyRow = (nightly.data || []).find(r => !r.job || r.job === 'nightly') || null

  return {
    found: true,
    code,
    name: row[C.name] || '',
    mobile: (C.mobile && row[C.mobile]) || '',
    whatsapp: (C.whatsapp && row[C.whatsapp]) || '',
    city: (C.city && row[C.city]) || '',
    group: (C.group && row[C.group]) || d?.group_name || '',
    phones: d?.phone_all || '',
    extra,
    dues: {
      amount: owes,
      asOf: runAt,
      ageing: ag ? { d0_30: +ag.d0_30 || 0, d31_60: +ag.d31_60 || 0, d61_90: +ag.d61_90 || 0, d90: +ag.d90_plus || 0, older: +ag.older || 0, oldestUnpaid: ag.oldest_unpaid_date || null, lastBill: ag.last_bill_date || null } : null,
    },
    customersAsOf: nightlyRow?.run_at || null,
    followups: follow.error ? null : (follow.data || []).map(f => ({
      at: f.created_at, channel: f.channel, outcome: f.outcome, remarks: f.remarks || '',
      by: f.created_by_name || '', promisedAmount: f.promised_amount, promisedDate: f.promised_date, next: f.next_followup,
    })),
    orders: orders.error ? [] : orders.data || [],
    bills: firstBills,
    ledgerReady: !missing(hasLedger) && !hasLedger.error,
  }
}

function label(k) {
  return k.replace(/_/g, ' ').replace(/\bno\b/i, 'no.').replace(/\bgstin?\b/i, 'GSTIN').replace(/\bpan\b/i, 'PAN')
    .replace(/^./, c => c.toUpperCase())
}

async function bills(busy, body) {
  const C = await columns(busy)
  const code = Number(body.party_code)
  const page = Math.max(0, Number(body.page) || 0)
  const r = await busy.from('invoices').select('*', { count: 'exact' }).eq('party_code', code)
    .order(C.invDate, { ascending: false }).range(page * BILL_PAGE, page * BILL_PAGE + BILL_PAGE - 1)
  const rows = check(r, 'invoices')
  return {
    total: r.count ?? rows.length, page, pageSize: BILL_PAGE,
    rows: rows.map(x => ({
      no: (C.invNo && x[C.invNo]) || x.vch_code || '',
      date: x[C.invDate] || null,
      amount: C.invAmount ? Number(x[C.invAmount]) || 0 : null,
      series: x.series || x.vch_series || '',
    })),
  }
}

// party_ledger is written by busy-sync/sync-ledger.js (one row per Busy voucher
// line on the party's account, this financial year). Until it runs, the page
// shows bills only and says so.
async function ledger(busy, body) {
  const code = String(Number(body.party_code))
  const page = Math.max(0, Number(body.page) || 0)
  const r = await busy.from('party_ledger').select('*', { count: 'exact' }).eq('party_code', code)
    .order('vch_date', { ascending: false }).order('vch_code', { ascending: false })
    .range(page * LEDGER_PAGE, page * LEDGER_PAGE + LEDGER_PAGE - 1)
  if (missing(r)) return { ready: false }
  const rows = check(r, 'party_ledger')
  return {
    ready: true, total: r.count ?? rows.length, page, pageSize: LEDGER_PAGE,
    rows: rows.map(x => ({ date: x.vch_date, type: x.vch_type_name || '', no: x.vch_no || '', debit: Number(x.debit) || 0, credit: Number(x.credit) || 0, narration: x.narration || '', balance: x.balance })),
    asOf: rows[0]?.synced_at || null,
  }
}
