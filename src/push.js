// Phone pop-up notifications in the JCM HQ app (Firebase), 2026-10-16. Server: api/_push.js.
//
// After sign-in (app only): ask once for permission (Android 13+ shows its own "Allow
// notifications?" box), register with Firebase and save this phone's token for the signed-in
// person (api/sync-status.js push-register). A shared phone moves to whoever signed in last.
//   - Tap on a pop-up → the page in its data.hash (e.g. #whatsapp/inbox/9198…, #floor-orders).
//   - A pop-up arriving while the app is open on screen shows as a small banner at the top
//     (Android does not show it by itself then).
// An app built before this file existed has no push plugin: everything here quietly does nothing
// and the bell says a new app is needed.
import './push.css'
import { Capacitor } from '@capacitor/core'
import { supabase } from './supabase.js'
import { apiUrl, IS_NATIVE } from './native.js'
import { esc } from './utils.js'

// 'web' | 'old-app' | 'denied' | 'on' | 'starting' | 'error'
export const pushState = { status: IS_NATIVE ? 'starting' : 'web', error: '' }
let Push = null
let token = null
let started = false
let pendingHash = null

async function call(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(apiUrl('/api/sync-status'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
    body: JSON.stringify(payload),
  })
  let body = null
  try { body = await res.json() } catch { /* not JSON */ }
  if (!res.ok) throw new Error(body?.error || 'Something went wrong. Try again.')
  return body
}

function goTo(hash) {
  if (!hash || !hash.startsWith('#')) return
  if (window.location.hash !== hash) window.location.hash = hash
}

function banner(n) {
  document.getElementById('pushBanner')?.remove()
  const el = document.createElement('button')
  el.type = 'button'
  el.id = 'pushBanner'
  el.className = 'push-banner'
  el.innerHTML = `<strong>${esc(n.title || 'JCM HQ')}</strong><span>${esc(n.body || '')}</span>`
  el.addEventListener('click', () => { el.remove(); goTo(n.data?.hash) })
  document.body.appendChild(el)
  requestAnimationFrame(() => el.classList.add('is-in'))
  setTimeout(() => { el.classList.remove('is-in'); setTimeout(() => el.remove(), 300) }, 6000)
}

export async function startPush() {
  if (!IS_NATIVE || started) return
  started = true
  if (!Capacitor.isPluginAvailable('PushNotifications')) { pushState.status = 'old-app'; return }
  try {
    ({ PushNotifications: Push } = await import('@capacitor/push-notifications'))
    await Push.addListener('registration', async t => {
      token = t.value
      try { await call({ action: 'push-register', token, device: navigator.userAgent.match(/Android [\d.]+; ([^)]+)\)/)?.[1] || 'Android' }); pushState.status = 'on' }
      catch (e) { pushState.status = 'error'; pushState.error = e.message }
    })
    await Push.addListener('registrationError', e => { pushState.status = 'error'; pushState.error = e?.error || 'Could not register with Firebase' })
    await Push.addListener('pushNotificationReceived', n => banner(n))
    await Push.addListener('pushNotificationActionPerformed', a => {
      const hash = a?.notification?.data?.hash
      // On a cold start the app first jumps to its home tab; go to the pop-up's page after that.
      pendingHash = hash
      setTimeout(() => { if (pendingHash) { goTo(pendingHash); pendingHash = null } }, 400)
    })
    try {
      await Push.createChannel({ id: 'hq', name: 'JCM HQ alerts', description: 'Tasks, orders, WhatsApp and red alerts', importance: 5, visibility: 1, vibration: true, lights: true, lightColor: '#D9AE55' })
    } catch { /* channels are Android 8+; older phones use the default */ }
    let perm = await Push.checkPermissions()
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await Push.requestPermissions()
    if (perm.receive !== 'granted') { pushState.status = 'denied'; return }
    await Push.register()
  } catch (e) {
    pushState.status = 'error'
    pushState.error = e?.message || String(e)
  }
}

// Ask again (from the bell) after "Don't allow": Android only lets the app ask a couple of times,
// after that the person has to switch it on in Settings → Apps → JCM HQ → Notifications.
export async function retryPush() {
  started = false
  await startPush()
  return pushState.status
}

export async function sendTestPush() {
  return call({ action: 'push-test' })
}

// On sign-out: this phone stops getting the signed-out person's pop-ups. The session is already
// gone, so instead of telling the server, the phone drops its Firebase token; the next send to it
// fails as UNREGISTERED and the server forgets it. Signing in again registers a fresh token.
export async function stopPush() {
  if (!IS_NATIVE || !Push) return
  started = false
  pushState.status = 'starting'
  token = null
  try { await Push.removeAllListeners() } catch { /* nothing to remove */ }
  try { await Push.unregister() } catch { /* not registered */ }
}
