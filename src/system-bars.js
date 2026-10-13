// The phone's own top (clock, battery) and bottom (gesture / back buttons) bars.
//
// Capacitor 8 used to keep the page out of those areas and fill them with the
// Android theme's plain grey. With viewport-fit=cover in index.html the page now
// draws behind them, so HQ paints them itself: two thin strips (safe-area.css)
// take the colour of whatever sits next to them — the page header on top, the
// tab bar at the bottom — and the clock / battery icons switch between light
// and dark so they stay readable on that colour. Page content itself is padded
// by the same safe-area amounts, so nothing hides under either bar.
import { SystemBars, SystemBarsStyle } from '@capacitor/core'
import { IS_NATIVE } from './native.js'

const TOP_SOURCES = '.app-header, .jo-hqhead, .stock-header, .im-topbar, .login-page'
const BOTTOM_SOURCES = '.app-tabs'

function visible(el) {
  if (!el) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
}

function solidBg(el) {
  // Walk up until something has a real (non-transparent) background.
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    const c = getComputedStyle(n).backgroundColor
    if (c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c)) return c
  }
  return getComputedStyle(document.body).backgroundColor || '#0E1A2E'
}

function isLight(color) {
  const m = String(color).match(/\d+(\.\d+)?/g)
  if (!m) return false
  const [r, g, b] = m.map(Number)
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150
}

let last = { top: '', bottom: '' }
export function paintSystemBars() { return paint() }
function paint() {
  const top = [...document.querySelectorAll(TOP_SOURCES)].find(visible)
  const bottom = [...document.querySelectorAll(BOTTOM_SOURCES)].find(visible)
  const topColor = solidBg(top || document.body)
  const bottomColor = solidBg(bottom || document.body)
  const root = document.documentElement.style
  root.setProperty('--sysbar-top', topColor)
  root.setProperty('--sysbar-bottom', bottomColor)
  if (!IS_NATIVE) return
  if (topColor !== last.top) {
    last.top = topColor
    SystemBars.setStyle({ bar: 'StatusBar', style: isLight(topColor) ? SystemBarsStyle.Light : SystemBarsStyle.Dark }).catch(() => {})
  }
  if (bottomColor !== last.bottom) {
    last.bottom = bottomColor
    SystemBars.setStyle({ bar: 'NavigationBar', style: isLight(bottomColor) ? SystemBarsStyle.Light : SystemBarsStyle.Dark }).catch(() => {})
  }
}

let queued = false
function soon() {
  if (queued) return
  queued = true
  requestAnimationFrame(() => { queued = false; paint() })
}

export function startSystemBars() {
  if (!IS_NATIVE) return
  document.documentElement.classList.add('sysbars')
  soon()
  // Pages are swapped by replacing #app's content, and the theme by a class on
  // <body>: watch both, repaint at most once a frame.
  new MutationObserver(soon).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
  window.addEventListener('hashchange', soon)
  window.addEventListener('resize', soon)
}
