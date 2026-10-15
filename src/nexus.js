// Nexus — the HQ assistant. Round button bottom-right on every page after sign-in (startNexus in main.js);
// tap → chat panel (full screen on phones). Asks api/db-chat.js (action 'nexus'): answers how-to questions
// about HQ and looks up data the person may see; actions (send ledger / invoice, add task, follow-up note)
// come back as a card with Confirm / Cancel. Conversation kept for this browser tab (sessionStorage).
// Classes nx-*. Server: api/_nexus.js, guide: api/_nexus-knowledge.js.
import './nexus.css'
import { supabase } from './supabase.js'
import { apiUrl } from './native.js'
import { esc } from './utils.js'

const STORE = 'nexus.chat.v1'
const MAX_KEEP = 30

// The mark: a hub with three linked nodes — "nexus" = where the connections meet.
export const NEXUS_LOGO = (size = 26) => `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
  <g stroke="currentColor" stroke-width="2.2" stroke-linecap="round" opacity=".9">
    <line x1="16" y1="16" x2="16" y2="5.5"/><line x1="16" y1="16" x2="25.5" y2="21.5"/><line x1="16" y1="16" x2="6.5" y2="21.5"/>
  </g>
  <circle cx="16" cy="5.5" r="3.4" fill="currentColor"/><circle cx="25.5" cy="21.5" r="3.4" fill="currentColor"/><circle cx="6.5" cy="21.5" r="3.4" fill="currentColor"/>
  <circle cx="16" cy="16" r="5.2" fill="var(--nx-gold, #C8A96E)"/><circle cx="16" cy="16" r="2" fill="var(--nx-navy, #1A2E3B)"/>
</svg>`

// First suggestions, by the page on screen.
const SUGGEST = {
  '#stock': ['Is Faber 90 cm chimney in stock?', 'Which Atomberg fans are out of stock?'],
  '#customers': ['How much does Badshah Electric owe?', 'Send ledger to a customer'],
  '#payment-followup': ['Who is due for a call today?', 'How do reminders work?'],
  '#floor-orders': ['Which orders are waiting for material?', 'How do I upload the LR photo?'],
  '#quotations': ['Find quotation for Jain', 'How do I send a Busy quotation on WhatsApp?'],
  '#purchases': ['Which purchase bills came today?'],
  '#email-purchases': ['Which brand invoices came by email today?'],
  '#tasks': ['What are my open tasks?', 'Add a task for Keshav'],
  '#whatsapp': ['Why did a customer not get the invoice message?'],
}
const DEFAULT_SUGGEST = ['What can you do?', 'What are my open tasks?', 'Where do I see a customer’s ledger?']

let root = null, state = null

