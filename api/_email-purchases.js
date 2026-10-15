// Email Purchase Summary — the brand invoices that arrive by email, read by
// busy-sync/sync-email-purchases.js on JCM-Server (Gmail → Claude → Supabase).
// Served from api/purchases.js (actions starting with "email-") so no extra Vercel
// function is needed. Tables email_bills / email_bill_lines / email_scan_mails /
// email_bill_senders / email_bill_settings in the Busy project; PDFs in the private
// Storage bucket email-bills. All closed to the browser.
//
// Access: admins, or anyone with 'email-purchases' in profiles.allowed_tabs.
// Actions (POST JSON, via /api/purchases):
//   email-count                         invoices received today (sidebar badge)
//   email-list from, to, by, q, kind    bills with item lines + totals (by = received | invoice)
//   email-pdf  id                       the stored PDF (base64) for the in-app viewer
//   email-senders                       sender list + settings + recent mails looked at
//   email-sender-save match, brand, enabled, remove
//   email-mail-retry message_id         read a mail again next run

const TAB_ID = 'email-purchases'
const MAX_BILLS = 300
const BUCKET = 'email-bills'

const IST_MS = 5.5 * 3600 * 1000
const todayIST = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10)
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
function nextDay(d) {
  const t = new Date(`${d}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + 1)
  return t.toISOString().slice(0, 10)
}
const startIST = d => `${d}T00:00:00+05:30`

function check({ data, error }, what) {
  if (error) { const e = new Error(`${what}: ${error.message}`); e.db = true; throw e }
  return data
}

export function emailTabId() { return TAB_ID }

export async function handleEmailAction(action, body, ctx) {
  const { busy, me, send, res } = ctx
  if (action === 'email-count') return send(res, 200, await countToday(busy))
  if (action === 'email-list') return send(res, 200, await list(busy, body))
  if (action === 'email-pdf') return send(res, 200, await pdf(busy, body))
  if (action === 'email-senders') return send(res, 200, await senders(busy))
  if (action === 'email-sender-save') return send(res, 200, await senderSave(busy, body, me))
  if (action === 'email-mail-retry') return send(res, 200, await mailRetry(busy, body))
  return send(res, 400, { error: 'Unknown request.' })
}

async function countToday(busy) {
  const t = todayIST()
  const { count, error } = await busy.from('email_bills').select('id', { count: 'exact', head: true })
    .eq('doc_kind', 'invoice').gte('received_at', startIST(t)).lt('received_at', startIST(nextDay(t)))
  if (error) throw error
  return { today: count || 0 }
}

async function linesFor(busy, ids) {
  const out = []
  for (let i = 0; i < ids.length; i += 100) {
    out.push(...check(await busy.from('email_bill_lines').select('*').in('bill_id', ids.slice(i, i + 100))
      .order('bill_id').order('sr_no').limit(10000), 'lines'))
  }
  const by = {}
  for (const l of out) (by[l.bill_id] ||= []).push(l)
  return by
}

async function list(busy, body) {
  const today = todayIST()
  const from = isDate(body.from) ? body.from : today
  const to = isDate(body.to) && body.to >= from ? body.to : from
  const by = body.by === 'invoice' ? 'invoice' : 'received'
  const kind = ['invoice', 'notes', 'all'].includes(body.kind) ? body.kind : 'all'
  const q = String(body.q || '').trim().slice(0, 80)

  let query = busy.from('email_bills').select('*')
  if (by === 'invoice') query = query.gte('invoice_date', from).lte('invoice_date', to)
  else query = query.gte('received_at', startIST(from)).lt('received_at', startIST(nextDay(to)))
  if (kind === 'invoice') query = query.eq('doc_kind', 'invoice')
  if (kind === 'notes') query = query.neq('doc_kind', 'invoice')

  if (q) {
    const like = `%${q.replace(/[%_,()]/g, ' ')}%`
    const hits = check(await busy.from('email_bill_lines').select('bill_id').ilike('item_name', like).limit(1000), 'search')
    const ids = [...new Set(hits.map(h => h.bill_id))].slice(0, 300)
    const parts = [`supplier_name.ilike.${like}`, `brand.ilike.${like}`, `invoice_no.ilike.${like}`]
    if (ids.length) parts.push(`id.in.(${ids.join(',')})`)
    query = query.or(parts.join(','))
  }
  query = by === 'invoice'
    ? query.order('invoice_date', { ascending: false }).order('received_at', { ascending: false })
    : query.order('received_at', { ascending: false })
  const rows = check(await query.limit(MAX_BILLS + 1), 'list')
  const more = rows.length > MAX_BILLS
  if (more) rows.length = MAX_BILLS

  const [lines, settings] = await Promise.all([
    linesFor(busy, rows.map(r => r.id)),
    busy.from('email_bill_settings').select('last_sync_at, last_sync_note').eq('id', 1).maybeSingle(),
  ])
  const bills = rows.map(r => ({ ...r, raw_json: undefined, lines: lines[r.id] || [] }))
  const inv = bills.filter(b => b.doc_kind === 'invoice')
  const totals = {
    bills: inv.length,
    notes: bills.length - inv.length,
    parties: new Set(inv.map(b => b.brand || b.supplier_name)).size,
    items: inv.reduce((s, b) => s + (b.item_count || 0), 0),
    value: inv.reduce((s, b) => s + Number(b.bill_total || 0), 0),
    notesValue: bills.filter(b => b.doc_kind !== 'invoice').reduce((s, b) => s + Number(b.bill_total || 0), 0),
  }
  return { from, to, by, kind, bills, totals, more, lastSyncAt: settings.data?.last_sync_at || null, lastSyncNote: settings.data?.last_sync_note || null }
}

async function pdf(busy, body) {
  const id = parseInt(body.id, 10)
  const b = check(await busy.from('email_bills').select('id, attachment_path, attachment_name, supplier_name, invoice_no').eq('id', id).maybeSingle(), 'bill')
  if (!b) throw Object.assign(new Error('Bill not found.'), { status: 404 })
  if (!b.attachment_path) throw Object.assign(new Error('This one came as text in the mail, there is no PDF.'), { status: 400 })
  const dl = await busy.storage.from(BUCKET).download(b.attachment_path)
  if (dl.error) throw new Error(`reading PDF: ${dl.error.message}`)
  const buf = Buffer.from(await dl.data.arrayBuffer())
  const filename = b.attachment_name || `${(b.supplier_name || 'invoice').replace(/[^A-Za-z0-9]+/g, '-')}-${b.invoice_no || b.id}.pdf`
  return { base64: buf.toString('base64'), filename }
}

async function senders(busy) {
  const [s, settings, mails] = await Promise.all([
    busy.from('email_bill_senders').select('*').order('brand'),
    busy.from('email_bill_settings').select('*').eq('id', 1).maybeSingle(),
    busy.from('email_scan_mails').select('message_id, sender, subject, received_at, status, note, bills').order('received_at', { ascending: false }).limit(60),
  ])
  if (s.error) throw s.error
  return { senders: s.data || [], settings: settings.data || {}, mails: mails.data || [] }
}

async function senderSave(busy, body, me) {
  const match = String(body.match || '').trim().toLowerCase()
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$|^[a-z0-9.-]+\.[a-z]{2,}$/.test(match)) throw Object.assign(new Error('Type an email address (noreply@brand.com) or a domain (brand.com).'), { status: 400 })
  if (body.remove === true) {
    check(await busy.from('email_bill_senders').delete().eq('match', match), 'remove sender')
    return { ok: true }
  }
  const row = { match, enabled: body.enabled !== false, added_by: me.name }
  if (body.brand !== undefined) row.brand = String(body.brand || '').trim().slice(0, 80) || null
  check(await busy.from('email_bill_senders').upsert(row, { onConflict: 'match' }), 'save sender')
  return { ok: true }
}

async function mailRetry(busy, body) {
  const id = String(body.message_id || '')
  if (!id) throw Object.assign(new Error('Which mail?'), { status: 400 })
  check(await busy.from('email_scan_mails').update({ status: 'failed', note: 'read again (asked from HQ)' }).eq('message_id', id), 'retry')
  return { ok: true }
}
