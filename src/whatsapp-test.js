// WhatsApp → Settings tab (src/whatsapp.js mounts this). Server: api/whatsapp.js.
//   • Connection: Meta set up? WABA subscribed to our app (button taps arrive)?
//   • Samples: send any JCM template with sample values to a number (customer ones take a Busy code).
//   • Switches: every kind of message HQ sends can be turned off (wa_settings 'off:<kind>').
import { esc } from './utils.js'
import { callWhatsapp as call } from './whatsapp.js'

const KIND_LABEL = {
  invoice: 'Invoice (customer)', receipt: 'Receipt (customer)', credit_note: 'Credit note (customer)', debit_note: 'Debit note (customer)',
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
  ['staff_red_alert', 'Staff: Red Alert explanation', false], ['staff_purchase_pdf', 'Staff: purchase bill entered (PDF)', false], ['staff_purchase_bill', 'Staff: purchase bill — old text version', false],
  ['staff_purchase_summary', 'Staff: purchases evening summary', false], ['staff_orders_pending', 'Admins: orders / material 17:30', false],
]

export function renderWhatsappSettings(container) {
  container.innerHTML = `
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
          <div class="wa-row">
            <button class="btn-ghost btn-small" id="waSampleAll">Send EVERY approved template to this number</button>
            <span class="wa-muted">One of each, with sample figures — the quickest full test. Customer ones use the Busy code above.</span>
          </div>
          <p id="waSampleResult" aria-live="polite"></p>
        </section>

        <section class="wa-card">
          <h3>What HQ sends — switches</h3>
          <p class="wa-muted" id="waSwNote">Tick a kind to let HQ send it. Customer transaction messages start OFF — tick them once their template is approved. A customer message that is off stays queued for 24 h, then expires. Automatic payment reminders have their own switch on Payment Follow-up → WhatsApp reminders.</p>
          <div id="waSwitches" class="wa-switches">Loading…</div>
        </section>`
  const $ = id => container.querySelector('#' + id)
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
    try { await call({ action: 'sample', phone: phone(), template, code: needsCode ? code : '' }); $('waSampleResult').textContent = `✅ ${template} sent.` }
    catch (err) { $('waSampleResult').textContent = '❌ ' + err.message }
    finally { busy($('waSampleSend'), false) }
  })
  $('waSampleAll').addEventListener('click', async () => {
    if (phone().length !== 10) { $('waSampleResult').textContent = 'Type a 10-digit mobile number in Connection first.'; return }
    if (!window.confirm('Send one sample of every approved template to this number?')) return
    busy($('waSampleAll'), true); $('waSampleResult').textContent = 'Sending all… this takes a minute.'
    try {
      const d = await call({ action: 'sample-all', phone: phone(), code: $('waCode').value.replace(/\D/g, '') })
      $('waSampleResult').innerHTML = d.results.map(r => `${r.status === 'sent' ? '✅' : r.status === 'not created' || r.status.startsWith('skipped') ? '⚪' : '❌'} <code>${esc(r.template)}</code> ${esc(r.status)}${r.error ? ` — ${esc(r.error)}` : ''}`).join('<br>')
    } catch (err) { $('waSampleResult').textContent = '❌ ' + err.message }
    finally { busy($('waSampleAll'), false) }
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

  async function loadAll() {
    try {
      const d = await call({ action: 'status' })
      $('waState').textContent = d.configured ? 'Meta WhatsApp is set up (number +91 91091 05999).' : 'Not set up: WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are missing in Vercel.'
    } catch (err) { $('waState').textContent = err.message }
    loadSwitches()
  }
  async function loadSwitches() {
    try {
      const d = await call({ action: 'settings' })
      if (!d.ready) { $('waSwitches').innerHTML = '<div class="pf-warn">Run the WhatsApp SQL in Supabase first (ask in the HQ chat).</div>'; return }
      const off = new Set(d.off)
      $('waSwitches').innerHTML = d.kinds.map(k => `<label class="wa-switch"><input type="checkbox" data-kind="${k}" ${off.has(k) ? '' : 'checked'}> ${esc(KIND_LABEL[k] || k)}</label>`).join('')
    } catch (err) { $('waSwitches').textContent = err.message }
  }
  loadAll()
}
