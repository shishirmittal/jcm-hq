import { applyCors } from './_cors.js'
import { createClient } from '@supabase/supabase-js'
import { handleTracker } from './_tracker.js'
import { drainPush, sendToPeople, pushReady } from './_push.js'

// Sync status (JCM HQ → Admin → #sync-status) — page src/sync-status.js.
//
// Shows what JCM Sync (busy-sync/jcm-sync.js on JCM-Server) is doing: every job, its
// timetable, last run, ok / failed / late, the last message, recent runs with the
// script's last output lines, and a "Run now" button. Data: sync_jobs and sync_job_runs
// in the JCM-Busysql project (supabase/jcm-sync-setup.sql), closed to the browser.
//
// Access: admins, or anyone given 'sync-status' in Manage Users.
// Also serves the Requests Tracker (actions tracker-*, api/_tracker.js, page id 'tracker').
//
// Also phone pop-up notifications (api/_push.js, src/push.js):
//   push-drain                       no sign-in needed — sends what is waiting in push_queue (pinged by
//                                    the database triggers; reveals nothing, sends only queued rows)
//   push-register { token, device }  this phone belongs to the signed-in person (anyone signed in)
//   push-unregister { token }        forget this phone
//   push-test                        a test pop-up to my own phones
//   push-status                      admins: who has the app with notifications on
//
// Actions (POST JSON):
//   list                    jobs + whether JCM Sync itself is alive
//   runs    { job_id }      last 20 runs of one job
//   run-now { job_id }      ask JCM Sync to start that job (picked up within ~15 s)

