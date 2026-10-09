import { supabase, getCurrentProfile } from './supabase.js'
import { supabaseBusy } from './supabase-busy.js'
import { renderProjectForm } from './project-form.js'
import { renderQuotationForm } from './quotation-form.js'
import { openSidebar } from './sidebar.js'
import { esc, PROJECT_STATUSES } from './utils.js'
import { icon } from './icons.js'

// Same six colours status-badge already uses elsewhere in the app (project
// cards, etc.) — see style.css .status-* — so a stage reads the same colour
// wherever it shows up, not a second palette invented just for this row.
const STATUS_BAR_COLORS = {
  'New Lead': '#93c5fd',
  'Store Visited': '#a5b4fc',
  'Quotation Given': '#fcd34d',
  'Partial Won': '#c4b5fd',
  'Project Final': '#6ee7b7',
  'Project Lost': '#fca5a5',
}

function greetingWord() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

// ₹18.4L / ₹1.2Cr style, for KPI card values only -- formatMoney (utils.js)
// stays the full-precision "₹18,40,000" form used everywhere else (invoices,
// quotations, line totals), where abbreviating would be wrong.
function compactMoney(n) {
  n = Number(n) || 0
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(1)}Cr`
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(1)}L`
  if (a >= 1e3) return `${sign}₹${(a / 1e3).toFixed(1)}K`
  return `${sign}₹${a.toFixed(0)}`
}

