import { applyCors } from './_cors.js'
import { createClient } from '@supabase/supabase-js'

// Payment Follow-up (JCM HQ → Collections) — page src/payment-followup.js.
//
// Reads dues from the JCM-Busysql project, which JCM-Server's sync scripts keep
// up to date:
//   dues_segmented   one row per account: balance, group, due_type, Retail/Distribution
//   party_dues       phones (phone_all), needs_review
//   customers        mobile / whatsapp_no (party_code is an integer there)
// and writes its own history there (supabase/collections-setup.sql):
//   collection_followups   every call / WhatsApp / visit / note / reminder
//   collection_latest      view: each party's latest call or note
//   collections_ageing()   balance split into 0-30 / 31-60 / 61-90 / 90+ days
// The new table, view and function are closed to the browser; everything goes
// through here with the Busy service key after the HQ login is checked.
//
// Access: admins, or anyone given the 'payment-followup' page in Manage Users.
//
// Actions (POST JSON):
//   meta                           groups with dues, follow-ups due count, WhatsApp ready?
//   count                          follow-ups due today or overdue (sidebar badge)
//   list    { view, group, q }     view = 'group' | 'all' | 'due'
//   history { party_code }         every follow-up for one party
//   save    { party_code, channel, outcome, remarks?, promised_amount?, promised_date?, next_followup? }
//   send-reminders { party_codes[], template }   WhatsApp through Whatshub360, at most 25 per call.
//           The server re-checks every party: the DND group, "check balance"
//           parties, nothing due, no number and anyone reminded in the last
//           20 hours are skipped whatever the page sent. Each attempt is kept
//           in collection_followups (channel 'reminder', outcome sent / failed / no_number).

const SUPABASE_URL = 'https://cmtnzmfuasniicsdxyle.supabase.co'      // HQ / CRM project (profiles)
const SUPABASE_BUSY_URL = 'https://jlkjjqnmhsgefpluemyz.supabase.co' // Busy-data project (dues)

const TAB_ID = 'payment-followup'
const DND_GROUP = 'JCM Due DND'

const CHANNELS = new Set(['call', 'whatsapp', 'visit', 'note'])
const OUTCOMES = new Set([
  'promised', 'paid', 'call_later', 'no_answer', 'dispute', 'wrong_number', 'refused', 'message_sent', 'other',
])

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json(body)
}

const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
const dateOk = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s))
const isDnd = row => String(row?.group_name || '').trim().toLowerCase() === DND_GROUP.toLowerCase() ||
  String(row?.group_path || '').toLowerCase().includes(DND_GROUP.toLowerCase())

