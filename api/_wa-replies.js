import { createClient } from '@supabase/supabase-js'
import QRCode from 'qrcode'
import { qrCardPng } from './_qr-card.js'
import { loadStatement, buildLedgerPdf } from './_ledger-pdf.js'
import { replyText, replyMedia, recordIncoming, recordStatuses } from './_wa-inbox.js'
import { loadOrder, buildOrderPdf, loadInvoice, buildInvoicePdf } from './_doc-pdf.js'
import { buildOrdersSummaryPdf } from './_orders-pdf.js'
import { buildCollectionsSummaryPdf } from './_collections-pdf.js'
import { eveningSummary, dueListFor } from './collections.js'
import { buildDueListPdf } from './_duelist-pdf.js'
import { materialOverview } from './_orders/lib/material.js'
import { db as ordersDb } from './_orders/lib/db.js'

// Answers the quick-reply buttons on the payment-reminder templates (QR Code / Ledger / Last 3 Invoices).
// Called from the WhatsApp webhook in api/whatsapp.js. Never throws to the caller.

const SUPABASE_BUSY_URL = 'https://jlkjjqnmhsgefpluemyz.supabase.co'
const HQ = 'https://hq.jcmretails.com'

// Same merchant details Busy prints in the QR on every invoice. Change here only.
const UPI = {
  pa: '7415277521-1@okbizaxis',
  pn: 'J C MITTAL AND SONS',
  mc: '5732',
  aid: 'uGICAgIC_9KuFXw',
  tr: 'BCR2DN6TQ7PITK3E',
}

