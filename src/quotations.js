import { supabase, getCurrentProfile, fetchAllRows } from './supabase.js'
import { esc, formatDate, formatMoney, formatMoneyCompact, skeletonList } from './utils.js'
import { openSidebar } from './sidebar.js'
import { renderQuotationForm } from './quotation-form.js'
import { renderQuotationView } from './quotation-view.js'

const PER_PAGE_OPTIONS = [10, 25, 50]
const DEFAULT_PER_PAGE = 10

const ACTIONS = [
  { action: 'edit', icon: '✏️', label: 'Edit' },
  { action: 'duplicate', icon: '⧉', label: 'Duplicate' },
  { action: 'print', icon: '🖨️', label: 'Print' },
  { action: 'pdf', icon: '⬇', label: 'Download PDF' },
]

// The brand mark rather than a speech bubble. 💬 is an emoji, which means it
// paints in its own colours whatever the button says — so it could not be
// made WhatsApp green, and read as "a message" rather than as WhatsApp. This
// is a filled glyph taking currentColor, so the button controls it.
//
// Not in icons.js: that set is one 24x24 stroke-drawn family with shared
// attributes, and a filled logo is neither of those things.
const WHATSAPP_GLYPH = `
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" aria-hidden="true">
    <path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.76-1.66-2.06-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51l-.57-.01c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.87 1.22 3.07.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.23 1.36.19 1.87.12.57-.09 1.76-.72 2.01-1.41.25-.69.25-1.29.17-1.41-.07-.12-.27-.2-.57-.35z"/>
    <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.87 9.87 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm0 18.13h-.01a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.11.82.83-3.04-.2-.31a8.16 8.16 0 0 1-1.25-4.36c0-4.54 3.7-8.23 8.24-8.23 2.2 0 4.27.86 5.82 2.42a8.18 8.18 0 0 1 2.41 5.82c0 4.54-3.7 8.23-8.25 8.23z"/>
  </svg>`

