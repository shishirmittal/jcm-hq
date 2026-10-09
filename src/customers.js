// Customer Card — any customer on the phone: name, mobiles, address, email,
// GSTIN, what they owe (with ageing), bills, ledger, orders and the payment
// follow-up history. Read only. Server: api/customers.js (admins, or the
// 'customers' page ticked in Manage Users).
//
// #customers            search / browse A–Z (25 per page)
// #customers/<code>     one customer's card
import './customers.css'
import { supabase } from './supabase.js'
import { apiUrl } from './native.js'
import { openSidebar } from './sidebar.js'
import { esc, formatMoney } from './utils.js'
import { icon } from './icons.js'

const Q_KEY = 'jcmHq.customersQ'
let searchTimer = null
let seq = 0

async function call(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(apiUrl('/api/customers'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
    body: JSON.stringify(payload),
  })
  let body = null
  try { body = await res.json() } catch { /* not JSON */ }
  if (!res.ok) throw new Error(body?.error || 'Something went wrong. Try again.')
  return body
}

const IST = { timeZone: 'Asia/Kolkata' }
function day(s) {
  if (!s) return ''
  const d = new Date(String(s).length === 10 ? s + 'T00:00:00+05:30' : s)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', ...IST })
}
function stamp(s) {
  if (!s) return ''
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', ...IST }) + ', ' +
    d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', ...IST })
}
function syncChip(label, at, lateHours) {
  if (!at) return ''
  const late = Date.now() - Date.parse(at) > lateHours * 3600e3
  return `<span class="hq-sync${late ? ' is-late' : ''}">${esc(label)} ${esc(stamp(at))}</span>`
}
// Busy keeps two numbers in one field sometimes ("98..,98.."). Mobiles lose a
// 0 / 91 in front; landlines (07412-230011) are kept as they are.
function phones(...vals) {
  const out = []
  for (const v of vals) {
    for (const part of String(v || '').split(/[,/;|]+|\s{2,}/)) {
      let d = part.replace(/\D/g, '')
      if (/^\s*0\d{2,4}\s*-\s*\d{5,8}\s*$/.test(part)) { if (!out.includes(d)) out.push(d); continue } // STD landline
      const m = d.match(/^(?:91|0)?([6-9]\d{9})$/)
      if (m) d = m[1]
      else if (d.length < 10) continue
      if (!out.includes(d)) out.push(d)
    }
  }
  return out
}
const pretty = d => /^[6-9]\d{9}$/.test(d) ? `${d.slice(0, 5)} ${d.slice(5)}` : d.replace(/^(0\d{4})(\d+)$/, '$1-$2')

function shell(container, title, back) {
  container.innerHTML = `
    <div class="app-layout cu-page">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px;min-width:0">
          ${back
            ? `<a class="btn-ghost cu-back" href="#customers" aria-label="Back">${icon('chevron-left', 18)}</a>`
            : '<button class="btn-ghost btn-hamburger" id="cuMenu" aria-label="Menu">☰</button>'}
          <span class="logo-small">${esc(title)}</span>
        </div>
        <span id="cuSync"></span>
      </header>
      <main class="app-main cu-main" id="cuMain"><div class="loading-state">Loading…</div></main>
    </div>`
  container.querySelector('#cuMenu')?.addEventListener('click', () => openSidebar())
  return container.querySelector('#cuMain')
}