function relativeTime(dateStr) {
  const then = new Date(dateStr).getTime()
  const diffMin = Math.round((Date.now() - then) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin} min ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr} hr${diffHr === 1 ? '' : 's'} ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay === 1) return 'Yesterday'
  if (diffDay < 7) return `${diffDay} days ago`
  return new Date(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

// Project Leads' status filter is real (a <select> wired to .eq('status', ...)
// in project-leads.js) but only reachable through in-page UI, not a URL
// param -- and hash-routing structure is explicitly out of scope for this
// redesign. Rather than add a new #leads/<status> segment, the filter is
// handed over via a one-shot sessionStorage key that project-leads.js reads
// and clears on mount, so it applies exactly once and never leaks into a
// later, unrelated visit to #leads.
function goToLeadsFiltered(status) {
  if (status) sessionStorage.setItem('leadsStatusFilter', status)
  window.location.hash = '#leads'
}

function renderSectionError(el, message, retry) {
  el.innerHTML = `
    <div class="dash-card dash-error">
      <span>${icon('alert-triangle', 16)}</span>
      <span>${esc(message)}</span>
      <button type="button" class="btn-ghost btn-small dash-retry-btn">Retry</button>
    </div>
  `
  el.querySelector('.dash-retry-btn').addEventListener('click', retry)
}

// Landing page — a summary/overview screen, not the project list (that lives
// on its own Project Leads page). Data fetching lives in each render*()
// function below rather than one big upfront Promise.all, specifically so
// one section's query failing (section 6 requirement) shows an inline
// error+retry for just that section instead of blanking the whole page.
export async function renderDashboard(container) {
  const profile = await getCurrentProfile()
  const isAdmin = profile?.role === 'admin'
  const firstName = (profile?.name || '').trim().split(/\s+/)[0] || ''

  container.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="hamburgerBtn" aria-label="Menu">☰</button>
          <span class="logo-small">Dashboard</span>
        </div>
      </header>
      <main class="app-main dash-main">
        <div id="dashHeader"></div>
        <div id="dashPriorities"></div>
        <div id="dashKpis"></div>
        <div class="dash-two">
          <div id="dashPipeline"></div>
          <div id="dashQuickActions"></div>
        </div>
        <div id="dashActivity"></div>
      </main>
    </div>
  `
  document.getElementById('hamburgerBtn').addEventListener('click', () => openSidebar({ isAdmin }))

  renderDashboardHeader()
  renderQuickActions()
  renderPrioritySection()
  renderKpiCards()
  renderPipeline()
  renderRecentActivity()

  function renderDashboardHeader() {
    const el = document.getElementById('dashHeader')
    if (!el) return
    const today = new Date()
    el.innerHTML = `
      <div class="dash-head">
        <div>
          <div class="dash-greet">${esc(greetingWord())}${firstName ? `, ${esc(firstName)}` : ''}</div>
          <div class="dash-date">${esc(today.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }))}</div>
        </div>
        <div class="dash-head-actions">
          <button type="button" class="btn dash-btn-primary" id="dashNewLeadBtn">${icon('plus', 15)} New Lead</button>
          <button type="button" class="btn dash-btn-secondary" id="dashNewQuoteBtn">${icon('plus', 15)} New Quotation</button>
        </div>
      </div>
    `
    document.getElementById('dashNewLeadBtn').addEventListener('click', () => {
      renderProjectForm(null, () => renderDashboard(container))
    })
    document.getElementById('dashNewQuoteBtn').addEventListener('click', () => {
      renderQuotationForm(container, null, () => renderDashboard(container))
    })
  }

  function renderQuickActions() {
    const el = document.getElementById('dashQuickActions')
    if (!el) return
    el.innerHTML = `
      <div class="dash-card">
        <div class="dash-card-head"><span class="dash-h2">Quick actions</span></div>
        <div class="dash-qa">
          <button type="button" class="dash-qa-item dash-qa-primary" id="qaNewLead">${icon('plus', 17)}<span>New Lead</span></button>
          <button type="button" class="dash-qa-item" id="qaNewQuote">${icon('file', 17)}<span>New Quotation</span></button>
          <button type="button" class="dash-qa-item" id="qaLeads">${icon('briefcase', 17)}<span>Project Leads</span></button>
          <button type="button" class="dash-qa-item" id="qaOrders">${icon('box', 17)}<span>Order Planning</span></button>
        </div>
      </div>
    `
    document.getElementById('qaNewLead').addEventListener('click', () => {
      renderProjectForm(null, () => renderDashboard(container))
    })
    document.getElementById('qaNewQuote').addEventListener('click', () => {
      renderQuotationForm(container, null, () => renderDashboard(container))
    })
    document.getElementById('qaLeads').addEventListener('click', () => { window.location.hash = '#leads' })
    document.getElementById('qaOrders').addEventListener('click', () => { window.location.hash = '#order-planning' })
  }

  // ---- Today's priorities ----
  // Two of the spec's three tiles assume columns that turned out not to
  // exist once checked against the real schema: quotations has no
  // followup_date, and no status/response-tracking field of its own (only
  // id, quote_no, client_name, phone, address, city, brand, model,
  // project_id, created_by, pricing_mode, gst_rate, label — verified live).
  // "Follow-ups due" has no real source at all, so it renders a defined
  // empty state per the spec's "don't invent data" rule rather than a
  // fabricated count, and isn't a navigable button since there's nowhere
  // real to send it. "Quotations awaiting response" has no way to detect
  // "no subsequent status change" without a status-change history (the
  // same gap #1 documented for Recent Activity) -- it uses the best real
  // proxy available, projects still sitting at 'Quotation Given', which is
  // the same underlying condition the Pending Quotations KPI already uses.
  // That means these two numbers will read the same; noted in the report
  // rather than hidden.
  async function renderPrioritySection() {
    const el = document.getElementById('dashPriorities')
    if (!el) return
    el.innerHTML = `<div class="dash-h2">Today's priorities</div><div class="dash-prio">${skeletonTiles(3, 'dash-prio-skel')}</div>`

    try {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString()
      const [{ count: awaitingResponse }, { count: newLeadsWeek }] = await Promise.all([
        supabase.from('projects').select('id', { count: 'exact', head: true }).eq('status', 'Quotation Given'),
        supabase.from('projects').select('id', { count: 'exact', head: true }).eq('status', 'New Lead').gte('created_at', weekAgo),
      ])

      el.innerHTML = `
        <div class="dash-h2">Today's priorities</div>
        <div class="dash-prio">
          <div class="dash-prio-tile" title="Follow-up dates aren't tracked in the CRM yet">
            <span class="dash-prio-icon" style="background:var(--red-bg);color:var(--red)">${icon('clock', 18)}</span>
            <div>
              <div class="dash-prio-n">0</div>
              <div class="dash-prio-l">Follow-ups due</div>
              <div class="dash-prio-empty">Not tracked yet</div>
            </div>
          </div>
          <button type="button" class="dash-prio-tile" id="prioQuotes">
            <span class="dash-prio-icon" style="background:var(--amb-bg);color:var(--amb)">${icon('file', 18)}</span>
            <div>
              <div class="dash-prio-n">${(awaitingResponse || 0).toLocaleString('en-IN')}</div>
              <div class="dash-prio-l">Quotations awaiting response</div>
              <div class="dash-prio-action">View quotations ${icon('chevron-right', 12)}</div>
            </div>
          </button>
          <button type="button" class="dash-prio-tile" id="prioLeads">
            <span class="dash-prio-icon" style="background:var(--blue-bg);color:var(--blue)">${icon('user', 18)}</span>
            <div>
              <div class="dash-prio-n">${(newLeadsWeek || 0).toLocaleString('en-IN')}</div>
              <div class="dash-prio-l">New leads this week</div>
              <div class="dash-prio-action">View leads ${icon('chevron-right', 12)}</div>
            </div>
          </button>
        </div>
      `
      document.getElementById('prioQuotes').addEventListener('click', () => goToLeadsFiltered('Quotation Given'))
      document.getElementById('prioLeads').addEventListener('click', () => goToLeadsFiltered('New Lead'))
    } catch (err) {
      renderSectionError(el, `Couldn't load today's priorities: ${err.message}`, renderPrioritySection)
    }
  }

  // ---- KPI cards ----
  async function renderKpiCards() {
    const el = document.getElementById('dashKpis')
    if (!el) return
    el.innerHTML = `<div class="dash-kpis">${skeletonTiles(4, 'dash-kpi-skel')}</div>`

    try {
      const now = new Date()
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const yesterdayStart = new Date(dayStart.getTime() - 86400000)
      const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

      const [
        { count: todaysLeads }, { count: yesterdaysLeads },
        { count: pendingQuotations }, { count: pendingOver7d },
        wonRes, lowStockRes,
      ] = await Promise.all([
        supabase.from('projects').select('id', { count: 'exact', head: true }).gte('created_at', dayStart.toISOString()),
        supabase.from('projects').select('id', { count: 'exact', head: true }).gte('created_at', yesterdayStart.toISOString()).lt('created_at', dayStart.toISOString()),
        supabase.from('projects').select('id', { count: 'exact', head: true }).eq('status', 'Quotation Given'),
        supabase.from('projects').select('id', { count: 'exact', head: true }).eq('status', 'Quotation Given').lt('created_at', weekAgo),
        supabase.from('projects').select('value, status, created_at').gte('created_at', monthStart),
        // Order Planning lives in a separate Supabase project the app is
        // already connected to (supabase-busy.js) -- a head-only count
        // avoids pulling the ~4,400-row view just for one dashboard number.
        supabaseBusy.from('reorder_suggestions').select('code', { count: 'exact', head: true }).gt('suggested_order_qty', 0),
      ])
      if (wonRes.error) throw wonRes.error

      // "Won this month" is approximated the same way the app already did
      // before this redesign: by the PROJECT's created_at, not by when its
      // status actually changed to won (there's no status-change history to
      // know that -- same root gap as Recent Activity's data gap #1). A
      // project created in July but won in August won't count in August
      // here; that's a pre-existing limitation, not new to this pass.
      const wonProjects = (wonRes.data || []).filter(p => ['Project Final', 'Partial Won'].includes(p.status))
      const wonThisMonth = wonProjects.reduce((s, p) => s + (Number(p.value) || 0), 0)

      const leadsDelta = (todaysLeads ?? 0) - (yesterdaysLeads ?? 0)
      const leadsSubtitle = leadsDelta === 0 ? 'Same as yesterday' : `${leadsDelta > 0 ? '+' : ''}${leadsDelta} since yesterday`

      const cards = [
        { label: "Today's Leads", value: (todaysLeads ?? 0).toLocaleString('en-IN'), sub: leadsSubtitle, up: leadsDelta > 0, iconName: 'user', tint: 'blue', onClick: () => goToLeadsFiltered('') },
        { label: 'Pending Quotations', value: (pendingQuotations ?? 0).toLocaleString('en-IN'), sub: `${(pendingOver7d ?? 0).toLocaleString('en-IN')} over 7 days old`, iconName: 'file', tint: 'amb', onClick: () => goToLeadsFiltered('Quotation Given') },
        { label: 'Won This Month', value: compactMoney(wonThisMonth), sub: `${wonProjects.length} project${wonProjects.length === 1 ? '' : 's'} closed`, iconName: 'check', tint: 'grn' },
        lowStockRes.error
          ? { label: 'Low Stock Alerts', value: '—', sub: 'Order Planning unavailable', iconName: 'alert-triangle', tint: 'red' }
          : { label: 'Low Stock Alerts', value: (lowStockRes.count ?? 0).toLocaleString('en-IN'), sub: 'items need attention', iconName: 'alert-triangle', tint: 'red', onClick: () => { window.location.hash = '#order-planning' } },
      ]

      el.innerHTML = `
        <div class="dash-kpis">
          ${cards.map((c, i) => `
            <button type="button" class="dash-kpi${c.onClick ? '' : ' dash-kpi-static'}" data-kpi-idx="${i}">
              <div class="dash-kpi-top">
                <span class="dash-kpi-l">${esc(c.label)}</span>
                <span class="dash-kpi-icon" style="background:var(--${c.tint}-bg);color:var(--${c.tint})">${icon(c.iconName, 15)}</span>
              </div>
              <div class="dash-kpi-v">${esc(c.value)}</div>
              <div class="dash-kpi-s${c.up ? ' up' : ''}">${esc(c.sub)}</div>
            </button>
          `).join('')}
        </div>
      `
      cards.forEach((c, i) => {
        if (!c.onClick) return
        el.querySelector(`[data-kpi-idx="${i}"]`)?.addEventListener('click', c.onClick)
      })
    } catch (err) {
      renderSectionError(el, `Couldn't load KPIs: ${err.message}`, renderKpiCards)
    }
  }

  // ---- Sales pipeline ----
  async function renderPipeline() {
    const el = document.getElementById('dashPipeline')
    if (!el) return
    el.innerHTML = `<div class="dash-card"><div class="dash-card-head"><span class="dash-h2">Sales pipeline</span></div><div class="dash-pipe">${skeletonTiles(6, 'dash-stage-skel')}</div></div>`

    try {
      const { data, error } = await supabase.from('projects').select('status')
      if (error) throw error
      const counts = {}
      PROJECT_STATUSES.forEach(s => { counts[s] = 0 })
      ;(data || []).forEach(p => { if (counts[p.status] !== undefined) counts[p.status]++ })

      el.innerHTML = `
        <div class="dash-card">
          <div class="dash-card-head"><span class="dash-h2">Sales pipeline</span></div>
          <div class="dash-pipe">
            ${PROJECT_STATUSES.map(status => `
              <button type="button" class="dash-stage" data-status="${esc(status)}">
                <div class="dash-stage-n">${counts[status].toLocaleString('en-IN')}</div>
                <div class="dash-stage-l">${esc(status)}</div>
                <div class="dash-stage-bar" style="background:${STATUS_BAR_COLORS[status] || '#cbd5e1'}"></div>
              </button>
            `).join('')}
          </div>
        </div>
      `
      // Project Leads' status filter is real (see goToLeadsFiltered's own
      // comment) -- each stage jumps there pre-filtered.
      el.querySelectorAll('.dash-stage').forEach(btn => {
        btn.addEventListener('click', () => goToLeadsFiltered(btn.dataset.status))
      })
    } catch (err) {
      renderSectionError(el, `Couldn't load the pipeline: ${err.message}`, renderPipeline)
    }
  }

  // ---- Recent activity ----
  // No activity/event table exists (data gap #1) -- status changes aren't
  // logged anywhere, so this can only ever be "things with a created_at,"
  // not "what changed." notes/meetings tables exist in the schema but hold
  // zero rows (checked live), so they're left out rather than adding two
  // queries that can never return anything today.
  let activityRows = []
  let activityShown = 0
  const ACTIVITY_PAGE = 10

  async function renderRecentActivity() {
    const el = document.getElementById('dashActivity')
    if (!el) return
    el.innerHTML = `
      <div class="dash-card">
        <div class="dash-card-head"><span class="dash-h2">Recent activity</span></div>
        <div class="dash-act">${skeletonRows(4)}</div>
      </div>
    `

    try {
      const [{ data: projects, error: pErr }, { data: quotes, error: qErr }] = await Promise.all([
        supabase.from('projects').select('id, client_name, location, created_at').order('created_at', { ascending: false }).limit(30),
        supabase.from('quotations').select('id, client_name, quote_no, created_at').order('created_at', { ascending: false }).limit(30),
      ])
      if (pErr) throw pErr
      if (qErr) throw qErr

      const projectEvents = (projects || []).map(p => ({
        kind: 'project', created_at: p.created_at,
        title: p.client_name || 'New project',
        detail: `New project created${p.location ? ` · ${p.location}` : ''}`,
      }))
      const quoteEvents = (quotes || []).map(q => ({
        kind: 'quotation', created_at: q.created_at,
        title: q.client_name || 'New quotation',
        detail: `Quotation created${q.quote_no ? ` · ${q.quote_no}` : ''}`,
      }))
      activityRows = [...projectEvents, ...quoteEvents].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      activityShown = 0
      renderActivityRows()
    } catch (err) {
      renderSectionError(el, `Couldn't load recent activity: ${err.message}`, renderRecentActivity)
    }
  }

  function renderActivityRows() {
    const el = document.getElementById('dashActivity')
    if (!el) return
    activityShown = Math.min(activityShown + ACTIVITY_PAGE, activityRows.length)
    const visible = activityRows.slice(0, activityShown)

    el.innerHTML = `
      <div class="dash-card">
        <div class="dash-card-head"><span class="dash-h2">Recent activity</span></div>
        ${!visible.length ? `<div class="dash-empty">No recent activity yet — new leads and quotations will show up here.</div>` : `
          <div class="dash-act">
            ${visible.map(a => `
              <div class="dash-act-row">
                <span class="dash-act-icon" style="background:${a.kind === 'project' ? 'var(--blue-bg);color:var(--blue)' : 'var(--amb-bg);color:var(--amb)'}">${icon(a.kind === 'project' ? 'user' : 'file', 15)}</span>
                <div class="dash-act-body">
                  <div class="dash-act-title">${esc(a.title)}</div>
                  <div class="dash-act-detail">${esc(a.detail)}</div>
                </div>
                <div class="dash-act-time">${esc(relativeTime(a.created_at))}</div>
              </div>
            `).join('')}
          </div>
          ${activityShown < activityRows.length ? `<div class="dash-act-foot"><button type="button" class="btn-ghost btn-small" id="dashLoadMore">Load more</button></div>` : ''}
        `}
      </div>
    `
    document.getElementById('dashLoadMore')?.addEventListener('click', renderActivityRows)
  }
}

function skeletonTiles(n, className) {
  return Array.from({ length: n }, () => `<div class="dash-skel ${className}"></div>`).join('')
}
function skeletonRows(n) {
  return Array.from({ length: n }, () => `<div class="dash-skel dash-act-skel"></div>`).join('')
}
