// Customer / supplier transaction messages (2026-10-12): one Meta template per Busy voucher,
// queued in wa_outbox by busy-sync/sync-transactions.js on JCM-Server and sent from here.
//
//   invoice      txn_invoice      {{1}} name {{2}} bill no {{3}} date {{4}} amount {{5}} items   buttons QR Code / PDF Copy (→ invoice PDF)
//   receipt      txn_receipt      {{1}} name {{2}} amount {{3}} date {{4}} receipt no             button Ledger
//   credit_note  txn_credit_note  {{1}} name {{2}} note no {{3}} date {{4}} amount                button Ledger
//   debit_note   txn_debit_note   {{1}} name {{2}} note no {{3}} date {{4}} amount                button Ledger
//   payment      txn_payment      {{1}} name {{2}} amount {{3}} date {{4}} voucher no             (to a supplier; no buttons)
//   purchase     txn_purchase     {{1}} name {{2}} bill no {{3}} bill date {{4}} amount {{5}} items   (to a supplier)
//   invoice, changed after it went (revision > 0) → txn_invoice_revised (same params; one button Revised Invoice PDF → invpdf:; txn_invoice until approved)
//   order        txn_order        {{1}} name {{2}} order no {{3}} date {{4}} items {{5}} amount   buttons Call (phone) / Order copy (→ SO PDF)
// Everything goes at the next tick after it is queued (the 20:30 wait for invoices was dropped 2026-10-12).
// A row older than EXPIRE_HOURS past its send time is never sent (marked expired) — so switching a
// kind on after days off does not flood customers with old messages.
import { sendLogged, waSwitches, waConfigured, BANNER, inr, niceDate } from './_wa-cloud.js'

const EXPIRE_HOURS = 24
const MAX_PER_TICK = 60
// Ledger-only names must never reach a customer (Shishir, 2026-10-12). sync-transactions.js already skips
// these; this is the second lock in case an older queued row still carries one.
const LEDGER_ONLY = /nexus enterprises|silver electric house|^cash\b/i
const LEDGER_ONLY_CODES = new Set(['40355', '65494', '56680'])
const ledgerOnlyRow = r => !r.party_name || LEDGER_ONLY.test(r.party_name) || (LEDGER_ONLY_CODES.has(String(r.party_code)) && r.party_name === r.ledger_name)

export const TXN = {
  invoice: { template: 'txn_invoice', banner: 'invoice', params: r => [r.party_name, r.vch_no, niceDate(r.vch_date), inr(r.amount), String(r.items || 0)], buttons: (c, r) => [`qr:${c}`, `invpdf:${c}:${r?.vch_no || ''}`] },
  receipt: { template: 'txn_receipt', banner: 'receipt', params: r => [r.party_name, inr(r.amount), niceDate(r.vch_date), r.vch_no], buttons: c => [`ledger:${c}`] },
  credit_note: { template: 'txn_credit_note', banner: 'credit-note', params: r => [r.party_name, r.vch_no, niceDate(r.vch_date), inr(r.amount)], buttons: c => [`ledger:${c}`] },
  debit_note: { template: 'txn_debit_note', banner: 'debit-note', params: r => [r.party_name, r.vch_no, niceDate(r.vch_date), inr(r.amount)], buttons: c => [`ledger:${c}`] },
  payment: { template: 'txn_payment', banner: 'payment', params: r => [r.party_name, inr(r.amount), niceDate(r.vch_date), r.vch_no], buttons: () => [] },
  purchase: { template: 'txn_purchase', banner: 'purchase', params: r => [r.party_name, r.vch_no, niceDate(r.vch_date), inr(r.amount), String(r.items || 0)], buttons: () => [] },
  order: { template: 'txn_order', banner: 'order', params: r => [r.party_name, r.vch_no, niceDate(r.vch_date), String(r.items || 0), inr(r.amount)], buttons: (c, r) => [{ index: 1, payload: `so:${c}:${r?.vch_no || ''}` }] },
}

