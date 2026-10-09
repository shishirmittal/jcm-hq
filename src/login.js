import { apiUrl, IS_NATIVE } from './native.js'
import { supabase } from './supabase.js'
import { esc } from './utils.js'
import { icon } from './icons.js'
import logoUrl from './assets/jcm-logo.png'

const PIN_LENGTH = 4

export function renderLogin(container, message) {
  // Two arrangements of the same parts. The website keeps the centred card it
  // has always had; the app follows the design's PIN screen, where the brand
  // stands on a full-height navy field and the pad rides in a white sheet
  // along the bottom edge. The pieces below are built once and only placed
  // differently, so the pad — the half that has logic hanging off it — is one
  // piece of markup rather than two that can drift apart.
  const brand = `
    <div class="login-logo">
      <img src="${logoUrl}" alt="JCM Retails" class="logo-img" />
      <h1>${IS_NATIVE ? 'JCM Tools' : 'JCM-Tools'}</h1>
      ${IS_NATIVE ? '<span class="login-rule"></span>' : ''}
      <p>Electrical &amp; Electronic Projects</p>
    </div>
  `

  // The hint sits immediately after the error on purpose: the two share one
  // line, and CSS picks between them on whether the error is empty.
  const pinBlock = `
    ${IS_NATIVE ? '<h2 class="pin-heading">Enter your 4-digit PIN</h2>' : ''}
    <div class="pin-dots" id="pinDots">
      ${Array.from({ length: PIN_LENGTH }, (_, i) => `<span class="pin-dot" data-i="${i}"></span>`).join('')}
    </div>
    <p id="loginError" class="error-msg pin-error">${message ? esc(message) : ''}</p>
    ${IS_NATIVE ? '<p class="pin-hint">Your PIN keeps the app locked on this phone</p>' : ''}
    <div class="pin-pad" id="pinPad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button type="button" class="pin-key" data-key="${n}">${n}</button>`).join('')}
      <span class="pin-key pin-key-spacer"></span>
      <button type="button" class="pin-key" data-key="0">0</button>
      <button type="button" class="pin-key pin-key-backspace" id="pinBackspace" aria-label="Backspace">${IS_NATIVE ? icon('backspace', 28) : '⌫'}</button>
    </div>
  `

  container.innerHTML = IS_NATIVE
    ? `
    <div class="login-page app-login">
      <div class="app-login-brand">${brand}</div>
      <div class="app-login-sheet">
        ${pinBlock}
        <p class="app-login-footer">J.C. Mittal &amp; Sons · Ratlam</p>
      </div>
    </div>
  `
    : `
    <div class="login-page">
      <div class="login-card pin-login-card">
        ${brand}
        ${pinBlock}
      </div>
    </div>
  `

  let pin = ''
  let busy = false

  const dots = [...document.querySelectorAll('.pin-dot')]
  const errorEl = document.getElementById('loginError')
  const pad = document.getElementById('pinPad')
  const keyButtons = [...pad.querySelectorAll('.pin-key[data-key]'), document.getElementById('pinBackspace')]

  function updateDots() {
    dots.forEach((d, i) => d.classList.toggle('filled', i < pin.length))
  }

  function setBusy(value) {
    busy = value
    keyButtons.forEach(b => { b.disabled = value })
  }

  function resetPin() {
    pin = ''
    updateDots()
  }

  async function submitPin() {
    setBusy(true)
    errorEl.textContent = ''

    let res, body
    try {
      res = await fetch(apiUrl('/api/pin-login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      })
      body = await res.json().catch(() => ({}))
    } catch {
      errorEl.textContent = 'Could not reach the server, try again'
      resetPin()
      setBusy(false)
      return
    }

    if (!res.ok) {
      errorEl.textContent = res.status === 429
        ? (body.error || 'Too many attempts, try again later')
        : 'Incorrect PIN, try again'
      resetPin()
      setBusy(false)
      return
    }

    const { error } = await supabase.auth.setSession({
      access_token: body.access_token,
      refresh_token: body.refresh_token
    })
    if (error) {
      errorEl.textContent = 'Incorrect PIN, try again'
      resetPin()
      setBusy(false)
      return
    }
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
  document.getElementById('pinBackspace').addEventListener('click', backspace)
}
