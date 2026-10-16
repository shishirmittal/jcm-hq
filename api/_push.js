// Phone pop-up notifications for the JCM HQ app (Firebase Cloud Messaging), 2026-10-16.
//
// How it works:
//   1. The app (src/push.js) asks the person once for permission and saves its phone token in
//      push_tokens (CRM project) through api/sync-status.js action 'push-register'.
//   2. Database triggers put things to announce into push_queue — CRM project: tasks, orders,
//      dispatch without LR; Busy project: incoming WhatsApp, red alerts, red-alert replies
//      (supabase/push-setup-crm.sql, supabase/push-setup-busy.sql).
//   3. Each insert pings POST /api/sync-status {action:'push-drain'} (pg_net), and the WhatsApp tick
//      (every 5 min) drains too in case a ping was lost. drainPush() works out who should hear
//      about each row, merges several of the same kind for one person ("5 new red alerts"), and
//      sends through FCM HTTP v1 with the service account in Vercel env FIREBASE_SERVICE_ACCOUNT.
//   Rows older than 30 min that were never sent are dropped (stale news is noise).
//
// A tap on the pop-up opens the page in data.hash (src/push.js).
import crypto from 'node:crypto'
import { readTabletStaff, jobsOf } from './_orders/lib/staff.js'

const MAX_AGE_MIN = 30
const CHANNEL = 'hq'
const GOLD = '#D9AE55'

let cachedToken = null // { token, until, project }

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) return null
  try {
    const sa = JSON.parse(raw)
    if (!sa.client_email || !sa.private_key || !sa.project_id) return null
    sa.private_key = String(sa.private_key).replace(/\\n/g, '\n')
    return sa
  } catch { return null }
}

export const pushReady = () => !!serviceAccount()

const b64url = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

