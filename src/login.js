import { apiUrl, IS_NATIVE } from './native.js'
import { supabase } from './supabase.js'
import { esc } from './utils.js'
import { icon } from './icons.js'
import { avatarColor } from './sidebar.js'
import logoUrl from './assets/jcm-logo.png'

const PIN_LENGTH = 4
// The last person who signed in on this device — their PIN pad opens
// straight away next time, with "Not you?" one tap away. Only an id, never
// anything secret.
const LAST_USER_KEY = 'jcmHq.lastUser'

function readLastUser() {
  try { return localStorage.getItem(LAST_USER_KEY) || '' } catch { return '' }
}
function writeLastUser(id) {
  try { id ? localStorage.setItem(LAST_USER_KEY, id) : localStorage.removeItem(LAST_USER_KEY) } catch { /* storage blocked */ }
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/)
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}

function avatar(person, size) {
  return `<span class="hq-avatar" style="background:${avatarColor(person.id)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px">${esc(initials(person.name))}</span>`
}

// One keydown handler for the whole login screen, replaced on every render
// so a re-render never stacks a second one, and removed once signed in.
let keyHandler = null
function setKeyHandler(fn) {
  if (keyHandler) document.removeEventListener('keydown', keyHandler)
  keyHandler = fn
  if (fn) document.addEventListener('keydown', fn)
}

let roster = null // cached for the life of the page; names rarely change

async function loadRoster() {
  if (roster) return roster
  const res = await fetch(apiUrl('/api/pin-login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'roster' })
  })
  if (!res.ok) throw new Error('roster')
  const body = await res.json()
  roster = Array.isArray(body.roster) ? body.roster : []
  return roster
}

function brandHtml() {
  return `
    <div class="login-logo">
      <img src="${logoUrl}" alt="JCM Retails" class="logo-img" />
      <h1>JCM HQ</h1>
      ${IS_NATIVE ? '<span class="login-rule"></span>' : ''}
      <p>J.C. Mittal &amp; Sons · Ratlam</p>
    </div>
  `
}

// Step 1 — who are you? Photo-and-name cards (initials until photos arrive).
// Step 2 — the PIN pad for that one person.
// A plain "PIN only" path stays for accounts hidden from the roster.
export function renderLogin(container, message) {
  const last = readLastUser()
  container.innerHTML = `
    <div class="login-page hq-login">
      <div class="login-card hq-login-card">
        ${brandHtml()}
        <div id="hqLoginBody"><p class="hq-login-loading">Loading…</p></div>
      </div>
    </div>
  `
  const body = container.querySelector('#hqLoginBody')

  loadRoster().then(list => {
    if (!body.isConnected) return
    const lastPerson = list.find(p => p.id === last)
    if (lastPerson) renderPin(body, lastPerson, message)
    else renderCards(body, list, message)
  }).catch(() => {
    if (!body.isConnected) return
    // Without the list the old PIN-only screen still gets everyone in.
    renderPin(body, null, message || 'Could not load the staff list — enter your PIN')
  })
}

function renderCards(body, list, message) {
  setKeyHandler(null)
  body.innerHTML = `
    <h2 class="hq-login-title">Who's signing in?</h2>
    ${message ? `<p class="error-msg hq-login-msg">${esc(message)}</p>` : ''}
    <div class="hq-people">
      ${list.map(p => `
        <button type="button" class="hq-person" data-id="${esc(p.id)}">
          ${avatar(p, 56)}
          <span class="hq-person-name">${esc(p.name)}</span>
          ${p.admin ? '<span class="hq-person-role">Admin</span>' : ''}
        </button>
      `).join('')}
    </div>
    <button type="button" class="hq-login-link" id="hqPinOnly">Not on the list? Sign in with PIN only</button>
  `
  body.querySelectorAll('.hq-person').forEach(btn => {
    btn.addEventListener('click', () => {
      const person = list.find(p => p.id === btn.dataset.id)
      if (person) renderPin(body, person)
    })
  })
  body.querySelector('#hqPinOnly').addEventListener('click', () => renderPin(body, null))
}

