import { applyCors } from './_cors.js'
import { createClient } from '@supabase/supabase-js'

// Red Alerts — zero-value billing and deletions in Busy, for admins.
//
// The alerts themselves are written by busy-sync/sync-red-alerts.js on
// JCM-Server (every 15 minutes) into the JCM-Busysql project:
//   red_alerts            one row per alert (alert_key unique), status new / seen / ok
//   red_alert_skip_items  give-away items the zero-billing check ignores
//   busy_user_names       Busy login -> person's name ('0' -> Dilip Mittal)
// All three have RLS on and no policies, so the browser (anon key) cannot read
// them at all. Everything goes through this function with the Busy project's
// service key, after the caller's HQ session has been checked here.
//
// Who may use it: admins, or anyone given the 'red-alerts' page in Manage Users
// (profiles.allowed_tabs) — the same rule the sidebar and router apply.
//
// POST { action: 'count' }                     number still New (sidebar badge)
// POST { action: 'list',   status?: 'open'|'new'|'seen'|'ok'|'all', type?: 'all'|<alert_type>, q? }
// POST { action: 'update', ids: [..], status: 'new'|'seen'|'ok', note? }
// POST { action: 'skip-add',    item_name }   also closes that item's open zero-billing alerts
// POST { action: 'skip-remove', item_name }

const SUPABASE_URL = 'https://cmtnzmfuasniicsdxyle.supabase.co'      // HQ / CRM project (profiles)
const SUPABASE_BUSY_URL = 'https://jlkjjqnmhsgefpluemyz.supabase.co' // Busy-data project (red_alerts)

const TAB_ID = 'red-alerts'
const STATUSES = new Set(['new', 'seen', 'ok'])
const TYPES = new Set(['zero_billing', 'deleted_item', 'deleted_account', 'deleted_voucher', 'deleted_other'])
const LIST_LIMIT = 500

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json(body)
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
  const isAdmin = profile?.is_admin === true || profile?.role === 'admin'
  const granted = Array.isArray(profile?.allowed_tabs) && profile.allowed_tabs.includes(TAB_ID)
  if (!profile || profile.active === false || !(isAdmin || granted)) {
    return send(res, 403, { error: 'You do not have access to Red Alerts.' })
  }
  const who = profile.name || profile.email || 'Someone'

  const body = req.body || {}
  try {
    if (body.action === 'count') return await handleCount(busy, res)
    if (body.action === 'list') return await handleList(busy, body, res)
    if (body.action === 'update') return await handleUpdate(busy, body, who, res)
    if (body.action === 'skip-add') return await handleSkipAdd(busy, body, who, res)
    if (body.action === 'skip-remove') return await handleSkipRemove(busy, body, res)
    return send(res, 400, { error: 'Unknown request.' })
  } catch (err) {
    console.error('red-alerts handler error:', err)
    return send(res, 500, { error: 'Something went wrong. Try again.' })
  }
}

// Sidebar badge: just the number still New.
async function handleCount(busy, res) {
  const { count, error } = await busy.from('red_alerts').select('id', { count: 'exact', head: true }).eq('status', 'new')
  if (error) return send(res, 500, { error: 'Could not count alerts.' })
  return send(res, 200, { new: count || 0 })
}

