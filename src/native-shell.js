import { icon } from './icons.js'
import { canSee } from './permissions.js'
import { IS_NATIVE } from './native.js'
import { openSidebar } from './sidebar.js'

// The phone's navigation: tabs along the bottom (JCM HQ, 2026-10-10).
// Used in the APK, and on the website whenever the screen is phone-sized
// (CSS shows the bar below 800 px; the computer keeps the sidebar).
//
// Shishir's order of importance for staff on phones. Each person sees only
// the ones they are allowed (Manage Users); admins see all. The bar holds
// five: with more than five allowed, the first four show and "More" opens
// the full menu, where the rest — and every other page — are.
const TABS = [
  { id: 'stock', label: 'Stock', hash: '#stock', icon: 'warehouse' },
  { id: 'customers', label: 'Customers', hash: '#customers', icon: 'idcard' },
  { id: 'payment-followup', label: 'Follow-up', hash: '#payment-followup', icon: 'phone' },
  { id: 'floor-orders', label: 'Orders', hash: '#floor-orders', icon: 'package' },
  { id: 'quotations', label: 'Quotes', hash: '#quotations', icon: 'file' },
  { id: 'tasks', label: 'Tasks', hash: '#tasks', icon: 'clipboard' },
]
const MAX_TABS = 5

export const NATIVE_HOME = '#tasks'

// The first tab this person may open — where the app opens.
export function phoneHome() {
  return TABS.find(t => canSee(t.id))?.hash || NATIVE_HOME
}

function visibleTabs() {
  const mine = TABS.filter(t => canSee(t.id))
  if (mine.length <= MAX_TABS) return { tabs: mine, more: false }
  return { tabs: mine.slice(0, MAX_TABS - 1), more: true }
}

let keyboardHandler = null

// A tab the signed-in user may not open is shown disabled rather than removed,
// so the bar is the same three tabs on every phone and does not reshuffle
// under someone's thumb when their permissions change.
function allowed(tab) {
  return tab.always === true || canSee(tab.id)
}

export function mountNativeShell() {
  document.body.classList.add('has-tabbar')
  if (IS_NATIVE) document.body.classList.add('native-app')
  document.getElementById('appTabs')?.remove()

  const { tabs, more } = visibleTabs()
  const bar = document.createElement('nav')
  bar.className = 'app-tabs'
  bar.id = 'appTabs'
  bar.setAttribute('aria-label', 'Sections')
  bar.style.gridTemplateColumns = `repeat(${tabs.length + (more ? 1 : 0)}, 1fr)`
  bar.innerHTML = tabs.map(tab => `
    <button type="button" class="app-tab" data-tab="${tab.id}" data-hash="${tab.hash}" aria-current="false">
      <span class="app-tab-icon">${icon(tab.icon, 21)}</span>
      <span class="app-tab-label">${tab.label}</span>
    </button>
  `).join('') + (more ? `
    <button type="button" class="app-tab" data-more="1" aria-label="More pages">
      <span class="app-tab-icon">${icon('more', 21)}</span>
      <span class="app-tab-label">More</span>
    </button>` : '')
  document.body.appendChild(bar)

  bar.querySelectorAll('.app-tab[data-hash]').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.hash
      // Assigning the hash we are already on fires no hashchange, so a second
      // tap on the current tab would do nothing at all. Treat it as "take me
      // back to the top of this tab" instead.
      if (window.location.hash === next) window.scrollTo({ top: 0, behavior: 'smooth' })
      else window.location.hash = next
    })
  })
  bar.querySelector('[data-more]')?.addEventListener('click', () => openSidebar())

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
  bar.querySelectorAll('.app-tab[data-hash]').forEach(btn => {
    // startsWith so a detail route under a tab (#quotations/<id>) keeps its
    // parent tab lit rather than leaving the bar with nothing selected.
    const on = hash === btn.dataset.hash || hash.startsWith(btn.dataset.hash + '/')
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-current', on ? 'page' : 'false')
  })
  // Any other page was reached through "More", so that one reads as current.
  const more = bar.querySelector('[data-more]')
  if (more) more.classList.toggle('active', !bar.querySelector('.app-tab[data-hash].active'))
}

export function unmountNativeShell() {
  document.getElementById('appTabs')?.remove()
  document.body.classList.remove('native-app', 'keyboard-open', 'has-tabbar')
  document.body.style.removeProperty('--app-nav-h')
  if (keyboardHandler && window.visualViewport) {
    window.visualViewport.removeEventListener('resize', keyboardHandler)
    window.visualViewport.removeEventListener('scroll', keyboardHandler)
    keyboardHandler = null
  }
}
