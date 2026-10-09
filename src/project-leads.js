import { supabase, getCurrentProfile } from './supabase.js'
import { renderProjectForm } from './project-form.js'
import { renderProjectDetail } from './project-detail.js'
import { openSidebar } from './sidebar.js'
import { esc, slug, telHref, waHref, PROJECT_STATUSES } from './utils.js'

// The searchable/filterable project list that used to live on the Dashboard —
// moved to its own page (#leads) once Dashboard became a summary/overview
// screen instead of doubling as the list.
export async function renderProjectLeads(container) {
  const profile = await getCurrentProfile()
  const isAdmin = profile?.role === 'admin'

  container.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="hamburgerBtn" aria-label="Menu">☰</button>
          <span class="logo-small">Project Leads</span>
        </div>
        <button class="btn-primary btn-small" id="addProjectBtn">+ Add project</button>
      </header>
      <main class="app-main">
        <div class="stats-grid" id="statsGrid"></div>
        <div class="controls-bar">
          <input type="text" id="searchInput" placeholder="Search client, location..." class="search-input" />
          <select id="statusFilter" class="filter-select">
            <option value="">All statuses</option>
            ${PROJECT_STATUSES.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
          </select>
          <select id="cityFilter" class="filter-select">
            <option value="">All cities</option>
          </select>
        </div>
        <div id="projectList" class="project-list">
          <div class="loading-state">Loading projects...</div>
        </div>
      </main>
    </div>
  `

  // One-shot pre-filter from the Dashboard's priority tiles/pipeline stages
  // (dashboard.js's goToLeadsFiltered) -- hash routing is out of scope for
  // that redesign, so the desired status rides in sessionStorage instead of
  // a URL param, consumed (removed) here so it never leaks into a later,
  // unrelated visit to this page.
  const pendingStatus = sessionStorage.getItem('leadsStatusFilter')
  if (pendingStatus !== null) {
    sessionStorage.removeItem('leadsStatusFilter')
    const statusSelect = document.getElementById('statusFilter')
    if (statusSelect) statusSelect.value = pendingStatus
  }

  await loadStats()
  await loadCityOptions()
  await loadProjects()

  // Navigating away (e.g. one-click pinned-sidebar nav) while these awaits are
  // still in flight replaces container's contents before we get here, so every
  // lookup below can come back null — optional-chain them rather than crash on
  // a page nobody's looking at anymore.
  document.getElementById('hamburgerBtn')?.addEventListener('click', () => {
    openSidebar({ isAdmin })
  })
  document.getElementById('addProjectBtn')?.addEventListener('click', () => {
    renderProjectForm(null, () => renderProjectLeads(container))
  })
  document.getElementById('searchInput')?.addEventListener('input', loadProjects)
  document.getElementById('statusFilter')?.addEventListener('change', loadProjects)
  document.getElementById('cityFilter')?.addEventListener('change', loadProjects)

  async function loadStats() {
    const { data: projects } = await supabase.from('projects').select('status, value')
    if (!projects) return
    const total = projects.length
    const won = projects.filter(p => ['Project Final', 'Partial Won'].includes(p.status)).reduce((s, p) => s + (Number(p.value) || 0), 0)
    const active = projects.filter(p => p.status === 'Quotation Given').length

    const statsGrid = document.getElementById('statsGrid')
    if (!statsGrid) return
    statsGrid.innerHTML = `
      <div class="stat-card"><div class="stat-label">Total projects</div><div class="stat-value">${total}</div></div>
      <div class="stat-card"><div class="stat-label">Won</div><div class="stat-value won">₹${won.toLocaleString('en-IN')}</div></div>
      <div class="stat-card"><div class="stat-label">Active</div><div class="stat-value">${active}</div></div>
    `
  }

  function projectCity(p) {
    return (p.city || p.location || '').trim()
  }

  async function loadCityOptions() {
    const { data: projects, error } = await supabase.from('projects').select('*')
    const select = document.getElementById('cityFilter')
    if (!select) return
    if (error) { console.error('Failed to load cities:', error); return }
    const cities = [...new Set((projects || []).map(p => projectCity(p)).filter(Boolean))].sort()
    select.innerHTML = '<option value="">All cities</option>' +
      cities.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')
  }

  async function loadProjects() {
    const search = document.getElementById('searchInput')?.value?.toLowerCase() || ''
    const status = document.getElementById('statusFilter')?.value || ''
    const city = document.getElementById('cityFilter')?.value || ''

    // Aliased architect_contact, not architect — projects.architect is itself a
    // real (legacy) text column, so embedding under that same name would collide.
    let query = supabase.from('projects')
      .select('*, project_photos(url, path, created_at), architect_contact:industry_contacts!architect_id(name)')
      .order('created_at', { ascending: false })
    if (status) query = query.eq('status', status)

    const { data: projects, error } = await query
    const list = document.getElementById('projectList')
    if (!list) return

    if (error) {
      console.error('Failed to load projects:', error)
      list.innerHTML = `<div class="empty-state">Couldn't load projects: ${esc(error.message)}</div>`
      return
    }

    let filtered = projects || []
    if (city) filtered = filtered.filter(p => projectCity(p) === city)
    if (search) {
      filtered = filtered.filter(p =>
        (p.client_name || '').toLowerCase().includes(search) ||
        projectCity(p).toLowerCase().includes(search) ||
        (p.description || '').toLowerCase().includes(search)
      )
    }

    if (filtered.length === 0) {
      list.innerHTML = '<div class="empty-state">No projects yet. Click "+ Add project" to get started.</div>'
      return
    }

    list.innerHTML = filtered.map(p => {
      const thumb = (p.project_photos || [])[0]?.url
      const cityLabel = projectCity(p)
      const phone = p.whatsapp || p.phone
      const metaParts = []
      if (cityLabel) metaParts.push(esc(cityLabel))
      // Prefer the new linked contact; fall back to the old free-text field for
      // projects created before industry_contacts existed.
      const architectName = p.architect_contact?.name || p.architect
      if (architectName) metaParts.push(`Architect: ${esc(architectName)}`)
      return `
      <div class="project-card" data-id="${p.id}">
        ${thumb ? `<img class="project-thumb" src="${esc(thumb)}" alt="" />` : ''}
        <div class="project-card-body">
          <div class="project-card-main">
            <div>
              <div class="project-name">${esc(p.client_name)}</div>
              ${metaParts.length ? `<div class="project-meta">${metaParts.join(' · ')}</div>` : ''}
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
              <span class="status-badge status-${slug(p.status)}">${esc(p.status)}</span>
            </div>
          </div>
          ${(p.product_stages || []).length ? `
            <div class="stage-tags">
              ${p.product_stages.map(s => `<span class="stage-tag">${esc(s)}</span>`).join('')}
            </div>
          ` : ''}
          ${phone ? `
            <div class="contact-actions">
              <a class="btn-contact btn-call" href="${telHref(phone)}" title="Call ${esc(phone)}" data-stop>📞 Call</a>
              <a class="btn-contact btn-whatsapp" href="${waHref(phone)}" target="_blank" rel="noopener" title="WhatsApp ${esc(phone)}" data-stop>💬 WhatsApp</a>
            </div>
          ` : ''}
        </div>
      </div>
    `}).join('')

    list.querySelectorAll('[data-stop]').forEach(el => {
      el.addEventListener('click', e => e.stopPropagation())
    })

    list.querySelectorAll('.project-card').forEach(card => {
      card.addEventListener('click', () => {
        const app = document.getElementById('app')
        renderProjectDetail(app, card.dataset.id, () => renderProjectLeads(app))
      })
    })
  }
}
