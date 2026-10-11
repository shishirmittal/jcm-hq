// WhatsApp — admin page (#whatsapp-test, Admin → WhatsApp). Server: api/whatsapp.js.
//   • Connection: Meta set up? WABA subscribed to our app (button taps arrive)?
//   • Switches: every kind of message HQ sends can be turned off (wa_settings 'off:<kind>').
//   • Samples: send any JCM template with sample values to a number (customer ones take a Busy code).
//   • Outbox: customer transaction messages waiting (invoices go at 20:30) — Run now sends what is due.
//   • Log: the last sends, with Meta's answer when one failed.
import { supabase } from './supabase.js'
import { apiUrl } from './native.js'
import { openSidebar } from './sidebar.js'
import { esc } from './utils.js'

async function call(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(apiUrl('/api/whatsapp'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
    body: JSON.stringify(payload),
  })
  let body = null
  try { body = await res.json() } catch { /* not JSON */ }
  if (!res.ok) throw new Error(body?.error || 'Something went wrong. Try again.')
  return body
}

const KIND_LABEL = {
  invoice: 'Invoice (customer, 20:30)', receipt: 'Receipt (customer)', credit_note: 'Credit note (customer)', debit_note: 'Debit note (customer)',
  payment: 'Payment made (supplier)', purchase: 'Purchase bill entered (supplier)', order: 'Order booked (customer)', quotation: 'Quotation (customer)',
  dispatch: 'Dispatched (customer, Orders)', gst_supplier: 'GSTR-1 reminder (supplier)', reminder: 'Payment reminders (customer)',
  staff_followup: 'Staff: morning follow-up list', staff_evening: 'Admins: evening collections summary', staff_red_alert: 'Staff: Red Alert explanation',
  staff_purchase: 'Staff: purchase bill entered', staff_purchase_summary: 'Staff: purchases evening summary', staff_gst: 'Staff: GST mismatch report',
  staff_orders: 'Admins: orders / material at 17:30',
}
const SAMPLES = [
  ['txn_invoice', 'Invoice — customer (Busy code needed)', true], ['txn_receipt', 'Receipt — customer', true],
  ['txn_credit_note', 'Credit note — customer', true], ['txn_debit_note', 'Debit note — customer', true],
  ['txn_payment', 'Payment made — supplier', true], ['txn_purchase', 'Purchase bill entered — supplier', true], ['txn_order', 'Order booked — customer', true],
  ['quotation_sent', 'Quotation sent — customer', true], ['order_dispatched', 'Dispatched (no LR photo)', true], ['order_dispatched_photo', 'Dispatched with LR photo (banner stands in)', true],
  ['staff_followup_morning', 'Staff: morning follow-up list', false], ['staff_followup_evening', 'Admins: evening summary', false],
  ['staff_red_alert', 'Staff: Red Alert explanation', false], ['staff_purchase_bill', 'Staff: purchase bill entered', false],
  ['staff_purchase_summary', 'Staff: purchases evening summary', false], ['staff_orders_pending', 'Admins: orders / material 17:30', false],
]
const STATUS_TONE = { sent: 'grn', failed: 'red', no_number: 'grey', off: 'grey', queued: 'amb', sending: 'amb', cancelled: 'grey', expired: 'grey', skipped: 'grey' }
const when = iso => iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : ''