async function accessToken() {
  if (cachedToken && cachedToken.until > Date.now() + 60_000) return cachedToken
  const sa = serviceAccount()
  if (!sa) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set in Vercel')
  const now = Math.floor(Date.now() / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64url(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }))
  const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claim}`), sa.private_key))
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.access_token) throw new Error(`Google sign-in for Firebase failed: ${j.error_description || j.error || r.status}`)
  cachedToken = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000, project: sa.project_id }
  return cachedToken
}

const cut = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }

// Send one notification to every phone of the given people. Returns { phones, sent, failed }.
export async function sendToPeople(hq, profileIds, note) {
  const ids = [...new Set((profileIds || []).filter(Boolean))]
  if (!ids.length) return { phones: 0, sent: 0, failed: 0 }
  const { data: rows, error } = await hq.from('push_tokens').select('token, profile_id').in('profile_id', ids)
  if (error) throw error
  if (!rows?.length) return { phones: 0, sent: 0, failed: 0 }
  const { token, project } = await accessToken()
  let sent = 0, failed = 0
  const dead = [], ok = [], errs = []
  await Promise.all(rows.map(async row => {
    const message = {
      token: row.token,
      notification: { title: cut(note.title, 80), body: cut(note.body, 240) },
      data: { hash: String(note.hash || ''), kind: String(note.kind || '') },
      android: {
        priority: 'HIGH',
        ttl: '3600s',
        notification: {
          channel_id: CHANNEL, color: GOLD, icon: 'ic_stat_jcm',
          ...(note.tag ? { tag: String(note.tag).slice(0, 60) } : {}),
          default_sound: true,
        },
      },
    }
    try {
      const r = await fetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
      if (r.ok) { sent++; ok.push(row.token); return }
      failed++
      const j = await r.json().catch(() => ({}))
      const code = j?.error?.details?.find?.(d => d.errorCode)?.errorCode || j?.error?.status || String(r.status)
      // The app was uninstalled / the token was replaced: forget this phone.
      if (code === 'UNREGISTERED' || code === 'NOT_FOUND' || (code === 'INVALID_ARGUMENT' && /token/i.test(j?.error?.message || ''))) dead.push(row.token)
      else errs.push({ token: row.token, err: `${code}: ${cut(j?.error?.message, 120)}` })
    } catch (e) { failed++; errs.push({ token: row.token, err: cut(e.message, 120) }) }
  }))
  const at = new Date().toISOString()
  if (dead.length) await hq.from('push_tokens').delete().in('token', dead)
  if (ok.length) await hq.from('push_tokens').update({ last_sent_at: at, last_error: null }).in('token', ok)
  for (const e of errs) await hq.from('push_tokens').update({ last_error: e.err }).eq('token', e.token)
  return { phones: rows.length, sent, failed }
}

// ── Who hears about what ────────────────────────────────────────────────────────────────────

const isAdmin = p => p.is_admin === true || p.role === 'admin'
const canSee = (p, tab) => isAdmin(p) || (Array.isArray(p.allowed_tabs) && p.allowed_tabs.includes(tab))
const nameOf = p => (p && (p.name || (p.email || '').split('@')[0])) || 'Someone'

const ORDER_STAGE = {
  new: { job: 'pick', title: '📦 New order to pick', many: n => `📦 ${n} new orders to pick` },
  invoiced: { job: 'check', title: '🧾 Order invoiced — check against the bill', many: n => `🧾 ${n} orders invoiced — check against the bills` },
  checked: { job: 'ready', title: '📦 Order checked — pack and set boxes', many: n => `📦 ${n} orders checked — pack and set boxes` },
  in_bay: { job: 'dispatch', title: '🚚 Ready to dispatch — attach LR photo', many: n => `🚚 ${n} orders ready to dispatch — attach LR photos` },
}

const TASK_TITLE = {
  filed: a => `📝 New task from ${a}`,
  passed: a => `📝 ${a} passed you a task`,
  sent_back: a => `↩️ ${a} sent a task back to you`,
}

const WA_KIND = { image: '📷 Photo', document: '📄 Document', audio: '🎤 Voice note', video: '🎬 Video', location: '📍 Location', sticker: 'Sticker', contacts: '👤 Contact' }

// Turn queue rows into [{ to: [profile ids], group, note }].
async function plan({ hq, busy }, crmRows, busyRows, people) {
  const out = []
  const active = people.filter(p => p.active !== false)
  const byId = new Map(active.map(p => [p.id, p]))

  // Tasks
  const taskRows = crmRows.filter(r => r.kind === 'task')
  if (taskRows.length) {
    const { data: tasks } = await hq.from('team_tasks').select('id, task_type, body, status, due_date').in('id', taskRows.map(r => r.ref))
    const tmap = new Map((tasks || []).map(t => [t.id, t]))
    for (const r of taskRows) {
      const t = tmap.get(r.ref), to = r.data?.to
      if (!t || t.status === 'done' || !byId.has(to)) continue
      const actor = nameOf(people.find(p => p.id === r.data?.actor))
      const followup = t.task_type === 'payment_followup'
      out.push({
        to: [to], group: followup ? 'followup' : 'task',
        note: {
          kind: 'task',
          title: followup ? '📞 Today\'s payment follow-ups' : (TASK_TITLE[r.data?.action] || TASK_TITLE.filed)(actor),
          body: cut(t.body, 200) + (t.due_date && !followup ? ` · due ${t.due_date.split('-').reverse().slice(0, 2).join('/')}` : ''),
          hash: followup ? '#followups' : '#tasks', tag: `task-${t.id}`,
        },
        short: cut(t.body, 50),
        many: n => (followup ? '📞 Payment follow-ups' : `📝 ${n} tasks for you`),
      })
    }
  }

  // Orders
  const orderRows = crmRows.filter(r => r.kind === 'order' || r.kind === 'order_no_lr')
  if (orderRows.length) {
    const { data: orders } = await hq.from('orders').select('id, so_vch_no, party_name, party_city, line_count, stage, closed_at').in('id', [...new Set(orderRows.map(r => r.ref))])
    const omap = new Map((orders || []).map(o => [o.id, o]))
    const cfg = await readTabletStaff(hq)
    const staff = active.filter(p => cfg.staff.includes(p.id) && !isAdmin(p))
    for (const r of orderRows) {
      const o = omap.get(r.ref)
      if (!o) continue
      const who = `${cut(o.party_name, 40)}${o.party_city ? `, ${cut(o.party_city, 20)}` : ''}`
      if (r.kind === 'order_no_lr') {
        const by = nameOf(people.find(p => p.id === r.data?.by))
        out.push({
          to: active.filter(isAdmin).map(p => p.id), group: 'no_lr',
          note: { kind: 'order', title: '⚠️ Dispatched without LR photo', body: `${who} · SO ${o.so_vch_no || ''} · by ${by}`, hash: '#order-log', tag: `nolr-${o.id}` },
          short: cut(o.party_name, 30),
        many: n => `⚠️ ${n} orders dispatched without LR photo`,
        })
        continue
      }
      const st = ORDER_STAGE[r.data?.stage]
      if (!st || o.closed_at || o.stage !== r.data.stage) continue // already moved on
      const to = staff.filter(p => jobsOf(p, cfg).includes(st.job)).map(p => p.id)
      out.push({
        to, group: `order-${r.data.stage}`,
        note: { kind: 'order', title: st.title, body: `${who} · ${o.line_count || 0} items · SO ${o.so_vch_no || ''}`, hash: '#floor-orders', tag: `order-${o.id}` },
        short: cut(o.party_name, 30),
        many: st.many,
      })
    }
  }

  // WhatsApp
  const waRows = busyRows.filter(r => r.kind === 'wa_in')
  if (waRows.length) {
    const ids = waRows.map(r => Number(r.data?.id)).filter(Boolean)
    const { data: msgs } = ids.length ? await busy.from('wa_messages').select('id, number, kind, text, profile_name').in('id', ids) : { data: [] }
    const numbers = [...new Set((msgs || []).map(m => m.number))]
    const { data: convs } = numbers.length ? await busy.from('wa_conversations').select('number, assigned_to').in('number', numbers) : { data: [] }
    const assigned = new Map((convs || []).map(c => [c.number, c.assigned_to]))
    const staffNums = new Map(active.filter(p => p.whatsapp).map(p => [String(p.whatsapp).replace(/\D/g, '').slice(-10), p]))
    const readers = active.filter(p => canSee(p, 'whatsapp')).map(p => p.id)
    for (const m of msgs || []) {
      const staffer = staffNums.get(String(m.number).replace(/\D/g, '').slice(-10))
      const from = staffer ? `${nameOf(staffer)} (staff)` : (m.profile_name || `+${m.number}`)
      const text = m.kind === 'text' ? m.text : `${WA_KIND[m.kind] || 'Message'}${m.text ? ` · ${m.text}` : ''}`
      const to = new Set(readers)
      const a = assigned.get(m.number)
      if (a && byId.has(a)) to.add(a)
      out.push({
        to: [...to], group: `wa-${m.number}`,
        note: { kind: 'wa', title: `💬 ${cut(from, 50)}`, body: cut(text, 200), hash: `#whatsapp/inbox/${m.number}`, tag: `wa-${m.number}` },
        many: n => `💬 ${cut(from, 40)} · ${n} new messages`,
      })
    }
  }

  // Red alerts
  const raNew = busyRows.filter(r => r.kind === 'red_alert')
  const raReply = busyRows.filter(r => r.kind === 'red_alert_reply')
  if (raNew.length || raReply.length) {
    const ids = [...raNew, ...raReply].map(r => Number(r.ref)).filter(Boolean)
    const { data: alerts } = await busy.from('red_alerts').select('id, title, subtitle, busy_user, status, asked_by, asked_name, reply').in('id', ids)
    const amap = new Map((alerts || []).map(a => [String(a.id), a]))
    const watchers = active.filter(p => canSee(p, 'red-alerts')).map(p => p.id)
    for (const r of raNew) {
      const a = amap.get(r.ref)
      if (!a || a.status !== 'new') continue
      out.push({
        to: watchers, group: 'red_alert',
        note: { kind: 'red', title: `🚨 Red alert: ${cut(a.title, 60)}`, body: cut([a.subtitle, a.busy_user && `by ${a.busy_user}`].filter(Boolean).join(' · '), 200), hash: '#red-alerts', tag: 'red-alerts' },
        short: cut(a.title, 40),
        many: n => `🚨 ${n} new red alerts`,
      })
    }
    for (const r of raReply) {
      const a = amap.get(r.ref)
      if (!a) continue
      const asker = active.find(p => a.asked_by && (p.name === a.asked_by || p.email === a.asked_by))
      out.push({
        to: asker ? [asker.id] : watchers, group: 'red_reply',
        note: { kind: 'red', title: `✍️ ${cut(a.asked_name || 'Staff', 40)} explained a red alert`, body: cut(`${a.title}: ${a.reply}`, 220), hash: '#red-alerts', tag: `ra-reply-${a.id}` },
        many: n => `✍️ ${n} red-alert explanations`,
      })
    }
  }
  return out
}