export async function renderQuotations(container) {
  const profile = await getCurrentProfile()
  const isAdmin = profile?.role === 'admin'

  container.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="hamburgerBtn" aria-label="Menu">☰</button>
          <span class="logo-small">Quotations</span>
        </div>
        <button class="btn-primary btn-small" id="newQuotationBtn">+ New quotation</button>
      </header>
      <main class="app-main">
        <div class="quotations-layout">
          <div class="quotations-main">
            <div class="qtn-filters">
              <div class="qtn-filters-row">
                <input type="text" id="searchInput" placeholder="Search client or quote no..." class="search-input" />
                <input type="date" id="dateFromInput" class="qtn-date-input" title="From date" />
                <span class="qtn-date-sep">to</span>
                <input type="date" id="dateToInput" class="qtn-date-input" title="To date" />
                <select id="customerFilter" class="filter-select">
                  <option value="">All customers</option>
                </select>
                <select id="brandFilter" class="filter-select">
                  <option value="">All brands</option>
                </select>
                <select id="salesPersonFilter" class="filter-select">
                  <option value="">All sales persons</option>
                </select>
              </div>
              <div class="qtn-filters-actions">
                <button class="btn-ghost btn-small" id="clearFiltersBtn">Clear Filters</button>
                <button class="btn-primary btn-small" id="applyFiltersBtn">Apply Filters</button>
              </div>
            </div>
            <div id="quotationList">
              ${skeletonList(4)}
            </div>
            <div id="quotationPagination"></div>
          </div>
          <div class="quotations-divider"></div>
          <div class="quotations-stats">
            <div class="stats-grid-2col" id="quotationStats">
              <div class="loading-state">Loading stats...</div>
            </div>
          </div>
        </div>
      </main>
    </div>
  `

  document.getElementById('hamburgerBtn').addEventListener('click', () => openSidebar({ isAdmin }))
  document.getElementById('newQuotationBtn').addEventListener('click', () => {
    renderQuotationForm(container, null, () => renderQuotations(container))
  })

  // ---- Data: fetched once per page-load, filtered/paginated entirely client-side --
  // the dataset is small (tens of quotations, not thousands), same tradeoff the old
  // version already made for its search box.
  const [quotations, items, profiles] = await Promise.all([
    fetchAllRows('quotations'),
    fetchAllRows('quotation_items', 'quotation_id, amount, on_request'),
    fetchAllRows('profiles', 'id, name, email'),
  ])

  // If the user navigated away while this was in flight, container's innerHTML
  // has already been replaced by whatever page they're on now -- bail rather
  // than throw trying to wire up elements that no longer exist. Every element
  // this function touches below was created together in the same innerHTML
  // assignment above, so this one check covers all of them.
  if (!document.getElementById('applyFiltersBtn')) return

  const profileById = {}
  profiles.forEach(p => { profileById[p.id] = p })
  const profileLabel = id => {
    const p = profileById[id]
    return p ? (p.name || p.email || 'Unknown') : 'Unassigned'
  }

  // One pass over quotation_items -- item count and grand total per quotation,
  // same "fetch everything, reduce client-side" shape as loadStats' brand tally.
  const itemStatsByQuotation = {}
  items.forEach(it => {
    const s = itemStatsByQuotation[it.quotation_id] || (itemStatsByQuotation[it.quotation_id] = { count: 0, amount: 0 })
    s.count++
    if (!it.on_request) s.amount += Number(it.amount) || 0
  })

  let page = 1
  let perPage = DEFAULT_PER_PAGE
  // The "applied" filter set -- only replaced when Apply Filters is clicked (or
  // Clear Filters resets it), per the spec's explicit Apply/Clear actions rather
  // than filtering live on every keystroke/selection.
  let applied = { search: '', dateFrom: '', dateTo: '', customer: '', brand: '', salesPerson: '' }

  populateFilterOptions()
  renderList()
  await loadStats()

  function populateFilterOptions() {
    const customers = [...new Set(quotations.map(q => q.client_name).filter(Boolean))].sort()
    const brands = [...new Set(quotations.map(q => q.brand).filter(Boolean))].sort()
    const salesPersonIds = [...new Set(quotations.map(q => q.created_by).filter(Boolean))]
      .sort((a, b) => profileLabel(a).localeCompare(profileLabel(b)))

    document.getElementById('customerFilter').innerHTML =
      '<option value="">All customers</option>' + customers.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')
    document.getElementById('brandFilter').innerHTML =
      '<option value="">All brands</option>' + brands.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('')
    document.getElementById('salesPersonFilter').innerHTML =
      '<option value="">All sales persons</option>' + salesPersonIds.map(id => `<option value="${esc(id)}">${esc(profileLabel(id))}</option>`).join('')
  }

  document.getElementById('applyFiltersBtn').addEventListener('click', () => {
    applied = {
      search: document.getElementById('searchInput').value.trim().toLowerCase(),
      dateFrom: document.getElementById('dateFromInput').value,
      dateTo: document.getElementById('dateToInput').value,
      customer: document.getElementById('customerFilter').value,
      brand: document.getElementById('brandFilter').value,
      salesPerson: document.getElementById('salesPersonFilter').value,
    }
    page = 1
    renderList()
  })

  document.getElementById('clearFiltersBtn').addEventListener('click', () => {
    document.getElementById('searchInput').value = ''
    document.getElementById('dateFromInput').value = ''
    document.getElementById('dateToInput').value = ''
    document.getElementById('customerFilter').value = ''
    document.getElementById('brandFilter').value = ''
    document.getElementById('salesPersonFilter').value = ''
    applied = { search: '', dateFrom: '', dateTo: '', customer: '', brand: '', salesPerson: '' }
    page = 1
    renderList()
  })

  function filteredQuotations() {
    return quotations.filter(q => {
      if (applied.search) {
        const hay = `${q.client_name || ''} ${q.quote_no || ''}`.toLowerCase()
        if (!hay.includes(applied.search)) return false
      }
      if (applied.dateFrom && (q.created_at || '').slice(0, 10) < applied.dateFrom) return false
      if (applied.dateTo && (q.created_at || '').slice(0, 10) > applied.dateTo) return false
      if (applied.customer && q.client_name !== applied.customer) return false
      if (applied.brand && q.brand !== applied.brand) return false
      if (applied.salesPerson && q.created_by !== applied.salesPerson) return false
      return true
    }).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  }

  function renderList() {
    const list = document.getElementById('quotationList')
    const paginationEl = document.getElementById('quotationPagination')
    if (!list) return

    const filtered = filteredQuotations()
    if (!filtered.length) {
      list.innerHTML = '<div class="empty-state">No quotations match these filters.</div>'
      paginationEl.innerHTML = ''
      return
    }

    const totalPages = Math.max(1, Math.ceil(filtered.length / perPage))
    if (page > totalPages) page = totalPages
    const start = (page - 1) * perPage
    const pageRows = filtered.slice(start, start + perPage)

    list.innerHTML = `
      <div class="qtn-table-wrap">
        <table class="qtn-table">
          <thead>
            <tr>
              <th>Quotation No.</th>
              <th>Date</th>
              <th>Customer</th>
              <th>Mobile</th>
              <th class="num">Items</th>
              <th class="num">Amount</th>
              <th>Sales Person</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${pageRows.map(q => {
              const stats = itemStatsByQuotation[q.id] || { count: 0, amount: 0 }
              return `
              <tr data-id="${q.id}">
                <td class="qtn-quote-no" data-label="Quotation No.">${esc(q.quote_no || '—')}</td>
                <td class="qtn-cell-date" data-label="Date">${q.created_at ? formatDate(q.created_at.slice(0, 10)) : '—'}</td>
                <td class="qtn-cell-customer" data-label="Customer">
                  <div class="qtn-customer-name">${esc(q.client_name || '—')}</div>
                  ${q.label ? `<div class="qtn-customer-sub">${esc(q.label)}</div>` : ''}
                </td>
                <td data-label="Mobile">
                  ${q.phone ? `
                    <div class="qtn-mobile">
                      <span>${esc(q.phone)}</span>
                      <button type="button" class="qtn-wa-btn" data-id="${q.id}" data-stop title="Send via WhatsApp" aria-label="Send via WhatsApp">${WHATSAPP_GLYPH}</button>
                    </div>
                  ` : '—'}
                </td>
                <td class="num" data-label="Items">${stats.count}</td>
                <td class="num qtn-amount" data-label="Amount">${formatMoney(stats.amount)}</td>
                <td data-label="Sales person">${esc(profileLabel(q.created_by))}</td>
                <td class="qtn-cell-actions" data-label="Actions">
                  <div class="qtn-actions-cell">
                    ${ACTIONS.map(a => `<button type="button" class="qtn-icon-btn" data-id="${q.id}" data-action="${a.action}" data-stop title="${esc(a.label)}">${a.icon}</button>`).join('')}
                  </div>
                </td>
              </tr>
            `}).join('')}
          </tbody>
        </table>
      </div>
    `

    list.querySelectorAll('tr[data-id]').forEach(row => {
      row.addEventListener('click', () => {
        renderQuotationView(container, row.dataset.id, () => renderQuotations(container))
      })
    })
    list.querySelectorAll('[data-stop]').forEach(el => {
      el.addEventListener('click', e => e.stopPropagation())
    })
    list.querySelectorAll('.qtn-wa-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        renderQuotationView(container, btn.dataset.id, () => renderQuotations(container), 'whatsapp')
      })
    })
    list.querySelectorAll('.qtn-icon-btn[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        renderQuotationView(container, btn.dataset.id, () => renderQuotations(container), btn.dataset.action)
      })
    })

    renderPagination(filtered.length, totalPages, start)
  }

  function renderPagination(total, totalPages, start) {
    const el = document.getElementById('quotationPagination')
    const end = Math.min(start + perPage, total)

    // Numbered buttons with an ellipsis once there are more pages than fit
    // comfortably -- always show first, last, current, and its neighbours.
    const pageNumbers = []
    for (let p = 1; p <= totalPages; p++) {
      if (p === 1 || p === totalPages || Math.abs(p - page) <= 1) pageNumbers.push(p)
      else if (pageNumbers[pageNumbers.length - 1] !== '…') pageNumbers.push('…')
    }

    el.innerHTML = `
      <div class="qtn-pagination">
        <span>Showing ${total ? start + 1 : 0} to ${end} of ${total} entries</span>
        <div class="qtn-page-btns">
          <button type="button" class="qtn-page-btn" id="qtnPrevBtn" ${page === 1 ? 'disabled' : ''}>‹</button>
          ${pageNumbers.map(p => p === '…'
            ? '<span class="qtn-page-ellipsis">…</span>'
            : `<button type="button" class="qtn-page-btn${p === page ? ' active' : ''}" data-page="${p}">${p}</button>`
          ).join('')}
          <button type="button" class="qtn-page-btn" id="qtnNextBtn" ${page === totalPages ? 'disabled' : ''}>›</button>
        </div>
        <div class="qtn-per-page">
          <label for="perPageSelect">Per page</label>
          <select id="perPageSelect">
            ${PER_PAGE_OPTIONS.map(n => `<option value="${n}" ${n === perPage ? 'selected' : ''}>${n}</option>`).join('')}
          </select>
        </div>
      </div>
    `

    el.querySelectorAll('.qtn-page-btn[data-page]').forEach(btn => {
      btn.addEventListener('click', () => { page = Number(btn.dataset.page); renderList() })
    })
    document.getElementById('qtnPrevBtn')?.addEventListener('click', () => { if (page > 1) { page--; renderList() } })
    document.getElementById('qtnNextBtn')?.addEventListener('click', () => { if (page < totalPages) { page++; renderList() } })
    document.getElementById('perPageSelect').addEventListener('change', e => {
      perPage = Number(e.target.value)
      page = 1
      renderList()
    })
  }

  async function loadStats() {
    const statsEl = document.getElementById('quotationStats')
    if (!statsEl) return

    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()

    const [{ count: totalCount }, { count: monthCount }, itemRows] = await Promise.all([
      supabase.from('quotations').select('id', { count: 'exact', head: true }),
      supabase.from('quotations').select('id', { count: 'exact', head: true }).gte('created_at', monthStart).lt('created_at', monthEnd),
      // One round trip for all brands — embeds quotations.brand via the quotation_items ->
      // quotations foreign key, then grouped/summed client-side instead of a query per brand.
      fetchAllRows('quotation_items', 'amount, on_request, quotations(brand)')
    ])

    // quotations.brand is now auto-derived from each quotation's items (see
    // quotation-form.js deriveBrandModel) rather than manually typed: a single
    // dominant brand stays as that brand's exact name, but a genuine mix of brands
    // comes through as "BrandA + BrandB" or "Mixed" — neither of which should get
    // folded into one of the three single-brand cards below, so they're tallied
    // into their own Mixed Value bucket instead.
    let combined = 0
    const byBrand = {}
    let mixedValue = 0
    for (const row of itemRows) {
      if (row.on_request) continue
      const amount = Number(row.amount) || 0
      combined += amount
      const brand = row.quotations?.brand
      if (!brand) continue
      if (brand === 'Mixed' || brand.includes(' + ')) {
        mixedValue += amount
      } else {
        byBrand[brand] = (byBrand[brand] || 0) + amount
      }
    }

    // Money reads short on the card and exact on hover. The two counts are
    // already short and have no longer form to show, so they carry no title —
    // a tooltip that repeats the thing it is pointing at is just noise.
    const money = n => ({ value: formatMoneyCompact(n), title: formatMoney(n) })

    const cards = [
      { label: 'Total Quotations', value: totalCount ?? 0, headline: true },
      { label: 'Combined Total Value', ...money(combined), headline: true },
      { label: 'LK Value', ...money(byBrand['LK'] || 0) },
      { label: 'Legrand Value', ...money(byBrand['Legrand'] || 0) },
      { label: 'Schneider Value', ...money(byBrand['Schneider Electric'] || 0) },
      { label: 'Mixed Value', ...money(mixedValue) },
      { label: "This Month's Quotations", value: monthCount ?? 0 }
    ]

    statsEl.innerHTML = cards.map(c => `
      <div class="stat-card${c.headline ? ' stat-card-headline' : ''}">
        <div class="stat-label">${esc(c.label)}</div>
        <div class="stat-value"${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(String(c.value))}</div>
      </div>
    `).join('')
  }
}
