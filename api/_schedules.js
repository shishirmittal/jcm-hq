// Scheduled payment reminders (2026-10-16, HQ Requests) — set from the WhatsApp Inbox when a customer
// replies ("will pay tomorrow"). A schedule sends the normal payment-reminder template (Dealer / Retail,
// amber / red, QR Code · Ledger · Invoices buttons — api/collections.js sendScheduledReminder) on the
// chosen date and time, once or repeating daily / weekly / monthly, and STOPS BY ITSELF as soon as a
// payment from that party shows in Busy (a receipt after the schedule was made — from the 5-minute
// transaction feed wa_outbox, or the ledger party_ledger) or nothing is due any more.
// Table collection_schedules (Busy project, RLS closed). Run from tick() in api/whatsapp.js (every 5 min).
// Actions (api/whatsapp.js, WhatsApp page people): party-search, schedule-list, schedule-save, schedule-stop.
import { sendScheduledReminder } from './collections.js'

const REPEATS = ['none', 'daily', 'weekly', 'monthly']
const MAX_SENDS = 30
const LEDGER_ONLY_CODES = new Set(['40355', '65494', '56680'])
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
const isTime = s => /^\d{2}:\d{2}$/.test(String(s || ''))
const atIST = (d, t) => new Date(`${d}T${t}:00+05:30`).toISOString()
const inr = n => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN')
const niceIST = iso => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })

function bad(msg) { return Object.assign(new Error(msg), { status: 400 }) }

// Next time after `prev` for a repeat; same clock time.
function nextOf(prevIso, repeat) {
  const d = new Date(prevIso)
  if (repeat === 'daily') d.setUTCDate(d.getUTCDate() + 1)
  else if (repeat === 'weekly') d.setUTCDate(d.getUTCDate() + 7)
  else if (repeat === 'monthly') {
    const day = d.getUTCDate()
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1)
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
    d.setUTCDate(Math.min(day, last))
  } else return null
  return d.toISOString()
}

// What the party owes now + where we stand, for the pop-up.
async function partyNow(busy, code) {
  const [cu, seg, pd, runs] = await Promise.all([
    busy.from('customers').select('party_code, name, mobile, whatsapp_no').eq('party_code', Number(code)).maybeSingle(),
    busy.from('dues_segmented').select('party_name, group_name, outstanding_balance, due_type').eq('party_code', code).limit(1),
    busy.from('party_dues').select('outstanding_balance, synced_at').eq('party_code', code).limit(1),
    busy.from('party_dues').select('synced_at').order('synced_at', { ascending: false }).limit(1),
  ])
  const latest = runs.data?.[0]?.synced_at
  const d = pd.data?.[0]
  const fresh = d && (!latest || Date.parse(d.synced_at) >= Date.parse(latest) - 30 * 60e3)
  return {
    code: String(code), name: cu.data?.name || seg.data?.[0]?.party_name || `Busy code ${code}`,
    group: seg.data?.[0]?.group_name || null, due: fresh ? Number(d.outstanding_balance) || 0 : 0,
    mobile: cu.data?.whatsapp_no || cu.data?.mobile || null, found: !!cu.data,
  }
}

export async function partySearch(busy, body) {
  const q = String(body.q || '').trim().slice(0, 60)
  if (!q) return { rows: [] }
  const digits = q.replace(/\D/g, '')
  let query = busy.from('customers').select('party_code, name, mobile, whatsapp_no')
  if (digits.length >= 4 && digits.length === q.replace(/[\s+-]/g, '').length) query = query.or(`mobile.ilike.%${digits.slice(-10)}%,whatsapp_no.ilike.%${digits.slice(-10)}%${digits.length <= 6 ? `,party_code.eq.${Number(digits)}` : ''}`)
  else for (const w of q.split(/\s+/).slice(0, 4)) query = query.ilike('name', `%${w.replace(/[%_,()]/g, '')}%`)
  const r = await query.order('name').limit(15)
  if (r.error) throw new Error(r.error.message)
  return { rows: (r.data || []).filter(x => !LEDGER_ONLY_CODES.has(String(x.party_code))).map(x => ({ code: String(x.party_code), name: x.name, mobile: x.whatsapp_no || x.mobile || '' })) }
}

export async function scheduleList(busy, body) {
  const code = String(body.party_code || '').replace(/\D/g, '')
  if (!code) throw bad('No customer chosen.')
  const [party, rows] = await Promise.all([
    partyNow(busy, code),
    busy.from('collection_schedules').select('*').eq('party_code', code).order('created_at', { ascending: false }).limit(10),
  ])
  if (rows.error) throw new Error(rows.error.message)
  return { party, schedules: rows.data || [] }
}

