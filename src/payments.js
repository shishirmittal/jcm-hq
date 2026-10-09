import { supabase } from './supabase.js'
import { openSidebar } from './sidebar.js'
import { esc, formatMoney } from './utils.js'
import { canSee } from './permissions.js'

const TABS = ['payments', 'feedback']
const TAB_LABELS = { payments: 'Payments received', feedback: 'Feedback' }

function stars(n) {
  return '★'.repeat(n) + '☆'.repeat(5 - n)
}

function fmtDate(s) {
  const d = new Date(s)
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
}

// Feeds off the same pay_payments/pay_feedback tables that pay.jcmretails.com's
// checkout flow writes to (see that project's sql/schema.sql) — this replaces
// its standalone, PIN-gated admin.html with a page inside the CRM's own auth.
export async function renderPayments(container, tab) {
  const activeTab = TABS.includes(tab) ? tab : 'payments'
  // Gated on the granted tab rather than on being an admin: Payments can now
  // be ticked for one person in Manage Users without making them a full
  // admin, and this guard has to agree with the sidebar or the tab shows up
  // and then refuses to open.
  if (!canSee('payments')) {
    container.innerHTML = '<div class="empty-state">You do not have access to this page.</div>'
    setTimeout(() => { window.location.hash = '' }, 1500)
    return
  }

  container.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="hamburgerBtn" aria-label="Menu">☰</button>
          <span class="logo-small">Payments</span>
        </div>
        <button class="btn-ghost" id="payRefreshBtn">Refresh</button>
      </header>
      <main class="app-main">
        <div class="stats-grid" id="paySummary"><div class="loading-state">Loading summary...</div></div>
        <div class="op-tabs">
          ${TABS.map(t => `<button class="op-tab ${t === activeTab ? 'active' : ''}" data-tab="${t}">${esc(TAB_LABELS[t])}</button>`).join('')}
        </div>
        <div id="payContent"><div class="loading-state">Loading...</div></div>
      </main>
    </div>
  `

  document.getElementById('hamburgerBtn').addEventListener('click', () => openSidebar())
  container.querySelectorAll('.op-tab').forEach(btn => {
    btn.addEventListener('click', () => { window.location.hash = `#payments/${btn.dataset.tab}` })
  })
  document.getElementById('payRefreshBtn').addEventListener('click', load)

  load()

  async function load() {
    const summaryEl = document.getElementById('paySummary')
    const contentEl = document.getElementById('payContent')
    if (!contentEl) return
    contentEl.innerHTML = '<div class="loading-state">Loading...</div>'

    const [{ data: payments, error: payErr }, { data: feedback, error: fbErr }] = await Promise.all([
      supabase.from('pay_payments').select('*').order('created_at', { ascending: false }).limit(200),
      supabase.from('pay_feedback').select('*').order('created_at', { ascending: false }).limit(200)
    ])
    if (!container.isConnected) return

    const err = payErr || fbErr
    if (err) {
      summaryEl.innerHTML = ''
      contentEl.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`
      return
    }

    const paymentRows = payments || []
    const feedbackRows = feedback || []
    const totalAmount = paymentRows.reduce((s, p) => s + Number(p.amount || 0), 0)
    const avgRating = feedbackRows.length
      ? feedbackRows.reduce((s, f) => s + Number(f.rating || 0), 0) / feedbackRows.length
      : 0
    const lowRatings = feedbackRows.filter(f => f.rating <= 3).length

    summaryEl.innerHTML = `
      <div class="stat-card stat-card-headline"><div class="stat-label">Total received</div><div class="stat-value">${formatMoney(totalAmount)}</div></div>
      <div class="stat-card"><div class="stat-label">Payments</div><div class="stat-value">${paymentRows.length}</div></div>
      <div class="stat-card"><div class="stat-label">Avg. rating</div><div class="stat-value">${avgRating ? avgRating.toFixed(1) : '—'}</div></div>
      <div class="stat-card"><div class="stat-label">Needs follow-up</div><div class="stat-value">${lowRatings}</div></div>
    `

    if (activeTab === 'feedback') renderFeedbackTable(contentEl, feedbackRows)
    else renderPaymentsTable(contentEl, paymentRows)
  }
}

function renderPaymentsTable(el, payments) {
  if (payments.length === 0) {
    el.innerHTML = '<div class="empty-state">No payments yet.</div>'
    return
  }
  const rows = payments.map(p => `
    <tr>
      <td>${esc(p.customer_name)}</td>
      <td>+91 ${esc(p.customer_mobile)}</td>
      <td class="num">${formatMoney(p.amount)}</td>
      <td>${esc(p.razorpay_payment_id || '—')}</td>
      <td>${esc(fmtDate(p.created_at))}</td>
    </tr>
  `).join('')
  el.innerHTML = `
    <div class="op-table-wrap">
      <table class="op-table">
        <thead><tr><th>Name</th><th>Mobile</th><th class="num">Amount</th><th>Payment ID</th><th>Date</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `
}

function renderFeedbackTable(el, feedback) {
  if (feedback.length === 0) {
    el.innerHTML = '<div class="empty-state">No feedback yet.</div>'
    return
  }
  const rows = feedback.map(f => `
    <tr>
      <td>${esc(f.customer_name)}</td>
      <td>+91 ${esc(f.customer_mobile)}</td>
      <td>${esc(stars(f.rating))}</td>
      <td>${esc(f.feedback_text || '—')}</td>
      <td>${esc(fmtDate(f.created_at))}</td>
    </tr>
  `).join('')
  el.innerHTML = `
    <div class="op-table-wrap">
      <table class="op-table">
        <thead><tr><th>Name</th><th>Mobile</th><th>Rating</th><th>Comments</th><th>Date</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `
}