async function call(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(apiUrl('/api/db-chat'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` }, body: JSON.stringify(payload),
  })
  let body = null
  try { body = await res.json() } catch { /* not JSON */ }
  if (!res.ok) throw new Error(body?.error || 'Nexus could not answer just now.')
  return body
}

const load = () => { try { return JSON.parse(sessionStorage.getItem(STORE) || '[]') } catch { return [] } }
const save = () => { try { sessionStorage.setItem(STORE, JSON.stringify(state.msgs.slice(-MAX_KEEP))) } catch { /* private mode */ } }
const pageNow = () => (location.hash || '').split('/')[0]

// Small, safe markdown: escape first, then **bold**, [text](#hash) links, bullets, line breaks.
function md(text) {
  const lines = esc(String(text || '')).split('\n')
  let html = '', inList = false
  for (const raw of lines) {
    let l = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\((#[^)\s]*)\)/g, '<a href="$2" class="nx-link">$1</a>')
    const bullet = /^\s*(?:[-•*]|\d+\.)\s+/.test(raw)
    if (bullet) { if (!inList) { html += '<ul>'; inList = true } html += `<li>${l.replace(/^\s*(?:[-•*]|\d+\.)\s+/, '')}</li>`; continue }
    if (inList) { html += '</ul>'; inList = false }
    html += l.trim() ? `<p>${l}</p>` : ''
  }
  return html + (inList ? '</ul>' : '')
}

export function startNexus() {
  if (root) return
  state = { open: false, busy: false, msgs: load() }
  root = document.createElement('div')
  root.className = 'nx-root'
  root.innerHTML = `
    <button type="button" class="nx-fab" aria-label="Ask Nexus" title="Ask Nexus — your HQ assistant">${NEXUS_LOGO(28)}</button>
    <section class="nx-panel" role="dialog" aria-label="Nexus assistant" hidden>
      <header class="nx-head">
        <span class="nx-badge">${NEXUS_LOGO(22)}</span>
        <span class="nx-title"><b>Nexus</b><small>Your HQ assistant · Hindi or English</small></span>
        <button type="button" class="nx-icon" data-nx="clear" title="New chat" aria-label="New chat">↺</button>
        <button type="button" class="nx-icon" data-nx="close" title="Close" aria-label="Close">✕</button>
      </header>
      <div class="nx-body" aria-live="polite"></div>
      <form class="nx-form">
        <textarea rows="1" placeholder="Ask Nexus anything about HQ…" aria-label="Message"></textarea>
        <button type="submit" class="nx-send" aria-label="Send">➤</button>
      </form>
    </section>`
  document.body.appendChild(root)
  const fab = root.querySelector('.nx-fab'), panel = root.querySelector('.nx-panel'), body = root.querySelector('.nx-body')
  const form = root.querySelector('.nx-form'), input = form.querySelector('textarea')

  const setOpen = open => {
    state.open = open
    panel.hidden = !open
    root.classList.toggle('is-open', open)
    document.body.classList.toggle('nx-open', open)
    if (open) { draw(); setTimeout(() => input.focus(), 50) }
  }
  fab.addEventListener('click', () => setOpen(!state.open))
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-nx]')
    if (b?.dataset.nx === 'close') setOpen(false)
    if (b?.dataset.nx === 'clear') { state.msgs = []; save(); draw() }
    const chip = e.target.closest('[data-ask]')
    if (chip) ask(chip.dataset.ask)
    const link = e.target.closest('.nx-link')
    if (link && window.matchMedia('(max-width: 640px)').matches) setOpen(false)
    const act = e.target.closest('[data-act]')
    if (act) decide(Number(act.dataset.i), act.dataset.act)
    const fb = e.target.closest('[data-fb]')
    if (fb) feedback(Number(fb.dataset.i), Number(fb.dataset.fb))
  })
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.open) setOpen(false) })
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px' })
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit() } })
  form.addEventListener('submit', e => { e.preventDefault(); const t = input.value.trim(); if (t) { input.value = ''; input.style.height = 'auto'; ask(t) } })

  function draw() {
    const m = state.msgs
    const chips = (SUGGEST[pageNow()] || DEFAULT_SUGGEST)
    body.innerHTML = (m.length ? '' : `
      <div class="nx-hello">
        <span class="nx-hello-mark">${NEXUS_LOGO(40)}</span>
        <h3>Namaste! I’m Nexus.</h3>
        <p>Ask me how to do anything in HQ, or ask for a customer’s dues, stock, orders, tasks… I can also send a ledger or invoice, add a task or save a follow-up — you confirm first.</p>
      </div>`) +
      m.map((x, i) => x.role === 'user'
        ? `<div class="nx-msg nx-me">${esc(x.text)}</div>`
        : `<div class="nx-msg nx-bot ${x.error ? 'is-error' : ''}">${md(x.text)}
            ${x.pending ? `<div class="nx-card"><div>${md(x.pending.summary)}</div>${x.pending.state === 'open'
              ? `<div class="nx-card-btns"><button type="button" class="nx-btn" data-act="cancel" data-i="${i}">Cancel</button><button type="button" class="nx-btn nx-primary" data-act="confirm" data-i="${i}">Confirm</button></div>`
              : `<div class="nx-card-state">${x.pending.state === 'done' ? '✓ Done' : x.pending.state === 'working' ? 'Working…' : x.pending.state === 'failed' ? '✕ Not done' : 'Cancelled'}</div>`}</div>` : ''}
            ${x.id && !x.pending ? `<div class="nx-fb"><button type="button" data-fb="1" data-i="${i}" class="${x.fb === 1 ? 'on' : ''}" title="Helpful">👍</button><button type="button" data-fb="-1" data-i="${i}" class="${x.fb === -1 ? 'on' : ''}" title="Not helpful">👎</button></div>` : ''}
          </div>`).join('') +
      (state.busy ? '<div class="nx-msg nx-bot nx-typing"><span></span><span></span><span></span></div>' : '') +
      (!state.busy && (!m.length || m[m.length - 1].role !== 'user') ? `<div class="nx-chips">${chips.map(c => `<button type="button" data-ask="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : '')
    body.scrollTop = body.scrollHeight
  }

  async function ask(text) {
    if (state.busy) return
    state.msgs.push({ role: 'user', text })
    state.busy = true; save(); draw()
    try {
      const history = state.msgs.filter(x => !x.error).map(x => ({ role: x.role, text: x.role === 'assistant' && x.pending ? `${x.text}\n[Proposed: ${x.pending.summary} — ${x.pending.state}]` : x.text }))
      const r = await call({ action: 'nexus', messages: history, page: pageNow() })
      state.msgs.push({ role: 'assistant', text: r.reply || '', id: r.id || null, pending: r.pending ? { ...r.pending, state: 'open' } : null })
    } catch (err) {
      state.msgs.push({ role: 'assistant', text: err.message, error: true })
    }
    state.busy = false; save(); draw()
  }

  async function decide(i, what) {
    const m = state.msgs[i]
    if (!m?.pending || m.pending.state !== 'open') return
    if (what === 'cancel') { m.pending.state = 'cancelled'; save(); draw(); return }
    m.pending.state = 'working'; draw()
    try {
      const r = await call({ action: 'nexus-confirm', tool: m.pending.tool, input: m.pending.input, page: pageNow() })
      if (r.error) throw new Error(r.error)
      m.pending.state = 'done'
      state.msgs.push({ role: 'assistant', text: r.result || 'Done.' })
    } catch (err) {
      m.pending.state = 'failed'
      state.msgs.push({ role: 'assistant', text: err.message, error: true })
    }
    save(); draw()
  }

  async function feedback(i, v) {
    const m = state.msgs[i]
    if (!m?.id) return
    m.fb = v; save(); draw()
    try { await call({ action: 'nexus-feedback', id: m.id, value: v }) } catch { /* not important */ }
  }
}

export function stopNexus() {
  root?.remove(); root = null
  document.body.classList.remove('nx-open')
  try { sessionStorage.removeItem(STORE) } catch { /* ignore */ }
}
