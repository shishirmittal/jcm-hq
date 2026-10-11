// Customer / supplier transaction messages (2026-10-12): one Meta template per Busy voucher,
// queued in wa_outbox by busy-sync/sync-transactions.js on JCM-Server and sent from here.
//
//   invoice      txn_invoice      {{1}} name {{2}} bill no {{3}} date {{4}} amount {{5}} items   buttons QR Code / Ledger
//   receipt      txn_receipt      {{1}} name {{2}} amount {{3}} date {{4}} receipt no             button Ledger
//   credit_note  txn_credit_note  {{1}} name {{2}} note no {{3}} date {{4}} amount                button Ledger
//   debit_note   txn_debit_note   {{1}} name {{2}} note no {{3}} date {{4}} amount                button Ledger
//   payment      txn_payment      {{1}} name {{2}} amount {{3}} date {{4}} voucher no             (to a supplier; no buttons)
//   purchase     txn_purchase     {{1}} name {{2}} bill no {{3}} bill date {{4}} amount {{5}} items   (to a supplier)
//   order        txn_order        {{1}} name {{2}} order no {{3}} date {{4}} items {{5}} amount   buttons Call (phone) / Order copy (→ SO PDF)
// Invoices wait for 20:30 (send_after, set by the sync script); the rest go at the next tick.
// A row older than EXPIRE_HOURS past its send time is never sent (marked expired) — so switching a
// kind on after days off does not flood customers with old messages.
import { sendLogged, waSwitches, waConfigured, BANNER, inr, niceDate } from './_wa-cloud.js'

const EXPIRE_HOURS = 24
const MAX_PER_TICK = 60

export const TXN = {
  invoice: { template: 'txn_invoice', banner: 'invoice', params: r => [r.party_name, r.vch_no, niceDate(r.vch_date), inr(r.amount), String(r.items || 0)], buttons: c => [`qr:${c}`, `ledger:${c}`] },
  receipt: { template: 'txn_receipt', banner: 'receipt', params: r => [r.party_name, inr(r.amount), niceDate(r.vch_date), r.vch_no], buttons: c => [`ledger:${c}`] },
  credit_note: { template: 'txn_credit_note', banner: 'credit-note', params: r => [r.party_name, r.vch_no, niceDate(r.vch_date), inr(r.amount)], buttons: c => [`ledger:${c}`] },
  debit_note: { template: 'txn_debit_note', banner: 'debit-note', params: r => [r.party_name, r.vch_no, niceDate(r.vch_date), inr(r.amount)], buttons: c => [`ledger:${c}`] },
  payment: { template: 'txn_payment', banner: 'payment', params: r => [r.party_name, inr(r.amount), niceDate(r.vch_date), r.vch_no], buttons: () => [] },
  purchase: { template: 'txn_purchase', banner: 'purchase', params: r => [r.party_name, r.vch_no, niceDate(r.vch_date), inr(r.amount), String(r.items || 0)], buttons: () => [] },
  order: { template: 'txn_order', banner: 'order', params: r => [r.party_name, r.vch_no, niceDate(r.vch_date), String(r.items || 0), inr(r.amount)], buttons: (c, r) => [{ index: 1, payload: `so:${c}:${r?.vch_no || ''}` }] },
}

// Send everything that is due. Returns counts. Never throws for one bad row.
export async function runOutbox(busy) {
  if (!waConfigured()) return { skipped: 'WhatsApp not configured' }
  const now = new Date().toISOString()
  const expireBefore = new Date(Date.now() - EXPIRE_HOURS * 3600e3).toISOString()
  const exp = await busy.from('wa_outbox').update({ status: 'expired', error: `not sent within ${EXPIRE_HOURS} h of its time` })
    .eq('status', 'queued').lt('send_after', expireBefore).select('id')
  const due = await busy.from('wa_outbox').select('*').eq('status', 'queued').lte('send_after', now)
    .order('send_after', { ascending: true }).limit(MAX_PER_TICK)
  if (due.error) throw new Error(`outbox read: ${due.error.message}`)
  const switches = await waSwitches(busy)
  const counts = { sent: 0, failed: 0, no_number: 0, off: 0, expired: (exp.data || []).length }
  for (const r of due.data || []) {
    const spec = TXN[r.kind]
    if (!spec) { await busy.from('wa_outbox').update({ status: 'failed', error: 'unknown kind' }).eq('id', r.id); counts.failed++; continue }
    if (switches.off.has(r.kind)) { counts.off++; continue } // stays queued until switched on (or expires)
    // Claim it so two ticks can never send the same voucher twice.
    const claim = await busy.from('wa_outbox').update({ status: 'sending' }).eq('id', r.id).eq('status', 'queued').select('id')
    if (claim.error || !(claim.data || []).length) continue
    const code = String(r.party_code || '').replace(/\D/g, '')
    const out = await sendLogged(busy, {
      kind: r.kind, to: r.mobile, template: spec.template, params: spec.params(r),
      opts: { headerImageUrl: BANNER(spec.banner), buttonPayloads: spec.buttons(code, r) },
      ref: `${r.kind}:${r.vch_no || r.vch_code}`, refName: r.party_name, by: 'HQ outbox', switches,
    })
    const status = out.status === 'sent' ? 'sent' : out.status === 'no_number' ? 'no_number' : 'failed'
    await busy.from('wa_outbox').update({ status, error: out.error || null, meta_id: out.id || null, sent_at: new Date().toISOString() }).eq('id', r.id)
    counts[status]++
  }
  return counts
}
