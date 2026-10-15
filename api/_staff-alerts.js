// Staff alerts (2026-10-15, HQ Requests) — documents sent on WhatsApp to chosen staff and to extra
// numbers of people who are not HQ staff (e.g. a brand's installation / warranty person).
//
// 1. Email Purchase Summary, brand-wise: each invoice that arrives by email (email_bills, doc_kind
//    'invoice', notify_state 'pending') goes to the people + numbers set on its brand in "Brands & mails"
//    (email_bill_senders.notify_profiles / notify_numbers; all sender rows of the same brand count).
//    Template staff_purchase_pdf: DOCUMENT header = the brand's PDF (or one we draw for mail-text bills),
//    {{1}} supplier {{2}} invoice no {{3}} total {{4}} "Mail from <brand> · <time>". Kind staff_email_bill.
//    No one set yet → the bill waits (up to 24 h) so setting people the same day still sends it.
//
// 2. Item-group invoice alerts: a SALES invoice holding an item from a chosen Busy item group (or a group
//    under it, by item_group_map.group_path) goes to that rule's people + numbers as the invoice PDF.
//    Template staff_invoice_copy: DOCUMENT header = invoice PDF (api/_doc-pdf.js), {{1}} item group
//    {{2}} customer {{3}} customer mobile {{4}} invoice no {{5}} date {{6}} the matching items. Kind
//    staff_invoice_alert. Invoices are found through wa_outbox (kind invoice, after its 15-min settle),
//    only ones queued after the rule was made; a rule never sends the same invoice twice
//    (item_alert_log unique rule + invoice). Until the template is approved the rows wait (24 h).
//
// Both run from tick() in api/whatsapp.js (every 5 min). Rules are edited on WhatsApp → Invoice alerts
// (actions alerts-get / alert-save / alert-remove) and in Email Purchase Summary → Brands & mails.
import { createClient } from '@supabase/supabase-js'
import { sendLogged, toWaNumber, inr, niceDate } from './_wa-cloud.js'
import { loadInvoice, buildInvoicePdf } from './_doc-pdf.js'
import { buildPurchasePdf } from './_purchase-pdf.js'

const CRM_URL = 'https://cmtnzmfuasniicsdxyle.supabase.co'
const NOT_APPROVED = /132001|does not exist|not found|template name/i
const DAY = 24 * 3600e3
export const INVOICE_TEMPLATE = 'staff_invoice_copy'
export const EMAIL_TEMPLATE = 'staff_purchase_pdf'

// A template that is not approved yet is tried again every 30 min, not every tick (keeps WhatsApp → Log clean).
async function templateResting(busy, template) {
  const r = await busy.from('wa_settings').select('value').eq('key', `retry_after:${template}`).maybeSingle()
  return !!(r.data?.value && Date.parse(r.data.value) > Date.now())
}
async function restTemplate(busy, template) {
  await busy.from('wa_settings').upsert({ key: `retry_after:${template}`, value: new Date(Date.now() + 30 * 60e3).toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'key' })
}

const crm = () => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  return key ? createClient(CRM_URL, key, { auth: { autoRefreshToken: false, persistSession: false } }) : null
}

export async function staffPeople(hq = crm()) {
  if (!hq) return []
  const r = await hq.from('profiles').select('id, name, email, whatsapp, active, is_admin, role').order('name')
  return (r.data || []).filter(p => p.active !== false).map(p => ({
    id: p.id, name: p.name || p.email || 'Someone', whatsapp: p.whatsapp || null, admin: p.is_admin === true || p.role === 'admin',
  }))
}

// [{name, number}] from what the page sent: keeps only numbers WhatsApp can take, at most 10.
export function cleanNumbers(list) {
  const out = []
  for (const x of Array.isArray(list) ? list : []) {
    const number = toWaNumber(x?.number)
    if (!number || out.some(o => o.number === number)) continue
    out.push({ name: String(x?.name || '').trim().slice(0, 60) || null, number })
    if (out.length >= 10) break
  }
  return out
}
const cleanIds = ids => [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(s => /^[0-9a-f-]{36}$/i.test(s)))].slice(0, 30)

// Everyone a rule reaches, one entry per WhatsApp number.
function recipients(profileIds, numbers, people) {
  const out = new Map()
  for (const id of profileIds || []) {
    const p = people.find(x => x.id === id)
    const n = p && toWaNumber(p.whatsapp)
    if (n && !out.has(n)) out.set(n, p.name)
  }
  for (const x of numbers || []) { const n = toWaNumber(x.number); if (n && !out.has(n)) out.set(n, x.name || 'Extra number') }
  return [...out].map(([number, name]) => ({ number, name }))
}

