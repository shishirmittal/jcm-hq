import { applyCors } from './_cors.js'
import { createClient } from '@supabase/supabase-js'

// Red Alerts — ₹0 billing, below-cost sales, bill edits, backdated entries and
// deletions in Busy, for admins; plus "My Explanations" for the staff asked
// about them.
//
// The alerts are written by busy-sync/sync-red-alerts.js on JCM-Server (every
// 15 minutes) into the JCM-Busysql project:
//   red_alerts            one row per alert (alert_key unique)
//                         status: new → seen / asked → answered → ok
//   red_alert_skip_items  give-away items the ₹0 checks ignore
//   red_alert_skip_parties parties billed below cost on purpose: the below-cost check ignores them
//   busy_user_names       Busy login -> person's name, HQ account and WhatsApp number
// All three have RLS on and no policies, so the browser (anon key) cannot read
// them. Everything goes through this function with the Busy project's service
// key, after the caller's HQ session has been checked here.
//
// "Ask for explanation" files a Task Board task (team_tasks, CRM project) for
// the person who made the entry, and sends them a WhatsApp through Whatshub360
// when WHATSHUB_SEND_URL is set. They answer on #explain; answering marks the
// task done and puts the alert in Answered for the admin.
//
// Access
//   admin actions — admins, or anyone given the 'red-alerts' page in Manage Users
//   staff actions (my-*, reply) — any active HQ user, only for alerts asked of them
//
// Admin actions (POST JSON):
//   count                          { new, answered } for the sidebar badge
//   list    filters + offset       a page of alerts plus tile counts
//   update  ids, status, note?     mark seen / ok (Clear) / new (Reopen)
//   update-matching filters, status, note?   same, for everything the filters match
//   ask     ids, question, hq_user_id?       ask the person who did it (or someone chosen)
//   skip-add / skip-remove  item_name        gift items
//   party-add / party-remove party_name      parties skipped by the below-cost check
//   band-save  from, to                      below-cost % band skipped as deliberate billing (red_alert_settings)
//   people  /  people-save  busy_user, display_name, hq_user_id, whatsapp
// Staff actions:
//   my-count, my-list, reply { id, reply }

const SUPABASE_URL = 'https://cmtnzmfuasniicsdxyle.supabase.co'      // HQ / CRM project (profiles, team_tasks)
const SUPABASE_BUSY_URL = 'https://jlkjjqnmhsgefpluemyz.supabase.co' // Busy-data project (red_alerts)
const HQ_URL = 'https://hq.jcmretails.com'

const TAB_ID = 'red-alerts'
const STATUSES = new Set(['new', 'seen', 'asked', 'answered', 'ok'])
const OPEN_STATUSES = ['new', 'seen', 'asked', 'answered']
const PAGE_SIZE = 200

// The filter menu. A group can cover several stored types; an old bill edited
// is both an edit and a backdating, so it shows under both.
const GROUPS = {
  deleted: ['deleted_item', 'deleted_account', 'deleted_voucher', 'deleted_other'],
  deleted_voucher: ['deleted_voucher'],
  deleted_item: ['deleted_item'],
  deleted_account: ['deleted_account', 'deleted_other'],
  modified: ['modified', 'old_bill_edited'],
  zero_rate: ['zero_rate', 'zero_billing'],
  zero_qty: ['zero_qty'],
  below_cost: ['below_cost'],
  backdated: ['backdated', 'old_bill_edited'],
}
const TILE_GROUPS = ['deleted', 'modified', 'zero_rate', 'zero_qty', 'below_cost', 'backdated']

const TYPE_TEXT = {
  zero_rate: '₹0 rate', zero_billing: '₹0 rate', zero_qty: '₹0 qty', below_cost: 'Below purchase cost',
  modified: 'Bill edited', old_bill_edited: 'Old bill edited', backdated: 'Backdated entry',
  deleted_voucher: 'Bill deleted', deleted_item: 'Item deleted', deleted_account: 'Account deleted', deleted_other: 'Deleted',
}

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json(body)
}