// Claim pending rows of one project (each row is claimed by exactly one drain).
async function claim(db) {
  const old = new Date(Date.now() - MAX_AGE_MIN * 60_000).toISOString()
  await db.from('push_queue').update({ status: 'expired' }).eq('status', 'pending').lt('created_at', old)
  const { data: pend, error } = await db.from('push_queue').select('id').eq('status', 'pending').order('id').limit(300)
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return []
    throw error
  }
  if (!pend?.length) return []
  const { data, error: e2 } = await db.from('push_queue').update({ status: 'sending' })
    .in('id', pend.map(r => r.id)).eq('status', 'pending').select('id, kind, ref, data, created_at')
  if (e2) throw e2
  return data || []
}

async function finish(db, rows, result) {
  if (!rows.length) return
  await db.from('push_queue').update({ status: 'sent', sent_at: new Date().toISOString(), result: cut(result, 300) }).in('id', rows.map(r => r.id))
}

// Send everything waiting in both projects. Safe to call often and from anywhere.
export async function drainPush({ hq, busy }) {
  if (!pushReady()) return { ok: false, reason: 'FIREBASE_SERVICE_ACCOUNT not set' }
  const [crmRows, busyRows] = await Promise.all([claim(hq), busy ? claim(busy) : []])
  if (!crmRows.length && !busyRows.length) return { ok: true, rows: 0 }
  let summary = ''
  try {
    const { data: people } = await hq.from('profiles').select('id, name, email, role, is_admin, active, allowed_tabs, whatsapp')
    const items = await plan({ hq, busy }, crmRows, busyRows, people || [])
    // Merge per person + group: one pop-up says "3 new orders to pick" instead of three.
    const per = new Map()
    for (const it of items) for (const pid of it.to) {
      const k = `${pid}|${it.group}`
      if (!per.has(k)) per.set(k, { pid, list: [] })
      per.get(k).list.push(it)
    }
    // Same text to many people → one call per distinct note.
    const notes = new Map()
    for (const { pid, list } of per.values()) {
      const first = list[list.length - 1]
      const note = list.length === 1 ? first.note
        : { ...first.note, title: first.many(list.length), body: list.slice(-3).map(i => i.short || i.note.body).filter(Boolean).reverse().join(' • ') + (list.length > 3 ? ' …' : ''), tag: first.note.tag?.startsWith('wa-') ? first.note.tag : `${first.group}-many` }
      const key = JSON.stringify(note)
      if (!notes.has(key)) notes.set(key, { note, pids: [] })
      notes.get(key).pids.push(pid)
    }
    let phones = 0, sent = 0, failed = 0
    for (const { note, pids } of notes.values()) {
      const r = await sendToPeople(hq, pids, note)
      phones += r.phones; sent += r.sent; failed += r.failed
    }
    summary = `${notes.size} notes · ${sent} sent${failed ? ` · ${failed} failed` : ''} · ${phones} phones`
    return { ok: true, rows: crmRows.length + busyRows.length, notes: notes.size, sent, failed }
  } catch (e) {
    summary = `error: ${e.message}`
    console.error('push drain:', e)
    return { ok: false, error: e.message }
  } finally {
    await Promise.all([finish(hq, crmRows, summary), busy ? finish(busy, busyRows, summary) : null])
  }
}
