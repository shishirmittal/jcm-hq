import { applyCors } from './_cors.js'
import { createClient } from '@supabase/supabase-js'
import { waConfigured, sendTemplate, wabaSubscription, toWaNumber, waSwitches, sendLogged, BANNER, HQ_URL, niceDate, listTemplates, fetchMedia } from './_wa-cloud.js'
import { handleIncoming, busyClient, ledgerNameByCode } from './_wa-replies.js'
import { runOutbox, TXN } from './_wa-outbox.js'
import { listConversations, loadThread, replyText, unreadCount } from './_wa-inbox.js'
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
// {{5}} who is waiting (flat). To admins. Quick reply "Summary PDF" (orders:<date>) → live report PDF (api/_orders-pdf.js).
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
      opts: { headerImageUrl: BANNER('staff-orders'), buttonPayloads: [`orders:${todayIST()}`] }, ref: todayIST(), refName: a.name, by: 'HQ timer', switches })
    sent.push({ to: a.name, status: r.status })
  }
  return { toOrder, late, waiting: parties.length, sent }
}

// Every template HQ uses — the Templates tab compares this with what WhatsApp Manager has.
const PAUSE_KEY = 'pause:customers'
const EXPECTED = [
  { name: 'txn_invoice_revised', used: 'Corrected invoice (invoice changed in Busy after its message went)' },
  { name: 'ledger_statement', used: 'Customer Card → Send ledger (PDF attached, QR Code button)' },
  { name: 'payment_reminder_20d', used: 'Payment reminder — Dealer, amber (over 20 days)' },
  { name: 'payment_reminder_40d', used: 'Payment reminder — Dealer, red (over 40 days)' },
  { name: 'retail_reminder_20d', used: 'Payment reminder — Retail, amber' },
  { name: 'retail_reminder_40d', used: 'Payment reminder — Retail, red' },
  { name: 'txn_invoice', used: 'Invoice generated (customer)' }, { name: 'txn_receipt', used: 'Payment received (customer)' },
  { name: 'txn_credit_note', used: 'Credit note (customer)' }, { name: 'txn_debit_note', used: 'Debit note (customer)' },
  { name: 'txn_payment', used: 'Payment made (supplier)' }, { name: 'txn_purchase', used: 'Purchase bill entered (supplier)' },
  { name: 'txn_order', used: 'Order booked (customer)' }, { name: 'quotation_sent', used: 'Quotation (customer)' },
  { name: 'order_dispatched_photo', used: 'Dispatched with LR photo (Orders)' }, { name: 'order_dispatched', used: 'Dispatched, no LR (Orders)' },
  { name: 'gstr1_filing_reminder', used: 'GSTR-1 reminder to supplier (GST page)' }, { name: 'invoice_portal_otp', used: 'Invoice-portal login code' },
  { name: 'staff_followup_morning', used: 'Staff: morning follow-up list' }, { name: 'staff_followup_evening', used: 'Admins: evening collections summary' },
  { name: 'staff_red_alert', used: 'Staff: Red Alert explanation' }, { name: 'staff_purchase_pdf', used: 'Staff: purchase bill entered (PDF)' }, { name: 'staff_purchase_bill', used: 'Staff: purchase bill — old text version (until the PDF one is approved)' },
  { name: 'staff_purchase_summary', used: 'Staff: purchases evening summary' }, { name: 'gst_mismatch_summary', used: 'Staff: GST mismatch report (PDF)' },
  { name: 'staff_orders_pending', used: 'Admins: orders / material 17:30' }, { name: 'hello_world', used: 'Connection test' },
]

