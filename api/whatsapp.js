import { applyCors } from './_cors.js'
import { createClient } from '@supabase/supabase-js'
import { waConfigured, sendTemplate, wabaSubscription, toWaNumber, waSwitches, sendLogged, BANNER, niceDate } from './_wa-cloud.js'
import { handleIncoming, busyClient, ledgerNameByCode } from './_wa-replies.js'
import { runOutbox, TXN } from './_wa-outbox.js'
import { db as ordersDb } from './_orders/lib/db.js'
import { materialOverview } from './_orders/lib/material.js'

// WhatsApp via Meta's Cloud API — the HQ "WhatsApp" admin page (src/whatsapp-test.js at #whatsapp-test),
// the Meta webhook, and the outbox of customer transaction messages (api/_wa-outbox.js).
//
// Actions (POST JSON, admins):
//   status                      { configured }  — are the Vercel env vars present?
//   test   { phone }            sends the approved "hello_world" template (en_US) to that number
//   sub-status / sub-fix        is the WABA subscribed to our app (needed for button taps)?
//   reminder-test { phone, code, tier }   one payment reminder with sample figures
//   sample { phone, template, code? }     any JCM template with sample values (docs/whatsapp-templates.md)
//   settings / settings-save { off: { kind: true|false } }   per-kind on/off switches (wa_settings)
//   log { kind?, limit? }       last sends (wa_log);  outbox { status? }  queued transaction messages
//   tick                        (JCM-Server, Busy service key) send due outbox rows — also run by admins from the page

const SUPABASE_URL = 'https://cmtnzmfuasniicsdxyle.supabase.co'

// Every kind of message HQ sends (switches on the WhatsApp page; wa_settings 'off:<kind>').
const KINDS = ['invoice', 'receipt', 'credit_note', 'debit_note', 'payment', 'purchase', 'order', 'quotation', 'dispatch', 'gst_supplier',
  'reminder', 'staff_followup', 'staff_evening', 'staff_red_alert', 'staff_purchase', 'staff_purchase_summary', 'staff_gst', 'staff_orders']

// Every tick (every 5 min from JCM-Server, or Run now on the page): the outbox, then the daily staff
// orders message once a day after wa_settings orders_daily_at (default 17:30 India time).
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)
const clockIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(11, 16)
async function tick(busy, force) {
  const out = { outbox: await runOutbox(busy) }
  const sw = await waSwitches(busy)
  const at = sw.get('orders_daily_at') || '17:30'
  const last = sw.get('last_orders_daily')
  const today = todayIST()
  if (force === 'orders' || (sw.ready && clockIST() >= at && last !== today)) {
    // Claim today's run first (compare-and-set on the stored day), so two ticks never both send.
    const claim = force ? { data: [1] } : last
      ? await busy.from('wa_settings').update({ value: today }).eq('key', 'last_orders_daily').eq('value', last).select('key')
      : await busy.from('wa_settings').upsert({ key: 'last_orders_daily', value: today }, { onConflict: 'key', ignoreDuplicates: true }).select('key')
    if (!claim.error && (claim.data || []).length) out.orders = await sendOrdersDaily(busy, sw)
  }
  return out
}

// staff_orders_pending: {{1}} date, {{2}} items to order, {{3}} ordered but late, {{4}} parties waiting,
// {{5}} who is waiting (flat). To admins. Button → Material page.
async function sendOrdersDaily(busy, switches) {
  const hq = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  const ov = await materialOverview(ordersDb())
  const all = ov.items.flatMap(g => g.items.map(i => ({ ...i, supplier: g.supplier })))
  const toOrder = all.filter(i => !i.orderedAt).length
  const late = all.filter(i => i.orderedAt && i.late).length
  const parties = ov.parties.filter(p => !p.floor)
  const who = parties.slice(0, 6).map(p => `${p.name}${p.status === 'red' ? ' (not all ordered)' : ''}`).join(', ') + (parties.length > 6 ? ` and ${parties.length - 6} more` : '')
  const { data: admins } = await hq.from('profiles').select('id, name, whatsapp, is_admin, role, active')
  const sent = []
  for (const a of (admins || []).filter(p => p.active !== false && (p.is_admin === true || p.role === 'admin') && p.whatsapp)) {
    const r = await sendLogged(busy, { kind: 'staff_orders', to: a.whatsapp, template: 'staff_orders_pending',
      params: [niceDate(todayIST()), String(toOrder), String(late), String(parties.length), who || 'nobody'],
      opts: { headerImageUrl: BANNER('staff-orders') }, ref: todayIST(), refName: a.name, by: 'HQ timer', switches })
    sent.push({ to: a.name, status: r.status })
  }
  return { toOrder, late, waiting: parties.length, sent }
}

