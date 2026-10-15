// Scheduled reminder lists (2026-10-16, HQ Requests) — Payment Follow-up → WhatsApp reminders → tick parties →
// "⏰ Schedule for later" saves a collection_batches row (Busy project, RLS closed): a name, the date + time,
// repeat (once / daily / weekly / monthly), the ticked parties, the 20 / 40-day tier and "skip anyone
// contacted recently". The Scheduled tab (#payment-followup/scheduled, src/payment-schedules.js) lists them
// as cards with an On / Off switch; a card opens to edit its name, time and parties (tick boxes).
// runBatches (from the WhatsApp tick every 5 min, api/whatsapp.js) sends due lists in chunks of 30 with the
// same rules as "Send now" (api/collections.js planReminder / dispatchReminder). Each party's result is kept
// in results {code: {s, at}} so a list that takes several ticks never sends twice; a repeating list starts
// fresh at its next time.
// The tab also lists the one-customer schedules made from the WhatsApp Inbox (collection_schedules,
// api/_schedules.js) with their own On / Off (status active ↔ paused), change time, stop.
import { reminderContext, planReminder, dispatchReminder } from './collections.js'

const REPEATS = ['none', 'daily', 'weekly', 'monthly']
const CHUNK = 30
const MAX_PARTIES = 400
const LEDGER_ONLY = new Set(['40355', '65494', '56680'])
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
const isTime = s => /^\d{2}:\d{2}$/.test(String(s || ''))
const atIST = (d, t) => new Date(`${d}T${t}:00+05:30`).toISOString()
const bad = msg => Object.assign(new Error(msg), { status: 400 })

export function nextTime(prevIso, repeat) {
  const d = new Date(prevIso)
  if (repeat === 'daily') d.setUTCDate(d.getUTCDate() + 1)
  else if (repeat === 'weekly') d.setUTCDate(d.getUTCDate() + 7)
  else if (repeat === 'monthly') {
    const day = d.getUTCDate()
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1)
    d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()))
  } else return null
  return d.toISOString()
}

const view = b => {
  const res = b.results || {}
  const sent = Object.values(res).filter(r => r.s === 'sent').length
  return {
    id: b.id, title: b.title, send_at: b.send_at, repeat: b.repeat, enabled: b.enabled, status: b.status, tier: b.tier,
    respect_gap: b.respect_gap, parties: b.parties || [], results: res, done: Object.keys(res).length, sent,
    total: (b.parties || []).reduce((s, p) => s + (Number(p.balance) || 0), 0),
    last_counts: b.last_counts, last_run_at: b.last_run_at, created_by_name: b.created_by_name, created_at: b.created_at,
    updated_by: b.updated_by, updated_at: b.updated_at,
  }
}

export async function batchList(busy) {
  const [b, s] = await Promise.all([
    busy.from('collection_batches').select('*').neq('status', 'cancelled').order('send_at', { ascending: true }).limit(200),
    busy.from('collection_schedules').select('*').in('status', ['active', 'paused']).order('next_at', { ascending: true }).limit(200),
  ])
  if (b.error) throw new Error(/does not exist|relation/i.test(b.error.message) ? 'The schedules table is not set up yet.' : b.error.message)
  // Finished one-time lists older than 14 days drop off the page.
  const cut = Date.now() - 14 * 86400e3
  const batches = (b.data || []).filter(x => !(x.status === 'done' && Date.parse(x.done_at || x.send_at) < cut)).map(view)
  return { batches, inbox: s.error ? [] : s.data || [] }
}

// Names + balances for the codes, from the dues list (only parties that owe and are not DND are kept).
async function partiesFor(busy, codes) {
  const out = []
  for (let i = 0; i < codes.length; i += 300) {
    const r = await busy.from('dues_segmented').select('party_code, party_name, group_name, outstanding_balance, due_type').in('party_code', codes.slice(i, i + 300))
    if (r.error) throw new Error(r.error.message)
    for (const x of r.data || []) if (x.due_type === 'Receivable') out.push({ code: String(x.party_code), name: x.party_name, group: x.group_name, balance: Number(x.outstanding_balance) || 0 })
  }
  const order = new Map(codes.map((c, i) => [c, i]))
  return out.sort((a, b) => order.get(a.code) - order.get(b.code))
}