// Busy's own format: upi://pay?pa=…&pn=…&mc=…&aid=…&tr=…&tn=<party name, 20 chars>
export function noteName(partyName) {
  return String(partyName || '').replace(/[\u0000-\u001f\u007f<>&=#%]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 20).trim()
}

export function upiString(partyName) {
  const tn = noteName(partyName)
  return `upi://pay?pa=${UPI.pa}&pn=${UPI.pn}&mc=${UPI.mc}&aid=${UPI.aid}&tr=${UPI.tr}&tn=${tn}`
}

// Plain QR (black on white). Used inside the decorated card below.
export async function qrPlain(partyName, width = 700) {
  return QRCode.toBuffer(upiString(partyName), { type: 'png', width, margin: 0, errorCorrectionLevel: 'M' })
}

// The payment card (api/_qr-card.js): the customer's own UPI QR + bank details, in the JCM document style.
export async function qrPng(partyName) {
  return qrCardPng({ upi: upiString(partyName), note: noteName(partyName), upiId: UPI.pa })
}

function busyClient() {
  const key = process.env.SUPABASE_BUSY_SERVICE_ROLE_KEY
  if (!key) return null
  return createClient(SUPABASE_BUSY_URL, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

const NAME_COLS = ['party_name', 'name', 'customer_name', 'account_name']

// Ledger name of the customer a reminder was sent about (by Busy code). Never looked up from a phone number.
export async function ledgerNameByCode(busy, code) {
  const n = Number(code)
  if (!Number.isFinite(n)) return ''
  const { data } = await busy.from('customers').select('*').eq('party_code', n).limit(1)
  const row = (data || [])[0]
  if (!row) return ''
  for (const c of NAME_COLS) if (row[c] && String(row[c]).trim()) return String(row[c]).trim()
  return ''
}

export { busyClient }

const PORTAL = 'https://invoice.jcmretails.com'
const pick = (cols, names) => names.find(n => cols.includes(n)) || null
const rupees = n => '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0))
const niceDate = v => {
  const d = new Date(v)
  return Number.isNaN(+d) ? String(v || '').slice(0, 10) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}

// The customer's latest bills (invoices table, by Busy code) as a WhatsApp message.
export async function lastInvoicesText(busy, code, name) {
  const probe = await busy.from('invoices').select('*').limit(1)
  const cols = Object.keys(probe.data?.[0] || {})
  const dateCol = pick(cols, ['vch_date', 'invoice_date', 'date']) || 'vch_date'
  const noCol = pick(cols, ['vch_no', 'voucher_no', 'invoice_no', 'bill_no', 'vch_number'])
  const amtCol = pick(cols, ['total_amount', 'amount', 'net_amount', 'invoice_value'])
  const r = await busy.from('invoices').select('*').eq('party_code', Number(code)).order(dateCol, { ascending: false }).limit(3)
  if (r.error) throw new Error(r.error.message)
  const rows = r.data || []
  const link = `${PORTAL}`
  if (!rows.length) {
    return `*${name}*\nWe could not find recent bills on your account here. Our team will share them with you shortly.\n\nInvoice portal: ${link}`
  }
  const lines = rows.map((x, i) => `${i + 1}. ${niceDate(x[dateCol])}  •  ${noCol ? x[noCol] : x.vch_code}${amtCol ? `  •  *${rupees(x[amtCol])}*` : ''}`)
  return `*Your last ${rows.length === 1 ? 'invoice' : rows.length + ' invoices'}*\n${name}\n\n${lines.join('\n')}\n\nView and download all your invoices:\n${link}\n\n*आपके पिछले बिल ऊपर दिए गए हैं। सभी बिल देखने और डाउनलोड करने के लिए ऊपर का लिंक खोलें।*`
}

const WHICH = [
  [/qr/i, 'qr'],
  [/ledger/i, 'ledger'],
  [/invoice|bill/i, 'invoices'],
]

// Button payloads we put on messages:
//   "qr:<code>", "ledger:<code>", "inv:<code>", "portal:<code>"   (code = the customer's Busy account code)
//   "so:<code>:<order no>"        Order copy  (txn_order)         → PDF of the sales order from JCM Orders
//   "invpdf:<code>:<invoice no>"  Invoice PDF (order_dispatched*) → PDF copy from the invoice portal's tables
//   "orders:<YYYY-MM-DD>"         Summary PDF (staff_orders_pending, 17:30) → live orders & material report; staff numbers only
//   "duelist:<profiles.id>"       Due List PDF (staff_followup_morning, 10:00) → that person's list with phones + Call; them or admins only
//   "collect:<YYYY-MM-DD>"        Summary PDF (staff_followup_evening, 19:00) → live collections summary; staff numbers only
function parsePayload(payload) {
  const p = String(payload || '')
  let m = /^(qr|ledger|inv|portal):(\d{1,9})$/.exec(p)
  if (m) return { kind: m[1] === 'inv' ? 'invoices' : m[1], code: m[2] }
  m = /^(so|invpdf):(\d{1,9}):(.{1,60})$/.exec(p)
  if (m) return { kind: m[1], code: m[2], ref: m[3] }
  m = /^duelist:([0-9a-f-]{36})$/i.exec(p)
  if (m) return { kind: 'duelist', code: '0', ref: m[1] }
  m = /^(orders|collect):(\d{4}-\d{2}-\d{2})$/.exec(p)
  if (m) return { kind: m[1], code: '0', ref: m[2] }
  m = /^quote:(.{1,110})$/.exec(p)
  return m ? { kind: 'quote', code: '0', ref: m[1] } : null
}
const hqClient = () => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  return key ? createClient('https://cmtnzmfuasniicsdxyle.supabase.co', key, { auth: { autoRefreshToken: false, persistSession: false } }) : null
}
const safeName = name => name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'JCM'


export async function handleIncoming(value) {
  const busy = busyClient()
  // Everything first goes into the inbox (wa_messages); statuses update the log. Never stops a reply.
  try { if (busy) { await recordIncoming(busy, value); await recordStatuses(busy, value) } } catch (err) { console.error('wa inbox record failed:', err.message) }
  const sendText = (to, text) => replyText(busy, to, text)
  const sendMedia = (to, buf, opts) => replyMedia(busy, to, buf, opts)
  try {
    for (const m of value?.messages || []) {
      const payload = m.button?.payload || m.interactive?.button_reply?.id || ''
      const label = m.button?.text || m.interactive?.button_reply?.title || ''
      const parsed = parsePayload(payload)
      const kindByLabel = (WHICH.find(([re]) => re.test(label)) || [])[1]
      // A typed message (not a button) is for a person to answer from the Inbox page.
      if (!parsed && !kindByLabel) continue
      const from = m.from
      console.log(`wa reply: button="${label}" payload=${payload ? 'yes' : 'none'}`)
      if (parsed?.kind === 'quote') {
        // "PDF Copy" on a quotation: the PDF was stored when it was sent (quote:<storage path>, or quote:sample).
        let pdf = null
        if (parsed.ref === 'sample') { try { pdf = Buffer.from(await (await fetch(`${HQ}/wa/sample-quotation.pdf`)).arrayBuffer()) } catch { pdf = null } }
        else for (const bucket of ['wa-docs', 'gst-reports']) { const d = await busy.storage.from(bucket).download(parsed.ref); if (!d.error && d.data) { pdf = Buffer.from(await d.data.arrayBuffer()); break } }
        if (!pdf) await sendText(from, 'Thank you. Our team will send the quotation PDF to you here shortly.')
        else await sendMedia(from, pdf, { kind: 'document', mime: 'application/pdf', filename: `JCM-${(parsed.ref.split('/').pop() || 'Quotation.pdf').replace(/-\d{13}\.pdf$/, '.pdf')}`, caption: '*Your quotation is attached.*\n*आपका कोटेशन संलग्न है।*' })
        continue
      }
      if (parsed?.kind === 'duelist') {
        // One person's follow-up list: only that person (their WhatsApp in Manage Users) or an admin gets it.
        const hq = hqClient()
        const ten = String(from).slice(-10)
        const { data: people } = hq ? await hq.from('profiles').select('id, whatsapp, active, is_admin, role') : { data: [] }
        const mine = p => p.active !== false && String(p.whatsapp || '').replace(/\D/g, '').slice(-10) === ten
        const ok = (people || []).some(p => mine(p) && (p.id === parsed.ref || p.is_admin === true || p.role === 'admin'))
        if (!ok) { await sendText(from, 'This list is for JCM staff only.'); continue }
        try {
          const data = await dueListFor(busy, hq, parsed.ref)
          const pdf = await buildDueListPdf(data, new Date())
          const first = (data.person?.name || 'Staff').split(' ')[0].replace(/[^A-Za-z0-9]+/g, '')
          await sendMedia(from, pdf, { kind: 'document', mime: 'application/pdf', filename: `JCM-Followups-${first}-${new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)}.pdf`,
            caption: data.list.length ? `*${data.list.length} follow-ups, Rs. ${Math.round(data.total).toLocaleString('en-IN')} due.* Tap Call next to each party.` : '*Your list is clear today.*' })
        } catch (err) {
          console.error('due list pdf failed:', err)
          await sendText(from, 'Could not make your list right now. Open Payment Follow-up in JCM HQ.')
        }
        continue
      }
      if (parsed?.kind === 'orders' || parsed?.kind === 'collect') {
        // Internal reports: answer only numbers that belong to an active HQ person (Manage Users → WhatsApp).
        const hq = hqClient()
        const ten = String(from).slice(-10)
        const { data: people } = hq ? await hq.from('profiles').select('whatsapp, active').not('whatsapp', 'is', null) : { data: [] }
        const staff = (people || []).some(p => p.active !== false && String(p.whatsapp || '').replace(/\D/g, '').slice(-10) === ten)
        if (!staff) { await sendText(from, 'This report is for JCM staff only.'); continue }
        const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)
        try {
          if (parsed.kind === 'orders') {
            const pdf = await buildOrdersSummaryPdf(await materialOverview(ordersDb()), new Date())
            await sendMedia(from, pdf, { kind: 'document', mime: 'application/pdf', filename: `JCM-Orders-Material-${day}.pdf`, caption: '*Orders & material — as on now.*' })
          } else {
            const pdf = await buildCollectionsSummaryPdf(await eveningSummary(busy, hq, day), new Date())
            await sendMedia(from, pdf, { kind: 'document', mime: 'application/pdf', filename: `JCM-Collections-${day}.pdf`, caption: '*Collections summary — as on now.*' })
          }
        } catch (err) {
          console.error(`${parsed.kind} summary pdf failed:`, err)
          await sendText(from, `Could not make the summary right now. Open ${parsed.kind === 'orders' ? 'Material' : 'Payment Follow-up'} in JCM HQ.`)
        }
        continue
      }
      const name = parsed && busy ? await ledgerNameByCode(busy, parsed.code) : ''
      if (!parsed || !name) {
        // Old message without a customer code, or the code is unknown: never guess from the phone number.
        await sendText(from, 'Thank you. Our team will send this to you here shortly.')
        continue
      }
      if (parsed.kind === 'qr') {
        const png = await qrPng(name)
        await sendMedia(from, png, {
          kind: 'image', mime: 'image/png', filename: 'JCM-payment-details.png',
          caption: '*Scan the QR to pay, or use the bank details.*\nAfter paying, please send the payment screenshot here.\n*भुगतान के बाद कृपया भुगतान की जानकारी यहाँ भेजें।*',
        })
      } else if (parsed.kind === 'ledger') {
        const stmt = await loadStatement(busy, parsed.code)
        if (!stmt) {
          await sendText(from, 'Thank you. Our team will send your ledger to you here shortly.')
        } else {
          const pdf = await buildLedgerPdf({ partyName: name, stmt })
          const safe = name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'Account'
          await sendMedia(from, pdf, {
            kind: 'document', mime: 'application/pdf', filename: `JCM-Ledger-${safe}.pdf`,
            caption: '*Your ledger statement is attached.*\n*आपका लेजर विवरण संलग्न है।*',
          })
        }
      } else if (parsed.kind === 'portal') {
        // Retail reminders: no list of bills, just the way to see them all.
        await sendText(from, `*${name}*\nYou can view and download all your invoices here:\n${PORTAL}\n\nPlease log in with your registered mobile number.\n\n*अपने सभी बिल देखने और डाउनलोड करने के लिए ऊपर दिया गया लिंक खोलें। लॉगिन के लिए अपना रजिस्टर्ड मोबाइल नंबर इस्तेमाल करें।*`)
      } else if (parsed.kind === 'invoices') {
        await sendText(from, await lastInvoicesText(busy, parsed.code, name))
      } else if (parsed.kind === 'so') {
        const hq = hqClient()
        const data = hq ? await loadOrder(hq, parsed.ref) : null
        if (!data) await sendText(from, `*${name}*\nOur team will send you a copy of order ${parsed.ref} here shortly.`)
        else {
          const pdf = await buildOrderPdf({ partyName: name, ...data })
          await sendMedia(from, pdf, { kind: 'document', mime: 'application/pdf', filename: `JCM-Order-${safeName(parsed.ref)}.pdf`,
            caption: `*Copy of your order ${parsed.ref} is attached.*\n*आपके ऑर्डर की कॉपी संलग्न है।*` })
        }
      } else if (parsed.kind === 'invpdf') {
        const data = await loadInvoice(busy, parsed.ref)
        if (!data) await sendText(from, `*${name}*\nInvoice ${parsed.ref} will be on the portal by tomorrow morning:\n${PORTAL}\n\nPlease log in with your registered mobile number.`)
        else {
          const pdf = await buildInvoicePdf({ partyName: name, ...data })
          await sendMedia(from, pdf, { kind: 'document', mime: 'application/pdf', filename: `JCM-Invoice-${safeName(parsed.ref)}.pdf`,
            caption: `*Copy of invoice ${parsed.ref} is attached.*\n*आपके बिल की कॉपी संलग्न है।*` })
        }
      } else {
        await sendText(from, 'Thank you. Our team will send this to you here shortly.')
      }
    }
  } catch (err) {
    console.error('wa reply error:', err.message)
    for (const m of value?.messages || []) {
      try { await sendText(m.from, 'Thank you. Our team will send this to you here shortly.') } catch (e2) { console.error('wa fallback error:', e2.message) }
    }
  }
}