const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
const shortDate = s => {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' })
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const busyServiceRoleKey = process.env.SUPABASE_BUSY_SERVICE_ROLE_KEY
  if (!serviceRoleKey || !busyServiceRoleKey) {
    console.error('red-alerts is missing env vars', { hq: !!serviceRoleKey, busy: !!busyServiceRoleKey })
    return send(res, 500, { error: 'Red Alerts is not configured yet.' })
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
    console.error('red-alerts profile read failed:', profErr)
    return send(res, 500, { error: 'Something went wrong. Try again.' })
  }
  if (!profile || profile.active === false) return send(res, 403, { error: 'Your account is not active.' })
  const isAdmin = profile.is_admin === true || profile.role === 'admin'
  const granted = Array.isArray(profile.allowed_tabs) && profile.allowed_tabs.includes(TAB_ID)
  const canReview = isAdmin || granted
  const me = { id: profile.id, name: profile.name || profile.email || 'Someone' }

  const body = req.body || {}
  const action = String(body.action || '')
  try {
    // Staff side — anyone signed in, only their own questions.
    if (action === 'my-count') return await handleMyCount(busy, me, res)
    if (action === 'my-list') return await handleMyList(busy, me, res)
    if (action === 'reply') return await handleReply(busy, hq, me, body, res)

    if (!canReview) return send(res, 403, { error: 'You do not have access to Red Alerts.' })
    if (action === 'count') return await handleCount(busy, res)
    if (action === 'list') return await handleList(busy, body, res)
    if (action === 'update') return await handleUpdate(busy, body, me, res)
    if (action === 'update-matching') return await handleUpdateMatching(busy, body, me, res)
    if (action === 'ask') return await handleAsk(busy, hq, me, body, res)
    if (action === 'skip-add') return await handleSkipAdd(busy, body, me, res)
    if (action === 'skip-remove') return await handleSkipRemove(busy, body, res)
    if (action === 'party-add') return await handlePartyAdd(busy, body, me, res)
    if (action === 'party-remove') return await handlePartyRemove(busy, body, res)
    if (action === 'band-save') return await handleBandSave(busy, body, me, res)
    if (action === 'people') return await handlePeople(busy, hq, res)
    if (action === 'people-save') return await handlePeopleSave(busy, body, res)
    return send(res, 400, { error: 'Unknown request.' })
  } catch (err) {
    console.error('red-alerts handler error:', err)
    return send(res, 500, { error: 'Something went wrong. Try again.' })
  }
}

// ---------------------------------------------------------------------------
// Filters — one function, used by list, its counts and update-matching, so
// "Clear all matching" can never touch a different set from the one on screen.
// ---------------------------------------------------------------------------
function readFilters(body) {
  const status = String(body.status || 'open')
  const group = String(body.type || 'all')
  const q = String(body.q || '').replace(/[,()*%\\]/g, ' ').trim().slice(0, 80)
  const dateOk = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
  return {
    status: status === 'open' || status === 'all' || STATUSES.has(status) ? status : 'open',
    group: GROUPS[group] ? group : 'all',
    q,
    from: dateOk(body.from) ? body.from : null,
    to: dateOk(body.to) ? body.to : null,
    changedOnly: body.changedOnly === true,
    user: typeof body.user === 'string' && body.user ? body.user.slice(0, 40) : null,
  }
}