async function handleList(busy, body, res) {
  const status = String(body.status || 'open')
  const type = String(body.type || 'all')
  const q = String(body.q || '').trim().slice(0, 80)

  let query = busy
    .from('red_alerts')
    .select('id, alert_type, happened_at, title, subtitle, amount, qty, busy_user, computer_name, details, status, reviewed_by, reviewed_at, review_note')
    .order('happened_at', { ascending: false })
    .limit(LIST_LIMIT)

  if (status === 'open') query = query.in('status', ['new', 'seen'])
  else if (STATUSES.has(status)) query = query.eq('status', status)
  if (TYPES.has(type)) query = query.eq('alert_type', type)
  if (q) {
    // Commas and brackets would break PostgREST's or() syntax; nobody searches with them.
    const safe = q.replace(/[,()*%\\]/g, ' ').trim()
    if (safe) query = query.or(`title.ilike.*${safe}*,subtitle.ilike.*${safe}*`)
  }

  // Counts for the summary tiles always cover everything still open, whatever the filters.
  const countOpen = t => {
    let c = busy.from('red_alerts').select('id', { count: 'exact', head: true }).in('status', ['new', 'seen'])
    if (t) c = c.eq('alert_type', t)
    return c
  }
  const countNew = busy.from('red_alerts').select('id', { count: 'exact', head: true }).eq('status', 'new')

  const [list, names, skips, lastSync, open, fresh, zero, items, accounts, vouchers, other] = await Promise.all([
    query,
    busy.from('busy_user_names').select('busy_user, display_name'),
    busy.from('red_alert_skip_items').select('item_name, added_by, added_at').order('item_name'),
    busy.from('red_alerts').select('created_at').order('created_at', { ascending: false }).limit(1),
    countOpen(null), countNew,
    countOpen('zero_billing'), countOpen('deleted_item'), countOpen('deleted_account'),
    countOpen('deleted_voucher'), countOpen('deleted_other'),
  ])
  const err = list.error || names.error || skips.error
  if (err) {
    console.error('red-alerts list failed:', err)
    // The tables not existing yet is the one failure worth naming plainly.
    if (/relation .* does not exist|Could not find the table/i.test(err.message || '')) {
      return send(res, 500, { error: 'The Red Alerts tables are not set up in Supabase yet.' })
    }
    return send(res, 500, { error: 'Could not load alerts. Try again.' })
  }

  const userNames = {}
  for (const n of names.data || []) userNames[String(n.busy_user).toLowerCase()] = n.display_name

  return send(res, 200, {
    alerts: list.data || [],
    limited: (list.data || []).length >= LIST_LIMIT,
    userNames,
    skipItems: skips.data || [],
    lastAlertAt: lastSync.data?.[0]?.created_at || null,
    counts: {
      open: open.count || 0,
      new: fresh.count || 0,
      zero_billing: zero.count || 0,
      deleted_item: items.count || 0,
      deleted_account: accounts.count || 0,
      deleted_voucher: vouchers.count || 0,
      deleted_other: other.count || 0,
    },
  })
}

async function handleUpdate(busy, body, who, res) {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 500) : []
  const status = String(body.status || '')
  if (!ids.length || !STATUSES.has(status)) return send(res, 400, { error: 'Nothing to update.' })
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : undefined

  const patch = status === 'new'
    ? { status, reviewed_by: null, reviewed_at: null, review_note: null } // "Reopen" clears the review
    : { status, reviewed_by: who, reviewed_at: new Date().toISOString() }
  if (status !== 'new' && note !== undefined) patch.review_note = note || null

  const { error } = await busy.from('red_alerts').update(patch).in('id', ids)
  if (error) {
    console.error('red-alerts update failed:', error)
    return send(res, 500, { error: 'Could not save. Try again.' })
  }
  return send(res, 200, { ok: true, updated: ids.length })
}

async function handleSkipAdd(busy, body, who, res) {
  const itemName = String(body.item_name || '').trim().slice(0, 200)
  if (!itemName) return send(res, 400, { error: 'Item name is required.' })

  const { error } = await busy.from('red_alert_skip_items')
    .upsert({ item_name: itemName, added_by: who }, { onConflict: 'item_name', ignoreDuplicates: true })
  if (error) {
    console.error('red-alerts skip-add failed:', error)
    return send(res, 500, { error: 'Could not save. Try again.' })
  }

  // Anything already flagged for this item is a give-away too — close it so the
  // list doesn't keep showing what was just declared normal.
  const { data: closed, error: closeErr } = await busy.from('red_alerts')
    .update({ status: 'ok', reviewed_by: who, reviewed_at: new Date().toISOString(), review_note: 'Added to gift / free items list' })
    .eq('alert_type', 'zero_billing')
    .in('status', ['new', 'seen'])
    .ilike('subtitle', itemName.replace(/[%_\\]/g, m => `\\${m}`))
    .select('id')
  if (closeErr) console.error('red-alerts skip-add close failed:', closeErr)

  return send(res, 200, { ok: true, closed: closed?.length || 0 })
}

async function handleSkipRemove(busy, body, res) {
  const itemName = String(body.item_name || '').trim()
  if (!itemName) return send(res, 400, { error: 'Item name is required.' })
  const { error } = await busy.from('red_alert_skip_items').delete().eq('item_name', itemName)
  if (error) {
    console.error('red-alerts skip-remove failed:', error)
    return send(res, 500, { error: 'Could not save. Try again.' })
  }
  return send(res, 200, { ok: true })
}
