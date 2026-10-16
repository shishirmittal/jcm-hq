import { applyCors } from './_cors.js'
import { createClient } from '@supabase/supabase-js'
import { waConfigured, sendLogged, waSwitches, BANNER, inr, niceDate as waDate } from './_wa-cloud.js'
import { buildPurchasePdf, purchaseFileName } from './_purchase-pdf.js'
import { handleEmailAction, emailTabId } from './_email-purchases.js'
import { handleCdAction } from './_cash-discount.js'
import { handleCashAction, cashTabId } from './_cash-drawer.js'

// Purchase Summary — every purchase bill the accounts team types into Busy, so
// admins know what material has reached the warehouse: party, bill no. and date,
// when it was entered in Busy and by whom, and every item with qty, rate and amount.
//
// Data: purchase_vouchers / purchase_lines in the JCM-Busysql project, written every
// 15 minutes by busy-sync/sync-purchases.js on JCM-Server. RLS-closed; everything goes
// through here with the Busy project's service key after the HQ session is checked.
//
// WhatsApp (Meta templates staff_purchase_bill / staff_purchase_summary, api/_wa-cloud.js):
//   instant — one message per new bill, to people ticked "Every bill", plus the
//             people the bill's maker reports to (Manage Users → Reports to)
//   daily   — the evening summary, once a day after purchase_settings.summary_time (IST)
// Both are sent from action 'notify', which the sync script calls after each run with
// the Busy service key (checked below by reading a closed table with it).
// Numbers come from profiles.whatsapp (CRM project, set in Manage Users).
//
// Access: admins, or anyone with 'purchases' in profiles.allowed_tabs.
// Actions (POST JSON):
//   count                         bills entered today (sidebar badge)
//   list   from, to, by, q        bills with their item lines, plus totals
//   people                        HQ users, who gets what, settings, last sync
//   people-save hq_user_id, instant, daily
//   settings-save instant_on, daily_on, summary_time
//   send-bill vch_key             send one bill's WhatsApp again, now
//   test                          the newest bill's WhatsApp, to the signed-in person only
//   pdf    vch_key                the bill PDF (base64) for the in-app viewer
//   notify                        (sync script only) send what is due

export const config = { maxDuration: 60 }

const SUPABASE_URL = 'https://cmtnzmfuasniicsdxyle.supabase.co'      // HQ / CRM project (profiles)
const SUPABASE_BUSY_URL = 'https://jlkjjqnmhsgefpluemyz.supabase.co' // Busy-data project (purchase_*)
const HQ_URL = 'https://hq.jcmretails.com'
const PAGE_URL = `${HQ_URL}/#purchases`

const TAB_ID = 'purchases'
const MAX_BILLS = 300
const MAX_INSTANT_PER_CALL = 8   // the rest wait for the next run (15 min)
const STALE_HOURS = 48           // bills typed in longer ago than this are never sent one by one

const opts = { auth: { autoRefreshToken: false, persistSession: false } }

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json(body)
}
function check({ data, error }, what) {
  if (error) { const e = new Error(`${what}: ${error.message}`); e.db = true; throw e }
  return data
}

