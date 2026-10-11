// WhatsApp (Meta) test — admin page that sends one hello_world template message through
// Meta's Cloud API, to check the direct connection. Server: api/whatsapp.js.
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

export function renderWhatsappTest(container) {
  container.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="waMenu" aria-label="Menu">☰</button>
          <span class="logo-small">WhatsApp (Meta) test</span>
        </div>
      </header>
      <main class="app-main" style="max-width:480px">
        <p id="waState" style="margin:0 0 14px">Checking setup…</p>
        <label for="waPhone" style="display:block;margin-bottom:6px;font-weight:500">Send a test message to</label>
        <input id="waPhone" type="tel" inputmode="numeric" placeholder="10-digit mobile number" autocomplete="off"
          style="width:100%;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:16px;margin-bottom:12px">
        <button class="btn-primary" id="waSend" style="padding:10px 18px;border-radius:8px">Send test message</button>
        <p id="waResult" style="margin-top:14px" aria-live="polite"></p>
      </main>
    </div>`
  const $ = id => container.querySelector('#' + id)
  $('waMenu').addEventListener('click', () => openSidebar())

  call({ action: 'status' }).then(d => {
    $('waState').textContent = d.configured
      ? 'Meta WhatsApp is set up. The test sends the approved "hello_world" template.'
      : 'Meta WhatsApp is not set up yet (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID in Vercel).'
  }).catch(err => { $('waState').textContent = err.message })

  $('waSend').addEventListener('click', async () => {
    const phone = $('waPhone').value.trim()
    if (!phone) { $('waResult').textContent = 'Type a mobile number first.'; return }
    $('waSend').disabled = true
    $('waResult').textContent = 'Sending…'
    try {
      await call({ action: 'test', phone })
      $('waResult').innerHTML = '✅ Sent. It should reach that WhatsApp within a few seconds.'
    } catch (err) {
      $('waResult').innerHTML = `❌ ${esc(err.message)}`
    } finally {
      $('waSend').disabled = false
    }
  })
}