export function renderWhatsappTest(container) {
  container.innerHTML = `
    <div class="app-layout wa-page">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="waMenu" aria-label="Menu">☰</button>
          <span class="logo-small">WhatsApp</span>
        </div>
        <button class="btn-ghost btn-small" id="waRefresh">Refresh</button>
      </header>
      <main class="app-main wa-main">
        <section class="wa-card">
          <h3>Connection</h3>
          <p id="waState">Checking setup…</p>
          <div class="wa-row">
            <input id="waPhone" type="tel" inputmode="numeric" placeholder="Your 10-digit mobile" autocomplete="off">
            <button class="btn-ghost btn-small" id="waSend">Send hello_world</button>
            <button class="btn-ghost btn-small" id="waSub">Check and connect replies</button>
          </div>
          <p id="waResult" aria-live="polite"></p>
          <p id="waSubResult" aria-live="polite"></p>
        </section>

        <section class="wa-card">
          <h3>Send a sample</h3>
          <p class="wa-muted">Goes to the number above with sample figures. Customer samples use a real customer's ledger name and buttons — type their Busy code.</p>
          <div class="wa-row">
            <select id="waSample">${SAMPLES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
            <input id="waCode" type="text" inputmode="numeric" placeholder="Busy code (customer samples)" autocomplete="off">
            <button class="btn-primary btn-small" id="waSampleSend">Send sample</button>
          </div>
          <div class="wa-row">
            <select id="waTier">
              <option value="20">Payment reminder — Dealer amber (20 d)</option><option value="40">Dealer red (40 d)</option>
              <option value="r20">Retail amber (20 d)</option><option value="r40">Retail red (40 d)</option>
            </select>
            <button class="btn-ghost btn-small" id="waRem">Send sample reminder</button>
          </div>
          <p id="waSampleResult" aria-live="polite"></p>
        </section>

        <section class="wa-card">
          <h3>What HQ sends — switches</h3>
          <p class="wa-muted" id="waSwNote">Untick a kind to stop it. A customer message that is off stays queued for 24 h, then expires.</p>
          <div id="waSwitches" class="wa-switches">Loading…</div>
        </section>

        <section class="wa-card">
          <h3>Customer messages waiting <span class="wa-muted">(invoices go at 20:30)</span></h3>
          <div class="wa-row">
            <select id="waOutboxFilter"><option value="queued">Queued</option><option value="sent">Sent</option><option value="failed">Failed</option><option value="no_number">No number</option><option value="expired">Expired</option><option value="cancelled">Cancelled</option><option value="">All</option></select>
            <button class="btn-ghost btn-small" id="waTick">Send what is due now</button>
            <button class="btn-ghost btn-small" id="waOrdersNow">Send the 17:30 orders message now</button>
          </div>
          <p id="waTickResult" aria-live="polite"></p>
          <div id="waOutbox" class="wa-table">Loading…</div>
        </section>

        <section class="wa-card">
          <h3>Last sends</h3>
          <div class="wa-row"><select id="waLogKind"><option value="">All kinds</option>${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
          <div id="waLog" class="wa-table">Loading…</div>
        </section>
      </main>
    </div>`
  const $ = id => container.querySelector('#' + id)
  $('waMenu').addEventListener('click', () => openSidebar())
  $('waRefresh').addEventListener('click', loadAll)
  const phone = () => $('waPhone').value.replace(/\D/g, '')
  const busy = (btn, on) => { btn.disabled = on }

  $('waSend').addEventListener('click', async () => {
    if (phone().length !== 10) { $('waResult').textContent = 'Type a 10-digit mobile number first.'; return }
    busy($('waSend'), true); $('waResult').textContent = 'Sending…'
    try { await call({ action: 'test', phone: phone() }); $('waResult').textContent = '✅ Sent. Check WhatsApp on that phone.' }
    catch (err) { $('waResult').textContent = '❌ ' + err.message }
    finally { busy($('waSend'), false) }
  })
  $('waSub').addEventListener('click', async () => {
    busy($('waSub'), true); $('waSubResult').textContent = 'Checking…'
    try {
      let d = await call({ action: 'sub-status' })
      if (!d.subscribed) d = await call({ action: 'sub-fix' })
      $('waSubResult').textContent = d.subscribed ? `✅ Replies and button taps reach HQ (app: ${d.apps.join(', ')}).` : '❌ Still not connected. Try again, then tell the HQ chat.'
    } catch (err) { $('waSubResult').textContent = '❌ ' + err.message }
    finally { busy($('waSub'), false) }
  })
  $('waSampleSend').addEventListener('click', async () => {
    if (phone().length !== 10) { $('waSampleResult').textContent = 'Type a 10-digit mobile number in Connection first.'; return }
    const template = $('waSample').value
    const needsCode = SAMPLES.find(x => x[0] === template)?.[2]
    const code = $('waCode').value.replace(/\D/g, '')
    if (needsCode && !code) { $('waSampleResult').textContent = 'This sample needs a customer\'s Busy code.'; return }
    busy($('waSampleSend'), true); $('waSampleResult').textContent = 'Sending…'
    try { await call({ action: 'sample', phone: phone(), template, code: needsCode ? code : '' }); $('waSampleResult').textContent = `✅ ${template} sent.`; loadLog() }
    catch (err) { $('waSampleResult').textContent = '❌ ' + err.message }
    finally { busy($('waSampleSend'), false) }
  })
  $('waRem').addEventListener('click', async () => {
    const code = $('waCode').value.replace(/\D/g, '')
    if (phone().length !== 10 || !code) { $('waSampleResult').textContent = 'Type the mobile number and the customer\'s Busy code first.'; return }
    busy($('waRem'), true); $('waSampleResult').textContent = 'Sending…'
    try { await call({ action: 'reminder-test', phone: phone(), code, tier: $('waTier').value }); $('waSampleResult').textContent = '✅ Reminder sent. Tap its buttons on the phone.' }
    catch (err) { $('waSampleResult').textContent = '❌ ' + err.message }
    finally { busy($('waRem'), false) }
  })
  $('waSwitches').addEventListener('change', async e => {
    const cb = e.target.closest('input[data-kind]')
    if (!cb) return
    try { await call({ action: 'settings-save', off: { [cb.dataset.kind]: !cb.checked } }) }
    catch (err) { cb.checked = !cb.checked; $('waSwNote').textContent = err.message }
  })
  $('waTick').addEventListener('click', async () => {
    busy($('waTick'), true); $('waTickResult').textContent = 'Sending…'
    try {
      const d = await call({ action: 'tick' })
      const o = d.outbox || {}
      $('waTickResult').textContent = o.skipped ? o.skipped : `Done: ${o.sent || 0} sent · ${o.failed || 0} failed · ${o.no_number || 0} no number${o.off ? ` · ${o.off} waiting (kind switched off)` : ''}${o.expired ? ` · ${o.expired} expired` : ''}.`
      loadOutbox(); loadLog()
    } catch (err) { $('waTickResult').textContent = '❌ ' + err.message }
    finally { busy($('waTick'), false) }
  })
  $('waOrdersNow').addEventListener('click', async () => {
    if (!window.confirm('Send the orders / material message to all admins now?')) return
    busy($('waOrdersNow'), true)
    try { const d = await call({ action: 'tick', force: 'orders' }); const o = d.orders || {}; $('waTickResult').textContent = `Orders message: ${(o.sent || []).map(x => `${x.to} ${x.status}`).join(', ') || 'nobody to send to'}.`; loadLog() }
    catch (err) { $('waTickResult').textContent = '❌ ' + err.message }
    finally { busy($('waOrdersNow'), false) }
  })
  $('waOutboxFilter').addEventListener('change', loadOutbox)
  $('waLogKind').addEventListener('change', loadLog)

  async function loadAll() {
    try {
      const d = await call({ action: 'status' })
      $('waState').textContent = d.configured ? 'Meta WhatsApp is set up (number +91 91091 05999).' : 'Not set up: WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are missing in Vercel.'
    } catch (err) { $('waState').textContent = err.message }
    loadSwitches(); loadOutbox(); loadLog()
  }
  async function loadSwitches() {
    try {
      const d = await call({ action: 'settings' })
      if (!d.ready) { $('waSwitches').innerHTML = '<div class="pf-warn">Run the WhatsApp SQL in Supabase first (ask in the HQ chat).</div>'; return }
      const off = new Set(d.off)
      $('waSwitches').innerHTML = d.kinds.map(k => `<label class="wa-switch"><input type="checkbox" data-kind="${k}" ${off.has(k) ? '' : 'checked'}> ${esc(KIND_LABEL[k] || k)}</label>`).join('')
    } catch (err) { $('waSwitches').textContent = err.message }
  }
  async function loadOutbox() {
    try {
      const d = await call({ action: 'outbox', status: $('waOutboxFilter').value })
      if (!d.rows.length) { $('waOutbox').innerHTML = '<div class="wa-muted">Nothing here.</div>'; return }
      $('waOutbox').innerHTML = `<table><thead><tr><th>Kind</th><th>Party</th><th>No.</th><th>Amount</th><th>Goes at</th><th>Status</th></tr></thead><tbody>
        ${d.rows.map(r => `<tr><td>${esc(r.kind)}</td><td>${esc(r.party_name || r.party_code)}<div class="wa-muted">${esc(r.mobile || 'no number')}</div></td><td>${esc(r.vch_no || '')}<div class="wa-muted">${esc(r.vch_date || '')}</div></td><td>₹${Number(r.amount || 0).toLocaleString('en-IN')}</td><td>${esc(when(r.send_after))}</td><td><span class="pf-pill pf-tone-${STATUS_TONE[r.status] || 'grey'}">${esc(r.status)}</span>${r.error ? `<div class="wa-muted">${esc(r.error)}</div>` : ''}</td></tr>`).join('')}
        </tbody></table>`
    } catch (err) { $('waOutbox').textContent = err.message }
  }
  async function loadLog() {
    try {
      const d = await call({ action: 'log', kind: $('waLogKind').value, limit: 100 })
      if (!d.rows.length) { $('waLog').innerHTML = '<div class="wa-muted">No sends yet.</div>'; return }
      $('waLog').innerHTML = `<table><thead><tr><th>When</th><th>Kind</th><th>To</th><th>Template</th><th>Status</th></tr></thead><tbody>
        ${d.rows.map(r => `<tr><td>${esc(when(r.created_at))}</td><td>${esc(KIND_LABEL[r.kind] || r.kind)}</td><td>${esc(r.ref_name || '')}<div class="wa-muted">${esc(r.to_number || '')}</div></td><td>${esc(r.template)}</td><td><span class="pf-pill pf-tone-${STATUS_TONE[r.status] || 'grey'}">${esc(r.status)}</span>${r.error ? `<div class="wa-muted">${esc(r.error)}</div>` : ''}</td></tr>`).join('')}
        </tbody></table>`
    } catch (err) { $('waLog').textContent = err.message }
  }
  loadAll()
}