function applyFilters(query, f, { skipStatus = false, skipGroup = false } = {}) {
  if (!skipStatus) {
    if (f.status === 'open') query = query.in('status', OPEN_STATUSES)
    else if (f.status !== 'all') query = query.eq('status', f.status)
  }
  if (!skipGroup && f.group !== 'all') query = query.in('alert_type', GROUPS[f.group])
  if (f.from) query = query.gte('happened_at', `${f.from}T00:00:00+05:30`)
  if (f.to) query = query.lte('happened_at', `${f.to}T23:59:59+05:30`)
  // "Amount or quantity changed" only means something for edits.
  if (f.changedOnly && f.group === 'modified') query = query.eq('details->>changed', 'true')
  if (f.user) query = query.ilike('busy_user', f.user)
  if (f.q) query = query.or(`title.ilike.*${f.q}*,subtitle.ilike.*${f.q}*,details->>party.ilike.*${f.q}*`)
  return query
}

// '*' rather than a column list: the page keeps working whether or not the
// ask/reply columns have been added to red_alerts yet.
const COLUMNS = '*'

async function handleCount(busy, res) {
  const [fresh, answered] = await Promise.all([
    busy.from('red_alerts').select('id', { count: 'exact', head: true }).eq('status', 'new'),
    busy.from('red_alerts').select('id', { count: 'exact', head: true }).eq('status', 'answered'),
  ])
  if (fresh.error || answered.error) return send(res, 500, { error: 'Could not count alerts.' })
  return send(res, 200, { new: fresh.count || 0, answered: answered.count || 0 })
}

async function handleList(busy, body, res) {
  const f = readFilters(body)
  const offset = Math.max(0, Math.min(100000, Number(body.offset) || 0))
  const ascending = body.sort === 'oldest'

  let query = busy.from('red_alerts').select(COLUMNS, { count: 'exact' })
  query = applyFilters(query, f)
    .order('happened_at', { ascending })
    .order('id', { ascending })
    .range(offset, offset + PAGE_SIZE - 1)

  // Tiles: every group's count under the current status / date / search, so
  // clicking a tile always shows exactly the number on it.
  const tileCount = g => applyFilters(
    busy.from('red_alerts').select('id', { count: 'exact', head: true }).in('alert_type', GROUPS[g]),
    { ...f, changedOnly: false }, { skipGroup: true })
  const statusCount = s => busy.from('red_alerts').select('id', { count: 'exact', head: true }).eq('status', s)

  const [list, names, skips, skipParties, settings, ...counts] = await Promise.all([
    query,
    busy.from('busy_user_names').select('busy_user, display_name'),
    busy.from('red_alert_skip_items').select('item_name, added_by, added_at').order('item_name'),
    busy.from('red_alert_skip_parties').select('party_name, added_by, added_at').order('party_name'),
    busy.from('red_alert_settings').select('key, value'),
    ...TILE_GROUPS.map(tileCount),
    ...['new', 'asked', 'answered'].map(statusCount),
  ])
  const err = list.error || names.error || skips.error
  if (err) {
    console.error('red-alerts list failed:', err)
    if (/does not exist|Could not find/i.test(err.message || '')) {
      return send(res, 500, { error: 'The Red Alerts tables need the latest update in Supabase.' })
    }
    return send(res, 500, { error: 'Could not load alerts. Try again.' })
  }

  const userNames = {}
  for (const n of names.data || []) userNames[String(n.busy_user).toLowerCase()] = n.display_name

  const tiles = {}
  TILE_GROUPS.forEach((g, i) => { tiles[g] = counts[i].count || 0 })
  const [cNew, cAsked, cAnswered] = counts.slice(TILE_GROUPS.length)

  return send(res, 200, {
    alerts: list.data || [],
    total: list.count || 0,
    offset,
    pageSize: PAGE_SIZE,
    userNames,
    skipItems: skips.data || [],
    // Missing table (not created yet) just means an empty list.
    skipParties: skipParties.error ? [] : (skipParties.data || []),
    band: readBand(settings.error ? [] : settings.data),
    tiles,
    statusCounts: { new: cNew.count || 0, asked: cAsked.count || 0, answered: cAnswered.count || 0 },
  })
}

