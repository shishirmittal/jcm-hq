import { applyCors } from './_cors.js'
import { createClient } from '@supabase/supabase-js'
import { sendTemplate, waConfigured } from './_wa-cloud.js'

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
//   collections_ageing()   balance split into 0-30 / 31-60 / 61-90 / 90+ days, and
//                          overdue = unpaid on debits older than GRACE_DAYS (v2,
//                          collections-ageing-v2.sql; v1 has no overdue column —
//                          then 31+ days is used so nothing breaks before the update)
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
//   list { view: 'due', person: 'me' | 'all' | <uuid> }   Today's follow-ups: due parties of that
//           person (owner of the party's account group), plus doneToday and a per-person summary
//   daily-run  (JCM-Server only — sent with the Busy service key by busy-sync/followup-notify.js,
//           every 15 min from JCM Sync)  after collection_settings.morning_at (10:00): one Task Board
//           task + one WhatsApp per person with their follow-ups for the day; after evening_at
//           (19:00): a summary WhatsApp to admins. Each runs once a day (last_morning / last_evening).
//   daily-now { which: 'morning' | 'evening' } (admins)  the same, right now, from the Today tab
//   owners / owners-save (admins)   who follows up which account group (collection_group_owners,
//           collection_settings.default_owner for groups nobody was given)
//   send-template { party_code }   ONE party, from the row's WhatsApp button, through Meta's own API with the
//           approved template: Dealer groups payment_reminder_20d/40d, Retail groups retail_reminder_20d/40d
//           (amber / red by days overdue). Same skip rules as below; logged as channel 'reminder'.
//   send-reminders { party_codes[], template }   WhatsApp through Whatshub360, at most 25 per call.
//           The server re-checks every party: the DND group, "check balance"
//           parties, nothing due, no number and anyone reminded in the last
//           20 hours are skipped whatever the page sent. Each attempt is kept
//           in collection_followups (channel 'reminder', outcome sent / failed / no_number).

const SUPABASE_URL = 'https://cmtnzmfuasniicsdxyle.supabase.co'      // HQ / CRM project (profiles)
const SUPABASE_BUSY_URL = 'https://jlkjjqnmhsgefpluemyz.supabase.co' // Busy-data project (dues)