// Sample sends for the WhatsApp page — one entry per template in docs/whatsapp-templates.md.
const HQ = 'https://hq.jcmretails.com'
const cust = (kind, extra) => ({ params: name => TXN[kind].params({ party_name: name, ...extra }), opts: code => ({ headerImageUrl: BANNER(TXN[kind].banner), buttonPayloads: TXN[kind].buttons(code) }) })
const SAMPLES = {
  txn_invoice: cust('invoice', { vch_no: 'JCM/1234', vch_date: '2026-10-12', amount: 45600, items: 7 }),
  txn_receipt: cust('receipt', { vch_no: 'R/221', vch_date: '2026-10-12', amount: 25000 }),
  txn_credit_note: cust('credit_note', { vch_no: 'CN/18', vch_date: '2026-10-12', amount: 1800 }),
  txn_debit_note: cust('debit_note', { vch_no: 'DN/7', vch_date: '2026-10-12', amount: 950 }),
  txn_payment: cust('payment', { vch_no: 'P/310', vch_date: '2026-10-12', amount: 1_20_000 }),
  txn_purchase: cust('purchase', { vch_no: 'INV-5521', vch_date: '2026-10-12', amount: 88000, items: 12 }),
  txn_order: cust('order', { vch_no: 'SO/261/45', vch_date: '2026-10-12', amount: 32500, items: 5 }),
  quotation_sent: { params: name => [name, 'Q-2026-118', '12 Oct 2026', '1,85,000'], opts: () => ({ headerImageUrl: BANNER('quotation') }) },
  order_dispatched: { params: name => [name, '3', '5 items (18 pcs)', 'Daikin 1.5T split AC × 1', '42,000', '68,500', 'JCM/1234', 'https://invoice.jcmretails.com'], opts: code => ({ headerImageUrl: BANNER('dispatched'), buttonPayloads: [`portal:${code}`] }) },
  order_dispatched_photo: { params: name => [name, '3', '5 items (18 pcs)', 'none', '0', '68,500', 'JCM/1234', 'https://invoice.jcmretails.com'], opts: code => ({ headerImageUrl: BANNER('dispatched'), buttonPayloads: [`portal:${code}`] }) },
  staff_followup_morning: { params: () => ['Keshav', '12', '4,85,000', 'Badshah Electric ₹1,20,000, Nexus Enterprises ₹95,000, Shree Traders ₹60,000 and 9 more'], opts: () => ({ headerImageUrl: BANNER('staff-followup') }) },
  staff_followup_evening: { params: () => ['12 Oct 2026', '18', '7', 'Keshav: 8 done of 12, 4 left · 3 promised ₹1,10,000; Ratan: 10 done of 13, 3 left', '2 parties, ₹85,000 — check they came in'], opts: () => ({ headerImageUrl: BANNER('staff-evening') }) },
  staff_red_alert: { params: () => ['Priti', 'Shishir', '2', 'Bill deleted: JCM/1180 Badshah Electric ₹12,400 (11 Oct); ₹0 rate: JCM/1190 line 3 (12 Oct)', 'Why was this bill deleted after printing?'], opts: () => ({ headerImageUrl: BANNER('staff-red-alert'), buttonUrlParams: { 1: '919109105999' } }) },
  staff_purchase_bill: { params: () => ['Lapp India Pvt Ltd', 'LAPP/88812', '11 Oct 2026', '12: Cable 2.5 sqmm 500 × ₹28; Cable 4 sqmm 300 × ₹44 and 10 more', '88,000', 'Ratan at 11:42, 12 Oct 2026'], opts: () => ({ headerImageUrl: BANNER('staff-purchase') }) },
  staff_purchase_summary: { params: () => ['12 Oct 2026', '6', '41', '3,42,000', 'Lapp India ₹88,000; Daikin ₹1,20,000; Atomberg ₹54,000 and 3 more'], opts: () => ({ headerImageUrl: BANNER('staff-purchase') }) },
  staff_orders_pending: { params: () => ['12 Oct 2026', '9', '4', '2,15,000', 'Badshah Electric (3 days), Nexus Enterprises (2 days), Shree Traders (today) and 6 more'], opts: () => ({ headerImageUrl: BANNER('staff-orders') }) },
}

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json(body)
}