export function renderCustomers(container, code) {
  if (code) return renderCard(container, code)
  const main = shell(container, 'Customer Card')
  let q = ''
  try { q = sessionStorage.getItem(Q_KEY) || '' } catch { /* private mode */ }
  main.innerHTML = `
    <div class="cu-searchbar">
      <span class="cu-search-icon">${icon('search', 18)}</span>
      <input id="cuQ" class="cu-search" type="search" inputmode="search" autocomplete="off"
        placeholder="Name, mobile or Busy code" value="${esc(q)}">
    </div>
    <div id="cuList"></div>`
  const input = main.querySelector('#cuQ')
  input.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => load(0), 300)
  })
  main.querySelector('#cuList').addEventListener('click', e => {
    const b = e.target.closest('[data-page]')
    if (b) { load(Number(b.dataset.page)); window.scrollTo({ top: 0 }) }
  })
  load(0)

  async function load(page) {
    const my = ++seq
    const list = main.querySelector('#cuList')
    const value = input.value.trim()
    try { sessionStorage.setItem(Q_KEY, value) } catch { /* ignore */ }
    if (!list.children.length) list.innerHTML = '<div class="loading-state">Loading…</div>'
    list.classList.add('is-busy')
    try {
      const d = await call({ action: 'search', q: value, page })
      if (my !== seq) return
      list.classList.remove('is-busy')
      if (!d.rows.length) {
        list.innerHTML = `<div class="cu-empty">${value ? `No customer matches “${esc(value)}”.` : 'No customers yet.'}</div>`
        return
      }
      const from = d.page * d.pageSize + 1
      const to = d.page * d.pageSize + d.rows.length
      list.innerHTML = `
        <div class="cu-count">${value ? 'Found' : 'All customers, A–Z'} · ${from}–${to} of ${d.total.toLocaleString('en-IN')}</div>
        <div class="cu-results">
          ${d.rows.map(r => `
            <a class="cu-row" href="#customers/${encodeURIComponent(r.code)}">
              <span class="cu-ava">${esc(initials(r.name))}</span>
              <span class="cu-row-main">
                <span class="cu-row-name">${esc(r.name)}</span>
                <span class="cu-row-sub">${[r.city, phones(r.mobile).map(pretty)[0]].filter(Boolean).map(esc).join(' · ') || `Code ${esc(r.code)}`}</span>
              </span>
              ${r.due > 0 ? `<span class="cu-due-pill">${esc(formatMoney(Math.round(r.due)))}</span>` : ''}
              <span class="cu-chev">${icon('chevron-right', 16)}</span>
            </a>`).join('')}
        </div>
        ${pager(d)}`
    } catch (err) {
      if (my !== seq) return
      list.classList.remove('is-busy')
      list.innerHTML = `<div class="cu-error">${esc(err.message)}</div>`
    }
  }
}

function pager(d) {
  const pages = Math.ceil(d.total / d.pageSize)
  if (pages <= 1) return ''
  return `<div class="cu-pager">
    <button class="btn-ghost btn-small" data-page="${d.page - 1}" ${d.page <= 0 ? 'disabled' : ''}>${icon('chevron-left', 14)} Previous</button>
    <span>Page ${d.page + 1} of ${pages}</span>
    <button class="btn-ghost btn-small" data-page="${d.page + 1}" ${d.page >= pages - 1 ? 'disabled' : ''}>Next ${icon('chevron-right', 14)}</button>
  </div>`
}

function initials(name) {
  const w = String(name || '').replace(/^(m\/s\.?|messrs\.?)\s+/i, '').split(/\s+/).filter(Boolean)
  return ((w[0]?.[0] || '') + (w[1]?.[0] || '')).toUpperCase() || '?'
}

const STAGE = { new: 'New', picking: 'Picking', invoiced: 'Invoiced', checked: 'Checked', in_bay: 'Ready for Dispatch', dispatched: 'Dispatched', waiting: 'Waiting for material' }
const OUTCOME = { promised: 'Promised', paid: 'Paid', call_later: 'Call later', no_answer: 'No answer', dispute: 'Dispute', wrong_number: 'Wrong number', refused: 'Refused', message_sent: 'Message sent', sent: 'Reminder sent', failed: 'Reminder failed', no_number: 'No number', other: 'Other' }
const CHANNEL = { call: 'Call', whatsapp: 'WhatsApp', visit: 'Visit', note: 'Note', reminder: 'Reminder' }