function reviewPatch(status, who, note) {
  const patch = status === 'new'
    ? { status, reviewed_by: null, reviewed_at: null, review_note: null } // Reopen clears the review
    : { status, reviewed_by: who, reviewed_at: new Date().toISOString() }
  if (status !== 'new' && typeof note === 'string') patch.review_note = note.trim().slice(0, 500) || null
  return patch
}

async function handleUpdate(busy, body, me, res) {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 2000) : []
  const status = String(body.status || '')
  if (!ids.length || !['new', 'seen', 'ok'].includes(status)) return send(res, 400, { error: 'Nothing to update.' })

  const { data, error } = await busy.from('red_alerts').update(reviewPatch(status, me.name, body.note)).in('id', ids).select('id')
  if (error) {
    console.error('red-alerts update failed:', error)
    return send(res, 500, { error: 'Could not save. Try again.' })
  }
  return send(res, 200, { ok: true, updated: data?.length || 0 })
}

// "Clear all N matching" — the same filters the list used. The client sends
// the count it showed; if the set has grown since (a sync ran), refuse rather
// than clear things nobody has seen.
async function handleUpdateMatching(busy, body, me, res) {
  const status = String(body.status || '')
  if (!['seen', 'ok'].includes(status)) return send(res, 400, { error: 'Nothing to update.' })
  // `status` here is the NEW status; the tab the list was filtered by comes as filter_status.
  const f = readFilters({ ...body, status: body.filter_status })
  const expected = Number(body.expected)

  const { count, error: cErr } = await applyFilters(busy.from('red_alerts').select('id', { count: 'exact', head: true }), f)
  if (cErr) return send(res, 500, { error: 'Could not check the list. Try again.' })
  if (!Number.isInteger(expected) || count !== expected) {
    return send(res, 409, { error: `The list changed (now ${count}). Refresh and try again.` })
  }

  const { data, error } = await applyFilters(busy.from('red_alerts').update(reviewPatch(status, me.name, body.note)), f).select('id')
  if (error) {
    console.error('red-alerts update-matching failed:', error)
    return send(res, 500, { error: 'Could not save. Try again.' })
  }
  return send(res, 200, { ok: true, updated: data?.length || 0 })
}

// ---------------------------------------------------------------------------
// Ask for explanation
// ---------------------------------------------------------------------------
function alertLine(a) {
  const d = a.details || {}
  const what = TYPE_TEXT[a.alert_type] || 'Alert'
  const bits = [a.title]
  if (a.subtitle && !String(a.alert_type).startsWith('deleted_')) bits.push(a.subtitle)
  if (d.party) bits.push(d.party)
  return `• ${what}: ${bits.filter(Boolean).join(' · ')} (${shortDate(a.happened_at)})`
}

async function sendWhatsApp(mobile, message) {
  const template = process.env.WHATSHUB_SEND_URL
  if (!template) return 'not_set_up'
  const digits = String(mobile || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '')
  if (!/^[6-9]\d{9}$/.test(digits)) return 'no_number'
  // The URL is kept in Vercel as a template, e.g.
  //   https://…/send?vid={vid}&recMobileNo=91{mobile}&msg={msg}
  // so the provider's exact parameter names never have to live in code.
  const url = template
    .replace('{vid}', encodeURIComponent(process.env.WHATSHUB_VID || ''))
    .replace('{mobile}', digits)
    .replace('{msg}', encodeURIComponent(message))
  try {
    const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) })
    const text = (await r.text()).slice(0, 300)
    if (!r.ok || /error|fail|invalid/i.test(text)) {
      console.error('Whatshub360 send failed:', r.status, text)
      return 'failed'
    }
    return 'sent'
  } catch (err) {
    console.error('Whatshub360 send error:', err)
    return 'failed'
  }
}

