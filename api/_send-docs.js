// Sending documents to ONE customer from an HQ page (2026-10-15): the ledger statement and an invoice copy.
// Used by the Customer Card (api/customers.js) and Payment Follow-up (api/collections.js).
//   sendLedger(busy, { party_code, phone }, by)         ledger PDF as template `ledger_statement` (see below)
//   sendInvoiceCopy(busy, { party_code, phone, vch_no }, by)
//        the invoice PDF (api/_doc-pdf.js, same copy the "PDF Copy" button sends). If the customer wrote to us in
//        the last 24 h the PDF goes straight into the chat; otherwise the approved `txn_invoice` template goes
//        (banner, invoice no./date/amount, QR Code + PDF Copy buttons — one tap on PDF Copy brings the PDF),
//        because a business-started message must be a template. Logged in wa_log kind 'invoice_copy'.
// Name always = the customer's LEDGER name from the Busy code (Shishir's rule); ledger-only accounts refused.
import { waConfigured, sendLogged, toWaNumber, niceDate, inr, BANNER } from './_wa-cloud.js'
import { loadStatement, buildLedgerPdf } from './_ledger-pdf.js'
import { ledgerNameByCode } from './_wa-replies.js'
import { replyMedia } from './_wa-inbox.js'
import { loadInvoice, buildInvoicePdf } from './_doc-pdf.js'