const SUPABASE_URL = 'https://cmtnzmfuasniicsdxyle.supabase.co'
const SUPABASE_BUSY_URL = 'https://jlkjjqnmhsgefpluemyz.supabase.co'
const TAB_ID = 'sync-status'

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json(body)
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  const busyKey = process.env.SUPABASE_BUSY_SERVICE_ROLE_KEY
  if (!key || !busyKey) return send(res, 500, { error: 'Sync status is not configured yet.' })

  const opts = { auth: { autoRefreshToken: false, persistSession: false } }
  const hq = createClient(SUPABASE_URL, key, opts)
  const busy = createClient(SUPABASE_BUSY_URL, busyKey, opts)

  if (req.body?.action === 'push-drain') {
    try { const r = await drainPush({ hq, busy }); return send(res, 200, { ok: r.ok !== false, rows: r.rows || 0 }) }
    catch (err) { console.error('push-drain:', err); return send(res, 200, { ok: false }) }
  }

  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return send(res, 401, { error: 'Please sign in again.' })
  const { data: u, error: uErr } = await hq.auth.getUser(token)
  if (uErr || !u?.user) return send(res, 401, { error: 'Please sign in again.' })
  const { data: profile } = await hq.from('profiles')
    .select('id, name, email, role, is_admin, active, allowed_tabs').eq('id', u.user.id).maybeSingle()
  if (!profile || profile.active === false) return send(res, 403, { error: 'Your account is not active.' })
  const isAdmin = profile.is_admin === true || profile.role === 'admin'
  const body = req.body || {}
  // Requests Tracker (api/_tracker.js) shares this function; its own page id 'tracker'.
  if (String(body.action || '').startsWith('tracker-')) {
    if (!isAdmin && !(Array.isArray(profile.allowed_tabs) && profile.allowed_tabs.includes('tracker'))) return send(res, 403, { error: 'You do not have access to the Requests Tracker.' })
    try { return send(res, 200, await handleTracker(body.action, body, { hq, me: { name: profile.name || profile.email || 'Someone' } })) }
    catch (err) { console.error('tracker error:', err); return send(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong. Try again.' }) }
  }
  if (String(body.action || '').startsWith('push-')) {
    try { return send(res, 200, await pushAction(body, { hq, profile, isAdmin })) }
    catch (err) { console.error('push error:', err); return send(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong. Try again.' }) }
  }
  if (!isAdmin && !(Array.isArray(profile.allowed_tabs) && profile.allowed_tabs.includes(TAB_ID))) {
    return send(res, 403, { error: 'You do not have access to Sync status.' })
  }

  try {
    if (body.action === 'list') {
      const r = await busy.from('sync_jobs').select('*').order('sort_order', { ascending: true })
      if (r.error) {
        if (/does not exist|Could not find|schema cache/i.test(r.error.message)) return send(res, 200, { ready: false, jobs: [] })
        throw r.error
      }
      const jobs = r.data || []
      const seen = jobs.reduce((m, j) => (j.runner_seen_at && j.runner_seen_at > m ? j.runner_seen_at : m), '')
      return send(res, 200, { ready: true, jobs, runnerSeenAt: seen || null, now: new Date().toISOString() })
    }
    const jobId = String(body.job_id || '').slice(0, 40)
    if (body.action === 'runs') {
      const r = await busy.from('sync_job_runs').select('*').eq('job_id', jobId).order('started_at', { ascending: false }).limit(20)
      if (r.error) throw r.error
      return send(res, 200, { runs: r.data || [] })
    }
    if (body.action === 'run-now') {
      const r = await busy.from('sync_jobs')
        .update({ run_requested_at: new Date().toISOString(), run_requested_by: profile.name || profile.email || 'HQ' })
        .eq('job_id', jobId).select('job_id')
      if (r.error) throw r.error
      if (!r.data?.length) return send(res, 404, { error: 'Unknown job.' })
      return send(res, 200, { ok: true })
    }
    return send(res, 400, { error: 'Unknown request.' })
  } catch (err) {
    console.error('sync-status error:', err)
    return send(res, 500, { error: 'Something went wrong. Try again.' })
  }
}

async function pushAction(body, { hq, profile, isAdmin }) {
  const token = String(body.token || '').trim().slice(0, 600)
  if (body.action === 'push-register') {
    if (token.length < 20) throw Object.assign(new Error('No phone token.'), { status: 400 })
    // Upsert on the token: a shared phone moves to whoever signed in last.
    const { error } = await hq.from('push_tokens').upsert({
      token, profile_id: profile.id, platform: 'android', device: String(body.device || '').slice(0, 80) || null,
      updated_at: new Date().toISOString(), last_error: null,
    }, { onConflict: 'token' })
    if (error) throw error
    return { ok: true, ready: pushReady() }
  }
  if (body.action === 'push-unregister') {
    if (token) await hq.from('push_tokens').delete().eq('token', token).eq('profile_id', profile.id)
    return { ok: true }
  }
  if (body.action === 'push-test') {
    if (!pushReady()) throw Object.assign(new Error('Firebase is not set up in Vercel yet (FIREBASE_SERVICE_ACCOUNT).'), { status: 400 })
    const r = await sendToPeople(hq, [profile.id], { kind: 'test', title: '🔔 JCM HQ test', body: 'Phone notifications are working on this phone.', hash: '#tasks', tag: 'test' })
    if (!r.phones) throw Object.assign(new Error('This phone is not registered yet. Open the JCM HQ app and allow notifications.'), { status: 400 })
    return { ok: true, ...r }
  }
  if (body.action === 'push-status') {
    if (!isAdmin) throw Object.assign(new Error('Admins only.'), { status: 403 })
    const [{ data: toks }, { data: people }] = await Promise.all([
      hq.from('push_tokens').select('profile_id, device, updated_at, last_sent_at, last_error'),
      hq.from('profiles').select('id, name, email, active').neq('active', false),
    ])
    return {
      ready: pushReady(),
      people: (people || []).map(p => ({ id: p.id, name: p.name || p.email, phones: (toks || []).filter(t => t.profile_id === p.id) })),
    }
  }
  throw Object.assign(new Error('Unknown action.'), { status: 400 })
}