async function handleAsk(busy, hq, me, body, res) {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 300) : []
  const question = String(body.question || '').trim().slice(0, 500)
  const override = typeof body.hq_user_id === 'string' && body.hq_user_id ? body.hq_user_id : null
  if (!ids.length) return send(res, 400, { error: 'Tick at least one alert.' })

  const [{ data: alerts, error: aErr }, { data: people, error: pErr }] = await Promise.all([
    busy.from('red_alerts').select('id, alert_type, happened_at, title, subtitle, busy_user, details, status').in('id', ids),
    busy.from('busy_user_names').select('busy_user, display_name, hq_user_id, whatsapp'),
  ])
  if (aErr || pErr) return send(res, 500, { error: 'Could not load the alerts. Try again.' })

  const byLogin = new Map((people || []).map(p => [String(p.busy_user).toLowerCase(), p]))
  const groups = new Map() // hq_user_id -> alerts
  const unassigned = []
  for (const a of alerts || []) {
    const person = override ? null : byLogin.get(String(a.busy_user || '').toLowerCase())
    const target = override || person?.hq_user_id
    if (!target) { unassigned.push(a); continue }
    if (!groups.has(target)) groups.set(target, [])
    groups.get(target).push(a)
  }
  if (!groups.size) {
    return send(res, 400, {
      error: 'No HQ person is linked to who made these entries. Pick a person, or link Busy logins under People.',
      unassigned: unassigned.length,
    })
  }

  const { data: targets } = await hq.from('profiles').select('id, name, email, active').in('id', [...groups.keys()])
  const targetById = new Map((targets || []).map(t => [t.id, t]))
  const phoneByHqId = new Map((people || []).filter(p => p.hq_user_id && p.whatsapp).map(p => [p.hq_user_id, p.whatsapp]))

  const results = []
  for (const [hqUserId, list] of groups) {
    const target = targetById.get(hqUserId)
    if (!target || target.active === false) { unassigned.push(...list); continue }
    const name = target.name || target.email || 'Staff'

    const lines = list.slice(0, 8).map(alertLine)
    if (list.length > 8) lines.push(`• …and ${list.length - 8} more`)
    const taskBody = [
      `Red Alert — please explain ${list.length === 1 ? 'this Busy entry' : `these ${list.length} Busy entries`} (asked by ${me.name}):`,
      ...lines,
      question ? `Question: ${question}` : null,
      `Reply in HQ → My Explanations (${HQ_URL}/#explain).`,
    ].filter(Boolean).join('\n')

    const { data: task, error: tErr } = await hq.from('team_tasks').insert({
      task_type: 'other',
      body: taskBody,
      created_by: me.id,
      assigned_to: hqUserId,
      due_date: todayIST(),
      status: 'open',
    }).select('id').single()
    if (tErr) {
      console.error('red-alerts task insert failed:', tErr)
      return send(res, 500, { error: `Could not create the task for ${name}: ${tErr.message}` })
    }
    const { error: hErr } = await hq.from('team_task_history').insert({ task_id: task.id, actor: me.id, action: 'filed', to_user: hqUserId })
    if (hErr) console.error('red-alerts task history failed:', hErr)

    const waText = `JCM HQ: ${me.name} has asked you to explain ${list.length === 1 ? '1 entry' : `${list.length} entries`} in Busy` +
      `${question ? ` — "${question}"` : ''}. Please reply in HQ → My Explanations: ${HQ_URL}/#explain`
    const waStatus = await sendWhatsApp(phoneByHqId.get(hqUserId), waText)

    const { error: uErr } = await busy.from('red_alerts').update({
      status: 'asked',
      asked_user_id: hqUserId,
      asked_name: name,
      asked_by: me.name,
      asked_at: new Date().toISOString(),
      question: question || null,
      task_id: String(task.id),
      whatsapp_status: waStatus,
      reply: null,
      replied_at: null,
    }).in('id', list.map(a => a.id))
    if (uErr) {
      console.error('red-alerts ask update failed:', uErr)
      return send(res, 500, { error: 'The task was created but the alerts could not be updated. Refresh and check.' })
    }
    results.push({ name, count: list.length, whatsapp: waStatus })
  }

  return send(res, 200, { ok: true, asked: results, unassigned: unassigned.length })
}