// ---- Ledger (moved from api/customers.js, built 2026-10-13) ----
const LEDGER_ONLY_CODES = new Set(['40355', '65494', '56680'])
const LEDGER_ONLY = /nexus enterprises|silver electric house|^cash\b/i
const LEDGER_TEMPLATE = 'ledger_statement'
const money2 = n => (Math.round(Math.abs(n) * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export async function sendLedger(busy, body, by) {
  if (!waConfigured()) return { error: 'WhatsApp is not set up in HQ yet.' }
  const code = String(Number(body.party_code) || '')
  if (!code || code === '0') return { error: 'No customer code.' }
  const number = toWaNumber(body.phone)
  if (!number) return { error: 'That is not a valid 10-digit mobile number.' }
  const name = await ledgerNameByCode(busy, code)
  if (!name) return { error: 'This customer is not in the Busy data.' }
  if (LEDGER_ONLY_CODES.has(code) || LEDGER_ONLY.test(name)) return { error: `${name} is a ledger-only account — its statement is not sent to anyone.` }
  const stmt = await loadStatement(busy, code)
  if (!stmt || !stmt.rows?.length) return { error: 'The ledger for this customer is not in HQ yet.' }

  const pdf = await buildLedgerPdf({ partyName: name, stmt })
  const safe = name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'Account'
  const filename = `JCM-Ledger-${safe}.pdf`
  const path = `ledgers/${code}-${Date.now()}.pdf`
  let url = null
  for (const bucket of ['wa-docs', 'gst-reports']) {
    const up = await busy.storage.from(bucket).upload(path, pdf, { contentType: 'application/pdf', upsert: true })
    if (!up.error) { url = busy.storage.from(bucket).getPublicUrl(path).data.publicUrl; break }
  }
  if (!url) return { error: 'Could not store the PDF (storage bucket wa-docs missing).' }

  const closing = Number(stmt.closing) || 0
  const balance = closing ? `${money2(closing)} ${closing > 0 ? 'Dr (payable to us)' : 'Cr (in your favour)'}` : '0.00 (nothing due)'
  const asOf = niceDate(stmt.asOf || new Date().toISOString())
  const out = await sendLogged(busy, {
    kind: 'ledger', to: number, template: LEDGER_TEMPLATE, params: [name, asOf, balance],
    opts: { headerDocumentUrl: url, headerDocumentName: filename, buttonPayloads: [`qr:${code}`] },
    ref: `ledger:${code}`, refName: name, by,
  })
  if (out.status === 'sent') return { ok: true, via: 'template', to: number, name }

  // Template missing / not approved: allowed only if the customer wrote to us in the last 24 hours.
  const since = new Date(Date.now() - 24 * 3600e3).toISOString()
  const w = await busy.from('wa_messages').select('id').eq('number', number).eq('direction', 'in').gte('created_at', since).limit(1)
  if (!w.error && w.data?.length) {
    try {
      await replyMedia(busy, number, pdf, { kind: 'document', mime: 'application/pdf', filename, caption: `*${name}*\nYour ledger statement up to ${asOf} is attached.\nClosing balance: ₹${balance}` }, by)
      return { ok: true, via: 'direct', to: number, name }
    } catch (err) { return { error: `Could not send: ${err.message}` } }
  }
  const notReady = /template|132001|does not exist|not found/i.test(out.error || '')
  return { error: notReady
    ? 'The WhatsApp template "ledger_statement" is not approved yet, and this customer has not written to us in the last 24 hours. Create the template in WhatsApp Manager (wording on the WhatsApp → Templates tab), then try again.'
    : `Not sent: ${out.error || out.status}` }
}

// ---- Invoice copy (2026-10-15) ----
const safeName = s => String(s || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'Invoice'
async function wroteRecently(busy, number) {
  const since = new Date(Date.now() - 24 * 3600e3).toISOString()
  const w = await busy.from('wa_messages').select('id').eq('number', number).eq('direction', 'in').gte('created_at', since).limit(1)
  return !w.error && !!w.data?.length
}
export async function sendInvoiceCopy(busy, body, by) {
  if (!waConfigured()) return { error: 'WhatsApp is not set up in HQ yet.' }
  const code = String(Number(body.party_code) || '')
  if (!code || code === '0') return { error: 'No customer code.' }
  const number = toWaNumber(body.phone)
  if (!number) return { error: 'That is not a valid 10-digit mobile number.' }
  const vchNo = String(body.vch_no || '').trim()
  if (!vchNo) return { error: 'No invoice number.' }
  const name = await ledgerNameByCode(busy, code)
  if (!name) return { error: 'This customer is not in the Busy data.' }
  if (LEDGER_ONLY_CODES.has(code) || LEDGER_ONLY.test(name)) return { error: `${name} is a ledger-only account — nothing is sent on it.` }
  const data = await loadInvoice(busy, vchNo)
  if (!data) return { error: `Invoice ${vchNo} is not in HQ yet (the 5-minute invoice sync brings it).` }
  if (String(data.invoice.party_code ?? '') && String(data.invoice.party_code) !== code) return { error: `Invoice ${vchNo} belongs to another customer.` }
  const inv = data.invoice
  const amount = Number(inv.total_amount ?? inv.amount ?? inv.grand_total) || 0
  const filename = `JCM-Invoice-${safeName(vchNo)}.pdf`

  // The customer wrote in the last 24 h → the PDF itself, straight into the chat.
  if (await wroteRecently(busy, number)) {
    try {
      const pdf = await buildInvoicePdf({ partyName: name, ...data })
      await replyMedia(busy, number, pdf, { kind: 'document', mime: 'application/pdf', filename, caption: `*Copy of invoice ${vchNo} is attached.*\n*आपके बिल की कॉपी संलग्न है।*` }, by)
      return { ok: true, via: 'direct', to: number, name }
    } catch (err) { return { error: `Could not send: ${err.message}` } }
  }
  const out = await sendLogged(busy, {
    kind: 'invoice_copy', to: number, template: 'txn_invoice',
    params: [name, vchNo, niceDate(inv.vch_date), inr(amount), String(data.items.length)],
    opts: { headerImageUrl: BANNER('invoice'), buttonPayloads: [`qr:${code}`, `invpdf:${code}:${vchNo}`] },
    ref: `invoice_copy:${vchNo}`, refName: name, by,
  })
  if (out.status === 'sent') return { ok: true, via: 'template', to: number, name }
  return { error: `Not sent: ${out.error || out.status}` }
}