async function renderCard(container, code) {
  const main = shell(container, 'Customer Card', true)
  let d
  try {
    d = await call({ action: 'card', party_code: code })
  } catch (err) {
    main.innerHTML = `<div class="cu-error">${esc(err.message)}</div>`
    return
  }
  if (!d.found) {
    main.innerHTML = '<div class="cu-empty">This customer is not in the Busy data.</div>'
    return
  }
  container.querySelector('#cuSync').innerHTML = syncChip('Busy', d.customersAsOf, 30)

  const nums = phones(d.mobile, d.whatsapp, d.phones)
  const mobiles = nums.filter(n => /^[6-9]\d{9}$/.test(n))
  const wa = phones(d.whatsapp).find(n => mobiles.includes(n)) || mobiles[0]
  const ag = d.dues.ageing
  const agBits = ag ? [['0–30 days', ag.d0_30], ['31–60', ag.d31_60], ['61–90', ag.d61_90], ['90+', ag.d90], ['Older', ag.older]].filter(([, v]) => v > 0) : []
  const agTotal = agBits.reduce((s, [, v]) => s + v, 0) || 1

  main.innerHTML = `
    <section class="cu-hero">
      <span class="cu-ava cu-ava-lg">${esc(initials(d.name))}</span>
      <div class="cu-hero-text">
        <h1 class="cu-name">${esc(d.name)}</h1>
        <div class="cu-sub">${[d.city, d.group, `Busy code ${d.code}`].filter(Boolean).map(esc).join(' · ')}</div>
      </div>
    </section>

    <div class="cu-actions">
      ${nums[0] ? `<a class="cu-act" href="tel:${nums[0]}">${icon('phone', 18)}<span>Call</span></a>` : ''}
      ${wa ? `<a class="cu-act" href="https://wa.me/91${wa}" target="_blank" rel="noopener">${icon('message', 18)}<span>WhatsApp</span></a>` : ''}
      ${d.canFollowUp ? `<a class="cu-act" href="#payment-followup">${icon('rupee', 18)}<span>Follow-up</span></a>` : ''}
    </div>

    <section class="cu-card cu-due ${d.dues.amount > 0 ? 'is-owing' : 'is-clear'}">
      <div class="cu-due-top">
        <div>
          <div class="cu-k">Outstanding</div>
          <div class="cu-due-amt">${d.dues.amount > 0 ? esc(formatMoney(Math.round(d.dues.amount))) : 'Nothing due'}</div>
        </div>
        ${syncChip('Dues', d.dues.asOf, 3)}
      </div>
      ${agBits.length ? `
        <div class="cu-agebar">${agBits.map(([, v], i) => `<span class="cu-age-${i}" style="flex:${v / agTotal}"></span>`).join('')}</div>
        <div class="cu-agelist">${agBits.map(([k, v], i) => `<span><i class="cu-age-${i}"></i>${esc(k)} <b>${esc(formatMoney(Math.round(v)))}</b></span>`).join('')}</div>` : ''}
      ${ag?.oldestUnpaid || ag?.lastBill ? `<div class="cu-due-foot">${ag.oldestUnpaid ? `Oldest unpaid bill ${esc(day(ag.oldestUnpaid))}` : ''}${ag.oldestUnpaid && ag.lastBill ? ' · ' : ''}${ag.lastBill ? `Last bill ${esc(day(ag.lastBill))}` : ''}</div>` : ''}
    </section>

    <section class="cu-card">
      <h2 class="cu-h">Contact</h2>
      <dl class="cu-dl">
        ${nums.map((n, i) => `<div><dt>${/^[6-9]\d{9}$/.test(n) ? 'Mobile' : 'Phone'}</dt><dd><a href="tel:${n}">${esc(pretty(n))}</a></dd></div>`).join('')}
        ${d.extra.map(x => `<div><dt>${esc(x.label)}</dt><dd>${linkify(x)}</dd></div>`).join('')}
        ${!nums.length && !d.extra.length ? '<div><dd class="cu-muted">No contact details in Busy.</dd></div>' : ''}
      </dl>
    </section>

    ${fold('bills', 'Bills', `${d.bills.total}`, true, `<div id="cuBills">${billsHtml(d.bills)}</div>`)}
    ${fold('ledger', 'Ledger', '', false, `<div id="cuLedger">${d.ledgerReady ? '<div class="loading-state">Loading…</div>' : ledgerNotReady()}</div>`)}
    ${fold('orders', 'Orders', `${d.orders.length}`, false, ordersHtml(d.orders))}
    ${d.followups ? fold('follow', 'Payment follow-ups', `${d.followups.length}`, false, followHtml(d.followups)) : ''}
  `

  main.addEventListener('click', async e => {
    const head = e.target.closest('[data-fold]')
    if (head) {
      const box = head.closest('.cu-fold')
      box.classList.toggle('is-open')
      head.setAttribute('aria-expanded', box.classList.contains('is-open'))
      if (box.dataset.id === 'ledger' && d.ledgerReady && !box.dataset.loaded) { box.dataset.loaded = '1'; loadLedger(0) }
      return
    }
    const bp = e.target.closest('#cuBills [data-page]')
    if (bp) {
      const el = main.querySelector('#cuBills')
      el.classList.add('is-busy')
      try { el.innerHTML = billsHtml(await call({ action: 'bills', party_code: d.code, page: Number(bp.dataset.page) })) }
      catch (err) { el.innerHTML = `<div class="cu-error">${esc(err.message)}</div>` }
      el.classList.remove('is-busy')
      return
    }
    const lp = e.target.closest('#cuLedger [data-page]')
    if (lp) loadLedger(Number(lp.dataset.page))
  })

  async function loadLedger(page) {
    const el = main.querySelector('#cuLedger')
    el.classList.add('is-busy')
    try {
      const l = await call({ action: 'ledger', party_code: d.code, page })
      el.innerHTML = l.ready ? ledgerHtml(l) : ledgerNotReady()
    } catch (err) { el.innerHTML = `<div class="cu-error">${esc(err.message)}</div>` }
    el.classList.remove('is-busy')
  }
}