// ---------------------------------------------------------------------------
// Staff: My Explanations
// ---------------------------------------------------------------------------
async function handleMyCount(busy, me, res) {
  const { count, error } = await busy.from('red_alerts').select('id', { count: 'exact', head: true })
    .eq('asked_user_id', me.id).eq('status', 'asked')
  if (error) return send(res, 200, { pending: 0 })
  return send(res, 200, { pending: count || 0 })
}

async function handleMyList(busy, me, res) {
  const { data, error } = await busy.from('red_alerts')
    .select('id, alert_type, happened_at, title, subtitle, amount, qty, busy_user, computer_name, details, status, asked_by, asked_at, question, reply, replied_at')
    .eq('asked_user_id', me.id)
    .in('status', ['asked', 'answered', 'ok', 'seen'])
    .not('asked_at', 'is', null)
    .order('asked_at', { ascending: false })
    .limit(300)
  if (error) {
    console.error('red-alerts my-list failed:', error)
    return send(res, 500, { error: 'Could not load your questions. Try again.' })
  }
  return send(res, 200, { alerts: data || [] })
}

async function handleReply(busy, hq, me, body, res) {
  const id = Number(body.id)
  const reply = String(body.reply || '').trim().slice(0, 1000)
  if (!Number.isInteger(id) || id <= 0) return send(res, 400, { error: 'Nothing to answer.' })
  if (reply.length < 3) return send(res, 400, { error: 'Please write your explanation.' })

  const { data: alert, error: aErr } = await busy.from('red_alerts')
    .select('id, asked_user_id, status, task_id').eq('id', id).maybeSingle()
  if (aErr || !alert) return send(res, 404, { error: 'That question is no longer there.' })
  if (alert.asked_user_id !== me.id) return send(res, 403, { error: 'This question was not asked of you.' })
  if (alert.status !== 'asked' && alert.status !== 'answered') return send(res, 409, { error: 'This has already been closed.' })

  const { error: uErr } = await busy.from('red_alerts')
    .update({ status: 'answered', reply, replied_at: new Date().toISOString() }).eq('id', id)
  if (uErr) return send(res, 500, { error: 'Could not save. Try again.' })

  // When every alert on this task has an answer, the task is done.
  if (alert.task_id) {
    const { count } = await busy.from('red_alerts').select('id', { count: 'exact', head: true })
      .eq('task_id', alert.task_id).eq('status', 'asked')
    if (!count) {
      const { data: closed } = await hq.from('team_tasks')
        .update({ status: 'done', done_at: new Date().toISOString() })
        .eq('id', alert.task_id).eq('status', 'open').select('id')
      if (closed?.length) {
        const { error: hErr } = await hq.from('team_task_history').insert({ task_id: alert.task_id, actor: me.id, action: 'done' })
        if (hErr) console.error('red-alerts done history failed:', hErr)
      }
    }
  }
  return send(res, 200, { ok: true })
}

// ---------------------------------------------------------------------------
// Gift items and People
// ---------------------------------------------------------------------------
async function handleSkipAdd(busy, body, me, res) {
  const itemName = String(body.item_name || '').trim().slice(0, 200)
  if (!itemName) return send(res, 400, { error: 'Item name is required.' })

  const { error } = await busy.from('red_alert_skip_items')
    .upsert({ item_name: itemName, added_by: me.name }, { onConflict: 'item_name', ignoreDuplicates: true })
  if (error) {
    console.error('red-alerts skip-add failed:', error)
    return send(res, 500, { error: 'Could not save. Try again.' })
  }

  // Anything already flagged for this item is a give-away too — close it.
  const { data: closed, error: closeErr } = await busy.from('red_alerts')
    .update({ status: 'ok', reviewed_by: me.name, reviewed_at: new Date().toISOString(), review_note: 'Added to gift / free items list' })
    .in('alert_type', ['zero_rate', 'zero_qty', 'zero_billing'])
    .in('status', ['new', 'seen'])
    .ilike('subtitle', itemName.replace(/[%_\\]/g, m => `\\${m}`))
    .select('id')
  if (closeErr) console.error('red-alerts skip-add close failed:', closeErr)

  return send(res, 200, { ok: true, closed: closed?.length || 0 })
}