// ---------- dates (IST) ----------
const IST_MS = 5.5 * 3600 * 1000
const todayIST = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10)
const nowHHMM = () => new Date(Date.now() + IST_MS).toISOString().slice(11, 16)
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
function nextDay(d) {
  const t = new Date(`${d}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + 1)
  return t.toISOString().slice(0, 10)
}
const startIST = d => `${d}T00:00:00+05:30`
function niceDate(s) {
  if (!s) return ''
  const d = new Date(String(s).length === 10 ? `${s}T00:00:00+05:30` : s)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}
function niceTime(s) {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
}
const rupees = n => {
  const v = Math.round(Number(n || 0) * 100) / 100
  const paise = !Number.isInteger(v)
  return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: paise ? 2 : 0, maximumFractionDigits: 2 })
}
const qtyText = q => { const n = Number(q || 0); return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000) }

// ---------- handler ----------
export default async function handler(req, res) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const busyServiceRoleKey = process.env.SUPABASE_BUSY_SERVICE_ROLE_KEY
  if (!serviceRoleKey || !busyServiceRoleKey) {
    console.error('purchases is missing env vars', { hq: !!serviceRoleKey, busy: !!busyServiceRoleKey })
    return send(res, 500, { error: 'Purchase Summary is not configured yet.' })
  }
  const hq = createClient(SUPABASE_URL, serviceRoleKey, opts)
  const busy = createClient(SUPABASE_BUSY_URL, busyServiceRoleKey, opts)

  const body = req.body || {}
  const action = String(body.action || '')
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return send(res, 401, { error: 'Please sign in again.' })

  try {
    // ---- The JCM-Server sync script. It holds the Busy project's service key; only
    // that key can read purchase_settings (RLS on, no policies), so a successful read
    // with the key it sent proves who it is. Works for old and new key formats.
    if (action === 'notify') {
      if (!(await isBusyServiceKey(token))) return send(res, 401, { error: 'Not allowed.' })
      const result = await runNotify(busy, hq)
      return send(res, 200, { ok: true, ...result })
    }

    const { data: userData, error: userErr } = await hq.auth.getUser(token)
    if (userErr || !userData?.user) return send(res, 401, { error: 'Please sign in again.' })
    const profile = check(await hq.from('profiles')
      .select('id, name, email, role, is_admin, active, allowed_tabs, whatsapp')
      .eq('id', userData.user.id).maybeSingle(), 'profile')
    if (!profile || profile.active === false) return send(res, 403, { error: 'Your account is not active.' })
    const isAdmin = profile.is_admin === true || profile.role === 'admin'
    const me = { id: profile.id, name: profile.name || profile.email || 'Someone', whatsapp: profile.whatsapp, isAdmin }

    // Email Purchase Summary (api/_email-purchases.js) shares this function; its own page id.
    if (action.startsWith('email-')) {
      const ok = isAdmin || (Array.isArray(profile.allowed_tabs) && profile.allowed_tabs.includes(emailTabId()))
      if (!ok) return send(res, 403, { error: 'You do not have access to Email Purchase Summary.' })
      try {
        return await handleEmailAction(action, body, { busy, hq, me, send, res })
      } catch (err) {
        if (err?.status) return send(res, err.status, { error: err.message })
        throw err
      }
    }

    // Signify Cash Discount (api/_cash-discount.js) shares this function; admins only.
    if (action.startsWith('cd-')) {
      if (!isAdmin) return send(res, 403, { error: 'Only admins can open Signify Cash Discount.' })
      try {
        return await handleCdAction(action, body, { busy, hq, me, send, res })
      } catch (err) {
        if (err?.status) return send(res, err.status, { error: err.message })
        throw err
      }
    }

    // Cash Drawer (api/_cash-drawer.js) shares this function; its own page id.
    if (action.startsWith('cash-')) {
      const ok = isAdmin || (Array.isArray(profile.allowed_tabs) && profile.allowed_tabs.includes(cashTabId()))
      if (!ok) return send(res, 403, { error: 'You do not have access to the Cash Drawer.' })
      try {
        return await handleCashAction(action, body, { busy, hq, me, send, res })
      } catch (err) {
        if (err?.status) return send(res, err.status, { error: err.message })
        throw err
      }
    }

    const granted = Array.isArray(profile.allowed_tabs) && profile.allowed_tabs.includes(TAB_ID)
    if (!isAdmin && !granted) return send(res, 403, { error: 'You do not have access to Purchase Summary.' })

    if (action === 'count') return await handleCount(busy, res)
    if (action === 'list') return await handleList(busy, hq, body, res)
    if (action === 'people') return await handlePeople(busy, hq, res)
    if (action === 'people-save') return await handlePeopleSave(busy, hq, body, me, res)
    if (action === 'settings-save') return await handleSettingsSave(busy, body, res)
    if (action === 'send-bill') return await handleSendBill(busy, hq, body, res)
    if (action === 'test') return await handleTest(busy, hq, me, res)
    if (action === 'pdf') return await handlePdf(busy, hq, body, res)
    return send(res, 400, { error: 'Unknown request.' })
  } catch (err) {
    console.error('purchases handler error:', err)
    const setup = /purchase_\w+|email_\w+|cd_\w+|cash_\w+/.test(err?.message || '') && /does not exist|schema cache/.test(err?.message || '')
    return send(res, 500, { error: setup ? 'Run the purchases / email-purchases / cash-discount setup SQL in the Busy Supabase project first.' : 'Something went wrong. Try again.' })
  }
}

async function isBusyServiceKey(key) {
  try {
    const c = createClient(SUPABASE_BUSY_URL, key, opts)
    const { data, error } = await c.from('purchase_settings').select('id').eq('id', 1)
    return !error && Array.isArray(data) && data.length === 1
  } catch {
    return false
  }
}

// ---------- names for Busy logins ----------
// Manage Users (profiles.busy_login) first, then busy_user_names (logins with no HQ account).
async function loginNames(busy, hq) {
  const [staff, extra] = await Promise.all([
    hq.from('profiles').select('*').eq('active', true),
    busy.from('busy_user_names').select('busy_user, display_name'),
  ])
  const map = {}
  for (const n of extra.data || []) if (n.busy_user && n.display_name) map[String(n.busy_user).trim().toLowerCase()] = n.display_name
  for (const p of staff.data || []) if (p.busy_login && p.name) map[String(p.busy_login).trim().toLowerCase()] = p.name
  return map
}
const whoName = (login, names) => (login ? names[String(login).trim().toLowerCase()] || login : '')

// ---------- page ----------
async function handleCount(busy, res) {
  const t = todayIST()
  const { count, error } = await busy.from('purchase_vouchers').select('vch_key', { count: 'exact', head: true })
    .is('deleted_at', null).gte('entered_at', startIST(t)).lt('entered_at', startIST(nextDay(t)))
  if (error) throw error
  return send(res, 200, { today: count || 0 })
}

async function linesFor(busy, keys) {
  const out = []
  for (let i = 0; i < keys.length; i += 100) {
    const part = check(await busy.from('purchase_lines').select('*').in('vch_key', keys.slice(i, i + 100))
      .order('vch_key').order('sr_no').limit(10000), 'lines')
    out.push(...part)
  }
  const by = {}
  for (const l of out) (by[l.vch_key] ||= []).push(l)
  return by
}

async function handleList(busy, hq, body, res) {
  const today = todayIST()
  const from = isDate(body.from) ? body.from : today
  const to = isDate(body.to) && body.to >= from ? body.to : from
  const by = body.by === 'bill' ? 'bill' : 'entered'
  const q = String(body.q || '').trim().slice(0, 80)

  let query = busy.from('purchase_vouchers').select('*')
  if (by === 'bill') query = query.gte('bill_date', from).lte('bill_date', to)
  else query = query.gte('entered_at', startIST(from)).lt('entered_at', startIST(nextDay(to)))

  if (q) {
    const like = `%${q.replace(/[%_,()]/g, ' ')}%`
    const hits = check(await busy.from('purchase_lines').select('vch_key').ilike('item_name', like).limit(1000), 'search')
    const keys = [...new Set(hits.map(h => h.vch_key))].slice(0, 300)
    const parts = [`party_name.ilike.${like}`, `vch_no.ilike.${like}`]
    if (keys.length) parts.push(`vch_key.in.(${keys.map(k => `"${k.replace(/"/g, '')}"`).join(',')})`)
    query = query.or(parts.join(','))
  }

  query = by === 'bill'
    ? query.order('bill_date', { ascending: false }).order('entered_at', { ascending: false, nullsFirst: false })
    : query.order('entered_at', { ascending: false, nullsFirst: false })
  const vouchers = check(await query.limit(MAX_BILLS + 1), 'list')
  const more = vouchers.length > MAX_BILLS
  if (more) vouchers.length = MAX_BILLS

  const [lines, names, settings] = await Promise.all([
    linesFor(busy, vouchers.map(v => v.vch_key)),
    loginNames(busy, hq),
    busy.from('purchase_settings').select('last_sync_at, last_sync_note').eq('id', 1).maybeSingle(),
  ])

  const bills = vouchers.map(v => ({
    ...v,
    entered_by_name: whoName(v.entered_by, names),
    last_edited_by_name: whoName(v.last_edited_by, names),
    lines: lines[v.vch_key] || [],
  }))
  const live = bills.filter(b => !b.deleted_at)
  const totals = {
    bills: live.length,
    parties: new Set(live.map(b => b.party_name || b.party_code)).size,
    items: live.reduce((s, b) => s + (b.item_count || 0), 0),
    qty: live.reduce((s, b) => s + Number(b.total_qty || 0), 0),
    value: live.reduce((s, b) => s + Number(b.bill_total || 0), 0),
  }
  return send(res, 200, {
    from, to, by, bills, totals, more,
    lastSyncAt: settings.data?.last_sync_at || null,
  })
}

async function handlePeople(busy, hq, res) {
  const [profiles, people, settings] = await Promise.all([
    hq.from('profiles').select('id, name, email, whatsapp, active, is_admin, role').eq('active', true).order('name'),
    busy.from('purchase_notify_people').select('*'),
    busy.from('purchase_settings').select('*').eq('id', 1).maybeSingle(),
  ])
  if (profiles.error) throw profiles.error
  if (people.error) throw people.error
  const chosen = new Map((people.data || []).map(p => [p.hq_user_id, p]))
  const users = (profiles.data || []).map(p => ({
    id: p.id,
    name: p.name || p.email || 'Unnamed',
    whatsapp: p.whatsapp || '',
    admin: p.is_admin === true || p.role === 'admin',
    instant: chosen.get(p.id)?.instant === true,
    daily: chosen.get(p.id)?.daily === true,
  }))
  return send(res, 200, {
    users,
    settings: settings.data || { instant_on: true, daily_on: true, summary_time: '19:30' },
    whatsappReady: waConfigured(),
  })
}

async function handlePeopleSave(busy, hq, body, me, res) {
  const id = String(body.hq_user_id || '')
  if (!/^[0-9a-f-]{36}$/i.test(id)) return send(res, 400, { error: 'Pick a person.' })
  const p = check(await hq.from('profiles').select('id').eq('id', id).maybeSingle(), 'profile')
  if (!p) return send(res, 400, { error: 'That person was not found.' })
  const instant = body.instant === true
  const daily = body.daily === true
  if (!instant && !daily) {
    check(await busy.from('purchase_notify_people').delete().eq('hq_user_id', id), 'remove person')
  } else {
    check(await busy.from('purchase_notify_people').upsert({ hq_user_id: id, instant, daily, added_by: me.name }, { onConflict: 'hq_user_id' }), 'save person')
  }
  return send(res, 200, { ok: true })
}

async function handleSettingsSave(busy, body, res) {
  const patch = {}
  if (typeof body.instant_on === 'boolean') patch.instant_on = body.instant_on
  if (typeof body.daily_on === 'boolean') patch.daily_on = body.daily_on
  if (body.summary_time !== undefined) {
    const t = String(body.summary_time)
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return send(res, 400, { error: 'Time should look like 19:30.' })
    patch.summary_time = t
  }
  if (!Object.keys(patch).length) return send(res, 400, { error: 'Nothing to save.' })
  // Switching "every bill" off: anything still waiting is dropped, so turning it
  // back on later does not send a pile of old bills at once.
  if (patch.instant_on === false) {
    check(await busy.from('purchase_vouchers').update({ notify_state: 'skipped' }).eq('notify_state', 'pending'), 'skip waiting')
  }
  check(await busy.from('purchase_settings').upsert({ id: 1, ...patch }, { onConflict: 'id' }), 'save settings')
  return send(res, 200, { ok: true })
}

// ---------- WhatsApp ----------
function cleanPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '')
  return /^[6-9]\d{9}$/.test(d) ? d : null
}

// Meta templates (staff): a value can't hold a line break, so lists are flattened.
//   staff_purchase_pdf      (2026-10-13, Shishir: "replace the text with a PDF") DOCUMENT header = the
//                           bill PDF (api/_purchase-pdf.js); {{1}} party, {{2}} bill no, {{3}} bill total,
//                           {{4}} entered by + time.   Button → Purchase Summary page.
//   staff_purchase_bill     the old text version — used only while staff_purchase_pdf is not approved yet
//                           (Meta answers 132001 "template does not exist").
//   staff_purchase_summary  {{1}} date, {{2}} bills, {{3}} item lines, {{4}} total, {{5}} parties (flat).
const PDF_BUCKETS = ['wa-docs', 'gst-reports']
const PDF_LINK_SECONDS = 7 * 24 * 3600

// Make the bill PDF, keep it in Storage and return a link Meta (and the page) can open.
async function billPdfLink(busy, v, lines, names) {
  const pdf = await buildPurchasePdf(v, lines, whoName(v.entered_by, names))
  const filename = purchaseFileName(v)
  const path = `purchases/${String(v.vch_key).replace(/[^A-Za-z0-9]+/g, '-')}-${Date.now()}.pdf`
  for (const bucket of PDF_BUCKETS) {
    const up = await busy.storage.from(bucket).upload(path, pdf, { contentType: 'application/pdf', upsert: true })
    if (up.error) continue
    const signed = await busy.storage.from(bucket).createSignedUrl(path, PDF_LINK_SECONDS)
    if (!signed.error && signed.data?.signedUrl) return { url: signed.data.signedUrl, filename }
  }
  throw new Error('Could not store the purchase PDF (Storage bucket wa-docs / gst-reports).')
}

export function billMessage(v, lines, names, pdf = null) {
  const who = whoName(v.entered_by, names)
  const first = lines.slice(0, 4).map(l => `${l.item_name || 'Item'} ${qtyText(l.qty)} × ${rupees(l.rate)}`).join('; ')
  const items = `${lines.length}: ${first}${lines.length > 4 ? ` and ${lines.length - 4} more` : ''}`
  const byLine = `${who || 'someone'} at ${niceTime(v.entered_at)}, ${niceDate(v.entered_at)}`
  const old = {
    kind: 'staff_purchase', template: 'staff_purchase_bill', opts: { headerImageUrl: BANNER('staff-purchase') },
    params: [v.party_name || 'Party', v.vch_no || '—', waDate(v.bill_date), items, inr(v.bill_total), byLine],
  }
  if (!pdf) return old
  return {
    kind: 'staff_purchase', template: 'staff_purchase_pdf',
    opts: { headerDocumentUrl: pdf.url, headerDocumentName: pdf.filename },
    params: [v.party_name || 'Party', v.vch_no || '—', inr(v.bill_total), byLine],
    fallback: old,
  }
}

// PDF version when it can be made; the old text message if Storage fails.
async function billMessageWithPdf(busy, v, lines, names) {
  try {
    return billMessage(v, lines, names, await billPdfLink(busy, v, lines, names))
  } catch (err) {
    console.error('purchase PDF failed, sending the text version:', err)
    return billMessage(v, lines, names)
  }
}

export function summaryMessage(day, bills) {
  const total = bills.reduce((s, b) => s + Number(b.bill_total || 0), 0)
  const items = bills.reduce((s, b) => s + (b.item_count || 0), 0)
  const list = bills.slice(0, 8).map(b => `${b.party_name || 'Party'} ${rupees(b.bill_total)}`).join('; ') + (bills.length > 8 ? ` and ${bills.length - 8} more` : '')
  return {
    kind: 'staff_purchase_summary', template: 'staff_purchase_summary', opts: { headerImageUrl: BANNER('staff-purchase') },
    params: [waDate(day), String(bills.length), String(items), inr(total), list || 'none'],
  }
}

async function recipients(busy, hq, kind) {
  const people = check(await busy.from('purchase_notify_people').select('*').eq(kind, true), 'recipients')
  if (!people.length) return []
  const profiles = check(await hq.from('profiles').select('id, name, email, whatsapp, active').in('id', people.map(p => p.hq_user_id)), 'recipient profiles')
  return profiles.filter(p => p.active !== false).map(p => ({ id: p.id, name: p.name || p.email || '', mobile: p.whatsapp || '' }))
}

// Each bill also goes to the people its maker reports to (Manage Users →
// "Reports to"), matched through the Busy login that entered it. Added to the
// "Every bill" list, never instead of it; each person gets it once.
async function managersByLogin(hq) {
  const { data, error } = await hq.from('profiles').select('*').eq('active', true)
  if (error) { console.error('purchases: reports_to read failed:', error); return new Map() }
  const byId = new Map((data || []).map(p => [p.id, p]))
  const out = new Map()
  for (const p of data || []) {
    if (!p.busy_login || !Array.isArray(p.reports_to) || !p.reports_to.length) continue
    const bosses = p.reports_to.map(id => byId.get(id)).filter(Boolean)
      .map(b => ({ id: b.id, name: b.name || b.email || '', mobile: b.whatsapp || '' }))
    if (bosses.length) out.set(String(p.busy_login).trim().toLowerCase(), bosses)
  }
  return out
}
function forBill(base, managers, v) {
  const extra = managers.get(String(v.entered_by || '').trim().toLowerCase()) || []
  const seen = new Set(base.map(p => p.id))
  return [...base, ...extra.filter(p => !seen.has(p.id) && seen.add(p.id))]
}

// Meta's answer when a template name is not on the account (or not approved yet).
const MISSING_TEMPLATE = /132001|does not exist|template name/i

async function sendToAll(busy, people, msg, logBase) {
  const switches = await waSwitches(busy)
  const one = (p, m) => sendLogged(busy, { kind: m.kind, to: p.mobile, template: m.template, params: m.params,
    opts: m.opts || {}, ref: logBase.vch_key || logBase.summary_date || null, refName: p.name, by: 'HQ', switches })
  const results = await Promise.all(people.map(async p => {
    let r = await one(p, msg)
    // New PDF template not approved yet → send the old text message instead, so nobody misses a bill.
    if (r.status === 'failed' && msg.fallback && MISSING_TEMPLATE.test(r.error || '')) r = await one(p, msg.fallback)
    const status = r.status === 'off' ? 'not_set_up' : r.status
    return { ...logBase, hq_user_id: p.id, name: p.name, mobile: cleanPhone(p.mobile), status }
  }))
  if (results.length) {
    const { error } = await busy.from('purchase_notify_log').insert(results)
    if (error) console.error('purchase_notify_log insert failed:', error)
  }
  return results
}
const overall = results =>
  !results.length ? 'no_recipients'
    : results.some(r => r.status === 'sent') ? 'sent'
      : results.every(r => r.status === 'not_set_up') ? 'not_set_up'
        : 'failed'

async function runNotify(busy, hq) {
  const settings = check(await busy.from('purchase_settings').select('*').eq('id', 1).maybeSingle(), 'settings') || {}
  const out = { instant: 0, skipped: 0, daily: null }

  // ---- one message per new bill
  // Bills typed in long ago (a first load, or the server PC off for days) are
  // dropped in one go, never sent one by one.
  const staleIso = new Date(Date.now() - STALE_HOURS * 3600 * 1000).toISOString()
  const dropped = check(await busy.from('purchase_vouchers').update({ notify_state: 'skipped' })
    .eq('notify_state', 'pending').lt('entered_at', staleIso).select('vch_key'), 'skip old')
  out.skipped += dropped.length
  const pending = check(await busy.from('purchase_vouchers').select('*').eq('notify_state', 'pending')
    .order('entered_at', { ascending: true, nullsFirst: false }).limit(50), 'pending bills')
  if (pending.length) {
    const staleBefore = Date.now() - STALE_HOURS * 3600 * 1000
    const tooOld = pending.filter(v => settings.instant_on === false || v.deleted_at ||
      (v.entered_at && new Date(v.entered_at).getTime() < staleBefore))
    if (tooOld.length) {
      check(await busy.from('purchase_vouchers').update({ notify_state: 'skipped' }).in('vch_key', tooOld.map(v => v.vch_key)), 'skip old')
      out.skipped += tooOld.length
    }
    const due = pending.filter(v => !tooOld.includes(v)).slice(0, MAX_INSTANT_PER_CALL)
    if (due.length) {
      const [people, names, lines, managers] = await Promise.all([recipients(busy, hq, 'instant'), loginNames(busy, hq), linesFor(busy, due.map(v => v.vch_key)), managersByLogin(hq)])
      for (const v of due) {
        // Claim it first, so two runs at once can never send the same bill twice.
        const claimed = check(await busy.from('purchase_vouchers').update({ notify_state: 'sending' })
          .eq('vch_key', v.vch_key).eq('notify_state', 'pending').select('vch_key'), 'claim')
        if (!claimed.length) continue
        const msg = await billMessageWithPdf(busy, v, lines[v.vch_key] || [], names)
        const results = await sendToAll(busy, forBill(people, managers, v), msg, { kind: 'instant', vch_key: v.vch_key })
        check(await busy.from('purchase_vouchers').update({ notify_state: overall(results), notified_at: new Date().toISOString() })
          .eq('vch_key', v.vch_key), 'mark sent')
        out.instant++
      }
    }
  }

  // ---- the evening summary, once a day
  const today = todayIST()
  const time = /^\d{2}:\d{2}$/.test(settings.summary_time || '') ? settings.summary_time : '19:30'
  if (settings.daily_on !== false && nowHHMM() >= time && (!settings.last_summary_date || settings.last_summary_date < today)) {
    const claimed = check(await busy.from('purchase_settings').update({ last_summary_date: today }).eq('id', 1)
      .or(`last_summary_date.is.null,last_summary_date.lt.${today}`).select('id'), 'claim summary')
    if (claimed.length) {
      const bills = check(await busy.from('purchase_vouchers').select('*').is('deleted_at', null)
        .gte('entered_at', startIST(today)).lt('entered_at', startIST(nextDay(today)))
        .order('entered_at', { ascending: true }), 'today bills')
      if (!bills.length) {
        out.daily = 'no bills today'
      } else {
        const people = await recipients(busy, hq, 'daily')
        const results = await sendToAll(busy, people, summaryMessage(today, bills), { kind: 'daily', summary_date: today })
        out.daily = overall(results)
      }
    }
  }
  return out
}

async function handleSendBill(busy, hq, body, res) {
  const key = String(body.vch_key || '')
  const v = check(await busy.from('purchase_vouchers').select('*').eq('vch_key', key).maybeSingle(), 'bill')
  if (!v) return send(res, 404, { error: 'Bill not found.' })
  const [base, names, lines, managers] = await Promise.all([recipients(busy, hq, 'instant'), loginNames(busy, hq), linesFor(busy, [key]), managersByLogin(hq)])
  const people = forBill(base, managers, v)
  if (!people.length) return send(res, 400, { error: 'Nobody gets this bill: tick someone for "Every bill", or set "Reports to" for whoever entered it in Manage Users.' })
  const msg = await billMessageWithPdf(busy, v, lines[key] || [], names)
  const results = await sendToAll(busy, people, msg, { kind: 'instant', vch_key: key })
  check(await busy.from('purchase_vouchers').update({ notify_state: overall(results), notified_at: new Date().toISOString() }).eq('vch_key', key), 'mark sent')
  return send(res, 200, { ok: true, results: results.map(r => ({ name: r.name, status: r.status })) })
}

// Test: the newest purchase bill, sent only to the person pressing the button.
async function handleTest(busy, hq, me, res) {
  const v = check(await busy.from('purchase_vouchers').select('*').is('deleted_at', null)
    .order('entered_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle(), 'latest bill')
  if (!v) return send(res, 400, { error: 'No purchase bill to test with yet.' })
  const [names, lines] = await Promise.all([loginNames(busy, hq), linesFor(busy, [v.vch_key])])
  const msg = await billMessageWithPdf(busy, v, lines[v.vch_key] || [], names)
  const results = await sendToAll(busy, [{ id: me.id, name: me.name, mobile: me.whatsapp }], msg, { kind: 'test' })
  return send(res, 200, { status: results[0]?.status || 'failed' })
}

// The page's "PDF" button on a bill: the same PDF as the WhatsApp, shown in HQ's in-app viewer.
async function handlePdf(busy, hq, body, res) {
  const key = String(body.vch_key || '')
  const v = check(await busy.from('purchase_vouchers').select('*').eq('vch_key', key).maybeSingle(), 'bill')
  if (!v) return send(res, 404, { error: 'Bill not found.' })
  const [names, lines] = await Promise.all([loginNames(busy, hq), linesFor(busy, [key])])
  const pdf = await buildPurchasePdf(v, lines[key] || [], whoName(v.entered_by, names))
  return send(res, 200, { base64: pdf.toString('base64'), filename: purchaseFileName(v) })
}