export async function scheduleSave(busy, body, me) {
  const code = String(body.party_code || '').replace(/\D/g, '')
  if (!code || LEDGER_ONLY_CODES.has(code)) throw bad(code ? 'That is a ledger-only account — pick the actual customer.' : 'Pick the customer first.')
  if (!isDate(body.date) || !isTime(body.time)) throw bad('Pick the date and time of the first reminder.')
  const repeat = REPEATS.includes(body.repeat) ? body.repeat : 'none'
  const first = atIST(body.date, body.time)
  if (Date.parse(first) < Date.now() - 5 * 60e3) throw bad('That time has already passed — pick a later one.')
  const party = await partyNow(busy, code)
  if (!party.found) throw bad('That customer is not in the Busy data.')
  const promised = Number(body.promised_amount) || null
  const note = String(body.note || '').trim().slice(0, 500) || null
  // One live schedule per customer: a new one replaces the old.
  await busy.from('collection_schedules').update({ status: 'stopped', stop_reason: 'replaced by a new schedule', stopped_by: me.name, stopped_at: new Date().toISOString() }).eq('party_code', code).eq('status', 'active')
  const ins = await busy.from('collection_schedules').insert({
    party_code: code, party_name: party.name, number: String(body.number || '').replace(/\D/g, '') || null,
    first_at: first, next_at: first, repeat, promised_amount: promised, note, balance_at_create: party.due,
    created_by: me.id, created_by_name: me.name,
  }).select('*').single()
  if (ins.error) throw new Error(ins.error.message)
  // Also on the Payment Follow-up history, so the calls list waits for this date too.
  const fu = await busy.from('collection_followups').insert({
    party_code: code, party_name: party.name, group_name: party.group, channel: 'whatsapp',
    outcome: promised || /pay|promis|kal|tomorrow/i.test(note || '') ? 'promised' : 'call_later',
    remarks: [note, `Reminder scheduled ${niceIST(first)}${repeat !== 'none' ? `, then ${repeat}` : ''} (from WhatsApp inbox)`].filter(Boolean).join(' — '),
    promised_amount: promised, promised_date: promised ? body.date : null, next_followup: body.date,
    balance_at_time: party.due, created_by: me.id, created_by_name: me.name,
  })
  if (fu.error) console.error('schedule follow-up note failed:', fu.error.message)
  return { ok: true, schedule: ins.data }
}

export async function scheduleStop(busy, body, me) {
  const r = await busy.from('collection_schedules').update({ status: 'stopped', stop_reason: `stopped by ${me.name}`, stopped_by: me.name, stopped_at: new Date().toISOString() })
    .eq('id', Number(body.id)).eq('status', 'active').select('id')
  if (r.error) throw new Error(r.error.message)
  return { ok: true, stopped: (r.data || []).length }
}

// A payment from this party after the schedule was made? Receipt messages (every 5 min) first, then the ledger (30 min).
async function paidSince(busy, code, sinceIso) {
  const [ob, led] = await Promise.all([
    busy.from('wa_outbox').select('vch_no, amount, vch_date').eq('party_code', code).eq('kind', 'receipt').gte('created_at', sinceIso).not('status', 'in', '(deleted,cancelled)').order('created_at', { ascending: false }).limit(1),
    busy.from('party_ledger').select('vch_no, credit, vch_date').eq('party_code', code).eq('vch_type', 14).gt('credit', 0).gte('vch_date', sinceIso.slice(0, 10)).order('vch_date', { ascending: false }).limit(1),
  ])
  const a = ob.data?.[0], b = led.data?.[0]
  if (a) return `Payment received in Busy — ${a.vch_no || 'receipt'} ${inr(a.amount)}`
  if (b) return `Payment received in Busy — ${b.vch_no || 'receipt'} ${inr(b.credit)}`
  return null
}

export async function runSchedules(busy, switches) {
  const due = await busy.from('collection_schedules').select('*').eq('status', 'active').lte('next_at', new Date().toISOString()).order('next_at').limit(25)
  if (due.error) { if (/does not exist|relation/i.test(due.error.message)) return { setup: false }; throw new Error(due.error.message) }
  const counts = { sent: 0, stopped: 0, skipped: 0, failed: 0 }
  for (const s of due.data || []) {
    // Claim it (two ticks never send the same one twice): move next_at on before sending.
    const nextAt = s.repeat === 'none' ? null : nextOf(s.next_at, s.repeat)
    const claim = await busy.from('collection_schedules').update({ next_at: nextAt || '9999-12-31T00:00:00Z' }).eq('id', s.id).eq('status', 'active').eq('next_at', s.next_at).select('id')
    if (claim.error || !(claim.data || []).length) continue
    try {
    const stop = async (reason) => { await busy.from('collection_schedules').update({ status: 'stopped', stop_reason: reason, stopped_by: 'HQ', stopped_at: new Date().toISOString(), next_at: null }).eq('id', s.id); counts.stopped++ }
    const paid = await paidSince(busy, s.party_code, s.created_at)
    if (paid) { await stop(paid); continue }
    const out = await sendScheduledReminder(busy, s.party_code, switches)
    if (out.status === 'skip' && ['nothing_due', 'not_found', 'dnd', 'no_number'].includes(out.skip)) { await stop(out.why); continue }
    const sent = out.status === 'sent'
    const count = s.sent_count + (sent ? 1 : 0)
    const finished = !nextAt || count >= MAX_SENDS
    await busy.from('collection_schedules').update({
      sent_count: count, last_sent_at: sent ? new Date().toISOString() : s.last_sent_at,
      last_status: sent ? 'sent' : out.status === 'skip' ? `skipped: ${out.why}` : out.status, last_error: out.error || null,
      ...(finished ? { status: 'done', next_at: null, stop_reason: !nextAt ? 'sent (one-time)' : `stopped after ${MAX_SENDS} reminders` } : {}),
    }).eq('id', s.id)
    counts[sent ? 'sent' : out.status === 'skip' ? 'skipped' : 'failed']++
    } catch (err) {
      // Put it back so the next tick tries again.
      await busy.from('collection_schedules').update({ next_at: s.next_at, last_status: 'error', last_error: String(err.message || err).slice(0, 300) }).eq('id', s.id)
      counts.failed++
    }
  }
  // Repeating schedules that are waiting for their next time also stop the moment a payment shows.
  const waiting = await busy.from('collection_schedules').select('id, party_code, created_at').eq('status', 'active').gt('sent_count', 0).limit(100)
  for (const s of waiting.data || []) {
    const paid = await paidSince(busy, s.party_code, s.created_at)
    if (paid) { await busy.from('collection_schedules').update({ status: 'stopped', stop_reason: paid, stopped_by: 'HQ', stopped_at: new Date().toISOString(), next_at: null }).eq('id', s.id).eq('status', 'active'); counts.stopped++ }
  }
  return counts
}