const BAND_DEFAULT = { from: 80, to: 97 }
function readBand(rows) {
  const band = { ...BAND_DEFAULT }
  for (const r of rows || []) {
    if (r.key === 'below_cost_skip_from' && Number.isFinite(Number(r.value))) band.from = Number(r.value)
    if (r.key === 'below_cost_skip_to' && Number.isFinite(Number(r.value))) band.to = Number(r.value)
  }
  return band
}

// The deliberate-billing band: below-cost lines between `from`% and `to`% below cost are skipped
// by the sync for every party. Saving it also clears open alerts already inside the band.
async function handleBandSave(busy, body, me, res) {
  const from = Number(body.from)
  const to = Number(body.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > 100 || (to !== from && to < from)) {
    return send(res, 400, { error: 'Enter two percentages, the first smaller than the second (or both 0 to switch it off).' })
  }
  const { error } = await busy.from('red_alert_settings').upsert([
    { key: 'below_cost_skip_from', value: String(from) },
    { key: 'below_cost_skip_to', value: String(to) },
  ], { onConflict: 'key' })
  if (error) {
    console.error('red-alerts band-save failed:', error)
    return send(res, 500, { error: /does not exist|Could not find/i.test(error.message || '') ? 'The settings table needs the latest update in Supabase.' : 'Could not save. Try again.' })
  }
  let closed = 0
  if (to > from) {
    // details->>below_pct is text; compare as numbers page by page.
    const ids = []
    for (let off = 0; off < 50000; off += 1000) {
      const { data, error: rErr } = await busy.from('red_alerts').select('id, details')
        .eq('alert_type', 'below_cost').in('status', ['new', 'seen']).order('id').range(off, off + 999)
      if (rErr || !data?.length) break
      for (const a of data) {
        const pct = Number(a.details?.below_pct)
        if (pct >= from && pct < to) ids.push(a.id)
      }
      if (data.length < 1000) break
    }
    for (let i = 0; i < ids.length; i += 500) {
      const { data } = await busy.from('red_alerts')
        .update({ status: 'ok', reviewed_by: me.name, reviewed_at: new Date().toISOString(), review_note: `Deliberate billing (${from}-${to}% below cost)` })
        .in('id', ids.slice(i, i + 500)).select('id')
      closed += data?.length || 0
    }
  }
  return send(res, 200, { ok: true, closed })
}

async function handlePartyAdd(busy, body, me, res) {
  const partyName = String(body.party_name || '').trim().slice(0, 200)
  if (!partyName) return send(res, 400, { error: 'Party name is required.' })
  const { error } = await busy.from('red_alert_skip_parties')
    .upsert({ party_name: partyName, added_by: me.name }, { onConflict: 'party_name', ignoreDuplicates: true })
  if (error) {
    console.error('red-alerts party-add failed:', error)
    return send(res, 500, { error: /does not exist|Could not find/i.test(error.message || '') ? 'The party list needs the latest update in Supabase.' : 'Could not save. Try again.' })
  }
  // Open below-cost alerts for this party are deliberate too — clear them.
  const { data: closed, error: closeErr } = await busy.from('red_alerts')
    .update({ status: 'ok', reviewed_by: me.name, reviewed_at: new Date().toISOString(), review_note: 'Party billed below cost on purpose' })
    .eq('alert_type', 'below_cost')
    .in('status', ['new', 'seen'])
    .ilike('details->>party', partyName.replace(/[%_\\]/g, m => `\\${m}`))
    .select('id')
  if (closeErr) console.error('red-alerts party-add close failed:', closeErr)
  return send(res, 200, { ok: true, closed: closed?.length || 0 })
}