function linkify(x) {
  const v = esc(x.value)
  if (/mail/i.test(x.key) && /@/.test(x.value)) return `<a href="mailto:${v}">${v}</a>`
  return v
}

function fold(id, title, count, open, inner) {
  return `<section class="cu-card cu-fold${open ? ' is-open' : ''}" data-id="${id}">
    <button type="button" class="cu-fold-head" data-fold aria-expanded="${open}">
      <span class="cu-h">${esc(title)}</span>
      ${count ? `<span class="cu-fold-count">${esc(count)}</span>` : ''}
      <span class="cu-fold-chev">${icon('chevron-down', 16)}</span>
    </button>
    <div class="cu-fold-body">${inner}</div>
  </section>`
}

function billsHtml(b) {
  if (!b.rows.length) return '<div class="cu-muted cu-pad">No bills in Busy for this customer.</div>'
  return `<table class="cu-table">
      <thead><tr><th>Date</th><th>Bill</th><th class="num">Amount</th></tr></thead>
      <tbody>${b.rows.map(r => `<tr><td>${esc(day(r.date))}</td><td>${esc(String(r.no))}</td><td class="num">${r.amount === null ? '' : esc(formatMoney(r.amount))}</td></tr>`).join('')}</tbody>
    </table>${pager(b)}`
}

function ledgerNotReady() {
  return `<div class="cu-muted cu-pad">The full ledger (receipts, payments, notes) is not in HQ yet — it needs one new
    sync on JCM-Server. Bills and the outstanding above are up to date.</div>`
}

function ledgerHtml(l) {
  if (!l.rows.length) return '<div class="cu-muted cu-pad">No entries this year.</div>'
  return `${l.asOf ? `<div class="cu-pad cu-ledger-sync">${syncChip('Ledger', l.asOf, 3)}</div>` : ''}
    <table class="cu-table">
      <thead><tr><th>Date</th><th>Entry</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
      <tbody>${l.rows.map(r => `<tr>
        <td>${esc(day(r.date))}</td>
        <td>${esc([r.type, r.no].filter(Boolean).join(' '))}${r.narration ? `<div class="cu-muted cu-small">${esc(r.narration)}</div>` : ''}</td>
        <td class="num">${r.debit ? esc(formatMoney(r.debit)) : ''}</td>
        <td class="num">${r.credit ? esc(formatMoney(r.credit)) : ''}</td>
        <td class="num">${r.balance === null || r.balance === undefined ? '' : esc(formatMoney(Math.abs(r.balance))) + (r.balance < 0 ? ' Cr' : ' Dr')}</td>
      </tr>`).join('')}</tbody>
    </table>${pager(l)}`
}

function ordersHtml(rows) {
  if (!rows.length) return '<div class="cu-muted cu-pad">No sales orders since JCM Orders started (4 Oct 2026).</div>'
  return `<div class="cu-orders">${rows.map(o => {
    const done = o.closed_at || o.stage === 'dispatched'
    return `<div class="cu-order">
      <div><b>SO ${esc(String(o.so_vch_no).split('/').pop())}</b> · ${esc(day(o.so_date))}${o.invoice_vch_no ? ` · Bill ${esc(o.invoice_vch_no)}` : ''}</div>
      <div class="cu-order-side">
        <span class="cu-stage${done ? ' is-done' : ''}">${esc(STAGE[o.stage] || o.stage)}</span>
        ${o.order_value ? `<span class="cu-muted cu-small">${esc(formatMoney(Math.round(o.order_value)))}</span>` : ''}
      </div>
    </div>`
  }).join('')}</div>`
}

function followHtml(rows) {
  if (!rows.length) return '<div class="cu-muted cu-pad">No calls or reminders saved yet.</div>'
  return `<div class="cu-follow">${rows.map(f => `
    <div class="cu-fu">
      <div class="cu-fu-top"><b>${esc(CHANNEL[f.channel] || f.channel)}${f.outcome ? ` · ${esc(OUTCOME[f.outcome] || f.outcome)}` : ''}</b><span class="cu-muted cu-small">${esc(stamp(f.at))}${f.by ? ` · ${esc(f.by)}` : ''}</span></div>
      ${f.remarks ? `<div>${esc(f.remarks)}</div>` : ''}
      ${f.promisedAmount || f.promisedDate ? `<div class="cu-small">Promised ${f.promisedAmount ? esc(formatMoney(f.promisedAmount)) : ''}${f.promisedDate ? ` by ${esc(day(f.promisedDate))}` : ''}</div>` : ''}
      ${f.next ? `<div class="cu-small cu-muted">Next follow-up ${esc(day(f.next))}</div>` : ''}
    </div>`).join('')}</div>`
}