// Sample sends for the WhatsApp page — one entry per template in docs/whatsapp-templates.md.
const HQ = 'https://hq.jcmretails.com'
const cust = (kind, extra) => ({ params: name => TXN[kind].params({ party_name: name, ...extra }), opts: code => ({ headerImageUrl: BANNER(TXN[kind].banner), buttonPayloads: TXN[kind].buttons(code, extra) }) })
const SAMPLES = {
  txn_invoice: cust('invoice', { vch_no: 'JCM/1234', vch_date: '2026-10-12', amount: 45600, items: 7 }),
  txn_invoice_revised: { params: name => TXN.invoice.params({ party_name: name, vch_no: 'JCM/1234', vch_date: '2026-10-13', amount: 41800, items: 6 }), opts: code => ({ headerImageUrl: BANNER('invoice'), buttonPayloads: [`invpdf:${code}:JCM/1234`] }) },
  txn_receipt: cust('receipt', { vch_no: 'R/221', vch_date: '2026-10-12', amount: 25000 }),
  txn_credit_note: cust('credit_note', { vch_no: 'CN/18', vch_date: '2026-10-12', amount: 1800 }),
  txn_debit_note: cust('debit_note', { vch_no: 'DN/7', vch_date: '2026-10-12', amount: 950 }),
  txn_payment: cust('payment', { vch_no: 'P/310', vch_date: '2026-10-12', amount: 1_20_000 }),
  txn_purchase: cust('purchase', { vch_no: 'INV-5521', vch_date: '2026-10-12', amount: 88000, items: 12 }),
  txn_order: cust('order', { vch_no: 'SO/261/45', vch_date: '2026-10-12', amount: 32500, items: 5 }),
  quotation_sent: { params: name => [name, 'Q-2026-118', '12 Oct 2026', '1,85,000'], opts: () => ({ headerImageUrl: BANNER('quotation'), buttonPayloads: ['quote:sample'] }) },
  order_dispatched: { params: name => [name, '6', 'JCM/1234'], opts: code => ({ headerImageUrl: BANNER('dispatched'), buttonPayloads: [`invpdf:${code}:JCM/1234`] }) },
  order_dispatched_photo: { params: name => [name, '6', 'JCM/1234'], opts: code => ({ headerImageUrl: BANNER('dispatched'), buttonPayloads: [`invpdf:${code}:JCM/1234`] }) },
  staff_followup_morning: { params: () => ['Keshav', '12', '4,85,000', 'Badshah Electric ₹1,20,000, Nexus Enterprises ₹95,000, Shree Traders ₹60,000 and 9 more'], opts: () => ({ headerImageUrl: BANNER('staff-followup') }) },
  staff_followup_evening: { params: () => ['12 Oct 2026', '18', '7', 'Keshav: 8 done of 12, 4 left · 3 promised ₹1,10,000; Ratan: 10 done of 13, 3 left', '2 parties, ₹85,000 — check they came in'], opts: () => ({ headerImageUrl: BANNER('staff-evening') }) },
  staff_red_alert: { params: () => ['Priti', 'Shishir', '2', 'Bill deleted: JCM/1180 Badshah Electric ₹12,400 (11 Oct); ₹0 rate: JCM/1190 line 3 (12 Oct)', 'Why was this bill deleted after printing?'], opts: () => ({ headerImageUrl: BANNER('staff-red-alert'), buttonUrlParams: { 1: '919109105999' } }) },
  staff_purchase_bill: { params: () => ['Lapp India Pvt Ltd', 'LAPP/88812', '11 Oct 2026', '12: Cable 2.5 sqmm 500 × ₹28; Cable 4 sqmm 300 × ₹44 and 10 more', '88,000', 'Ratan at 11:42, 12 Oct 2026'], opts: () => ({ headerImageUrl: BANNER('staff-purchase') }) },
  staff_purchase_pdf: { params: () => ['Emechem (Indore)', '4892', '58,620', 'Ruchir Mittal at 8:47 pm, 12 Oct 2026'], opts: () => ({ headerDocumentUrl: `${HQ_URL}/wa/sample-purchase.pdf`, headerDocumentName: 'Purchase-4892-Emechem-Indore.pdf' }) },
  staff_purchase_summary: { params: () => ['12 Oct 2026', '6', '41', '3,42,000', 'Lapp India ₹88,000; Daikin ₹1,20,000; Atomberg ₹54,000 and 3 more'], opts: () => ({ headerImageUrl: BANNER('staff-purchase') }) },
  staff_orders_pending: { params: () => ['12 Oct 2026', '9', '4', '2,15,000', 'Badshah Electric (3 days), Nexus Enterprises (2 days), Shree Traders (today) and 6 more'], opts: () => ({ headerImageUrl: BANNER('staff-orders'), buttonPayloads: [`orders:${todayIST()}`] }) },
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
    // The key JCM-Server holds may be written differently from Vercel's copy, so prove it by
    // reading a closed table with it (RLS on, no policies) — same trick as api/collections.js.
    let busyKeyOk = !!k && k === process.env.SUPABASE_BUSY_SERVICE_ROLE_KEY
    if (k && !busyKeyOk) {
      try { const c = createClient('https://jlkjjqnmhsgefpluemyz.supabase.co', k, { auth: { autoRefreshToken: false, persistSession: false } }); const r = await c.from('wa_settings').select('key').limit(1); busyKeyOk = !r.error } catch { busyKeyOk = false }
    }
    if (busyKeyOk) {
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
    .select('id, name, email, role, is_admin, active, allowed_tabs').eq('id', u.user.id).maybeSingle()
  if (!profile || profile.active === false) return send(res, 403, { error: 'Your account is not active.' })
  const isAdmin = profile.is_admin === true || profile.role === 'admin'
  const granted = Array.isArray(profile.allowed_tabs) && profile.allowed_tabs.includes('whatsapp')
  if (!isAdmin && !granted) return send(res, 403, { error: 'You do not have access to WhatsApp.' })
  const me = { id: profile.id, name: profile.name || profile.email || 'Someone', isAdmin }

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
    if (body.action === 'count') return send(res, 200, { unread: await unreadCount(busy) })
    if (body.action === 'inbox') {
      try { return send(res, 200, { conversations: await listConversations(busy) }) }
      catch (err) { if (err.message === 'SETUP') return send(res, 200, { conversations: [], setup: true }); throw err }
    }
    if (body.action === 'thread') {
      try { return send(res, 200, await loadThread(busy, String(body.number || ''))) }
      catch (err) { if (err.message === 'SETUP') return send(res, 200, { items: [], setup: true }); throw err }
    }
    if (body.action === 'media') {
      // A file / photo a customer sent: fetched from Meta on demand (they keep it ~30 days), handed to the page as base64.
      const row = await busy.from('wa_messages').select('media_id, text, kind').eq('id', Number(body.id)).maybeSingle()
      if (row.error || !row.data?.media_id) return send(res, 404, { error: 'No file on that message.' })
      try {
        const m = await fetchMedia(row.data.media_id)
        if (m.size > 4_000_000) return send(res, 413, { error: 'That file is over 4 MB — too big to pass through HQ. Open it on the WhatsApp phone.' })
        const fileName = String(row.data.text || '').split(' — ')[0].split('\n')[0].replace(/^[^\w]+/, '').trim()
        const name = /\.\w{2,5}$/.test(fileName) ? fileName : `${row.data.kind || 'file'}-${body.id}.${(m.mime.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/;.*/, '')}`
        return send(res, 200, { mime: m.mime, filename: name, base64: m.buffer.toString('base64') })
      } catch (err) { return send(res, 502, { error: err.message }) }
    }
    if (body.action === 'reply') {
      const number = toWaNumber(body.number)
      const text = String(body.text || '').trim().slice(0, 4000)
      if (!number) return send(res, 400, { error: 'Bad number.' })
      if (!text) return send(res, 400, { error: 'Type a message first.' })
      const t = await loadThread(busy, number, { markSeen: false })
      if (!t.windowOpen) return send(res, 400, { error: 'This person has not written in the last 24 hours, so WhatsApp only allows an approved template now. Send one from Samples, or wait for their reply.' })
      try { const id = await replyText(busy, number, text, me.name); return send(res, 200, { ok: true, messageId: id }) }
      catch (err) { return send(res, 502, { error: err.message }) }
    }
    if (body.action === 'templates') {
      const live = await listTemplates()
      // Last real send per template (what actually happened), so the tab answers "is it working?".
      const lastRows = await busy.from('wa_log').select('template, status, error, created_at').order('created_at', { ascending: false }).limit(2000)
      const lastBy = new Map()
      for (const r of lastRows.data || []) if (!lastBy.has(r.template)) lastBy.set(r.template, { status: r.status, error: r.error, at: r.created_at })
      const byName = new Map(live.map(t => [t.name, t]))
      const rows = EXPECTED.map(e => {
        const t = byName.get(e.name)
        return { ...e, found: !!t, last: lastBy.get(e.name) || null, status: t?.status || 'MISSING', category: t?.category || null, language: t?.language || null, rejected_reason: t?.rejected_reason || null, quality: t?.quality_score?.score || null,
          body: t ? (t.components || []).find(c => c.type === 'BODY')?.text || '' : '', buttons: t ? ((t.components || []).find(c => c.type === 'BUTTONS')?.buttons || []).map(b => `${b.type === 'QUICK_REPLY' ? '↩' : b.type === 'URL' ? '🔗' : b.type === 'PHONE_NUMBER' ? '📞' : ''} ${b.text}`) : [] }
      })
      const extra = live.filter(t => !EXPECTED.some(e => e.name === t.name)).map(t => ({ name: t.name, used: '(not used by HQ)', found: true, status: t.status, category: t.category, language: t.language, rejected_reason: t.rejected_reason || null, body: (t.components || []).find(c => c.type === 'BODY')?.text || '', buttons: ((t.components || []).find(c => c.type === 'BUTTONS')?.buttons || []).map(b => b.text) }))
      return send(res, 200, { templates: [...rows, ...extra] })
    }
    if (body.action === 'quotation') {
      // The Quotations page made the PDF in the browser; keep it in a public bucket so Meta can fetch it as the document header.
      const b64 = String(body.pdf_base64 || '')
      if (!b64 || b64.length > 6_000_000) return send(res, 400, { error: b64 ? 'That PDF is too big to send this way (over ~4 MB).' : 'No PDF received.' })
      const pdf = Buffer.from(b64, 'base64')
      const safe = String(body.quote_no || 'quotation').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')
      const path = `quotations/${safe}-${Date.now()}.pdf`
      let stored = false
      for (const bucket of ['wa-docs', 'gst-reports']) {
        const up = await busy.storage.from(bucket).upload(path, pdf, { contentType: 'application/pdf', upsert: true })
        if (!up.error) { stored = true; break }
      }
      if (!stored) return send(res, 500, { error: 'Could not store the PDF (no bucket wa-docs / gst-reports).' })
      // Template quotation_sent (as Shishir made it): Quotation banner header + a "PDF Copy" quick reply; the tap sends the stored PDF.
      const out = await sendLogged(busy, { kind: 'quotation', to: body.phone, template: 'quotation_sent',
        params: [String(body.name || 'Customer'), String(body.quote_no || ''), niceDate(body.date), Number(body.total || 0).toLocaleString('en-IN')],
        opts: { headerImageUrl: BANNER('quotation'), buttonPayloads: [`quote:${path}`] }, ref: String(body.quote_no || ''), refName: String(body.name || ''), by: me.name })
      if (out.status !== 'sent') return send(res, 502, { error: out.error || out.status })
      return send(res, 200, { ok: true, messageId: out.id })
    }
    if (body.action === 'log-summary') {
      const since = new Date(Date.now() - 7 * 86400e3).toISOString()
      const r = await busy.from('wa_log').select('kind, status').gte('created_at', since).limit(5000)
      const sum = {}
      for (const x of r.data || []) { const k = sum[x.kind] || (sum[x.kind] = { sent: 0, delivered: 0, read: 0, failed: 0, other: 0 }); k[['sent', 'delivered', 'read', 'failed'].includes(x.status) ? x.status : 'other']++ }
      return send(res, 200, { days: 7, summary: sum })
    }
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
      if (body.status === 'after_send') q = q.not('after_send', 'is', null)
      else if (body.status === 'revised') q = q.gt('revision', 0)
      else if (body.status) q = q.eq('status', String(body.status))
      const [r, p] = await Promise.all([q, busy.from('wa_settings').select('value').eq('key', PAUSE_KEY).maybeSingle()])
      if (r.error) return send(res, 500, { error: r.error.message })
      return send(res, 200, { rows: r.data || [], paused: p.data?.value === 'true' })
    }
    if (body.action === 'outbox-pause') {
      // One switch for every customer transaction message (invoice, receipt, notes, payment, purchase, order).
      const on = body.on === true
      const r = await busy.from('wa_settings').upsert({ key: PAUSE_KEY, value: on ? 'true' : 'false', updated_at: new Date().toISOString() }, { onConflict: 'key' })
      if (r.error) return send(res, 500, { error: r.error.message })
      return send(res, 200, { ok: true, paused: on })
    }
    if (body.action === 'outbox-op') {
      // Per-row control while a message is waiting: hold (stop the clock), release, cancel, send now.
      const id = Number(body.id), op = String(body.op || '')
      const row = await busy.from('wa_outbox').select('id, status').eq('id', id).maybeSingle()
      if (row.error || !row.data) return send(res, 404, { error: 'Not found.' })
      const st = row.data.status
      const by = me.name, at = new Date().toISOString()
      let patch = null
      if (op === 'hold' && st === 'queued') patch = { status: 'held', error: `held by ${by}`, changed_at: at }
      else if (op === 'release' && st === 'held') patch = { status: 'queued', error: null, send_after: at, changed_at: at }
      else if (op === 'cancel' && ['queued', 'held', 'failed', 'no_billing'].includes(st)) patch = { status: 'cancelled', error: `cancelled by ${by}`, changed_at: at }
      else if (op === 'send-now' && ['queued', 'held', 'failed'].includes(st)) patch = { status: 'queued', error: null, send_after: at, changed_at: at }
      if (!patch) return send(res, 400, { error: `Cannot ${op.replace('-', ' ')} a message that is ${st}.` })
      const u = await busy.from('wa_outbox').update(patch).eq('id', id).eq('status', st)
      if (u.error) return send(res, 500, { error: u.error.message })
      if (op === 'send-now') { const t = await runOutbox(busy, { onlyId: id }); return send(res, 200, { ok: true, ...t }) }
      return send(res, 200, { ok: true })
    }
    if (body.action === 'sample-all') {
      // Every template that exists in WhatsApp Manager, one after another, to one number (customer ones need a Busy code).
      const code = String(body.code || '').replace(/\D/g, '')
      const name = code ? await ledgerNameByCode(busy, code) : ''
      if (code && !name) return send(res, 400, { error: 'No customer with that Busy code.' })
      const live = new Set((await listTemplates()).filter(t => t.status === 'APPROVED').map(t => t.name))
      const results = []
      for (const [t, spec] of Object.entries(SAMPLES)) {
        if (!live.has(t)) { results.push({ template: t, status: 'not created' }); continue }
        const needsCode = /^txn_|^order_dispatched|^quotation/.test(t)
        if (needsCode && !code) { results.push({ template: t, status: 'skipped (needs a Busy code)' }); continue }
        const out = await sendLogged(busy, { kind: 'test', to: body.phone, template: t, params: spec.params(needsCode ? name : 'Sample'), opts: spec.opts(code || '0'), by: 'test-all' })
        results.push({ template: t, status: out.status, error: out.error || null })
      }
      return send(res, 200, { results })
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