const TAB_ID = 'payment-followup'
const DND_GROUP = 'JCM Due DND'
// Credit younger than this is not chased: the page shows only parties with
// something unpaid on bills older than this, unless "All dues" is picked.
// The number lives in the SQL function's default (p_grace 20); this is only for labels.
const GRACE_DAYS = 20
// The "Due over N days" buttons on the page. Each step is one extra call to
// collections_ageing with p_grace = N; overdueBy[N] on every party.
const GRACE_STEPS = [20, 40]
// Follow-up rhythm (Shishir, 2026-10-11): anything over 40 days → every week,
// over 20 days → every two weeks, counted from the last call / note saved.
// A next follow-up date that staff typed always wins over the rhythm.
const CADENCE = [{ over: 40, every: 7 }, { over: 20, every: 14 }]

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

  // ---- JCM-Server's timer. Only the Busy project's service key can read
  // collection_settings (RLS on, no policies), so a read with the key it sent proves who it is.
  if ((req.body || {}).action === 'daily-run') {
    if (!(await isBusyServiceKey(token))) return send(res, 401, { error: 'Not allowed.' })
    try {
      return send(res, 200, { ok: true, ...(await runDaily(busy, hq, null)) })
    } catch (err) {
      console.error('collections daily-run failed:', err)
      return send(res, 500, { error: String(err.message || err).slice(0, 300) })
    }
  }

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
  const me = { id: profile.id, name: profile.name || profile.email || 'Someone', isAdmin }

  const body = req.body || {}
  const action = String(body.action || '')
  try {
    if (action === 'count') return await handleCount(busy, hq, me, res)
    if (action === 'meta') return await handleMeta(busy, me, res)
    if (action === 'list') return await handleList(busy, hq, me, body, res)
    if (action === 'owners') return await handleOwners(busy, hq, me, res)
    if (action === 'daily-now') {
      if (!me.isAdmin) return send(res, 403, { error: 'Only admins can send these.' })
      const which = body.which === 'evening' ? 'evening' : 'morning'
      return send(res, 200, { ok: true, ...(await runDaily(busy, hq, which)) })
    }
    if (action === 'owners-save') return await handleOwnersSave(busy, me, body, res)
    if (action === 'history') return await handleHistory(busy, body, res)
    if (action === 'save') return await handleSave(busy, hq, body, me, res)
    if (action === 'send-template') return await handleSendTemplate(busy, body, me, res)
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

function overdueOf(ag) {
  if (!ag) return 0
  if (ag.overdue !== undefined && ag.overdue !== null) return Number(ag.overdue) || 0
  return (Number(ag.d31_60) || 0) + (Number(ag.d61_90) || 0) + (Number(ag.d90_plus) || 0) + (Number(ag.older) || 0)
}
const ageingFor = (busy, codes, grace) =>
  inChunks(codes, 400, part => busy.rpc('collections_ageing', grace ? { p_codes: part, p_grace: grace } : { p_codes: part })
    .then(r => check(r, 'ageing')))
// { 20: Map(code -> overdue), 40: … } — the first step reuses `base` (default p_grace = 20).
async function overdueSteps(busy, codes, base) {
  const out = {}
  await Promise.all(GRACE_STEPS.map(async g => {
    const rows = g === GRACE_DAYS && base ? base : await ageingFor(busy, codes, g)
    out[g] = new Map(rows.map(a => [String(a.party_code), overdueOf(a)]))
  }))
  return out
}

// party_dues is written by sync-dues-final.js on JCM-Server, which only
// updates parties that still owe money: someone who has paid in full keeps
// their last balance in the table. So a row the latest run did not touch
// counts as nothing due. One run takes about a minute; 30 minutes of slack.
async function dueFreshness(busy) {
  const last = check(await busy.from('party_dues').select('synced_at')
    .not('synced_at', 'is', null).order('synced_at', { ascending: false }).limit(1), 'last sync')
  const lastSync = last[0]?.synced_at || null
  if (!lastSync) return { lastSync: null, stale: new Set() }
  const cutoff = new Date(new Date(lastSync).getTime() - 30 * 60 * 1000).toISOString()
  const rows = await fetchAll(() => busy.from('party_dues').select('party_code')
    .or(`synced_at.lt.${cutoff},synced_at.is.null`), 'stale dues')
  return { lastSync, stale: new Set(rows.map(r => String(r.party_code))) }
}

// Who follows up which account group. Missing tables (setup not run yet) read as
// "nobody assigned" so the rest of the page keeps working.
async function loadOwners(busy) {
  const [o, st] = await Promise.all([
    busy.from('collection_group_owners').select('group_name, hq_user_id'),
    busy.from('collection_settings').select('*').eq('id', 1).maybeSingle(),
  ])
  const byGroup = new Map()
  for (const r of o.data || []) if (r.hq_user_id) byGroup.set(r.group_name, r.hq_user_id)
  const settings = st.data || {}
  return {
    ready: !o.error && !st.error,
    byGroup,
    defaultOwner: settings.default_owner || null,
    settings,
    ownerOf: group => byGroup.get(group || '') || settings.default_owner || null,
  }
}

// People who may be given follow-ups: active, and admin or with the page ticked.
async function loadPeople(hq) {
  const rows = check(await hq.from('profiles').select('id, name, email, role, is_admin, active, allowed_tabs, whatsapp'), 'people')
  return rows
    .filter(p => p.active !== false && (p.is_admin === true || p.role === 'admin' || (Array.isArray(p.allowed_tabs) && p.allowed_tabs.includes(TAB_ID))))
    .map(p => ({ id: p.id, name: p.name || p.email || 'Someone', whatsapp: p.whatsapp || null, isAdmin: p.is_admin === true || p.role === 'admin' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// Who needs a follow-up today, and why. Map party_code -> reason.
//   { kind: 'date', date }                     next follow-up date typed, today or earlier
//   { kind: 'cadence', over, every, days }     rhythm reached (days = since last contact, null = never)
// `pre` = { live, steps } when the caller already has them (meta).
async function computeDue(busy, pre = null) {
  const today = todayIST()
  const [fresh, rows, latest] = await Promise.all([
    pre ? null : dueFreshness(busy),
    pre ? null : fetchAll(receivables(busy, 'party_code, group_name'), 'dues'),
    fetchAll(() => busy.from('collection_latest').select('party_code, group_name, next_followup, created_at'), 'latest'),
  ])
  const groupOf = new Map()
  for (const l of latest) groupOf.set(String(l.party_code), l.group_name)
  for (const r of (pre ? pre.rows : rows) || []) groupOf.set(String(r.party_code), r.group_name)
  const live = pre ? pre.live : rows.map(r => String(r.party_code)).filter(c => !fresh.stale.has(c))
  const steps = pre ? pre.steps : await overdueSteps(busy, live)
  const latestMap = new Map(latest.map(l => [String(l.party_code), l]))
  const due = new Map()
  // Dates staff typed — even for a party who has paid since (shown as nothing due).
  for (const l of latest) {
    if (l.next_followup && l.next_followup <= today) due.set(String(l.party_code), { kind: 'date', date: l.next_followup, group: groupOf.get(String(l.party_code)) })
  }
  for (const code of live) {
    if (due.has(code)) continue
    const l = latestMap.get(code)
    if (l?.next_followup) continue // a future date was typed: wait for it
    const rule = CADENCE.find(c => (steps[c.over]?.get(code) || 0) >= 1)
    if (!rule) continue
    const lastDay = l?.created_at ? new Date(new Date(l.created_at).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10) : null
    const days = lastDay ? Math.round((Date.parse(today) - Date.parse(lastDay)) / 86400000) : null
    if (days === null || days >= rule.every) due.set(code, { kind: 'cadence', over: rule.over, every: rule.every, days, group: groupOf.get(code) })
  }
  return due
}

// ---------------------------------------------------------------------------
// count / meta
// ---------------------------------------------------------------------------
async function handleCount(busy, hq, me, res) {
  try {
    const [due, owners] = await Promise.all([computeDue(busy), loadOwners(busy)])
    const mine = [...due.values()].filter(r => owners.ownerOf(r.group) === me.id).length
    // Admins see everything due; everyone else sees what is theirs.
    return send(res, 200, { due: me.isAdmin ? due.size : mine, mine, all: due.size })
  } catch (err) {
    console.error('collections count failed:', err)
    return send(res, 200, { due: 0 })
  }
}

async function handleMeta(busy, me, res) {
  const [fresh, allRows] = await Promise.all([
    dueFreshness(busy),
    fetchAll(receivables(busy, 'party_code, group_name, segment, outstanding_balance'), 'groups'),
  ])
  const rows = allRows.filter(r => !fresh.stale.has(String(r.party_code)))
  const steps = await overdueSteps(busy, rows.map(r => String(r.party_code)))
  const overdueMap = steps[GRACE_DAYS]
  const map = new Map()
  let overdueParties = 0
  let overdueTotal = 0
  const byStep = Object.fromEntries(GRACE_STEPS.map(n => [n, { parties: 0, total: 0 }]))
  for (const r of rows) {
    const name = r.group_name || '(No group)'
    const g = map.get(name) || {
      group_name: name, segment: r.segment || 'Unassigned', parties: 0, total: 0, overdueParties: 0, overdue: 0, dnd: isDnd(r),
      byStep: Object.fromEntries(GRACE_STEPS.map(n => [n, { parties: 0, total: 0 }])),
    }
    g.parties += 1
    g.total += Number(r.outstanding_balance) || 0
    const od = overdueMap.get(String(r.party_code)) || 0
    if (od >= 1) { g.overdueParties += 1; g.overdue += od; overdueParties += 1; overdueTotal += od }
    for (const n of GRACE_STEPS) {
      const v = steps[n].get(String(r.party_code)) || 0
      if (v >= 1) { g.byStep[n].parties += 1; g.byStep[n].total += v; byStep[n].parties += 1; byStep[n].total += v }
    }
    map.set(name, g)
  }
  const groups = [...map.values()].sort((a, b) => b.total - a.total)
  let dueCount = 0
  let setupNeeded = false
  let dueMine = 0
  try {
    const [dueMap, owners] = await Promise.all([
      computeDue(busy, { live: rows.map(r => String(r.party_code)), steps, rows }),
      loadOwners(busy),
    ])
    dueCount = dueMap.size
    dueMine = [...dueMap.values()].filter(r => owners.ownerOf(r.group) === me.id).length
  } catch (err) { setupNeeded = true; console.error('collections due failed:', err) }
  return send(res, 200, {
    groups,
    totalParties: rows.length,
    totalDue: rows.reduce((s, r) => s + (Number(r.outstanding_balance) || 0), 0),
    overdueParties,
    overdueTotal,
    graceDays: GRACE_DAYS,
    graceSteps: GRACE_STEPS,
    byStep,
    dueFollowups: dueCount,
    dueMine,
    me: { id: me.id, name: me.name, isAdmin: me.isAdmin },
    cadence: CADENCE,
    setupNeeded,
    dndGroup: DND_GROUP,
    whatsappReady: !!process.env.WHATSHUB_SEND_URL,
    today: todayIST(),
    lastSync: fresh.lastSync,
  })
}

// ---------------------------------------------------------------------------
// list — parties with dues, ageing, phones and their latest follow-up
// ---------------------------------------------------------------------------
async function handleList(busy, hq, me, body, res) {
  const view = ['group', 'all', 'due'].includes(body.view) ? body.view : 'group'
  const group = String(body.group || '').slice(0, 200)
  const today = todayIST()
  const cols = 'party_code, party_name, phone_primary, outstanding_balance, group_name, group_path, segment'

  const [fresh, owners, people] = await Promise.all([dueFreshness(busy), loadOwners(busy), loadPeople(hq)])
  const nameOf = new Map(people.map(p => [p.id, p.name]))
  let parties
  let latestRows = null
  let dueMap = null
  let summary = null
  let doneToday = null
  // Today's follow-ups: whose list? 'me' (default), 'all', or one person's id.
  const person = view === 'due' ? (body.person === 'all' ? 'all' : body.person && body.person !== 'me' ? String(body.person) : me.id) : null
  if (view === 'due') {
    const fullDue = await computeDue(busy)
    // Done today = calls / notes saved today (India date), any party.
    const startIST = new Date(`${today}T00:00:00+05:30`).toISOString()
    const doneRows = await fetchAll(() => busy.from('collection_followups')
      .select('party_code, party_name, group_name, channel, outcome, remarks, promised_amount, promised_date, next_followup, created_by, created_by_name, created_at')
      .neq('channel', 'reminder').gte('created_at', startIST).order('created_at', { ascending: false }), 'done today')
    // Per-person counts for the chips (everyone, whatever is being shown).
    const counts = new Map()
    const bump = (id, key) => {
      const k = id || 'none'
      const c = counts.get(k) || { id: id || null, name: id ? (nameOf.get(id) || 'Someone') : 'Nobody assigned', due: 0, done: 0 }
      c[key] += 1
      counts.set(k, c)
    }
    for (const r of fullDue.values()) bump(owners.ownerOf(r.group), 'due')
    const doneSeen = new Set()
    for (const d of doneRows) {
      if (doneSeen.has(d.party_code)) continue
      doneSeen.add(d.party_code)
      bump(owners.ownerOf(d.group_name), 'done')
    }
    summary = [...counts.values()].sort((a, b) => (b.due + b.done) - (a.due + a.done))
    const wanted = r => person === 'all' || owners.ownerOf(r.group) === person
    dueMap = new Map([...fullDue].filter(([, r]) => wanted(r)))
    const doneFiltered = []
    const seenDone = new Set()
    for (const d of doneRows) {
      if (seenDone.has(d.party_code) || !(person === 'all' || owners.ownerOf(d.group_name) === person)) continue
      seenDone.add(d.party_code)
      doneFiltered.push(d)
    }
    doneToday = doneFiltered
    const codes = [...dueMap.keys()]
    parties = await inChunks(codes, 200, part => busy.from('dues_segmented').select(cols).in('party_code', part).then(r => check(r, 'dues')))
    // Someone set a follow-up date for a party who has since paid up: still show them.
    const seen = new Set(parties.map(p => String(p.party_code)))
    const missing = codes.filter(c => !seen.has(c))
    if (missing.length) {
      latestRows = await inChunks(missing, 200, part => busy.from('collection_latest').select('*').in('party_code', part).then(r => check(r, 'latest')))
      for (const l of latestRows) parties.push({ party_code: l.party_code, party_name: l.party_name, group_name: l.group_name, outstanding_balance: 0 })
      latestRows = null
    }
  } else if (view === 'all') {
    parties = await fetchAll(receivables(busy, cols), 'dues')
  } else {
    if (!group) return send(res, 400, { error: 'Pick an account group.' })
    parties = await fetchAll(() => receivables(busy, cols)().eq('group_name', group), 'dues')
  }
  // Paid up since the last sync run: hide from the lists, show as nothing due on the due view.
  if (view === 'due') {
    for (const p of parties) if (fresh.stale.has(String(p.party_code))) p.outstanding_balance = 0
  } else {
    parties = parties.filter(p => !fresh.stale.has(String(p.party_code)))
  }

  const codes = [...new Set(parties.map(p => String(p.party_code)))]
  const intCodes = codes.filter(c => /^\d+$/.test(c)).map(Number)

  const [ageing, partyDues, customers, latest, reminders] = await Promise.all([
    ageingFor(busy, codes),
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
  const steps = await overdueSteps(busy, codes, ageing)
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
      overdue: fresh.stale.has(code) ? 0 : Math.min(overdueOf(ag), Number(p.outstanding_balance) || 0),
      overdueBy: Object.fromEntries(GRACE_STEPS.map(n => [n,
        fresh.stale.has(code) ? 0 : Math.min(steps[n].get(code) || 0, Number(p.outstanding_balance) || 0)])),
      ageing: ag && !fresh.stale.has(code) && {
        last_bill_date: ag.last_bill_date,
        oldest_unpaid_date: ag.oldest_unpaid_date,
        d0_30: Number(ag.d0_30) || 0,
        d31_60: Number(ag.d31_60) || 0,
        d61_90: Number(ag.d61_90) || 0,
        d90_plus: Number(ag.d90_plus) || 0,
        older: Number(ag.older) || 0,
        source: ag.source || 'invoices',
      },
      latest: latestMap.get(code) || null,
      last_reminder: lastReminder.get(code) || null,
      due_reason: dueMap ? dueMap.get(code) || null : null,
      owner_id: owners.ownerOf(p.group_name),
      owner_name: nameOf.get(owners.ownerOf(p.group_name)) || null,
    }
  })

  return send(res, 200, { parties: out, view, group, today, lastSync: fresh.lastSync, graceDays: GRACE_DAYS, graceSteps: GRACE_STEPS,
    person, summary, doneToday, ownersReady: owners.ready,
    me: { id: me.id, name: me.name, isAdmin: me.isAdmin },
    people: people.map(p => ({ id: p.id, name: p.name })) })
}

// ---------------------------------------------------------------------------
// owners — who follows up which account group (admins)
// ---------------------------------------------------------------------------
async function handleOwners(busy, hq, me, res) {
  if (!me.isAdmin) return send(res, 403, { error: 'Only admins can assign groups.' })
  const [rows, owners, people] = await Promise.all([
    fetchAll(receivables(busy, 'group_name, segment, outstanding_balance'), 'groups'),
    loadOwners(busy),
    loadPeople(hq),
  ])
  if (!owners.ready) return send(res, 500, { error: 'Run collections-notify-setup.sql in Supabase first.' })
  const map = new Map()
  for (const r of rows) {
    const name = r.group_name || ''
    const g = map.get(name) || { group_name: name, segment: r.segment || 'Unassigned', parties: 0, total: 0, dnd: isDnd(r) }
    g.parties += 1
    g.total += Number(r.outstanding_balance) || 0
    map.set(name, g)
  }
  // Groups given to someone earlier but with nothing due right now stay listed.
  for (const [name] of owners.byGroup) if (!map.has(name)) map.set(name, { group_name: name, segment: '', parties: 0, total: 0 })
  // Dealer / Retail type per group (column added by collections-group-kind.sql).
  const kr = await busy.from('collection_group_owners').select('group_name, kind')
  const kindReady = !kr.error
  const kinds = new Map((kr.data || []).map(r => [r.group_name, r.kind === 'retail' ? 'retail' : 'dealer']))
  for (const name of kinds.keys()) if (!map.has(name)) map.set(name, { group_name: name, segment: '', parties: 0, total: 0 })
  const groups = [...map.values()].map(g => ({ ...g, hq_user_id: owners.byGroup.get(g.group_name) || null, kind: kinds.get(g.group_name) || 'dealer' }))
    .sort((a, b) => b.total - a.total)
  return send(res, 200, { groups, kindReady, defaultOwner: owners.defaultOwner, people: people.map(p => ({ id: p.id, name: p.name })) })
}

async function handleOwnersSave(busy, me, body, res) {
  if (!me.isAdmin) return send(res, 403, { error: 'Only admins can assign groups.' })
  const uuid = v => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null)
  const list = Array.isArray(body.owners) ? body.owners.slice(0, 500) : []
  const rows = list
    .filter(o => o && typeof o.group_name === 'string')
    .map(o => {
      const r = { group_name: o.group_name.slice(0, 200), hq_user_id: uuid(o.hq_user_id), updated_by: me.name, updated_at: new Date().toISOString() }
      if (o.kind === 'dealer' || o.kind === 'retail') r.kind = o.kind
      return r
    })
  if (rows.length) check(await busy.from('collection_group_owners').upsert(rows, { onConflict: 'group_name' }), 'owners save')
  if ('default_owner' in body) {
    check(await busy.from('collection_settings').upsert({ id: 1, default_owner: uuid(body.default_owner), updated_at: new Date().toISOString() }, { onConflict: 'id' }), 'settings save')
  }
  return send(res, 200, { ok: true, saved: rows.length })
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

async function handleSave(busy, hq, body, me, res) {
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
  const [seg, pd, fresh] = await Promise.all([
    busy.from('dues_segmented').select('party_name, group_name, outstanding_balance').eq('party_code', code).limit(1),
    busy.from('party_dues').select('party_name, group_name, outstanding_balance').eq('party_code', code).limit(1),
    dueFreshness(busy),
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
    balance_at_time: fresh.stale.has(code) ? 0 : (Number(party.outstanding_balance) || 0),
    created_by: me.id,
    created_by_name: me.name,
  }
  const saved = check(await busy.from('collection_followups').insert(row).select('*'), 'save')
  // The owner's daily task is done once nothing is left on their list.
  try { await closeDailyTaskIfDone(busy, hq, party.group_name, me) } catch (err) { console.error('daily task check failed:', err) }
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
    .replace(/\{overdue\}/gi, rupeesText(party.overdue))
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
  const [seg, pd, cu, recent, fresh, ageing] = await Promise.all([
    busy.from('dues_segmented').select('party_code, party_name, outstanding_balance, group_name, group_path, due_type').in('party_code', codes),
    busy.from('party_dues').select('party_code, phone_primary, phone_all, needs_review').in('party_code', codes),
    intCodes.length ? busy.from('customers').select('party_code, mobile, whatsapp_no').in('party_code', intCodes) : Promise.resolve({ data: [] }),
    busy.from('collection_followups').select('party_code').eq('channel', 'reminder').eq('outcome', 'sent')
      .in('party_code', codes).gte('created_at', since),
    dueFreshness(busy),
    /\{overdue\}/i.test(template) ? ageingFor(busy, codes) : Promise.resolve([]),
  ])
  const ageMap = new Map(ageing.map(a => [String(a.party_code), a]))
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
    const party = s && {
      party_code: code, party_name: s.party_name, group_name: s.group_name,
      balance: Number(s.outstanding_balance) || 0,
      overdue: Math.min(overdueOf(ageMap.get(code)), Number(s.outstanding_balance) || 0),
    }
    let skip = null
    if (!s || s.due_type !== 'Receivable') skip = 'not_found'
    else if (isDnd(s)) skip = 'dnd'
    else if (p.needs_review === true) skip = 'needs_review'
    else if (party.balance <= 0 || fresh.stale.has(code)) skip = 'nothing_due'
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

// ---------------------------------------------------------------------------
// One WhatsApp reminder through Meta (the row's WhatsApp button)
// ---------------------------------------------------------------------------
const HQ_SITE = 'https://hq.jcmretails.com'
const inr = n => Math.round(Number(n) || 0).toLocaleString('en-IN')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const niceDate = iso => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}` }
const daysSince = iso => Math.max(0, Math.round((Date.parse(todayIST()) - Date.parse(String(iso).slice(0, 10))) / 86400000))
const fyStartIST = () => { const t = todayIST(); const y = Number(t.slice(0, 4)); return `${Number(t.slice(5, 7)) >= 4 ? y : y - 1}-04-01` }

async function handleSendTemplate(busy, body, me, res) {
  if (!waConfigured()) return send(res, 400, { error: 'WhatsApp (Meta) is not set up yet in Vercel.' })
  const code = String(body.party_code || '').slice(0, 40)
  if (!/^\d{1,9}$/.test(code)) return send(res, 400, { error: 'No party chosen.' })
  const since = new Date(Date.now() - REMINDER_GAP_HOURS * 3600 * 1000).toISOString()
  const [seg, pd, cu, recent, fresh, ag20, ag40, kr] = await Promise.all([
    busy.from('dues_segmented').select('party_code, party_name, outstanding_balance, group_name, group_path, due_type, phone_primary').eq('party_code', code),
    busy.from('party_dues').select('party_code, phone_primary, phone_all, needs_review').eq('party_code', code),
    busy.from('customers').select('party_code, mobile, whatsapp_no').eq('party_code', Number(code)),
    busy.from('collection_followups').select('created_at').eq('party_code', code).eq('channel', 'reminder').eq('outcome', 'sent')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(1),
    dueFreshness(busy),
    ageingFor(busy, [code]),
    ageingFor(busy, [code], 40),
    busy.from('collection_group_owners').select('group_name, kind'),
  ])
  const s = check(seg, 'dues')[0]
  const p = check(pd, 'party_dues')[0] || {}
  const c = check(cu, 'customers')[0] || {}
  if (!s || s.due_type !== 'Receivable') return send(res, 400, { error: 'This party has no dues in Busy.' })
  const balance = Number(s.outstanding_balance) || 0
  if (isDnd(s)) return send(res, 400, { error: 'This group is "JCM Due DND" — reminders are never sent to it.' })
  if (p.needs_review === true) return send(res, 400, { error: 'This balance is flagged "Check balance" — sort that out before reminding.' })
  if (balance <= 0 || fresh.stale.has(code)) return send(res, 400, { error: 'Nothing is due from this party right now.' })
  const last = check(recent, 'recent')[0]
  if (last) {
    const hrs = Math.max(1, Math.round((Date.now() - Date.parse(last.created_at)) / 3600000))
    return send(res, 400, { error: `A reminder was already sent ${hrs} hour${hrs === 1 ? '' : 's'} ago. Wait until tomorrow.` })
  }
  const mobile = cleanPhone(c.whatsapp_no) || phonesFrom(c.mobile, s.phone_primary, p.phone_primary, p.phone_all)[0] || null
  if (!mobile) return send(res, 400, { error: 'No WhatsApp number for this party in Busy.' })

  const overdue = Math.min(overdueOf(ag20[0]), balance)
  const overdue40 = Math.min(overdueOf(ag40[0]), balance)
  if (overdue <= 0) return send(res, 400, { error: 'Nothing is over 20 days yet — only recent credit.' })
  const red = overdue40 > 0
  const ag = ag20[0] || {}
  const oldest = ag.oldest_unpaid_date || (Number(ag.older) > 0 ? fyStartIST() : ag.last_bill_date)
  if (!oldest) return send(res, 400, { error: 'Bill dates are not available for this party yet.' })

  const kinds = new Map((kr.error ? [] : kr.data || []).map(r => [r.group_name, r.kind]))
  const retail = kinds.get(s.group_name) === 'retail'
  const name = String(s.party_name || '').trim()
  const days = String(daysSince(oldest))
  const when = niceDate(oldest)
  const params = retail ? [name, inr(balance), days, when] : [name, inr(balance), inr(overdue), days, when]
  const template = `${retail ? 'retail_reminder' : 'payment_reminder'}_${red ? '40d' : '20d'}`
  const detail = `${template}: ${params.join(' | ')}`
  const row = {
    party_code: code, party_name: name, group_name: s.group_name, channel: 'reminder', mobile, message: detail,
    balance_at_time: balance, created_by: me.id, created_by_name: me.name,
  }
  try {
    await sendTemplate(mobile, template, 'en', params, {
      headerImageUrl: `${HQ_SITE}/wa/${red ? 'reminder-red-40d' : 'reminder-amber-20d'}.png`,
      buttonPayloads: [`qr:${code}`, `ledger:${code}`, `${retail ? 'portal' : 'inv'}:${code}`],
    })
  } catch (err) {
    console.error('collections send-template failed:', err)
    const ins = await busy.from('collection_followups').insert({ ...row, outcome: 'failed' })
    if (ins.error) console.error('collections reminder log failed:', ins.error)
    return send(res, 502, { error: String(err.message || err).slice(0, 300) })
  }
  const ins = await busy.from('collection_followups').insert({ ...row, outcome: 'sent' })
  if (ins.error) console.error('collections reminder log failed:', ins.error)
  return send(res, 200, { ok: true, template, tone: red ? 'red' : 'amber', kind: retail ? 'retail' : 'dealer', mobile, name })
}

// ---------------------------------------------------------------------------
// Daily WhatsApps + Task Board tasks (JCM-Server timer, or admins from the Today tab)
// ---------------------------------------------------------------------------
const HQ_URL = 'https://hq.jcmretails.com'

async function isBusyServiceKey(key) {
  try {
    const c = createClient(SUPABASE_BUSY_URL, key, { auth: { autoRefreshToken: false, persistSession: false } })
    const { data, error } = await c.from('collection_settings').select('id').eq('id', 1)
    return !error && Array.isArray(data) && data.length === 1
  } catch {
    return false
  }
}

const nowISTClock = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(11, 16)

// Claim today's run so two timers can never both send: the update only goes
// through if last_<which> still holds the value we read (compare-and-set).
async function claimRun(busy, which, today, previous) {
  const col = which === 'morning' ? 'last_morning' : 'last_evening'
  let q = busy.from('collection_settings').update({ [col]: today }).eq('id', 1)
  q = previous ? q.eq(col, previous) : q.is(col, null)
  const r = await q.select('id')
  if (r.error) console.error('collections claimRun failed:', r.error)
  return !r.error && (r.data || []).length === 1
}

async function runDaily(busy, hq, force) {
  const today = todayIST()
  const clock = nowISTClock()
  const settings = check(await busy.from('collection_settings').select('*').eq('id', 1), 'settings')[0] || {}
  const morningAt = settings.morning_at || '10:00'
  const eveningAt = settings.evening_at || '19:00'
  const out = { today, clock }
  if (force === 'morning' || (!force && clock >= morningAt && clock < eveningAt && settings.last_morning !== today)) {
    if (force || await claimRun(busy, 'morning', today, settings.last_morning)) out.morning = await runMorning(busy, hq, today)
  }
  if (force === 'evening' || (!force && clock >= eveningAt && settings.last_evening !== today)) {
    if (force || await claimRun(busy, 'evening', today, settings.last_evening)) out.evening = await runEvening(busy, hq, today)
  }
  if (!out.morning && !out.evening) out.note = `nothing to do (morning ${morningAt}, evening ${eveningAt}, last ${settings.last_morning || '-'} / ${settings.last_evening || '-'})`
  return out
}

// Due parties grouped by the person who follows up their group.
async function dueByPerson(busy, hq) {
  const [due, owners, people] = await Promise.all([computeDue(busy), loadOwners(busy), loadPeople(hq)])
  const codes = [...due.keys()]
  const rows = await inChunks(codes, 200, part => busy.from('dues_segmented')
    .select('party_code, party_name, outstanding_balance').in('party_code', part).then(r => check(r, 'dues')))
  const info = new Map(rows.map(r => [String(r.party_code), r]))
  const byPerson = new Map()
  for (const [code, reason] of due) {
    const owner = owners.ownerOf(reason.group) || 'none'
    const r = info.get(code) || {}
    const list = byPerson.get(owner) || []
    list.push({ code, name: r.party_name || code, balance: Number(r.outstanding_balance) || 0, reason })
    byPerson.set(owner, list)
  }
  for (const list of byPerson.values()) {
    const rank = x => x.reason.kind === 'date' ? 0 : x.reason.over >= 40 ? 1 : 2
    list.sort((a, b) => rank(a) - rank(b) || b.balance - a.balance)
  }
  return { byPerson, people, owners }
}

const reasonText = r => r.kind === 'date' ? 'date set'
  : `${r.every === 7 ? 'weekly' : 'fortnightly'}, ${r.days === null ? 'never called' : `last ${r.days} d ago`}`

async function runMorning(busy, hq, today) {
  const { byPerson, people } = await dueByPerson(busy, hq)
  const filer = people.find(p => p.isAdmin) || null
  const existing = check(await busy.from('collection_daily_tasks').select('*').eq('day', today), 'daily tasks')
  const hasTask = new Set(existing.map(t => t.hq_user_id))
  const results = []
  for (const person of people) {
    const list = byPerson.get(person.id) || []
    if (!list.length) continue
    const total = list.reduce((s, x) => s + x.balance, 0)
    const top = list.slice(0, 10).map((x, i) => `${i + 1}. ${x.name} — ${rupeesText(x.balance)} (${reasonText(x.reason)})`)
    let taskId = null
    if (!hasTask.has(person.id)) {
      const taskBody = [
        `Payment follow-ups for today: ${list.length} part${list.length === 1 ? 'y' : 'ies'}, ${rupeesText(total)} due.`,
        ...top,
        list.length > 10 ? `…and ${list.length - 10} more.` : null,
        `Call them from HQ → Payment Follow-up → Today's follow-ups (${HQ_URL}/#payment-followup/today). This task ticks itself done when your list is empty.`,
      ].filter(Boolean).join('\n')
      const t = await hq.from('team_tasks').insert({
        task_type: 'payment_followup', body: taskBody, created_by: (filer || person).id,
        assigned_to: person.id, due_date: today, status: 'open',
      }).select('id').single()
      if (t.error) console.error('daily task insert failed:', t.error)
      else {
        taskId = String(t.data.id)
        const h = await hq.from('team_task_history').insert({ task_id: t.data.id, actor: (filer || person).id, action: 'filed', to_user: person.id })
        if (h.error) console.error('daily task history failed:', h.error)
      }
    }
    const text = [
      `Good morning ${person.name.split(' ')[0]} 🙏`,
      `Payment follow-ups for today: *${list.length}* part${list.length === 1 ? 'y' : 'ies'}, ${rupeesText(total)} due.`,
      '',
      ...top,
      list.length > 10 ? `…and ${list.length - 10} more.` : null,
      '',
      `Open your list: ${HQ_URL}/#payment-followup/today`,
    ].filter(x => x !== null).join('\n')
    const wa = person.whatsapp ? await sendWhatsApp(person.whatsapp, text) : 'no_number'
    const up = await busy.from('collection_daily_tasks').upsert({
      day: today, hq_user_id: person.id, due_count: list.length, whatsapp: wa,
      ...(taskId ? { task_id: taskId } : {}),
    }, { onConflict: 'day,hq_user_id' })
    if (up.error) console.error('daily task record failed:', up.error)
    results.push({ person: person.name, due: list.length, task: taskId ? 'made' : hasTask.has(person.id) ? 'already' : 'failed', whatsapp: wa })
  }
  const unassigned = (byPerson.get('none') || []).length
  return { people: results, unassigned }
}

async function runEvening(busy, hq, today) {
  const { byPerson, people, owners } = await dueByPerson(busy, hq)
  const startIST = new Date(`${today}T00:00:00+05:30`).toISOString()
  const [done, morning, promisedToday] = await Promise.all([
    fetchAll(() => busy.from('collection_followups').select('party_code, group_name, outcome, promised_amount, created_by')
      .neq('channel', 'reminder').gte('created_at', startIST), 'done today'),
    busy.from('collection_daily_tasks').select('hq_user_id, due_count').eq('day', today),
    fetchAll(() => busy.from('collection_latest').select('party_code, party_name, promised_amount')
      .eq('outcome', 'promised').eq('promised_date', today), 'promises today'),
  ])
  const morningCount = new Map((morning.data || []).map(r => [r.hq_user_id, r.due_count]))
  const stats = new Map()
  const stat = id => stats.get(id) || stats.set(id, { done: 0, promised: 0, promisedAmt: 0, noAnswer: 0 }).get(id)
  const seen = new Set()
  for (const d of done) {
    if (seen.has(d.party_code)) continue
    seen.add(d.party_code)
    const s = stat(owners.ownerOf(d.group_name) || 'none')
    s.done += 1
    if (d.outcome === 'promised') { s.promised += 1; s.promisedAmt += Number(d.promised_amount) || 0 }
    if (d.outcome === 'no_answer' || d.outcome === 'wrong_number') s.noAnswer += 1
  }
  // Close daily tasks whose list is now empty (in case the last save missed it).
  const tasks = check(await busy.from('collection_daily_tasks').select('hq_user_id, task_id').eq('day', today), 'daily tasks')
  for (const t of tasks) if (t.task_id && !(byPerson.get(t.hq_user_id) || []).length) await markTaskDone(hq, t.task_id, t.hq_user_id)

  const lines = []
  let tDone = 0
  let tLeft = 0
  for (const person of people) {
    const s = stats.get(person.id) || { done: 0, promised: 0, promisedAmt: 0, noAnswer: 0 }
    const left = (byPerson.get(person.id) || []).length
    if (!s.done && !left && !morningCount.get(person.id)) continue
    tDone += s.done
    tLeft += left
    lines.push(`• ${person.name}: ${s.done} done${morningCount.has(person.id) ? ` of ${morningCount.get(person.id)}` : ''}, ${left} left` +
      `${s.promised ? ` · ${s.promised} promised ${rupeesText(s.promisedAmt)}` : ''}${s.noAnswer ? ` · ${s.noAnswer} no answer` : ''}`)
  }
  const none = (byPerson.get('none') || []).length
  if (none) lines.push(`• Nobody assigned: ${none} parties due — set them in Assign groups.`)
  const promiseTotal = promisedToday.reduce((s, p) => s + (Number(p.promised_amount) || 0), 0)
  const text = [
    `Payment follow-up — ${new Date(`${today}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' })}`,
    `${tDone} parties followed up, ${tLeft} still due.`,
    '',
    ...lines,
    promisedToday.length ? `\nPromised for today: ${promisedToday.length} part${promisedToday.length === 1 ? 'y' : 'ies'}, ${rupeesText(promiseTotal)} — check they came in.` : null,
    `\n${HQ_URL}/#payment-followup/today`,
  ].filter(x => x !== null).join('\n')
  const sent = []
  for (const admin of people.filter(p => p.isAdmin)) {
    sent.push({ to: admin.name, whatsapp: admin.whatsapp ? await sendWhatsApp(admin.whatsapp, text) : 'no_number' })
  }
  return { done: tDone, left: tLeft, sent }
}

async function markTaskDone(hq, taskId, actor) {
  const { data } = await hq.from('team_tasks').update({ status: 'done', done_at: new Date().toISOString() })
    .eq('id', taskId).eq('status', 'open').select('id')
  if (data?.length) {
    const h = await hq.from('team_task_history').insert({ task_id: taskId, actor, action: 'done' })
    if (h.error) console.error('daily task done history failed:', h.error)
  }
}

async function closeDailyTaskIfDone(busy, hq, groupName, me) {
  const owners = await loadOwners(busy)
  const owner = owners.ownerOf(groupName)
  if (!owner) return
  const t = await busy.from('collection_daily_tasks').select('task_id').eq('day', todayIST()).eq('hq_user_id', owner).maybeSingle()
  if (t.error || !t.data?.task_id) return
  const due = await computeDue(busy)
  const left = [...due.values()].some(r => owners.ownerOf(r.group) === owner)
  if (!left) await markTaskDone(hq, t.data.task_id, me.id)
}