async function storePdf(busy, path, pdf) {
  for (const bucket of ['wa-docs', 'gst-reports']) {
    const up = await busy.storage.from(bucket).upload(path, pdf, { contentType: 'application/pdf', upsert: true })
    if (!up.error) return busy.storage.from(bucket).getPublicUrl(path).data.publicUrl
  }
  throw new Error('could not store the PDF (bucket wa-docs missing)')
}
const safe = s => String(s || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const timeIST = iso => iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : ''

// ---- 1. Email bills, brand-wise ---------------------------------------------------------------
export async function runEmailAlerts(busy, switches) {
  const old = new Date(Date.now() - DAY).toISOString()
  await busy.from('email_bills').update({ notify_state: 'skipped', notify_note: 'older than 24 h when looked at' })
    .eq('notify_state', 'pending').lt('created_at', old)
  const pend = await busy.from('email_bills').select('*').eq('notify_state', 'pending').eq('doc_kind', 'invoice').order('created_at').limit(20)
  if (pend.error) throw new Error(`email bills: ${pend.error.message}`)
  if (!(pend.data || []).length) return { pending: 0 }
  if (await templateResting(busy, EMAIL_TEMPLATE)) return { pending: pend.data.length, waitingFor: EMAIL_TEMPLATE }
  const [snd, people] = await Promise.all([busy.from('email_bill_senders').select('match, brand, notify_profiles, notify_numbers'), staffPeople()])
  const senders = snd.data || []
  const counts = { sent: 0, waiting: 0, failed: 0 }
  for (const b of pend.data) {
    const mine = senders.filter(s => (b.brand && s.brand && s.brand.toLowerCase() === b.brand.toLowerCase()) || (b.sender && String(b.sender).toLowerCase().includes(s.match)))
    const to = recipients(mine.flatMap(s => s.notify_profiles || []), mine.flatMap(s => s.notify_numbers || []), people)
    if (!to.length) { counts.waiting++; continue }
    const claim = await busy.from('email_bills').update({ notify_state: 'sending' }).eq('id', b.id).eq('notify_state', 'pending').select('id')
    if (claim.error || !(claim.data || []).length) continue
    let url, filename
    try {
      if (b.attachment_path) {
        const s = await busy.storage.from('email-bills').createSignedUrl(b.attachment_path, 7 * 24 * 3600)
        if (s.error) throw new Error(s.error.message)
        url = s.data.signedUrl
        filename = b.attachment_name || `${safe(b.brand || b.supplier_name)}-${safe(b.invoice_no) || b.id}.pdf`
      } else {
        const l = await busy.from('email_bill_lines').select('*').eq('bill_id', b.id).order('sr_no')
        const lines = (l.data || []).map(x => ({ item_name: x.item_name, qty: x.qty, gst_rate: x.gst_rate, tax_amount: x.tax_amount, taxable: x.amount, rate_before_gst: x.rate }))
        const v = { vch_no: b.invoice_no, party_name: b.supplier_name || b.brand, bill_date: b.invoice_date, bill_total: b.bill_total, entered_at: b.received_at, vch_key: `email-${b.id}` }
        filename = `Invoice-${safe(b.invoice_no) || b.id}-${safe(b.supplier_name || b.brand)}.pdf`
        url = await storePdf(busy, `email-bills/${b.id}-${Date.now()}.pdf`, await buildPurchasePdf(v, lines, 'Email (no PDF attached)'))
      }
    } catch (err) {
      await busy.from('email_bills').update({ notify_state: 'failed', notify_note: `PDF: ${String(err.message).slice(0, 200)}` }).eq('id', b.id)
      counts.failed++; continue
    }
    const params = [b.supplier_name || b.brand || 'Supplier', b.invoice_no || '—', inr(b.bill_total), `Mail from ${b.brand || b.sender || 'brand'} · ${timeIST(b.received_at)}`]
    let ok = 0, notApproved = false
    const errs = []
    for (const r of to) {
      const out = await sendLogged(busy, { kind: 'staff_email_bill', to: r.number, template: EMAIL_TEMPLATE, params,
        opts: { headerDocumentUrl: url, headerDocumentName: filename }, ref: `email_bill:${b.id}`, refName: r.name, by: 'HQ email bills', switches })
      if (out.status === 'sent') ok++
      else { errs.push(`${r.name}: ${out.error || out.status}`); if (NOT_APPROVED.test(out.error || '')) { notApproved = true; break } }
    }
    const state = notApproved ? 'pending' : ok === to.length ? 'sent' : ok ? 'partly' : 'failed'
    await busy.from('email_bills').update({ notify_state: state, notified_at: ok ? new Date().toISOString() : null,
      notify_note: `${ok} of ${to.length} sent${errs.length ? ' · ' + errs.join('; ').slice(0, 300) : ''}` }).eq('id', b.id)
    counts[state === 'sent' || state === 'partly' ? 'sent' : notApproved ? 'waiting' : 'failed']++
    if (notApproved) { await restTemplate(busy, EMAIL_TEMPLATE); break }
  }
  return counts
}

// ---- 2. Sales invoices by item group ------------------------------------------------------------
const pathMatch = (path, rule) => path === rule || String(path || '').startsWith(rule + ' > ')

export async function runItemAlerts(busy, switches) {
  const rr = await busy.from('item_alert_rules').select('*').eq('enabled', true)
  if (rr.error) { if (/does not exist|relation/i.test(rr.error.message)) return { setup: false }; throw new Error(rr.error.message) }
  const rules = rr.data || []
  const counts = { looked: 0, queued: 0, sent: 0, waiting: 0, failed: 0 }
  if (rules.length) {
    const since = new Date(Math.max(Date.now() - 2 * DAY, Math.min(...rules.map(r => Date.parse(r.created_at))))).toISOString()
    const rows = await busy.from('wa_outbox').select('id, vch_no, vch_date, party_name, mobile, created_at, status')
      .eq('kind', 'invoice').is('item_alert_at', null).gte('created_at', since).lte('send_after', new Date().toISOString())
      .not('status', 'in', '(deleted,cancelled,held)').order('created_at').limit(80)
    if (rows.error) throw new Error(`outbox: ${rows.error.message}`)
    for (const row of rows.data || []) {
      const done = () => busy.from('wa_outbox').update({ item_alert_at: new Date().toISOString() }).eq('id', row.id)
      const inv = row.vch_no ? await loadInvoice(busy, row.vch_no) : null
      if (!inv || !inv.items.length) { if (Date.now() - Date.parse(row.created_at) > 3 * 3600e3) await done(); continue } // invoices-live brings it within minutes
      counts.looked++
      if (!Number(inv.invoice.total_amount)) { await done(); continue } // cancelled bill
      const codes = [...new Set(inv.items.map(l => l.item_code).filter(c => c != null))]
      const m = codes.length ? await busy.from('item_group_map').select('code, group_path').in('code', codes) : { data: [] }
      const pathOf = new Map((m.data || []).map(x => [String(x.code), x.group_path]))
      // An item made in Busy today is not in item_group_map until the night items sync: wait for it (up to 20 h).
      const unknown = codes.filter(c => !pathOf.has(String(c)))
      if (unknown.length) {
        const it = await busy.from('items').select('code, category_path').in('code', unknown)
        for (const x of it.data || []) if (x.category_path) pathOf.set(String(x.code), x.category_path)
        if (codes.some(c => !pathOf.has(String(c))) && Date.now() - Date.parse(row.created_at) < 20 * 3600e3) continue
      }
      for (const rule of rules) {
        if (Date.parse(rule.created_at) > Date.parse(row.created_at)) continue
        const hits = inv.items.filter(l => pathMatch(pathOf.get(String(l.item_code)), rule.group_path))
        if (!hits.length) continue
        const lines = hits.map(l => `${l.item_name} × ${Number(l.qty) || 0}`).join(', ')
        const ins = await busy.from('item_alert_log').upsert({ rule_id: rule.id, vch_no: row.vch_no, vch_date: row.vch_date || inv.invoice.vch_date,
          party_name: row.party_name || inv.invoice.customer_name, mobile: row.mobile || inv.invoice.customer_mobile, group_path: rule.group_path, lines: lines.slice(0, 600) },
        { onConflict: 'rule_id,vch_no', ignoreDuplicates: true }).select('id')
        if (!ins.error && (ins.data || []).length) counts.queued++
      }
      await done()
    }
  }
  // Send what is waiting.
  await busy.from('item_alert_log').update({ status: 'expired', error: 'not sent within 24 h' }).eq('status', 'pending').lt('created_at', new Date(Date.now() - DAY).toISOString())
  const pend = await busy.from('item_alert_log').select('*').eq('status', 'pending').order('created_at').limit(20)
  if (!(pend.data || []).length) return counts
  if (await templateResting(busy, INVOICE_TEMPLATE)) return { ...counts, waitingFor: INVOICE_TEMPLATE }
  const allRules = (await busy.from('item_alert_rules').select('*')).data || []
  const people = await staffPeople()
  const pdfs = new Map()
  for (const a of pend.data) {
    const rule = allRules.find(r => r.id === a.rule_id)
    const to = rule ? recipients(rule.profile_ids, rule.extra_numbers, people) : []
    if (!to.length) { await busy.from('item_alert_log').update({ status: 'no_one', error: 'nobody with a WhatsApp number on this rule' }).eq('id', a.id); continue }
    const claim = await busy.from('item_alert_log').update({ status: 'sending' }).eq('id', a.id).eq('status', 'pending').select('id')
    if (claim.error || !(claim.data || []).length) continue
    let doc = pdfs.get(a.vch_no)
    try {
      if (!doc) {
        const inv = await loadInvoice(busy, a.vch_no)
        if (!inv) throw new Error('invoice not in HQ')
        const name = inv.invoice.customer_name || a.party_name || 'Customer'
        const pdf = await buildInvoicePdf({ partyName: name, ...inv })
        doc = { url: await storePdf(busy, `alerts/${safe(a.vch_no)}-${Date.now()}.pdf`, pdf), filename: `JCM-Invoice-${safe(a.vch_no)}.pdf` }
        pdfs.set(a.vch_no, doc)
      }
    } catch (err) {
      await busy.from('item_alert_log').update({ status: 'failed', error: `PDF: ${String(err.message).slice(0, 200)}` }).eq('id', a.id)
      counts.failed++; continue
    }
    const group = String(a.group_path || '').split(' > ').pop()
    const params = [group, a.party_name || 'Customer', a.mobile ? String(a.mobile).slice(0, 40) : 'not given', a.vch_no, niceDate(a.vch_date), a.lines || '—']
    let ok = 0, notApproved = false
    const errs = []
    for (const r of to) {
      const out = await sendLogged(busy, { kind: 'staff_invoice_alert', to: r.number, template: INVOICE_TEMPLATE, params,
        opts: { headerDocumentUrl: doc.url, headerDocumentName: doc.filename }, ref: `item_alert:${a.vch_no}`, refName: r.name, by: 'HQ item alerts', switches })
      if (out.status === 'sent') ok++
      else { errs.push(`${r.name}: ${out.error || out.status}`); if (NOT_APPROVED.test(out.error || '')) { notApproved = true; break } }
    }
    const status = notApproved ? 'pending' : ok === to.length ? 'sent' : ok ? 'partly' : 'failed'
    await busy.from('item_alert_log').update({ status, recipients: to.length, sent: ok, sent_at: ok ? new Date().toISOString() : null,
      error: notApproved ? `waiting for template ${INVOICE_TEMPLATE} to be approved in WhatsApp Manager` : errs.join('; ').slice(0, 400) || null }).eq('id', a.id)
    counts[status === 'sent' || status === 'partly' ? 'sent' : notApproved ? 'waiting' : 'failed']++
    if (notApproved) { await restTemplate(busy, INVOICE_TEMPLATE); break } // same answer for every row until it is approved
  }
  return counts
}

// ---- Rules (WhatsApp → Invoice alerts) -----------------------------------------------------------
export async function alertsGet(busy) {
  const [rules, groups, log, people] = await Promise.all([
    busy.from('item_alert_rules').select('*').order('group_path'),
    busy.from('item_groups').select('code, name, full_path, depth').order('full_path'),
    busy.from('item_alert_log').select('*').order('created_at', { ascending: false }).limit(80),
    staffPeople(),
  ])
  if (rules.error) throw new Error(rules.error.message)
  return { rules: rules.data || [], groups: groups.data || [], log: log.data || [], people, template: INVOICE_TEMPLATE }
}

export async function alertSave(busy, body, me) {
  const path = String(body.group_path || '').trim()
  const g = await busy.from('item_groups').select('code, full_path').eq('full_path', path).maybeSingle()
  if (!g.data) throw Object.assign(new Error('Pick an item group from the list.'), { status: 400 })
  const row = {
    group_code: g.data.code, group_path: path, profile_ids: cleanIds(body.profile_ids), extra_numbers: cleanNumbers(body.extra_numbers),
    note: String(body.note || '').trim().slice(0, 200) || null, enabled: body.enabled !== false, updated_by: me.name, updated_at: new Date().toISOString(),
  }
  if (!row.profile_ids.length && !row.extra_numbers.length) throw Object.assign(new Error('Tick at least one person or add a mobile number.'), { status: 400 })
  const id = Number(body.id) || null
  const r = id
    ? await busy.from('item_alert_rules').update(row).eq('id', id).select('id')
    : await busy.from('item_alert_rules').insert({ ...row, created_by: me.name }).select('id')
  if (r.error) throw Object.assign(new Error(/duplicate/i.test(r.error.message) ? 'That item group already has a rule — edit it instead.' : r.error.message), { status: 400 })
  return { ok: true, id: r.data?.[0]?.id }
}

export async function alertRemove(busy, body) {
  const r = await busy.from('item_alert_rules').delete().eq('id', Number(body.id))
  if (r.error) throw new Error(r.error.message)
  return { ok: true }
}
