// Android back button (JCM HQ app, 2026-10-12).
//
// Without this, Android's back press left the WebView — the app folded away on most pages.
// Now a press means, in order:
//   1. an open overlay (menu drawer, any modal, a toast) → close it
//   2. a page we came from in this app → go back to it (our own history of hashes)
//   3. nothing left to go back to → "Exit JCM HQ?" — Yes closes the app, No stays.
// Also a swipe-back gesture on Android 10+ arrives as the same back event.
// Does nothing on the website (IS_NATIVE is false there).
import { IS_NATIVE } from './native.js'

const stack = []          // hashes visited in this app session, oldest first
let suppressNext = false  // set while we trigger history.back() ourselves

function closeAnyOverlay() {
  // The menu drawer.
  const drawer = document.querySelector('.sidebar-overlay')
  if (drawer) { document.getElementById('sidebarCloseBtn')?.click() || drawer.remove(); return true }
  // Modals: every page uses .modal-overlay (hidden with [hidden] or removed) — press its close button,
  // otherwise send Escape, which every modal in HQ listens for.
  const modal = [...document.querySelectorAll('.modal-overlay:not([hidden]), .ra-drawer:not([hidden])')].pop()
  if (modal) {
    const btn = modal.querySelector('[aria-label="Close"], .modal-close, [id$="Close"], [id$="Cancel"], [id$="No"]')
    if (btn) btn.click()
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return true
  }
  return false
}

function askExit(App) {
  if (document.getElementById('exitConfirm')) return
  const ov = document.createElement('div')
  ov.className = 'modal-overlay'
  ov.id = 'exitConfirm'
  ov.innerHTML = `
    <div class="modal exit-modal" role="alertdialog" aria-modal="true">
      <h2 style="margin:0 0 6px;font-size:18px">Exit JCM HQ?</h2>
      <p style="margin:0 0 14px;color:var(--muted,#666)">Press Yes to close the app.</p>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn-ghost" id="exitNo">No, stay</button>
        <button type="button" class="btn-primary" id="exitYes">Yes, exit</button>
      </div>
    </div>`
  document.body.appendChild(ov)
  ov.querySelector('#exitNo').addEventListener('click', () => ov.remove())
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove() })
  ov.querySelector('#exitYes').addEventListener('click', () => App.exitApp())
}

export async function mountBackButton() {
  if (!IS_NATIVE) return
  let App
  try { ({ App } = await import('@capacitor/app')) } catch (err) { console.warn('back button: @capacitor/app not available', err); return }

  const record = () => {
    const h = window.location.hash || '#'
    if (suppressNext) { suppressNext = false; return }
    if (stack[stack.length - 1] !== h) stack.push(h)
    if (stack.length > 50) stack.shift()
  }
  record()
  window.addEventListener('hashchange', record)

  App.addListener('backButton', () => {
    if (document.getElementById('exitConfirm')) { document.getElementById('exitConfirm').remove(); return }
    if (closeAnyOverlay()) return
    if (stack.length > 1) {
      stack.pop()
      suppressNext = true
      window.location.hash = stack[stack.length - 1]
      return
    }
    askExit(App)
  })
}