export default async function handler(req, res) {
  // Meta webhook (no sign-in; Meta calls this). GET = one-time check with our verify token,
  // POST = messages / button taps. Env: WHATSAPP_VERIFY_TOKEN (any secret word you choose).
  if (req.method === 'GET' && req.query?.['hub.mode']) {
    const ok = process.env.WHATSAPP_VERIFY_TOKEN && req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN
    return ok ? res.status(200).send(String(req.query['hub.challenge'] || '')) : res.status(403).send('Forbidden')
  }
  if (req.method === 'POST' && req.body?.object === 'whatsapp_business_account') {
    for (const e of req.body.entry || []) for (const c of e.changes || []) {
      const v = c.value || {}
      const n = (v.messages || []).length
      console.log(`wa webhook: field=${c.field} messages=${n} statuses=${(v.statuses || []).length} types=${(v.messages || []).map(m => m.type).join(',')} phoneIdMatch=${v.metadata?.phone_number_id === process.env.WHATSAPP_PHONE_NUMBER_ID}`)
      if (v.metadata?.phone_number_id === process.env.WHATSAPP_PHONE_NUMBER_ID) await handleIncoming(v)
    }
    return res.status(200).send('ok')
  }
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
  // JCM-Server's timer (busy-sync/sync-transactions.js): only the Busy project's service key can
  // read wa_settings (RLS on, no policies), so a read with the key it sent proves who it is.
  if (req.body?.action === 'tick') {
    const auth = req.headers.authorization || ''
    const k = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (k && k === process.env.SUPABASE_BUSY_SERVICE_ROLE_KEY) {
      try { return send(res, 200, { ok: true, ...(await tick(busyClient())) }) }
      catch (err) { console.error('wa tick failed:', err); return send(res, 500, { error: String(err.message || err).slice(0, 300) }) }
    }
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) return send(res, 500, { error: 'HQ is not configured yet.' })

  const hq = createClient(SUPABASE_URL, key, { auth: { autoRefreshToken: false, persistSession: false } })
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return send(res, 401, { error: 'Please sign in again.' })
  const { data: u, error: uErr } = await hq.auth.getUser(token)
  if (uErr || !u?.user) return send(res, 401, { error: 'Please sign in again.' })
  const { data: profile } = await hq.from('profiles')
    .select('id, role, is_admin, active').eq('id', u.user.id).maybeSingle()
  if (!profile || profile.active === false) return send(res, 403, { error: 'Your account is not active.' })
  const isAdmin = profile.is_admin === true || profile.role === 'admin'
  if (!isAdmin) return send(res, 403, { error: 'Only admins can use this page.' })

  const body = req.body || {}
  try {
    if (body.action === 'status') return send(res, 200, { configured: waConfigured() })
    if (body.action === 'test') {
      const out = await sendTemplate(body.phone, 'hello_world', 'en_US', [])
      return send(res, 200, { ok: true, messageId: out?.messages?.[0]?.id || null })
    }
    if (body.action === 'sub-status' || body.action === 'sub-fix') {
      if (body.action === 'sub-fix') await wabaSubscription('subscribe')
      const d = await wabaSubscription('get')
      const apps = (d?.data || []).map(a => a.whatsapp_business_api_data?.name || a.name || 'app')
      return send(res, 200, { subscribed: apps.length > 0, apps })
    }
    if (body.action === 'reminder-test') {
      // Sends one payment-reminder template for a real customer (by Busy code), with sample amounts, to check look + buttons.
      // tier: 20 / 40 = Dealer templates (total outstanding + overdue); r20 / r40 = Retail templates (one amount due).
      const tier = String(body.tier || '20')
      const red = tier.endsWith('40')
      const retail = tier.startsWith('r')
      const code = String(body.code || '').replace(/\D/g, '')
      if (!code) return send(res, 400, { error: 'Type the customer\'s Busy code first.' })
      const busy = busyClient()
      const name = busy ? await ledgerNameByCode(busy, code) : ''
      if (!name) return send(res, 400, { error: 'No customer with that Busy code.' })
      const template = `${retail ? 'retail_reminder' : 'payment_reminder'}_${red ? '40d' : '20d'}`
      const params = retail
        ? [name, '45,000', red ? '47' : '26', '26 Aug 2026']
        : [name, '1,25,000', '85,000', red ? '47' : '26', '26 Aug 2026']
      const out = await sendTemplate(body.phone, template, body.lang || 'en', params, {
        buttonPayloads: [`qr:${code}`, `ledger:${code}`, `${retail ? 'portal' : 'inv'}:${code}`],
        headerImageUrl: `https://hq.jcmretails.com/wa/${red ? 'reminder-red-40d' : 'reminder-amber-20d'}.png`,
      })
      return send(res, 200, { ok: true, messageId: out?.messages?.[0]?.id || null })
    }
    const busy = busyClient()
    if (!busy) return send(res, 500, { error: 'SUPABASE_BUSY_SERVICE_ROLE_KEY missing in Vercel.' })
    if (body.action === 'tick') return send(res, 200, { ok: true, ...(await tick(busy, body.force)) })
    if (body.action === 'settings' || body.action === 'settings-save') {
      if (body.action === 'settings-save' && body.off && typeof body.off === 'object') {
        const rows = Object.entries(body.off).filter(([k]) => KINDS.includes(k)).map(([k, v]) => ({ key: `off:${k}`, value: v === true ? 'true' : 'false', updated_at: new Date().toISOString() }))
        if (rows.length) { const r = await busy.from('wa_settings').upsert(rows, { onConflict: 'key' }); if (r.error) return send(res, 500, { error: r.error.message }) }
      }
      const sw = await waSwitches(busy)
      return send(res, 200, { ready: sw.ready, kinds: KINDS, off: KINDS.filter(k => sw.off.has(k)) })
    }
    if (body.action === 'log') {
      let q = busy.from('wa_log').select('*').order('created_at', { ascending: false }).limit(Math.min(500, Number(body.limit) || 100))
      if (body.kind) q = q.eq('kind', String(body.kind))
      const r = await q
      if (r.error) return send(res, 500, { error: r.error.message })
      return send(res, 200, { rows: r.data || [] })
    }
    if (body.action === 'outbox') {
      let q = busy.from('wa_outbox').select('*').order('send_after', { ascending: false }).limit(200)
      if (body.status) q = q.eq('status', String(body.status))
      const r = await q
      if (r.error) return send(res, 500, { error: r.error.message })
      return send(res, 200, { rows: r.data || [] })
    }
    if (body.action === 'sample') {
      // Any template, sample values. Customer templates take a real Busy code (ledger name + buttons).
      const t = String(body.template || '')
      const spec = SAMPLES[t]
      if (!spec) return send(res, 400, { error: 'Unknown template.' })
      let name = 'Sample Customer', code = '0'
      if (body.code) {
        code = String(body.code).replace(/\D/g, '')
        name = await ledgerNameByCode(busy, code)
        if (!name) return send(res, 400, { error: 'No customer with that Busy code.' })
      }
      const out = await sendLogged(busy, { kind: 'test', to: body.phone, template: t, params: spec.params(name), opts: spec.opts(code), by: 'test' })
      if (out.status !== 'sent') return send(res, 502, { error: out.error || out.status })
      return send(res, 200, { ok: true, messageId: out.id })
    }
    return send(res, 400, { error: 'Unknown request.' })
  } catch (err) {
    // Messages from sendTemplate are plain-language and never contain the token.
    return send(res, 502, { error: err.message || 'Something went wrong. Try again.' })
  }
}