function renderPin(body, person, message) {
  body.innerHTML = `
    <div class="hq-pin-head">
      ${person ? `${avatar(person, 64)}<span class="hq-pin-name">${esc(person.name)}</span>` : '<span class="hq-pin-name">Enter your PIN</span>'}
    </div>
    <div class="pin-dots" id="pinDots">
      ${Array.from({ length: PIN_LENGTH }, (_, i) => `<span class="pin-dot" data-i="${i}"></span>`).join('')}
    </div>
    <p id="loginError" class="error-msg pin-error">${message ? esc(message) : ''}</p>
    <div class="pin-pad" id="pinPad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button type="button" class="pin-key" data-key="${n}">${n}</button>`).join('')}
      <span class="pin-key pin-key-spacer"></span>
      <button type="button" class="pin-key" data-key="0">0</button>
      <button type="button" class="pin-key pin-key-backspace" id="pinBackspace" aria-label="Backspace">${icon('backspace', 24)}</button>
    </div>
    <button type="button" class="hq-login-link" id="hqNotYou">${person ? `Not ${esc(person.name.split(' ')[0])}? Choose your name` : 'Back to names'}</button>
  `

  let pin = ''
  let busy = false
  const dots = [...body.querySelectorAll('.pin-dot')]
  const errorEl = body.querySelector('#loginError')
  const pad = body.querySelector('#pinPad')
  const keyButtons = [...pad.querySelectorAll('.pin-key[data-key]'), body.querySelector('#pinBackspace')]

  const updateDots = () => dots.forEach((d, i) => d.classList.toggle('filled', i < pin.length))
  const setBusy = v => { busy = v; keyButtons.forEach(b => { b.disabled = v }) }
  const resetPin = () => { pin = ''; updateDots() }
  const shake = () => {
    const el = body.querySelector('#pinDots')
    el.classList.remove('hq-shake')
    void el.offsetWidth // restart the animation
    el.classList.add('hq-shake')
  }

  async function submitPin() {
    setBusy(true)
    errorEl.textContent = ''
    let res, data
    try {
      res = await fetch(apiUrl('/api/pin-login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(person ? { pin, user_id: person.id } : { pin })
      })
      data = await res.json().catch(() => ({}))
    } catch {
      errorEl.textContent = 'Could not reach the server, try again'
      resetPin(); setBusy(false)
      return
    }
    if (!res.ok) {
      errorEl.textContent = res.status === 429
        ? (data.error || 'Too many attempts, try again later')
        : 'Incorrect PIN, try again'
      shake(); resetPin(); setBusy(false)
      return
    }
    const { error } = await supabase.auth.setSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token
    })
    if (error) {
      errorEl.textContent = 'Incorrect PIN, try again'
      shake(); resetPin(); setBusy(false)
      return
    }
    writeLastUser(person?.id || '')
    setKeyHandler(null)
    // Success: the SIGNED_IN listener in main.js takes it from here.
  }

  function pressDigit(digit) {
    if (busy || pin.length >= PIN_LENGTH) return
    pin += digit
    updateDots()
    if (pin.length === PIN_LENGTH) submitPin()
  }
  function backspace() {
    if (busy) return
    pin = pin.slice(0, -1)
    updateDots()
  }

  pad.querySelectorAll('.pin-key[data-key]').forEach(btn => {
    btn.addEventListener('click', () => pressDigit(btn.dataset.key))
  })
  body.querySelector('#pinBackspace').addEventListener('click', backspace)
  body.querySelector('#hqNotYou').addEventListener('click', () => {
    writeLastUser('')
    loadRoster()
      .then(list => renderCards(body, list))
      .catch(() => renderPin(body, null, 'Could not load the staff list — enter your PIN'))
  })

  // Desktop: type the PIN on the keyboard as well as clicking the pad.
  setKeyHandler(e => {
    if (!body.isConnected) { setKeyHandler(null); return }
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); pressDigit(e.key) }
    else if (e.key === 'Backspace') { e.preventDefault(); backspace() }
    else if (e.key === 'Escape') body.querySelector('#hqNotYou').click()
  })
}