export async function batchSave(busy, body, me) {
  const codes = [...new Set((Array.isArray(body.party_codes) ? body.party_codes : []).map(c => String(c).replace(/\D/g, '')).filter(c => c && !LEDGER_ONLY.has(c)))]
  if (!codes.length) throw bad('Tick at least one party.')
  if (codes.length > MAX_PARTIES) throw bad(`At most ${MAX_PARTIES} parties in one schedule.`)
  if (!isDate(body.date) || !isTime(body.time)) throw bad('Pick the date and time.')
  const sendAt = atIST(body.date, body.time)
  const repeat = REPEATS.includes(body.repeat) ? body.repeat : 'none'
  const title = String(body.title || '').trim().slice(0, 80) || 'Payment reminders'
  const parties = await partiesFor(busy, codes)
  if (!parties.length) throw bad('None of those parties has dues in Busy right now.')
  const row = {
    title, send_at: sendAt, repeat, parties, tier: Number(body.tier) === 40 ? 40 : 20, respect_gap: body.respect_gap !== false,
    updated_at: new Date().toISOString(), updated_by: me.name,
  }
  if (body.id) {
    const cur = await busy.from('collection_batches').select('*').eq('id', Number(body.id)).maybeSingle()
    if (cur.error || !cur.data) throw bad('That schedule is not there any more.')
    if (cur.data.status === 'sending') throw bad('This schedule is sending right now — wait a few minutes, then change it.')
    // A new time in the future starts it again (results cleared); same time keeps what was already sent.
    const restart = cur.data.status === 'done' || sendAt !== cur.data.send_at
    if (restart && Date.parse(sendAt) < Date.now() - 5 * 60e3) throw bad('That time has already passed — pick a later one.')
    const patch = { ...row, ...(restart ? { status: 'scheduled', results: {}, done_at: null } : {}) }
    const r = await busy.from('collection_batches').update(patch).eq('id', Number(body.id)).select('*').single()
    if (r.error) throw new Error(r.error.message)
    return { ok: true, batch: view(r.data) }
  }
  if (Date.parse(sendAt) < Date.now() - 5 * 60e3) throw bad('That time has already passed — pick a later one.')
  const r = await busy.from('collection_batches').insert({ ...row, created_by: me.id, created_by_name: me.name }).select('*').single()
  if (r.error) throw new Error(r.error.message)
  return { ok: true, batch: view(r.data) }
}

export async function batchOp(busy, body, me) {
  const id = Number(body.id)
  const stamp = { updated_at: new Date().toISOString(), updated_by: me.name }
  let r
  if (body.op === 'on' || body.op === 'off') r = await busy.from('collection_batches').update({ enabled: body.op === 'on', ...stamp }).eq('id', id).select('*').single()
  else if (body.op === 'remove') r = await busy.from('collection_batches').update({ status: 'cancelled', enabled: false, ...stamp }).eq('id', id).neq('status', 'sending').select('*').single()
  else if (body.op === 'now') {
    // Send now: a one-time list goes now (and is then done); a repeating list goes now AND keeps its normal day / time.
    const cur = await busy.from('collection_batches').select('repeat, status').eq('id', id).maybeSingle()
    if (cur.error || !cur.data) throw bad('That schedule is not there any more.')
    const once = cur.data.repeat === 'none'
    r = await busy.from('collection_batches').update({ status: 'sending', enabled: true, done_at: null, ...(once ? { send_at: new Date().toISOString() } : {}), ...(body.restart || cur.data.status === 'done' || !once ? { results: {} } : {}), ...stamp })
      .eq('id', id).neq('status', 'sending').select('*').single()
  }
  else throw bad('Unknown action.')
  if (r.error) throw bad(/0 rows|multiple|no rows/i.test(r.error.message) ? 'It is sending right now — try again in a few minutes.' : r.error.message)
  return { ok: true, batch: view(r.data) }
}

// One-customer schedules from the WhatsApp Inbox: On / Off, new time, stop.
export async function inboxScheduleOp(busy, body, me) {
  const id = Number(body.id)
  let patch
  if (body.op === 'on') patch = { status: 'active' }
  else if (body.op === 'off') patch = { status: 'paused' }
  else if (body.op === 'stop') patch = { status: 'stopped', stop_reason: `stopped by ${me.name}`, stopped_by: me.name, stopped_at: new Date().toISOString(), next_at: null }
  else if (body.op === 'edit') {
    if (!isDate(body.date) || !isTime(body.time)) throw bad('Pick the date and time.')
    const at = atIST(body.date, body.time)
    if (Date.parse(at) < Date.now() - 5 * 60e3) throw bad('That time has already passed — pick a later one.')
    patch = { next_at: at, repeat: REPEATS.includes(body.repeat) ? body.repeat : 'none' }
  } else throw bad('Unknown action.')
  const r = await busy.from('collection_schedules').update(patch).eq('id', id).in('status', ['active', 'paused']).select('id')
  if (r.error) throw new Error(r.error.message)
  if (!(r.data || []).length) throw bad('That schedule has already finished or was stopped.')
  return { ok: true }
}