// Send everything that is due. Returns counts. Never throws for one bad row.
// Template for a corrected copy (revision > 0): an invoice changed in Busy after its message went.
// Same params and buttons as txn_invoice. Until txn_invoice_revised is approved, txn_invoice is used.
const REVISED = 'txn_invoice_revised'
const NOT_APPROVED = /132001|does not exist|not found|template name/i

export async function runOutbox(busy, { onlyId = null } = {}) {
  if (!waConfigured()) return { skipped: 'WhatsApp not configured' }
  // One switch on the Outbox tab pauses every customer transaction message (rows stay queued).
  const pause = await busy.from('wa_settings').select('value').eq('key', 'pause:customers').maybeSingle()
  if (pause.data?.value === 'true' && !onlyId) return { skipped: 'Paused on the WhatsApp → Outbox tab' }
  const now = new Date().toISOString()
  const expireBefore = new Date(Date.now() - EXPIRE_HOURS * 3600e3).toISOString()
  const exp = await busy.from('wa_outbox').update({ status: 'expired', error: `not sent within ${EXPIRE_HOURS} h of its time` })
    .eq('status', 'queued').lt('send_after', expireBefore).select('id')
  let dq = busy.from('wa_outbox').select('*').eq('status', 'queued').lte('send_after', now)
  if (onlyId) dq = dq.eq('id', onlyId)
  const due = await dq.order('send_after', { ascending: true }).limit(MAX_PER_TICK)
  if (due.error) throw new Error(`outbox read: ${due.error.message}`)
  const switches = await waSwitches(busy)
  const counts = { sent: 0, failed: 0, no_number: 0, off: 0, expired: (exp.data || []).length }
  for (const r of due.data || []) {
    const spec = TXN[r.kind]
    if (!spec) { await busy.from('wa_outbox').update({ status: 'failed', error: 'unknown kind' }).eq('id', r.id); counts.failed++; continue }
    if (switches.off.has(r.kind)) { counts.off++; continue } // stays queued until switched on (or expires)
    if (ledgerOnlyRow(r)) {
      await busy.from('wa_outbox').update({ status: 'no_billing', error: `ledger-only account "${r.ledger_name || r.party_name || ''}" — no billed party on the voucher, not sent` }).eq('id', r.id).eq('status', 'queued')
      counts.no_billing = (counts.no_billing || 0) + 1; continue
    }
    // Claim it so two ticks can never send the same voucher twice.
    const claim = await busy.from('wa_outbox').update({ status: 'sending' }).eq('id', r.id).eq('status', 'queued').select('id')
    if (claim.error || !(claim.data || []).length) continue
    const code = String(r.party_code || '').replace(/\D/g, '')
    const revised = r.kind === 'invoice' && (r.revision || 0) > 0
    const msg = tpl => ({
      kind: r.kind, to: r.mobile, template: tpl, params: spec.params(r),
      // txn_invoice_revised (as Shishir made it, 2026-10-14) has ONE quick reply, "Revised Invoice PDF".
      opts: { headerImageUrl: BANNER(spec.banner), buttonPayloads: tpl === REVISED ? [`invpdf:${code}:${r.vch_no || ''}`] : spec.buttons(code, r) },
      ref: `${r.kind}:${r.vch_no || r.vch_code}${revised ? `:rev${r.revision}` : ''}`, refName: r.party_name, by: revised ? 'HQ outbox (corrected)' : 'HQ outbox', switches,
    })
    let out = await sendLogged(busy, msg(revised ? REVISED : spec.template))
    if (revised && out.status === 'failed' && NOT_APPROVED.test(out.error || '')) out = await sendLogged(busy, msg(spec.template))
    const status = out.status === 'sent' ? 'sent' : out.status === 'no_number' ? 'no_number' : 'failed'
    await busy.from('wa_outbox').update({ status, error: out.error || null, meta_id: out.id || null, sent_at: new Date().toISOString() }).eq('id', r.id)
    counts[status]++
  }
  return counts
}
