import { applyCors } from './_cors.js'
import { createClient } from '@supabase/supabase-js'
import { waConfigured, sendLogged, waSwitches, BANNER, HQ_URL, inr, niceDate } from './_wa-cloud.js'
import { sendLedger } from './_send-docs.js'

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
//   send-template { party_code }   ONE party, from the row's WhatsApp button: the approved Meta template
//           (Dealer groups payment_reminder_20d/40d, Retail groups retail_reminder_20d/40d; red when
//           something is over 40 days, else amber). Logged in collection_followups (channel 'reminder').
//   send-reminders { party_codes[], tier }   the same template, for ticked parties (max 25 per call).
//   reminder-plan { tier }         who the automatic run would message right now, and why others are skipped.
//   reminder-settings / reminder-settings-save (admins)  automatic daily reminders: on/off, time, tiers, cap.
//   All reminder sends re-check: DND group, "check balance", nothing over 20 days, no number,
//   any reminder in the last 20 h, and the contact gap (over 40 days: nothing in the last 6 days,
//   over 20 days: nothing in the last 13 days — calls, notes and reminders all count).

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
      const which = body.which === 'evening' ? 'evening' : body.which === 'reminders' ? 'reminders' : 'morning'
      return send(res, 200, { ok: true, ...(await runDaily(busy, hq, which)) })
    }
    if (action === 'owners-save') return await handleOwnersSave(busy, me, body, res)
    if (action === 'history') return await handleHistory(busy, body, res)
    if (action === 'save') return await handleSave(busy, hq, body, me, res)
    if (action === 'send-template') return await handleSendTemplate(busy, body, me, res)
    if (action === 'send-ledger') { const r = await sendLedger(busy, body, me.name || me.email || 'HQ'); return send(res, r.error ? 400 : 200, r) }
    if (action === 'reminder-plan') return await handleReminderPlan(busy, body, me, res)
    if (action === 'reminder-settings') return await handleReminderSettings(busy, me, body, res, false)
    if (action === 'reminder-settings-save') return await handleReminderSettings(busy, me, body, res, true)
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
    whatsappReady: waConfigured(),
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
// WhatsApp payment reminders (Meta templates) — one party, ticked parties, or the daily automatic run
// ---------------------------------------------------------------------------
const REMINDER_GAP_HOURS = 20
const MAX_PER_CALL = 25
// Contact gap (Shishir, 2026-10-12): a party contacted (call / note / visit / reminder) within
// this many days is left alone by every reminder send. Over 40 days → 6 days, over 20 → 13 days.
const CONTACT_GAP = { 40: 6, 20: 13 }
const AUTO_DEFAULTS = { reminders_on: false, reminders_at: '11:00', reminders_tiers: '20,40', reminders_max: 150 }

const rupeesText = n => '₹' + inr(n)
const daysSince = iso => Math.max(0, Math.round((Date.parse(todayIST()) - Date.parse(String(iso).slice(0, 10))) / 86400000))
const fyStartIST = () => { const t = todayIST(); const y = Number(t.slice(0, 4)); return `${Number(t.slice(5, 7)) >= 4 ? y : y - 1}-04-01` }