// Parties to add to a schedule (search by name / code among parties that owe).
export async function partyFind(busy, body) {
  const q = String(body.q || '').trim().slice(0, 60)
  if (q.length < 2) return { rows: [] }
  let query = busy.from('dues_segmented').select('party_code, party_name, group_name, outstanding_balance, due_type').eq('due_type', 'Receivable').gt('outstanding_balance', 0)
  if (/^\d+$/.test(q)) query = query.eq('party_code', q)
  else for (const w of q.split(/\s+/).slice(0, 4)) query = query.ilike('party_name', `%${w.replace(/[%_,()]/g, '')}%`)
  const r = await query.order('outstanding_balance', { ascending: false }).limit(15)
  if (r.error) throw new Error(r.error.message)
  return { rows: (r.data || []).filter(x => !LEDGER_ONLY.has(String(x.party_code))).map(x => ({ code: String(x.party_code), name: x.party_name, group: x.group_name, balance: Number(x.outstanding_balance) || 0 })) }
}

// The sender. budgetMs keeps one call short; anything left goes on the next tick.
export async function runBatches(busy, switches, { onlyId = null, budgetMs = 25000 } = {}) {
  const started = Date.now()
  const nowIso = new Date().toISOString()
  // Due = waiting and its time has come, or already sending (a "Send now", or a list that ran out of time last tick).
  let q = busy.from('collection_batches').select('*').eq('enabled', true).in('status', ['scheduled', 'sending']).or(`status.eq.sending,send_at.lte.${nowIso}`).order('send_at').limit(5)
  if (onlyId) q = q.eq('id', onlyId)
  const due = await q
  if (due.error) { if (/does not exist|relation/i.test(due.error.message)) return { setup: false }; throw new Error(due.error.message) }
  const counts = { sent: 0, skipped: 0, failed: 0, finished: 0 }
  for (const b of due.data || []) {
    if (Date.now() - started > budgetMs) break
    // Claim it for 2 minutes so two ticks never work on the same list.
    const lock = new Date(Date.now() + 120e3).toISOString()
    const claim = await busy.from('collection_batches').update({ lock_until: lock, status: 'sending', started_at: b.started_at || nowIso })
      .eq('id', b.id).eq('enabled', true).or(`lock_until.is.null,lock_until.lt.${nowIso}`).select('id')
    if (claim.error || !(claim.data || []).length) continue
    const results = { ...(b.results || {}) }
    try {
      const me = { id: b.created_by || null, name: `Scheduled: ${b.title}`.slice(0, 60) }
      let pending = (b.parties || []).map(p => String(p.code)).filter(c => !results[c])
      while (pending.length && Date.now() - started < budgetMs) {
        const chunk = pending.slice(0, CHUNK)
        pending = pending.slice(CHUNK)
        const ctx = await reminderContext(busy, chunk)
        const work = []
        for (const code of chunk) {
          const d = planReminder(ctx, code, { minOver: b.tier === 40 ? 40 : 20, respectGap: b.respect_gap !== false })
          if (!d.ok) { results[code] = { s: d.skip, why: d.why, at: new Date().toISOString() }; counts.skipped++ }
          else work.push({ code, plan: d.plan })
        }
        const worker = async () => {
          while (work.length) {
            const { code, plan } = work.shift()
            const r = await dispatchReminder(busy, plan, me, switches)
            results[code] = { s: r.status, why: r.error || undefined, at: new Date().toISOString() }
            counts[r.status === 'sent' ? 'sent' : 'failed']++
          }
        }
        await Promise.all([worker(), worker(), worker()])
        await busy.from('collection_batches').update({ results, lock_until: new Date(Date.now() + 120e3).toISOString() }).eq('id', b.id)
      }
      const left = (b.parties || []).filter(p => !results[String(p.code)]).length
      if (left) { await busy.from('collection_batches').update({ results, lock_until: null }).eq('id', b.id); continue }
      // Finished this run.
      const tally = {}
      for (const r of Object.values(results)) tally[r.s] = (tally[r.s] || 0) + 1
      counts.finished++
      // A repeating list sent early with "Send now" keeps its next normal time.
      let next = b.repeat !== 'none' ? (Date.parse(b.send_at) > Date.now() ? b.send_at : nextTime(b.send_at, b.repeat)) : null
      while (next && Date.parse(next) <= Date.now()) next = nextTime(next, b.repeat)
      await busy.from('collection_batches').update(next
        ? { status: 'scheduled', send_at: next, results: {}, last_counts: tally, last_run_at: new Date().toISOString(), lock_until: null }
        : { status: 'done', results, last_counts: tally, last_run_at: new Date().toISOString(), done_at: new Date().toISOString(), lock_until: null }).eq('id', b.id)
    } catch (err) {
      await busy.from('collection_batches').update({ results, lock_until: null }).eq('id', b.id)
      console.error('batch send failed:', b.id, err)
      counts.failed++
    }
  }
  return counts
}