export default async function handler(req, res) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const busyServiceRoleKey = process.env.SUPABASE_BUSY_SERVICE_ROLE_KEY
  if (!serviceRoleKey || !busyServiceRoleKey) {
    console.error('collections is missing env vars', { hq: !!serviceRoleKey, busy: !!busyServiceRoleKey })
    return send(res, 500, { error: 'Payment Follow-up is not configured yet.' })
  }

  const opts = { auth: { autoRefreshToken: false, persistSession: false } }
  const hq = createClient(SUPABASE_URL, serviceRoleKey, opts)
  const busy = createClient(SUPABASE_BUSY_URL, busyServiceRoleKey, opts)

  // ---- Who is asking. The page's own check is a convenience; this is the gate.
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return send(res, 401, { error: 'Please sign in again.' })

  const { data: userData, error: userErr } = await hq.auth.getUser(token)
  if (userErr || !userData?.user) return send(res, 401, { error: 'Please sign in again.' })

  const { data: profile, error: profErr } = await hq
    .from('profiles')
    .select('id, name, email, role, is_admin, active, allowed_tabs')
    .eq('id', userData.user.id)
    .maybeSingle()
  if (profErr) {
    console.error('collections profile read failed:', profErr)
    return send(res, 500, { error: 'Something went wrong. Try again.' })
  }
  if (!profile || profile.active === false) return send(res, 403, { error: 'Your account is not active.' })
  const isAdmin = profile.is_admin === true || profile.role === 'admin'
  const granted = Array.isArray(profile.allowed_tabs) && profile.allowed_tabs.includes(TAB_ID)
  if (!isAdmin && !granted) return send(res, 403, { error: 'You do not have access to Payment Follow-up.' })
  const me = { id: profile.id, name: profile.name || profile.email || 'Someone' }

  const body = req.body || {}
  const action = String(body.action || '')
  try {
    if (action === 'count') return await handleCount(busy, res)
    if (action === 'meta') return await handleMeta(busy, res)
    if (action === 'list') return await handleList(busy, body, res)
    if (action === 'history') return await handleHistory(busy, body, res)
    if (action === 'save') return await handleSave(busy, body, me, res)
    if (action === 'send-reminders') return await handleSendReminders(busy, body, me, res)
    return send(res, 400, { error: 'Unknown request.' })
  } catch (err) {
    console.error('collections handler error:', err)
    if (/does not exist|Could not find/i.test(err?.message || '')) {
      return send(res, 500, { error: 'Payment Follow-up needs its setup in Supabase (collections-setup.sql).' })
    }
    return send(res, 500, { error: 'Something went wrong. Try again.' })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function check(result, what) {
  if (result.error) {
    const err = new Error(`${what}: ${result.error.message}`)
    err.cause = result.error
    throw err
  }
  return result.data || []
}

// Supabase returns at most 1000 rows per request — page through.
async function fetchAll(makeQuery, what) {
  const out = []
  for (let from = 0; from < 50000; from += 1000) {
    const rows = check(await makeQuery().range(from, from + 999), what)
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

// .in() with hundreds of values makes a long URL — split it.
async function inChunks(values, size, run) {
  const out = []
  for (let i = 0; i < values.length; i += size) out.push(...await run(values.slice(i, i + size)))
  return out
}

// Parties who owe us: receivable accounts with a balance above zero.
const receivables = (busy, select) => () => busy.from('dues_segmented').select(select)
  .eq('due_type', 'Receivable').gt('outstanding_balance', 0)

function cleanPhone(p) {
  const d = String(p || '').replace(/\D/g, '').replace(/^0+/, '').replace(/^91(?=\d{10}$)/, '')
  return /^[6-9]\d{9}$/.test(d) ? d : null
}
function phonesFrom(...values) {
  const out = []
  for (const v of values) {
    // Numbers are separated by , ; / | or new lines; spaces inside one number
    // ("+91 98930 11111") are kept together. Two 10-digit numbers run
    // together with only a space between them are split apart.
    for (const part of String(v || '').split(/[,;/|\n]+/)) {
      const digits = part.replace(/\D/g, '')
      const pieces = digits.length >= 20 && digits.length % 10 === 0 ? digits.match(/\d{10}/g) : [part]
      for (const piece of pieces) {
        const p = cleanPhone(piece)
        if (p && !out.includes(p)) out.push(p)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// count / meta
// ---------------------------------------------------------------------------
async function handleCount(busy, res) {
  const r = await busy.from('collection_latest').select('party_code', { count: 'exact', head: true })
    .lte('next_followup', todayIST())
  if (r.error) return send(res, 200, { due: 0 })
  return send(res, 200, { due: r.count || 0 })
}

async function handleMeta(busy, res) {
  const rows = await fetchAll(receivables(busy, 'group_name, segment, outstanding_balance'), 'groups')
  const map = new Map()
  for (const r of rows) {
    const name = r.group_name || '(No group)'
    const g = map.get(name) || { group_name: name, segment: r.segment || 'Unassigned', parties: 0, total: 0, dnd: isDnd(r) }
    g.parties += 1
    g.total += Number(r.outstanding_balance) || 0
    map.set(name, g)
  }
  const groups = [...map.values()].sort((a, b) => b.total - a.total)
  const due = await busy.from('collection_latest').select('party_code', { count: 'exact', head: true })
    .lte('next_followup', todayIST())
  return send(res, 200, {
    groups,
    totalParties: rows.length,
    totalDue: rows.reduce((s, r) => s + (Number(r.outstanding_balance) || 0), 0),
    dueFollowups: due.error ? 0 : (due.count || 0),
    setupNeeded: !!due.error,
    dndGroup: DND_GROUP,
    whatsappReady: !!process.env.WHATSHUB_SEND_URL,
    today: todayIST(),
  })
}

// ---------------------------------------------------------------------------
// list — parties with dues, ageing, phones and their latest follow-up
// ---------------------------------------------------------------------------
async function handleList(busy, body, res) {
  const view = ['group', 'all', 'due'].includes(body.view) ? body.view : 'group'
  const group = String(body.group || '').slice(0, 200)
  const today = todayIST()
  const cols = 'party_code, party_name, phone_primary, outstanding_balance, group_name, group_path, segment'

  let parties
  let latestRows = null
  if (view === 'due') {
    latestRows = await fetchAll(() => busy.from('collection_latest').select('*').lte('next_followup', today), 'due follow-ups')
    const codes = latestRows.map(r => r.party_code)
    parties = await inChunks(codes, 200, part => busy.from('dues_segmented').select(cols).in('party_code', part).then(r => check(r, 'dues')))
    // Someone set a follow-up date for a party who has since paid up: still show them.
    const seen = new Set(parties.map(p => p.party_code))
    for (const l of latestRows) {
      if (!seen.has(l.party_code)) parties.push({ party_code: l.party_code, party_name: l.party_name, group_name: l.group_name, outstanding_balance: 0 })
    }
  } else if (view === 'all') {
    parties = await fetchAll(receivables(busy, cols), 'dues')
  } else {
    if (!group) return send(res, 400, { error: 'Pick an account group.' })
    parties = await fetchAll(() => receivables(busy, cols)().eq('group_name', group), 'dues')
  }

  const codes = [...new Set(parties.map(p => String(p.party_code)))]
  const intCodes = codes.filter(c => /^\d+$/.test(c)).map(Number)

  const [ageing, partyDues, customers, latest, reminders] = await Promise.all([
    inChunks(codes, 400, part => busy.rpc('collections_ageing', { p_codes: part }).then(r => check(r, 'ageing'))),
    inChunks(codes, 200, part => busy.from('party_dues').select('party_code, phone_primary, phone_all, needs_review').in('party_code', part).then(r => check(r, 'party_dues'))),
    inChunks(intCodes, 200, part => busy.from('customers').select('party_code, mobile, whatsapp_no').in('party_code', part).then(r => check(r, 'customers'))),
    latestRows
      ? Promise.resolve(latestRows)
      : inChunks(codes, 200, part => busy.from('collection_latest').select('*').in('party_code', part).then(r => check(r, 'latest'))),
    inChunks(codes, 200, part => busy.from('collection_followups').select('party_code, created_at')
      .eq('channel', 'reminder').eq('outcome', 'sent').in('party_code', part)
      .order('created_at', { ascending: false }).limit(5000).then(r => check(r, 'reminders'))),
  ])

  const byCode = (rows, key = 'party_code') => {
    const m = new Map()
    for (const r of rows) m.set(String(r[key]), r)
    return m
  }
  const ageMap = byCode(ageing)
  const pdMap = byCode(partyDues)
  const custMap = byCode(customers)
  const latestMap = byCode(latest)
  const lastReminder = new Map()
  for (const r of reminders) if (!lastReminder.has(String(r.party_code))) lastReminder.set(String(r.party_code), r.created_at)

  const out = parties.map(p => {
    const code = String(p.party_code)
    const pd = pdMap.get(code) || {}
    const cu = custMap.get(code) || {}
    const ag = ageMap.get(code) || null
    const phones = phonesFrom(cu.mobile, p.phone_primary, pd.phone_primary, pd.phone_all, cu.whatsapp_no)
    const whatsapp = cleanPhone(cu.whatsapp_no) || phones[0] || null
    return {
      party_code: code,
      party_name: p.party_name,
      group_name: p.group_name,
      segment: p.segment || null,
      balance: Number(p.outstanding_balance) || 0,
      dnd: isDnd(p),
      needs_review: pd.needs_review === true,
      phones,
      whatsapp,
      ageing: ag && {
        last_bill_date: ag.last_bill_date,
        oldest_unpaid_date: ag.oldest_unpaid_date,
        d0_30: Number(ag.d0_30) || 0,
        d31_60: Number(ag.d31_60) || 0,
        d61_90: Number(ag.d61_90) || 0,
        d90_plus: Number(ag.d90_plus) || 0,
        older: Number(ag.older) || 0,
      },
      latest: latestMap.get(code) || null,
      last_reminder: lastReminder.get(code) || null,
    }
  })

  return send(res, 200, { parties: out, view, group, today })
}

// ---------------------------------------------------------------------------
// history / save
// ---------------------------------------------------------------------------
async function handleHistory(busy, body, res) {
  const code = String(body.party_code || '').slice(0, 40)
  if (!code) return send(res, 400, { error: 'No party chosen.' })
  const rows = check(await busy.from('collection_followups').select('*')
    .eq('party_code', code).order('created_at', { ascending: false }).limit(300), 'history')
  return send(res, 200, { history: rows })
}

async function handleSave(busy, body, me, res) {
  const code = String(body.party_code || '').slice(0, 40)
  const channel = String(body.channel || 'call')
  const outcome = String(body.outcome || '')
  if (!code) return send(res, 400, { error: 'No party chosen.' })
  if (!CHANNELS.has(channel)) return send(res, 400, { error: 'Pick Call, WhatsApp, Visit or Note.' })
  if (!OUTCOMES.has(outcome)) return send(res, 400, { error: 'Pick what happened.' })

  const remarks = String(body.remarks || '').trim().slice(0, 1000) || null
  let promisedAmount = null
  if (body.promised_amount !== undefined && body.promised_amount !== null && body.promised_amount !== '') {
    promisedAmount = Number(body.promised_amount)
    if (!Number.isFinite(promisedAmount) || promisedAmount < 0 || promisedAmount > 1e10) {
      return send(res, 400, { error: 'Promised amount should be a number.' })
    }
  }
  const promisedDate = body.promised_date ? String(body.promised_date) : null
  const nextFollowup = body.next_followup ? String(body.next_followup) : null
  if (promisedDate && !dateOk(promisedDate)) return send(res, 400, { error: 'Promised date is not a valid date.' })
  if (nextFollowup && !dateOk(nextFollowup)) return send(res, 400, { error: 'Next follow-up date is not a valid date.' })

  // Name, group and balance come from the dues data, not from the page.
  const [seg, pd] = await Promise.all([
    busy.from('dues_segmented').select('party_name, group_name, outstanding_balance').eq('party_code', code).limit(1),
    busy.from('party_dues').select('party_name, group_name, outstanding_balance').eq('party_code', code).limit(1),
  ])
  const party = (seg.data && seg.data[0]) || (pd.data && pd.data[0])
  if (!party) return send(res, 404, { error: 'That party was not found in the dues list.' })

  const row = {
    party_code: code,
    party_name: party.party_name,
    group_name: party.group_name,
    channel,
    outcome,
    remarks,
    promised_amount: promisedAmount,
    promised_date: promisedDate,
    next_followup: nextFollowup,
    balance_at_time: Number(party.outstanding_balance) || 0,
    created_by: me.id,
    created_by_name: me.name,
  }
  const saved = check(await busy.from('collection_followups').insert(row).select('*'), 'save')
  return send(res, 200, { ok: true, followup: saved[0] || null })
}

// ---------------------------------------------------------------------------
// WhatsApp reminders (Whatshub360)
// ---------------------------------------------------------------------------
const REMINDER_GAP_HOURS = 20
const MAX_PER_CALL = 25

async function sendWhatsApp(mobile, message) {
  const template = process.env.WHATSHUB_SEND_URL
  if (!template) return 'not_set_up'
  const digits = cleanPhone(mobile)
  if (!digits) return 'no_number'
  // Same Vercel settings as Red Alerts: the send link is kept as a template,
  //   https://…?vid={vid}&recMobileNo=91{mobile}&msg={msg}
  const url = template
    .replace('{vid}', encodeURIComponent(process.env.WHATSHUB_VID || ''))
    .replace('{mobile}', digits)
    .replace('{msg}', encodeURIComponent(message))
  try {
    const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) })
    const text = (await r.text()).slice(0, 300)
    if (!r.ok || /error|fail|invalid/i.test(text)) {
      console.error('Whatshub360 reminder failed:', r.status, text)
      return 'failed'
    }
    return 'sent'
  } catch (err) {
    console.error('Whatshub360 reminder error:', err)
    return 'failed'
  }
}

const rupeesText = n => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN')

function fillTemplate(template, party) {
  return template
    .replace(/\{name\}/gi, party.party_name || '')
    .replace(/\{amount\}/gi, rupeesText(party.balance))
    .trim()
}

async function handleSendReminders(busy, body, me, res) {
  if (!process.env.WHATSHUB_SEND_URL) {
    return send(res, 400, { error: 'WhatsApp sending is not set up yet (WHATSHUB_SEND_URL in Vercel).' })
  }
  const codes = Array.isArray(body.party_codes)
    ? [...new Set(body.party_codes.map(c => String(c).slice(0, 40)).filter(Boolean))]
    : []
  if (!codes.length) return send(res, 400, { error: 'Tick at least one party.' })
  if (codes.length > MAX_PER_CALL) return send(res, 400, { error: `At most ${MAX_PER_CALL} at a time.` })
  const template = String(body.template || '').trim().slice(0, 1000)
  if (template.length < 10) return send(res, 400, { error: 'Write the message first.' })

  const intCodes = codes.filter(c => /^\d+$/.test(c)).map(Number)
  const since = new Date(Date.now() - REMINDER_GAP_HOURS * 3600 * 1000).toISOString()
  const [seg, pd, cu, recent] = await Promise.all([
    busy.from('dues_segmented').select('party_code, party_name, outstanding_balance, group_name, group_path, due_type').in('party_code', codes),
    busy.from('party_dues').select('party_code, phone_primary, phone_all, needs_review').in('party_code', codes),
    intCodes.length ? busy.from('customers').select('party_code, mobile, whatsapp_no').in('party_code', intCodes) : Promise.resolve({ data: [] }),
    busy.from('collection_followups').select('party_code').eq('channel', 'reminder').eq('outcome', 'sent')
      .in('party_code', codes).gte('created_at', since),
  ])
  const segMap = new Map(check(seg, 'dues').map(r => [String(r.party_code), r]))
  const pdMap = new Map(check(pd, 'party_dues').map(r => [String(r.party_code), r]))
  const cuMap = new Map(check(cu, 'customers').map(r => [String(r.party_code), r]))
  const recentSet = new Set(check(recent, 'recent').map(r => String(r.party_code)))

  const results = []
  const toSend = []
  for (const code of codes) {
    const s = segMap.get(code)
    const p = pdMap.get(code) || {}
    const c = cuMap.get(code) || {}
    const party = s && { party_code: code, party_name: s.party_name, group_name: s.group_name, balance: Number(s.outstanding_balance) || 0 }
    let skip = null
    if (!s || s.due_type !== 'Receivable') skip = 'not_found'
    else if (isDnd(s)) skip = 'dnd'
    else if (p.needs_review === true) skip = 'needs_review'
    else if (party.balance <= 0) skip = 'nothing_due'
    else if (recentSet.has(code)) skip = 'recent'
    if (skip) { results.push({ party_code: code, status: skip }); continue }
    const mobile = cleanPhone(c.whatsapp_no) || phonesFrom(c.mobile, s.phone_primary, p.phone_primary, p.phone_all)[0] || null
    toSend.push({ party, mobile })
  }

  // Three at a time keeps a batch of 25 well inside the function time limit.
  const queue = [...toSend]
  const logRows = []
  async function worker() {
    while (queue.length) {
      const { party, mobile } = queue.shift()
      const message = fillTemplate(template, party)
      const status = mobile ? await sendWhatsApp(mobile, message) : 'no_number'
      results.push({ party_code: party.party_code, status, mobile })
      logRows.push({
        party_code: party.party_code, party_name: party.party_name, group_name: party.group_name,
        channel: 'reminder', outcome: status, mobile, message, balance_at_time: party.balance,
        created_by: me.id, created_by_name: me.name,
      })
    }
  }
  await Promise.all([worker(), worker(), worker()])

  if (logRows.length) {
    const ins = await busy.from('collection_followups').insert(logRows)
    if (ins.error) console.error('collections reminder log failed:', ins.error)
  }
  const sentAt = new Date().toISOString()
  return send(res, 200, { results, sentAt })
}