// Everything needed to decide and send reminders for `codes`: dues, phones, ageing at 20 and 40
// days, last contact, last reminder, group kind. One round of queries for the whole batch.
async function reminderContext(busy, codes) {
  const intCodes = codes.filter(c => /^\d+$/.test(c)).map(Number)
  const sinceRem = new Date(Date.now() - REMINDER_GAP_HOURS * 3600 * 1000).toISOString()
  const sinceContact = new Date(Date.now() - Math.max(...Object.values(CONTACT_GAP)) * 86400000).toISOString()
  const q = (table, select) => inChunks(codes, 300, part => busy.from(table).select(select).in('party_code', part).then(r => check(r, table)))
  const [seg, pd, cu, recentRem, contacts, fresh, ag20, ag40, kr] = await Promise.all([
    q('dues_segmented', 'party_code, party_name, outstanding_balance, group_name, group_path, due_type, phone_primary'),
    q('party_dues', 'party_code, phone_primary, phone_all, needs_review'),
    intCodes.length ? inChunks(intCodes, 300, part => busy.from('customers').select('party_code, mobile, whatsapp_no').in('party_code', part).then(r => check(r, 'customers'))) : [],
    inChunks(codes, 300, part => busy.from('collection_followups').select('party_code, created_at').eq('channel', 'reminder').eq('outcome', 'sent')
      .in('party_code', part).gte('created_at', sinceRem).then(r => check(r, 'recent reminders'))),
    inChunks(codes, 300, part => busy.from('collection_followups').select('party_code, created_at, channel').in('party_code', part)
      .gte('created_at', sinceContact).then(r => check(r, 'contacts'))),
    dueFreshness(busy),
    ageingFor(busy, codes),
    ageingFor(busy, codes, 40),
    busy.from('collection_group_owners').select('group_name, kind'),
  ])
  const latestOf = rows => { const m = new Map(); for (const r of rows) { const k = String(r.party_code); if (!m.has(k) || m.get(k) < r.created_at) m.set(k, r.created_at) } return m }
  return {
    seg: new Map(seg.map(r => [String(r.party_code), r])),
    pd: new Map(pd.map(r => [String(r.party_code), r])),
    cu: new Map(cu.map(r => [String(r.party_code), r])),
    lastReminder: latestOf(recentRem),
    lastContact: latestOf(contacts),
    fresh,
    ag20: new Map(ag20.map(a => [String(a.party_code), a])),
    ag40: new Map(ag40.map(a => [String(a.party_code), a])),
    kinds: new Map((kr.error ? [] : kr.data || []).map(r => [r.group_name, r.kind])),
  }
}