async function handlePartyRemove(busy, body, res) {
  const partyName = String(body.party_name || '').trim()
  if (!partyName) return send(res, 400, { error: 'Party name is required.' })
  const { error } = await busy.from('red_alert_skip_parties').delete().eq('party_name', partyName)
  if (error) return send(res, 500, { error: 'Could not save. Try again.' })
  return send(res, 200, { ok: true })
}

async function handleSkipRemove(busy, body, res) {
  const itemName = String(body.item_name || '').trim()
  if (!itemName) return send(res, 400, { error: 'Item name is required.' })
  const { error } = await busy.from('red_alert_skip_items').delete().eq('item_name', itemName)
  if (error) return send(res, 500, { error: 'Could not save. Try again.' })
  return send(res, 200, { ok: true })
}

async function handlePeople(busy, hq, res) {
  const [{ data: names, error: nErr }, { data: profiles, error: pErr }] = await Promise.all([
    busy.from('busy_user_names').select('busy_user, display_name, hq_user_id, whatsapp').order('busy_user'),
    hq.from('profiles').select('id, name, email, active, hide_from_roster').eq('active', true).order('name'),
  ])
  if (nErr || pErr) return send(res, 500, { error: 'Could not load people. Try again.' })

  // Every Busy login that appears on an alert, so a new one shows up here to be linked.
  const logins = new Set((names || []).map(n => n.busy_user))
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await busy.from('red_alerts').select('busy_user').not('busy_user', 'is', null).range(from, from + 999)
    if (error || !data?.length) break
    data.forEach(r => logins.add(r.busy_user))
    if (data.length < 1000) break
  }
  const byLogin = new Map((names || []).map(n => [n.busy_user.toLowerCase(), n]))
  const seen = new Set()
  const rows = []
  for (const login of logins) {
    const key = String(login).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const n = byLogin.get(key)
    rows.push({ busy_user: n?.busy_user || login, display_name: n?.display_name || '', hq_user_id: n?.hq_user_id || null, whatsapp: n?.whatsapp || '' })
  }
  rows.sort((a, b) => a.busy_user.localeCompare(b.busy_user))

  return send(res, 200, {
    people: rows,
    hqUsers: (profiles || []).filter(p => !p.hide_from_roster).map(p => ({ id: p.id, name: p.name || p.email })),
    whatsappReady: !!process.env.WHATSHUB_SEND_URL,
  })
}

async function handlePeopleSave(busy, body, res) {
  const login = String(body.busy_user || '').trim().slice(0, 40)
  if (!login) return send(res, 400, { error: 'Busy login is required.' })
  const displayName = String(body.display_name || '').trim().slice(0, 80) || login
  const hqUserId = typeof body.hq_user_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.hq_user_id) ? body.hq_user_id : null
  const whatsapp = String(body.whatsapp || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '')
  if (whatsapp && !/^[6-9]\d{9}$/.test(whatsapp)) return send(res, 400, { error: 'WhatsApp number should be a 10-digit mobile.' })

  // Match case-insensitively so 'RM' and 'Rm' never become two people.
  const { data: existing } = await busy.from('busy_user_names').select('busy_user').ilike('busy_user', login)
  const key = existing?.[0]?.busy_user || login
  const { error } = await busy.from('busy_user_names').upsert(
    { busy_user: key, display_name: displayName, hq_user_id: hqUserId, whatsapp: whatsapp || null },
    { onConflict: 'busy_user' })
  if (error) {
    console.error('red-alerts people-save failed:', error)
    return send(res, 500, { error: 'Could not save. Try again.' })
  }
  return send(res, 200, { ok: true })
}
