import { icon } from './icons.js'
import { canSee } from './permissions.js'
import { IS_NATIVE } from './native.js'

// The app's whole navigation: three tabs along the bottom, in place of the
// sidebar. Mounted only inside the APK — the website keeps mountPinnedSidebar
// and is not touched by any of this.
//
// Kept deliberately separate from NAV_CONFIG rather than filtered out of it.
// NAV_CONFIG is the website's nav and will keep growing; this is a fixed
// three-tab shell, and tying them together would mean every new CRM page had
// to be explicitly excluded from the phone.
const TABS = [
  { id: 'tasks', label: 'Tasks', hash: '#tasks', icon: 'clipboard' },
  { id: 'quotations', label: 'Quotations', hash: '#quotations', icon: 'file' },
  // Not in NAV_CONFIG and not permission-gated: a placeholder with no data
  // behind it is not something to grant.
  { id: 'stock', label: 'Stock', hash: '#stock', icon: 'box', always: true },
]

export const NATIVE_HOME = '#tasks'

let keyboardHandler = null

// A tab the signed-in user may not open is shown disabled rather than removed,
// so the bar is the same three tabs on every phone and does not reshuffle
// under someone's thumb when their permissions change.
function allowed(tab) {
  return tab.always === true || canSee(tab.id)
}

export function mountNativeShell() {
  if (!IS_NATIVE) return
  document.body.classList.add('native-app')
  if (document.getElementById('appTabs')) { syncNativeShell(); return }

  const bar = document.createElement('nav')
  bar.className = 'app-tabs'
  bar.id = 'appTabs'
  bar.setAttribute('role', 'tablist')
  bar.setAttribute('aria-label', 'Sections')
  bar.innerHTML = TABS.map(tab => `
    <button type="button" class="app-tab" role="tab" data-tab="${tab.id}" data-hash="${tab.hash}"
            aria-selected="false"${allowed(tab) ? '' : ' disabled title="You do not have access to this"'}>
      <span class="app-tab-icon">${icon(tab.icon, 21)}</span>
      <span class="app-tab-label">${tab.label}</span>
    </button>
  `).join('')
  document.body.appendChild(bar)

  bar.querySelectorAll('.app-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.hash
      // Assigning the hash we are already on fires no hashchange, so a second
      // tap on the current tab would do nothing at all. Treat it as "take me
      // back to the top of this tab" instead.
      if (window.location.hash === next) window.scrollTo({ top: 0, behavior: 'smooth' })
      else window.location.hash = next
    })
  })

  // The keyboard and a bottom bar want the same strip of screen. Collapsing
  // the bar while typing gives the field the room, and zeroing --app-nav-h is
  // what lets the Task Board's compose bar sit straight on the keyboard
  // rather than floating a tab bar's height above it.
  if (window.visualViewport && !keyboardHandler) {
    keyboardHandler = () => {
      const vv = window.visualViewport
      const hidden = document.documentElement.clientHeight - vv.height - vv.offsetTop
      // 120px, not >0: the viewport moves by a pixel or two for reasons that
      // are not a keyboard, and the bar must not flicker on every scroll.
      document.body.classList.toggle('keyboard-open', hidden > 120)
      syncNavHeight()
    }
    window.visualViewport.addEventListener('resize', keyboardHandler)
    window.visualViewport.addEventListener('scroll', keyboardHandler)
  }

  syncNavHeight()
  syncNativeShell()
}

// --app-nav-h is how much of the bottom of the screen the bar owns, and
// everything that pins itself down there offsets by it. Measured from the
// rendered bar rather than written out as a number, because the number has to
// agree with the bar's height, its hairline border AND its safe-area padding
// — the first version of this was a 1px-too-small constant and the Task
// Board's compose bar sat on the border.
//
// Set inline on <body>, so it beats the stylesheet's own fallback value.
function syncNavHeight() {
  const bar = document.getElementById('appTabs')
  if (!bar) return
  // The bar slides off screen under the keyboard, so it owns nothing then.
  const h = document.body.classList.contains('keyboard-open')
    ? 0
    : Math.ceil(bar.getBoundingClientRect().height)
  document.body.style.setProperty('--app-nav-h', h + 'px')
}

// Which tab reads as current. Called on every route so a hash typed, restored
// or arrived at via the back button lights the right one.
export function syncNativeShell() {
  const bar = document.getElementById('appTabs')
  if (!bar) return
  const hash = window.location.hash
  bar.querySelectorAll('.app-tab').forEach(btn => {
    // startsWith so a detail route under a tab (#quotations/<id>) keeps its
    // parent tab lit rather than leaving the bar with nothing selected.
    const on = hash === btn.dataset.hash || hash.startsWith(btn.dataset.hash + '/')
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-selected', String(on))
  })
}

export function unmountNativeShell() {
  document.getElementById('appTabs')?.remove()
  document.body.classList.remove('native-app', 'keyboard-open')
  document.body.style.removeProperty('--app-nav-h')
  if (keyboardHandler && window.visualViewport) {
    window.visualViewport.removeEventListener('resize', keyboardHandler)
    window.visualViewport.removeEventListener('scroll', keyboardHandler)
    keyboardHandler = null
  }
}