// Decide for one party. Returns { ok: true, plan } or { ok: false, skip, why }.
//   minOver: 20 = anyone with something over 20 days, 40 = only parties with something over 40 days.
function planReminder(ctx, code, { minOver = 20, respectGap = true } = {}) {
  const s = ctx.seg.get(code)
  const p = ctx.pd.get(code) || {}
  const c = ctx.cu.get(code) || {}
  if (!s || s.due_type !== 'Receivable') return { ok: false, skip: 'not_found', why: 'No dues in Busy' }
  const balance = Number(s.outstanding_balance) || 0
  if (isDnd(s)) return { ok: false, skip: 'dnd', why: 'JCM Due DND group' }
  if (p.needs_review === true) return { ok: false, skip: 'needs_review', why: 'Balance flagged "Check balance"' }
  if (balance <= 0 || ctx.fresh.stale.has(code)) return { ok: false, skip: 'nothing_due', why: 'Nothing due right now' }
  const overdue = Math.min(overdueOf(ctx.ag20.get(code)), balance)
  const overdue40 = Math.min(overdueOf(ctx.ag40.get(code)), balance)
  if (overdue <= 0) return { ok: false, skip: 'recent_credit', why: 'Nothing over 20 days yet' }
  const red = overdue40 > 0
  if (minOver >= 40 && !red) return { ok: false, skip: 'under_40', why: 'Nothing over 40 days' }
  const rem = ctx.lastReminder.get(code)
  if (rem) {
    const hrs = Math.max(1, Math.round((Date.now() - Date.parse(rem)) / 3600000))
    return { ok: false, skip: 'recent', why: `Reminder already sent ${hrs} h ago` }
  }
  const gapDays = red ? CONTACT_GAP[40] : CONTACT_GAP[20]
  const last = ctx.lastContact.get(code)
  if (respectGap && last && Date.now() - Date.parse(last) < gapDays * 86400000) {
    const d = Math.floor((Date.now() - Date.parse(last)) / 86400000)
    return { ok: false, skip: 'contacted', why: `Contacted ${d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'} ago`} (gap for over ${red ? 40 : 20} days is ${gapDays} days)` }
  }
  const mobile = cleanPhone(c.whatsapp_no) || phonesFrom(c.mobile, s.phone_primary, p.phone_primary, p.phone_all)[0] || null
  if (!mobile) return { ok: false, skip: 'no_number', why: 'No WhatsApp number in Busy' }
  const ag = ctx.ag20.get(code) || {}
  const oldest = ag.oldest_unpaid_date || (Number(ag.older) > 0 ? fyStartIST() : ag.last_bill_date)
  if (!oldest) return { ok: false, skip: 'no_dates', why: 'Bill dates not synced yet' }
  const retail = ctx.kinds.get(s.group_name) === 'retail'
  const name = String(s.party_name || '').trim()
  const days = String(daysSince(oldest))
  const when = niceDate(oldest)
  return {
    ok: true,
    plan: {
      code, name, group: s.group_name, mobile, balance, overdue, red, retail,
      template: `${retail ? 'retail_reminder' : 'payment_reminder'}_${red ? '40d' : '20d'}`,
      params: retail ? [name, inr(balance), days, when] : [name, inr(balance), inr(overdue), days, when],
      opts: {
        headerImageUrl: BANNER(red ? 'reminder-red-40d' : 'reminder-amber-20d'),
        buttonPayloads: [`qr:${code}`, `ledger:${code}`, `${retail ? 'portal' : 'inv'}:${code}`],
      },
    },
  }
}

// Send one planned reminder and log it in collection_followups (channel 'reminder').
async function dispatchReminder(busy, plan, me, switches) {
  const out = await sendLogged(busy, { kind: 'reminder', to: plan.mobile, template: plan.template, params: plan.params, opts: plan.opts,
    ref: plan.code, refName: plan.name, by: me.name, switches })
  const outcome = out.status === 'sent' ? 'sent' : out.status === 'no_number' ? 'no_number' : 'failed'
  const ins = await busy.from('collection_followups').insert({
    party_code: plan.code, party_name: plan.name, group_name: plan.group, channel: 'reminder', outcome, mobile: plan.mobile,
    message: `${plan.template}: ${plan.params.join(' | ')}${out.error ? ` — ${out.error}` : ''}`,
    balance_at_time: plan.balance, created_by: me.id, created_by_name: me.name,
  })
  if (ins.error) console.error('collections reminder log failed:', ins.error)
  return { status: outcome, error: out.error || null }
}

async function handleSendTemplate(busy, body, me, res) {
  if (!waConfigured()) return send(res, 400, { error: 'WhatsApp (Meta) is not set up yet in Vercel.' })
  const code = String(body.party_code || '').slice(0, 40)
  if (!/^\d{1,9}$/.test(code)) return send(res, 400, { error: 'No party chosen.' })
  const ctx = await reminderContext(busy, [code])
  // A person pressing the button has decided; only the 20-hour repeat guard and the hard skips apply.
  const d = planReminder(ctx, code, { respectGap: false })
  if (!d.ok) return send(res, 400, { error: d.why + '.' })
  const r = await dispatchReminder(busy, d.plan, me)
  if (r.status !== 'sent') return send(res, 502, { error: r.error || 'Could not send.' })
  return send(res, 200, { ok: true, template: d.plan.template, tone: d.plan.red ? 'red' : 'amber', kind: d.plan.retail ? 'retail' : 'dealer', mobile: d.plan.mobile, name: d.plan.name })
}

async function handleSendReminders(busy, body, me, res) {
  if (!waConfigured()) return send(res, 400, { error: 'WhatsApp (Meta) is not set up yet in Vercel.' })
  const codes = Array.isArray(body.party_codes) ? [...new Set(body.party_codes.map(c => String(c).slice(0, 40)).filter(c => /^\d{1,9}$/.test(c)))] : []
  if (!codes.length) return send(res, 400, { error: 'Tick at least one party.' })
  if (codes.length > MAX_PER_CALL) return send(res, 400, { error: `At most ${MAX_PER_CALL} at a time.` })
  const minOver = Number(body.tier) === 40 ? 40 : 20
  const ctx = await reminderContext(busy, codes)
  const switches = await waSwitches(busy)
  const results = []
  const queue = codes.map(code => ({ code, d: planReminder(ctx, code, { minOver, respectGap: body.respect_gap !== false }) }))
  for (const x of queue) if (!x.d.ok) results.push({ party_code: x.code, status: x.d.skip, why: x.d.why })
  const toSend = queue.filter(x => x.d.ok)
  async function worker() {
    while (toSend.length) {
      const { code, d } = toSend.shift()
      const r = await dispatchReminder(busy, d.plan, me, switches)
      results.push({ party_code: code, status: r.status, mobile: d.plan.mobile, template: d.plan.template, why: r.error })
    }
  }
  await Promise.all([worker(), worker(), worker()])
  return send(res, 200, { results, sentAt: new Date().toISOString() })
}

// Who would get an automatic reminder right now (admins' preview on the reminders tab).
async function autoCandidates(busy, settings) {
  const tiers = String(settings.reminders_tiers || AUTO_DEFAULTS.reminders_tiers).split(',').map(Number).filter(n => n === 20 || n === 40)
  const minOver = tiers.includes(20) ? 20 : 40
  const rows = await fetchAll(receivables(busy, 'party_code'), 'dues')
  const codes = rows.map(r => String(r.party_code)).filter(c => /^\d{1,9}$/.test(c))
  const ctx = await reminderContext(busy, codes)
  const plans = []
  const skipped = {}
  for (const code of codes) {
    const d = planReminder(ctx, code, { minOver })
    if (d.ok) plans.push(d.plan)
    else if (!['nothing_due', 'recent_credit', 'not_found'].includes(d.skip)) skipped[d.skip] = (skipped[d.skip] || 0) + 1
  }
  plans.sort((a, b) => (b.red - a.red) || b.overdue - a.overdue)
  const max = Math.max(1, Math.min(500, Number(settings.reminders_max) || AUTO_DEFAULTS.reminders_max))
  return { plans: plans.slice(0, max), beyondCap: Math.max(0, plans.length - max), skipped, tiers, max }
}

async function handleReminderPlan(busy, body, me, res) {
  if (!me.isAdmin) return send(res, 403, { error: 'Only admins can see this.' })
  const settings = check(await busy.from('collection_settings').select('*').eq('id', 1), 'settings')[0] || {}
  const c = await autoCandidates(busy, settings)
  return send(res, 200, {
    parties: c.plans.map(p => ({ party_code: p.code, party_name: p.name, group_name: p.group, mobile: p.mobile, balance: p.balance, overdue: p.overdue, tone: p.red ? 'red' : 'amber', kind: p.retail ? 'retail' : 'dealer', template: p.template })),
    beyondCap: c.beyondCap, skipped: c.skipped, tiers: c.tiers, max: c.max,
  })
}

async function handleReminderSettings(busy, me, body, res, save) {
  if (!me.isAdmin) return send(res, 403, { error: 'Only admins can change this.' })
  if (save) {
    const patch = { updated_at: new Date().toISOString() }
    if (typeof body.reminders_on === 'boolean') patch.reminders_on = body.reminders_on
    if (/^\d{2}:\d{2}$/.test(String(body.reminders_at || ''))) patch.reminders_at = body.reminders_at
    if (Array.isArray(body.reminders_tiers)) patch.reminders_tiers = body.reminders_tiers.map(Number).filter(n => n === 20 || n === 40).join(',') || '20,40'
    if (Number.isFinite(Number(body.reminders_max))) patch.reminders_max = Math.max(1, Math.min(500, Math.round(Number(body.reminders_max))))
    const r = await busy.from('collection_settings').update(patch).eq('id', 1)
    if (r.error) return send(res, 500, { error: /column/i.test(r.error.message) ? 'Run the reminder-scheduler SQL in Supabase first.' : r.error.message })
  }
  const row = check(await busy.from('collection_settings').select('*').eq('id', 1), 'settings')[0] || {}
  const last = await busy.from('collection_followups').select('created_at, outcome').eq('channel', 'reminder').eq('created_by_name', 'Auto reminders')
    .order('created_at', { ascending: false }).limit(1)
  return send(res, 200, {
    settings: {
      reminders_on: row.reminders_on === true,
      reminders_at: row.reminders_at || AUTO_DEFAULTS.reminders_at,
      reminders_tiers: String(row.reminders_tiers || AUTO_DEFAULTS.reminders_tiers).split(',').map(Number),
      reminders_max: row.reminders_max || AUTO_DEFAULTS.reminders_max,
      last_reminders: row.last_reminders || null,
      ready: 'reminders_on' in row,
    },
    lastRun: last.data?.[0] || null,
    contactGap: CONTACT_GAP,
  })
}

// The automatic daily run (from runDaily, once a day after reminders_at).
async function runAutoReminders(busy, settings) {
  if (!waConfigured()) return { skipped: 'WhatsApp not configured' }
  const c = await autoCandidates(busy, settings)
  const switches = await waSwitches(busy)
  const me = { id: null, name: 'Auto reminders' }
  const counts = { sent: 0, failed: 0, no_number: 0 }
  const queue = [...c.plans]
  async function worker() {
    while (queue.length) {
      const plan = queue.shift()
      const r = await dispatchReminder(busy, plan, me, switches)
      counts[r.status] = (counts[r.status] || 0) + 1
    }
  }
  await Promise.all([worker(), worker(), worker()])
  return { ...counts, planned: c.plans.length, beyondCap: c.beyondCap, skipped: c.skipped }
}

// ---------------------------------------------------------------------------
// Daily WhatsApps + Task Board tasks (JCM-Server timer, or admins from the Today tab)
// ---------------------------------------------------------------------------

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
  const col = which === 'morning' ? 'last_morning' : which === 'reminders' ? 'last_reminders' : 'last_evening'
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
  const remAt = settings.reminders_at || AUTO_DEFAULTS.reminders_at
  if (force === 'reminders' || (!force && settings.reminders_on === true && clock >= remAt && settings.last_reminders !== today)) {
    if (force || await claimRun(busy, 'reminders', today, settings.last_reminders)) out.reminders = await runAutoReminders(busy, settings)
  }
  if (!out.morning && !out.evening && !out.reminders) out.note = `nothing to do (morning ${morningAt}, evening ${eveningAt}, reminders ${settings.reminders_on ? remAt : 'off'}, last ${settings.last_morning || '-'} / ${settings.last_evening || '-'} / ${settings.last_reminders || '-'})`
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

// One person's follow-ups for today with each party's phone (customers table), for the "Due List PDF" button on
// staff_followup_morning (api/_duelist-pdf.js). personId = profiles.id.
export async function dueListFor(busy, hq, personId) {
  const { byPerson, people } = await dueByPerson(busy, hq)
  const person = people.find(p => p.id === personId) || null
  const list = (byPerson.get(personId) || []).map(x => ({ code: x.code, name: x.name, balance: x.balance, reason: reasonText(x.reason) }))
  const phones = new Map()
  const codes = list.map(x => Number(x.code)).filter(Number.isFinite)
  if (codes.length) {
    const rows = await inChunks(codes, 200, part => busy.from('customers').select('*').in('party_code', part).then(r => r.data || []))
    for (const c of rows) {
      const nums = [c.whatsapp_no, c.mobile, c.mobile_no, c.phone].filter(Boolean).join(',').split(/[,;/\s]+/)
      const ten = nums.map(n => String(n).replace(/\D/g, '')).map(d => (d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d)).find(d => /^[6-9]\d{9}$/.test(d))
      if (ten) phones.set(String(c.party_code), ten)
    }
  }
  for (const x of list) x.phone = phones.get(String(x.code)) || null
  return { person, list, total: list.reduce((s, x) => s + x.balance, 0), people }
}

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
    // staff_followup_morning: {{1}} first name, {{2}} parties, {{3}} total due, {{4}} the biggest three.
    // One quick reply "Due List PDF" (as created 2026-10-14) → payload duelist:<profiles.id> → api/_duelist-pdf.js (phones + Call buttons).
    const top3 = list.slice(0, 3).map(x => `${x.name} ₹${inr(x.balance)}`).join(', ') + (list.length > 3 ? ` and ${list.length - 3} more` : '')
    const wa = (await sendLogged(busy, { kind: 'staff_followup', to: person.whatsapp, template: 'staff_followup_morning',
      params: [person.name.split(' ')[0], String(list.length), inr(total), top3], opts: { headerImageUrl: BANNER('staff-followup'), buttonPayloads: [`duelist:${person.id}`] },
      ref: person.id, refName: person.name, by: 'HQ timer' })).status
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

// The evening numbers, shared by the 19:00 WhatsApp and its "Summary PDF" button (api/_collections-pdf.js).
export async function eveningSummary(busy, hq, today) {
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
  const rows = []
  let tDone = 0
  let tLeft = 0
  for (const person of people) {
    const s = stats.get(person.id) || { done: 0, promised: 0, promisedAmt: 0, noAnswer: 0 }
    const left = (byPerson.get(person.id) || []).length
    if (!s.done && !left && !morningCount.get(person.id)) continue
    tDone += s.done
    tLeft += left
    rows.push({ name: person.name, done: s.done, of: morningCount.get(person.id) ?? null, left, promised: s.promised, promisedAmt: s.promisedAmt, noAnswer: s.noAnswer,
      dueList: (byPerson.get(person.id) || []).map(x => ({ name: x.name, balance: x.balance, reason: reasonText(x.reason) })) })
    lines.push(`• ${person.name}: ${s.done} done${morningCount.has(person.id) ? ` of ${morningCount.get(person.id)}` : ''}, ${left} left` +
      `${s.promised ? ` · ${s.promised} promised ${rupeesText(s.promisedAmt)}` : ''}${s.noAnswer ? ` · ${s.noAnswer} no answer` : ''}`)
  }
  const none = (byPerson.get('none') || []).length
  if (none) lines.push(`• Nobody assigned: ${none} parties due — set them in Assign groups.`)
  const promiseTotal = promisedToday.reduce((s, p) => s + (Number(p.promised_amount) || 0), 0)
  const unassigned = (byPerson.get('none') || []).map(x => ({ name: x.name, balance: x.balance, reason: reasonText(x.reason) }))
  return { today, tDone, tLeft, lines, rows, unassigned, promisedToday, promiseTotal, people }
}

async function runEvening(busy, hq, today) {
  const { tDone, tLeft, lines, promisedToday, promiseTotal, people } = await eveningSummary(busy, hq, today)
  // staff_followup_evening: {{1}} date, {{2}} done, {{3}} still due, {{4}} per person, {{5}} promised for today.
  // One quick reply "Summary PDF" (as created 2026-10-14) → payload collect:<date> → api/_collections-pdf.js.
  const perPerson = lines.map(l => l.replace(/^• /, '')).join('; ') || 'nobody had follow-ups today'
  const promised = promisedToday.length ? `${promisedToday.length} part${promisedToday.length === 1 ? 'y' : 'ies'}, ₹${inr(promiseTotal)} — check they came in` : 'none'
  const sent = []
  const switches = await waSwitches(busy)
  for (const admin of people.filter(p => p.isAdmin)) {
    const r = await sendLogged(busy, { kind: 'staff_evening', to: admin.whatsapp, template: 'staff_followup_evening',
      params: [niceDate(today), String(tDone), String(tLeft), perPerson, promised], opts: { headerImageUrl: BANNER('staff-evening'), buttonPayloads: [`collect:${today}`] },
      ref: admin.id, refName: admin.name, by: 'HQ timer', switches })
    sent.push({ to: admin.name, whatsapp: r.status })
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
