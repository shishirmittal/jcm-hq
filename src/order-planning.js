import { getCurrentProfile } from './supabase.js'
import { supabaseBusy, fetchAllBusyRows } from './supabase-busy.js'
import { openSidebar } from './sidebar.js'
import { esc, formatMoney } from './utils.js'

const TABS = ['dashboard', 'settings', 'declutter']
const TAB_LABELS = { dashboard: 'Reorder Dashboard', settings: 'Item Settings', declutter: 'Declutter' }
const UNIT_DAYS = { days: 1, weeks: 7, months: 30 }

// purchase_rate is 0/blank for a meaningful chunk of items (never actually
// purchased at a recorded rate) — avg_rate on the base items table is a more
// honest "what this item typically costs" for those, so Est. Order Value falls
// back to it instead of silently pricing the line at ₹0.
function effectiveRate(row, avgRateByCode) {
  const pr = Number(row.purchase_rate) || 0
  if (pr !== 0) return pr
  return Number(avgRateByCode[row.code] || 0)
}

// null/undefined stock_qty means "we don't actually know the stock" (see
// stock_source), which is a different situation from "stock is zero" — the
// old `|| 0` coercion made needs_manual_check items compute a suggested qty
// as if they had none on hand, silently inflating the number instead of
// flagging it as unverifiable. Kept from the earlier fix even though it
// wasn't in the requested replacement snippet -- dropping it would silently
// bring back the exact "Verify stock" regression that fix addressed.
//
// Rounds the raw shortfall UP to the nearest multiple of min_order_qty
// (from Item Settings, defaulting to 1 for items no one's configured) --
// previously this ignored min_order_qty entirely, so saving it in Item
// Settings had zero effect on what the dashboard actually suggested.
function computeSuggestedQty(row, planDays) {
  if (row.stock_qty === null || row.stock_qty === undefined) return null
  const minOrderQty = Number(row.min_order_qty || 1)
  const raw = Number(row.avg_weekly_qty || 0) * (planDays / 7) - Number(row.stock_qty || 0)
  return Math.ceil(Math.max(0, raw) / minOrderQty) * minOrderQty
}

// Plain-text note for a stock_source value — shared by the HTML badge below
// and the declutter CSV export, so the wording (and busy_report_* date
// parsing) only lives in one place. includeUnpriced is off by default since
// reorder_suggestions no longer contains unpriced rows at all (excluded at
// the view level) — only declutter_candidates still needs that case.
function stockSourceNote(stockSource, { includeUnpriced = false } = {}) {
  if (stockSource === 'needs_manual_check') return 'Verify stock'
  if (typeof stockSource === 'string' && stockSource.startsWith('busy_report_')) {
    const dateStr = stockSource.slice('busy_report_'.length)
    const parsed = new Date(dateStr)
    const label = isNaN(parsed) ? dateStr : parsed.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    return `Stock as of ${label} (manual import)`
  }
  if (includeUnpriced && stockSource === 'unpriced') return 'No sale rate set'
  return ''
}

function stockSourceBadge(stockSource, opts) {
  const note = stockSourceNote(stockSource, opts)
  if (!note) return ''
  const icon = stockSource?.startsWith('busy_report_') ? '📋' : '⚠️'
  const title = stockSource === 'needs_manual_check'
    ? "This item hasn't sold recently in Busy; stock shown may be outdated, verify before ordering"
    : stockSource === 'unpriced'
    ? 'This item has no sale rate set in Busy'
    : 'Stock for this item comes from a manually imported Busy report, not the live sync'
  return `<span class="op-badge-warn" title="${esc(title)}">${icon} ${esc(note)}</span>`
}

// ---- Category tree (Reorder Dashboard navigation) ----
// Builds a tree from category_path (split on ' > ') so browsing can drill
// through the real hierarchy instead of a single brand-level list. A node
// holds BOTH child nodes AND items directly -- confirmed in the live data:
// 10 of 35 top-level brands have items sitting on a node that ALSO has
// sub-category children (e.g. "Signify Innovations" has 1 item with no
// sub-category at all, while the rest of its 724 items nest 1-4 levels
// deeper under it) -- and it recurs at intermediate levels too, not just at
// the brand root. So every node needs both an items array and a children
// map; there's no clean leaf-vs-branch split.
function buildCategoryTree(rows) {
  const root = { name: null, children: new Map(), items: [] }
  rows.forEach(r => {
    const segs = (r.category_path || 'Uncategorized').split(' > ').map(s => s.trim()).filter(Boolean)
    let node = root
    segs.forEach(seg => {
      if (!node.children.has(seg)) node.children.set(seg, { name: seg, children: new Map(), items: [] })
      node = node.children.get(seg)
    })
    node.items.push(r)
  })
  return root
}

// Same "flagged" definition the old brand grid used (suggested_order_qty >
// 0), aggregated across a node's own items AND every descendant -- what the
// card count badge shows.
function flaggedCount(node) {
  let count = node.items.filter(r => Number(r.suggested_order_qty) > 0).length
  for (const child of node.children.values()) count += flaggedCount(child)
  return count
}

// Every item under a node at any depth -- feeds both the item table (leaf
// click) and "search below this level."
function allItems(node) {
  let items = [...node.items]
  for (const child of node.children.values()) items = items.concat(allItems(child))
  return items
}

function nodeAtPath(root, path) {
  let node = root
  for (const seg of path) {
    node = node.children.get(seg)
    if (!node) return null // stale path -- guards a rebuild mid-navigation
  }
  return node
}

function matchesSearch(item, term) {
  const t = term.toLowerCase()
  return (item.name || '').toLowerCase().includes(t) || (item.alias || '').toLowerCase().includes(t)
}

// Re-evaluated fresh against the CURRENT node on every keystroke -- cheap
// enough (low thousands of rows worst case) that caching isn't worth the
// staleness risk when the path changes mid-search.
function computeSearchResults(currentNode, term) {
  const t = term.trim().toLowerCase()
  if (!t) return null

  // Category cards at this level whose own name matches, OR that have at
  // least one matching item somewhere beneath them -- each gets a match
  // count for its badge.
  const matchingCategories = []
  for (const [name, child] of currentNode.children) {
    const nameMatches = name.toLowerCase().includes(t)
    const matchingBelow = allItems(child).filter(r => matchesSearch(r, t))
    if (nameMatches || matchingBelow.length > 0) {
      matchingCategories.push({ name, node: child, matchCount: matchingBelow.length })
    }
  }

  // Items sitting directly on this node (not in a sub-category) that match.
  const directItemMatches = currentNode.items.filter(r => matchesSearch(r, t))

  // Everything matching anywhere under this level -- the flat list for the
  // "skip the drill-down" jump-straight-to-items view.
  const allMatchingItems = allItems(currentNode).filter(r => matchesSearch(r, t))

  return { matchingCategories, directItemMatches, allMatchingItems }
}

function breadcrumbLabel(path) {
  return path.length ? path.join(' > ') : 'All'
}

// ---- Reorder shortlist ("cart") ----
// Module-level, like declutterState -- decoupled from `path`/`searchTerm`/
// `tree` (all local to renderReorderDashboard and rebuilt on every call), so
// ticking a checkbox survives drilling, searching, even leaving Order
// Planning entirely and coming back. Only clears on an actual page reload.
const reorderShortlist = new Map() // code -> { code, name, brand, stock_qty, suggested_order_qty, qty }

// Ignores rows already present so re-adding via "select all" never clobbers
// a quantity the user already edited by hand.
function addToShortlist(row) {
  if (reorderShortlist.has(row.code)) return
  const suggested = row.liveQty // null when stock is unknown ("Verify stock")
  reorderShortlist.set(row.code, {
    code: row.code,
    name: row.name,
    brand: row.brand || 'Unbranded',
    stock_qty: row.stock_qty,
    suggested_order_qty: suggested,
    qty: suggested == null ? 0 : suggested, // a number input needs a real value; unknown-stock rows start at 0 for manual entry
  })
}

// Most urgent first by default. One shared column/direction for the whole
// item table, but applied independently WITHIN each brand-group's own rows
// (groups themselves stay in their existing alphabetical order) rather than
// flattening into one globally-ranked list across brands.
const reorderTableSort = createSortState('suggested_qty', 'desc')

function removeFromShortlist(code) {
  reorderShortlist.delete(code)
}

function toggleShortlist(row) {
  if (reorderShortlist.has(row.code)) removeFromShortlist(row.code)
  else addToShortlist(row)
}

function clearShortlist() {
  reorderShortlist.clear()
}

function areAllShortlisted(rows) {
  return rows.length > 0 && rows.every(r => reorderShortlist.has(r.code))
}

// If everything currently visible is already in, treat this as "deselect
// all of these"; otherwise add whichever aren't in yet, leaving already-
// present rows (and any qty already edited on them) untouched.
function toggleAllVisible(rows) {
  if (areAllShortlisted(rows)) rows.forEach(r => reorderShortlist.delete(r.code))
  else rows.forEach(r => addToShortlist(r))
}

// Standalone (not nested in renderReorderDashboard) so it's callable from
// anywhere the shortlist changes -- item-table checkboxes and the modal
// below alike -- without threading a callback through both. No-ops
// whenever #opShortlistBar isn't currently in the DOM (any other tab/page).
function renderShortlistBar() {
  const el = document.getElementById('opShortlistBar')
  if (!el) return
  const n = reorderShortlist.size
  el.innerHTML = n ? `
    <div class="op-shortlist-bar">
      <span>${n} item${n === 1 ? '' : 's'} shortlisted</span>
      <button type="button" class="btn-primary btn-small" id="opViewShortlistBtn">View list</button>
    </div>
  ` : ''
  document.getElementById('opViewShortlistBtn')?.addEventListener('click', openShortlistModal)
}

// A real modal overlay (not a stepBody swap) so it can be dismissed without
// disturbing whatever drill/search state is underneath it -- same pattern
// showContactForm() etc. already use elsewhere in this app.
function openShortlistModal() {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.body.appendChild(overlay)
  renderShortlistModal(overlay, close)
}

function renderShortlistModal(overlay, close) {
  const entries = [...reorderShortlist.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''))

  overlay.innerHTML = `
    <div class="modal op-shortlist-modal">
      <div class="modal-header">
        <h2>Shortlisted items (${entries.length})</h2>
        <button class="btn-ghost close-btn" style="padding:6px 10px">✕</button>
      </div>
      ${!entries.length ? `<div class="empty-state">Nothing shortlisted yet.</div>` : `
        <div class="controls-bar" style="justify-content:flex-end">
          <button type="button" class="btn-ghost btn-small" id="opShortlistClearBtn">Clear all</button>
          <button type="button" class="btn-ghost btn-small" id="opShortlistCopyBtn">📋 Copy to clipboard</button>
          <button type="button" class="btn-primary btn-small" id="opShortlistCsvBtn">⬇ Download CSV</button>
        </div>
        <div class="op-table-wrap">
          <table class="op-table">
            <thead>
              <tr><th>Item</th><th>Brand</th><th class="num">Stock</th><th class="num">Qty</th><th></th></tr>
            </thead>
            <tbody>
              ${entries.map(e => `
                <tr data-code="${e.code}">
                  <td>${esc(e.name)}</td>
                  <td>${esc(e.brand)}</td>
                  <td class="num">${e.stock_qty ?? '—'}</td>
                  <td class="num"><input type="number" min="0" class="mini-input op-shortlist-qty" value="${e.qty}" style="width:70px" /></td>
                  <td><button type="button" class="btn-ghost btn-small op-shortlist-remove" title="Remove">✕</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `

  overlay.querySelector('.close-btn').addEventListener('click', close)
  if (!entries.length) return

  overlay.querySelectorAll('.op-shortlist-qty').forEach(input => {
    input.addEventListener('input', () => {
      const code = Number(input.closest('tr').dataset.code)
      const entry = reorderShortlist.get(code)
      if (entry) entry.qty = Number(input.value) || 0
    })
  })
  overlay.querySelectorAll('.op-shortlist-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      removeFromShortlist(Number(btn.closest('tr').dataset.code))
      renderShortlistBar()
      renderShortlistModal(overlay, close)
    })
  })
  document.getElementById('opShortlistClearBtn').addEventListener('click', () => {
    clearShortlist()
    renderShortlistBar()
    renderShortlistModal(overlay, close)
  })

  const buildShortlistCsvText = () => {
    const csvRows = [
      ['Item', 'Brand', 'Stock', 'Qty'],
      ...entries.map(e => [e.name, e.brand, e.stock_qty ?? '', e.qty])
    ]
    return csvRows.map(row => row.map(csvEscape).join(',')).join('\n')
  }
  document.getElementById('opShortlistCsvBtn').addEventListener('click', () => {
    const blob = new Blob([buildShortlistCsvText()], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'reorder-shortlist.csv'
    a.click()
    URL.revokeObjectURL(url)
  })
  document.getElementById('opShortlistCopyBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(buildShortlistCsvText())
    const btn = document.getElementById('opShortlistCopyBtn')
    btn.textContent = 'Copied ✓'
    setTimeout(() => { if (btn.isConnected) btn.textContent = '📋 Copy to clipboard' }, 1500)
  })
}

// ---- Column sorting (shared by Item Settings, the Reorder Dashboard's item
// table, and Declutter) ----
// State shape: { column: string|null, dir: 'asc'|'desc' }. column: null means
// "no sort applied, keep current order" -- the default for Item Settings and
// Declutter. Comparators take (a, b, dir) rather than a plain ascending-only
// comparator that gets reversed afterwards -- reversing a whole sorted array
// for 'desc' would flip null values (genuinely unknown stock, not zero) to
// the FRONT on any descending sort, when they should sort last regardless of
// direction, same reasoning as everywhere else in this file that null stock
// isn't allowed to silently read as zero.

function createSortState(defaultColumn = null, defaultDir = 'asc') {
  return { column: defaultColumn, dir: defaultDir }
}

// Same column clicked again -> flip direction. Different column -> switch to
// it, ascending.
function toggleSort(state, column) {
  if (state.column === column) state.dir = state.dir === 'asc' ? 'desc' : 'asc'
  else { state.column = column; state.dir = 'asc' }
}

function applySort(rows, state, comparators) {
  if (!state.column || !comparators[state.column]) return rows
  const cmp = comparators[state.column]
  return [...rows].sort((a, b) => cmp(a, b, state.dir))
}

// One clickable <th> with a ▲/▼ indicator when it's the active column.
function sortableHeader(state, column, label, extraClass = '') {
  const active = state.column === column
  const arrow = active ? (state.dir === 'asc' ? ' ▲' : ' ▼') : ''
  const cls = ['op-sortable-th', extraClass, active ? 'active' : ''].filter(Boolean).join(' ')
  return `<th class="${cls}" data-sort-col="${column}">${esc(label)}${arrow}</th>`
}

function wireSortableHeaders(container, state, onSort) {
  container.querySelectorAll('[data-sort-col]').forEach(th => {
    th.addEventListener('click', () => { toggleSort(state, th.dataset.sortCol); onSort() })
  })
}

// Dir-aware comparators, reused across every table's own comparator map.
function compareNumber(a, b, dir) {
  const an = Number(a) || 0, bn = Number(b) || 0
  return dir === 'asc' ? an - bn : bn - an
}
function compareNullableNumber(a, b, dir) {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  return dir === 'asc' ? a - b : b - a
}
function compareText(a, b, dir) {
  const cmp = (a || '').localeCompare(b || '')
  return dir === 'asc' ? cmp : -cmp
}

export async function renderOrderPlanning(container, tab) {
  const activeTab = TABS.includes(tab) ? tab : 'dashboard'
  const profile = await getCurrentProfile()
  const isAdmin = profile?.role === 'admin'

  container.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="hamburgerBtn" aria-label="Menu">☰</button>
          <span class="logo-small">Order Planning</span>
        </div>
        <div id="opSyncStatus"></div>
      </header>
      <main class="app-main">
        <div class="op-tabs">
          ${TABS.map(t => `<button class="op-tab ${t === activeTab ? 'active' : ''}" data-tab="${t}">${esc(TAB_LABELS[t])}</button>`).join('')}
        </div>
        <div id="opContent"></div>
      </main>
    </div>
  `

  document.getElementById('hamburgerBtn').addEventListener('click', () => openSidebar({ isAdmin }))
  container.querySelectorAll('.op-tab').forEach(btn => {
    btn.addEventListener('click', () => { window.location.hash = `#order-planning/${btn.dataset.tab}` })
  })

  loadSyncStatus()

  const content = document.getElementById('opContent')
  if (activeTab === 'settings') renderItemSettings(content)
  else if (activeTab === 'declutter') renderDeclutter(content)
  else renderReorderDashboard(content)
}

async function loadSyncStatus() {
  const el = document.getElementById('opSyncStatus')
  if (!el) return
  // job='nightly' specifically: sync-stock-live.js writes a sync_log row every
  // ten minutes during the day, and without this filter the newest row would
  // almost always be that one — so this pill would report the stock refresh as
  // the last full sync, and would never warn that the nightly had stopped.
  //
  // The column is added by README-stock-live.md's first SQL block and defaults
  // to 'nightly', so existing rows match. Until that has been run the filter
  // is an error, not an empty result, so fall back to the unfiltered read
  // rather than leaving this pill blank in the meantime.
  let { data, error } = await supabaseBusy.from('sync_log').select('*').eq('job', 'nightly').order('run_at', { ascending: false }).limit(1)
  if (error) {
    ({ data } = await supabaseBusy.from('sync_log').select('*').order('run_at', { ascending: false }).limit(1))
  }
  const last = data?.[0]
  if (!el.isConnected) return
  if (!last) { el.innerHTML = ''; return }

  const runAt = new Date(last.run_at)
  const hoursAgo = (Date.now() - runAt.getTime()) / 36e5
  const warn = hoursAgo > 36 || last.status === 'error'
  const timeText = runAt.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
  el.innerHTML = `
    <span class="op-sync-pill ${warn ? 'op-sync-warn' : ''}" title="${last.status === 'error' ? esc(last.error_message || 'Sync failed') : ''}">
      ${warn ? '⚠️ ' : ''}Last synced: ${esc(timeText)}${last.status === 'error' ? ' (failed)' : ''}
    </span>
  `
}

// ---- Screen A: Reorder Dashboard ----
// Drillable category tree (brand > sub-brand > ... > item, arbitrary depth --
// see buildCategoryTree) plus a persistent search box, replacing what used to
// be a flat brand-multiselect. Landing on a leaf category (or a search
// result) opens the item table below, which recomputes live from the "Plan
// for next" control -- that table's own logic (badges, null-stock handling,
// grouping) is untouched from before; only how you reach it changed.
async function renderReorderDashboard(container) {
  container.innerHTML = '<div class="loading-state">Loading reorder suggestions...</div>'

  const [allRows, avgRateRows] = await Promise.all([
    fetchAllBusyRows('reorder_suggestions'),
    fetchAllBusyRows('items', 'code, avg_rate')
  ])
  if (!container.isConnected) return
  const avgRateByCode = {}
  avgRateRows.forEach(r => { avgRateByCode[r.code] = r.avg_rate })
  const tree = buildCategoryTree(allRows)

  // Siblings of the grid/item-table content rather than part of it, since
  // stepBody replaces its own contents wholesale on every re-render —
  // nesting the summary or shortlist bar inside would mean re-fetching or
  // re-threading them through every screen. The shortlist bar in particular
  // has to survive here regardless of whether you're browsing the category
  // grid or looking at an item table, since reorderShortlist persists across
  // both (and across mounts entirely) — see its own comment further down.
  container.innerHTML = `
    <p class="client-meta" id="opCoverageSummary">Loading coverage summary…</p>
    <div id="opStepBody"></div>
    <div id="opShortlistBar"></div>
  `
  loadCoverageSummary()
  renderShortlistBar()
  const stepBody = document.getElementById('opStepBody')

  let path = []               // segment names from root to the current node; also the breadcrumb
  let searchTerm = ''
  let searchItemViewActive = false  // true once "Show all N matching items" has been clicked

  renderCategoryGrid()

  // Queried directly from items rather than derived from reorder_suggestions,
  // since the view no longer contains unpriced rows at all — their count
  // (and needs_manual_check's) can only be seen from the base table now.
  async function loadCoverageSummary() {
    const el = document.getElementById('opCoverageSummary')
    if (!el) return
    const sourceRows = await fetchAllBusyRows('items', 'stock_source')
    if (!el.isConnected) return
    const total = sourceRows.length
    const unpriced = sourceRows.filter(r => r.stock_source === 'unpriced').length
    const needsCheck = sourceRows.filter(r => r.stock_source === 'needs_manual_check').length
    const inView = total - unpriced
    el.textContent = `${inView.toLocaleString('en-IN')} items in reorder view · ${unpriced.toLocaleString('en-IN')} items excluded (no sale rate) · ${needsCheck.toLocaleString('en-IN')} stock unknown, verify manually`
  }

  // Rebuilds the whole grid screen, including the search <input> itself --
  // only called on first entry and when returning from the item table, so
  // that typing (which only touches #opCatGridBody, see below) never loses
  // focus/cursor position by recreating the input mid-keystroke.
  function renderCategoryGrid() {
    stepBody.innerHTML = `
      <div class="controls-bar">
        <input type="text" id="opCatSearch" class="search-input" placeholder="Search categories or items..." />
      </div>
      <div id="opCatGridBody"></div>
    `
    const searchEl = document.getElementById('opCatSearch')
    searchEl.value = searchTerm
    searchEl.addEventListener('input', () => {
      searchTerm = searchEl.value
      searchItemViewActive = false
      renderCategoryGridBody()
    })
    renderCategoryGridBody()
  }

  function renderCategoryGridBody() {
    const wrap = document.getElementById('opCatGridBody')
    if (!wrap) return

    const node = nodeAtPath(tree, path)
    if (!node) { path = []; renderCategoryGridBody(); return } // stale path guard

    const term = searchTerm.trim()
    const results = term ? computeSearchResults(node, term) : null

    if (results && searchItemViewActive) {
      enterItemTable(
        results.allMatchingItems,
        `Search results for "${term}"`,
        () => { searchTerm = ''; searchItemViewActive = false; renderCategoryGrid() }
      )
      return
    }

    wrap.innerHTML = `
      <div class="op-cat-breadcrumb">${renderBreadcrumbHtml(path)}</div>
      ${results ? renderSearchGridHtml(results, term) : renderBrowseGridHtml(node)}
    `

    wrap.querySelectorAll('.op-breadcrumb-item[data-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        path = path.slice(0, Number(btn.dataset.idx))
        searchItemViewActive = false
        renderCategoryGridBody()
      })
    })
    wrap.querySelectorAll('[data-kind="child"]').forEach(btn => {
      btn.addEventListener('click', () => navigateInto(node, btn.dataset.name))
    })
    const directBtn = wrap.querySelector('[data-kind="direct"]')
    if (directBtn) {
      directBtn.addEventListener('click', () => {
        enterItemTable(node.items, `${breadcrumbLabel(path)} — other items`, renderCategoryGrid)
      })
    }
    const directSearchBtn = wrap.querySelector('[data-kind="direct-search"]')
    if (directSearchBtn) {
      directSearchBtn.addEventListener('click', () => {
        enterItemTable(results.directItemMatches, `Search results for "${term}" in ${breadcrumbLabel(path)}`, renderCategoryGrid)
      })
    }
    const jumpBtn = document.getElementById('opShowAllMatches')
    if (jumpBtn) {
      jumpBtn.addEventListener('click', () => { searchItemViewActive = true; renderCategoryGridBody() })
    }
  }

  function navigateInto(node, name) {
    const child = node.children.get(name)
    if (!child) return
    if (child.children.size === 0) {
      // Pure leaf -- straight to the item table. `path` itself doesn't
      // change, so "Back" lands exactly where this click happened. If this
      // card was surfaced by a search (its badge read "N matches", not a
      // flagged count), only the matches go into the table -- otherwise
      // clicking a "3 matches" card would dump every item in that leaf,
      // including ones that don't match at all.
      const term = searchTerm.trim()
      const items = term ? child.items.filter(r => matchesSearch(r, term)) : child.items
      const label = term ? `Search results for "${term}" in ${breadcrumbLabel([...path, name])}` : breadcrumbLabel([...path, name])
      enterItemTable(items, label, renderCategoryGrid)
    } else {
      path = [...path, name]
      searchItemViewActive = false
      renderCategoryGridBody()
    }
  }

  function renderBreadcrumbHtml(path) {
    const crumbs = [{ label: 'All', idx: 0 }, ...path.map((seg, i) => ({ label: seg, idx: i + 1 }))]
    return crumbs.map((c, i) => {
      const isLast = i === crumbs.length - 1
      const sep = isLast ? '' : ' <span class="op-breadcrumb-sep">›</span> '
      return `<button type="button" class="op-breadcrumb-item${isLast ? ' current' : ''}" data-idx="${c.idx}" ${isLast ? 'disabled' : ''}>${esc(c.label)}</button>${sep}`
    }).join('')
  }

  // Normal browsing (no active search): a card per child category, plus one
  // synthetic card for any items sitting directly on this node when it also
  // has children (the "mixed node" case -- see buildCategoryTree comment).
  function renderBrowseGridHtml(node) {
    const childCards = [...node.children.entries()].map(([name, child]) => {
      const count = flaggedCount(child)
      return `
        <button type="button" class="op-brand-card" data-kind="child" data-name="${esc(name)}">
          <span class="op-brand-card-name">${esc(name)}</span>
          <span class="op-brand-card-count">${count} item${count === 1 ? '' : 's'} flagged</span>
        </button>
      `
    }).join('')

    let directCard = ''
    if (node.items.length) {
      const count = node.items.filter(r => Number(r.suggested_order_qty) > 0).length
      directCard = `
        <button type="button" class="op-brand-card" data-kind="direct">
          <span class="op-brand-card-name">Other ${esc(node.name || '')} items</span>
          <span class="op-brand-card-count">${count} item${count === 1 ? '' : 's'} flagged</span>
        </button>
      `
    }

    if (!childCards && !directCard) return `<div class="empty-state">No categories here.</div>`
    return `<div class="op-brand-grid">${childCards}${directCard}</div>`
  }

  // Search mode: matching category cards (badged with their match count)
  // plus, if this node itself has direct matches, one more card for those --
  // and a "show everything flat" button below if there's anything to jump to.
  function renderSearchGridHtml(results, term) {
    const { matchingCategories, directItemMatches, allMatchingItems } = results

    const catCards = matchingCategories.map(({ name, matchCount }) => `
      <button type="button" class="op-brand-card" data-kind="child" data-name="${esc(name)}">
        <span class="op-brand-card-name">${esc(name)}</span>
        <span class="op-brand-card-count">${matchCount} match${matchCount === 1 ? '' : 'es'}</span>
      </button>
    `).join('')

    const directCard = directItemMatches.length ? `
      <button type="button" class="op-brand-card" data-kind="direct-search">
        <span class="op-brand-card-name">Matching items here</span>
        <span class="op-brand-card-count">${directItemMatches.length} match${directItemMatches.length === 1 ? '' : 'es'}</span>
      </button>
    ` : ''

    const grid = (catCards || directCard)
      ? `<div class="op-brand-grid">${catCards}${directCard}</div>`
      : `<div class="empty-state">No matches for "${esc(term)}" here.</div>`

    const jumpBtn = allMatchingItems.length ? `
      <div class="op-brand-actions">
        <button type="button" class="btn-primary" id="opShowAllMatches">Show all ${allMatchingItems.length} matching item${allMatchingItems.length === 1 ? '' : 's'} →</button>
      </div>
    ` : ''

    return grid + jumpBtn
  }

  // ---- Item table (unchanged table-rendering logic; only the source array
  // and how you arrive here changed from the old brand-multiselect flow) ----
  function enterItemTable(items, label, onBack) {
    stepBody.innerHTML = `
      <div class="op-item-step-header">
        <button type="button" class="btn-ghost btn-small" id="opBackToGrid">← Back</button>
        <div class="op-plan-control">
          <label for="opPlanQty">Plan for next</label>
          <input type="number" min="1" id="opPlanQty" class="mini-input" value="1" style="width:56px" />
          <select id="opPlanUnit" class="mini-select">
            <option value="days">day(s)</option>
            <option value="weeks" selected>week(s)</option>
            <option value="months">month(s)</option>
          </select>
        </div>
      </div>
      <p class="client-meta">${esc(label)}</p>
      <div id="opItemStepBody"></div>
    `
    document.getElementById('opBackToGrid').addEventListener('click', onBack)
    const qtyEl = document.getElementById('opPlanQty')
    const unitEl = document.getElementById('opPlanUnit')
    const rerender = () => renderItemTable()
    qtyEl.addEventListener('input', rerender)
    unitEl.addEventListener('change', rerender)
    renderItemTable()

    function renderItemTable() {
      const planDays = (Number(qtyEl.value) || 1) * UNIT_DAYS[unitEl.value]
      const body = document.getElementById('opItemStepBody')
      if (!body) return

      const byBrand = new Map()
      items.forEach(r => {
        const brand = r.brand || 'Unbranded'
        const qty = computeSuggestedQty(r, planDays)
        // null means "stock unknown", not "nothing to order" -- still worth
        // surfacing so it doesn't just silently vanish from the table. Only
        // a real non-positive number means it's actually safe to drop.
        if (qty !== null && qty <= 0) return
        if (!byBrand.has(brand)) byBrand.set(brand, [])
        byBrand.get(brand).push({ ...r, liveQty: qty })
      })
      const brands = [...byBrand.keys()].sort((a, b) => a.localeCompare(b))

      if (!brands.length) {
        body.innerHTML = `<div class="empty-state">Nothing needs reordering here for that period.</div>`
        return
      }

      // Everything actually on screen across every brand group here -- what
      // "select all visible" and its checked-state mean, scoped to this one
      // drilled/searched view rather than the whole reorder_suggestions set.
      const allVisibleRows = brands.flatMap(brand => byBrand.get(brand))

      // avgRateByCode is only in scope here (closure from renderReorderDashboard),
      // so Est. order value's comparator has to live here too rather than in
      // the shared sort helpers above.
      const rowComparators = {
        name: (a, b, dir) => compareText(a.name, b.name, dir),
        stock: (a, b, dir) => compareNullableNumber(a.stock_qty, b.stock_qty, dir),
        avg_weekly: (a, b, dir) => compareNumber(a.avg_weekly_qty, b.avg_weekly_qty, dir),
        suggested_qty: (a, b, dir) => compareNullableNumber(a.liveQty, b.liveQty, dir),
        est_value: (a, b, dir) => compareNullableNumber(
          a.liveQty == null ? null : a.liveQty * effectiveRate(a, avgRateByCode),
          b.liveQty == null ? null : b.liveQty * effectiveRate(b, avgRateByCode),
          dir
        ),
      }

      body.innerHTML = `
        <div class="controls-bar">
          <label class="op-select-all-label">
            <input type="checkbox" id="opSelectAllVisible" ${areAllShortlisted(allVisibleRows) ? 'checked' : ''} />
            Select all ${allVisibleRows.length} visible item${allVisibleRows.length === 1 ? '' : 's'}
          </label>
        </div>
        ${brands.map(brand => {
          const rows = applySort(byBrand.get(brand), reorderTableSort, rowComparators)
          const groupTotal = rows.reduce((s, r) => s + (r.liveQty == null ? 0 : r.liveQty * effectiveRate(r, avgRateByCode)), 0)
          return `
            <div class="op-brand-group">
              <div class="op-brand-header">
                <span>${esc(brand)}</span>
                <span>${rows.length} item${rows.length === 1 ? '' : 's'} · Est. order value ${formatMoney(groupTotal)}</span>
              </div>
              <div class="op-table-wrap">
                <table class="op-table">
                  <thead>
                    <tr>
                      <th></th>
                      ${sortableHeader(reorderTableSort, 'name', 'Item')}
                      ${sortableHeader(reorderTableSort, 'stock', 'Stock', 'num')}
                      ${sortableHeader(reorderTableSort, 'avg_weekly', 'Avg weekly', 'num')}
                      ${sortableHeader(reorderTableSort, 'suggested_qty', 'Suggested qty', 'num')}
                      ${sortableHeader(reorderTableSort, 'est_value', 'Est. order value', 'num')}
                    </tr>
                  </thead>
                  <tbody>
                    ${rows.map(r => `
                      <tr data-code="${r.code}">
                        <td><input type="checkbox" class="op-shortlist-check" ${reorderShortlist.has(r.code) ? 'checked' : ''} /></td>
                        <td>
                          <div class="item-name">${esc(r.name)}</div>
                          ${r.alias ? `<div class="item-sub">${esc(r.alias)}</div>` : ''}
                          ${stockSourceBadge(r.stock_source)}
                        </td>
                        <td class="num">${r.stock_qty ?? '—'}</td>
                        <td class="num">${Number(r.avg_weekly_qty || 0).toFixed(1)}</td>
                        <td class="num">${r.liveQty == null ? 'Verify stock' : r.liveQty}</td>
                        <td class="num">${r.liveQty == null ? '—' : formatMoney(r.liveQty * effectiveRate(r, avgRateByCode))}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          `
        }).join('')}
      `

      wireSortableHeaders(body, reorderTableSort, renderItemTable)

      document.getElementById('opSelectAllVisible').addEventListener('change', () => {
        toggleAllVisible(allVisibleRows)
        renderShortlistBar()
        renderItemTable() // full re-render so every row's checkbox reflects the bulk change
      })
      body.querySelectorAll('.op-shortlist-check').forEach(cb => {
        cb.addEventListener('change', () => {
          const code = Number(cb.closest('tr').dataset.code)
          const row = allVisibleRows.find(r => r.code === code)
          if (row) toggleShortlist(row)
          renderShortlistBar()
          // Just keep "select all" in sync -- no need to re-render the whole
          // table for a single row's own checkbox, which already shows its
          // new state natively.
          const selectAllCb = document.getElementById('opSelectAllVisible')
          if (selectAllCb) selectAllCb.checked = areAllShortlisted(allVisibleRows)
        })
      })
    }
  }
}

// ---- Screen B: Item Settings ----
const itemSettingsSort = createSortState() // no sort until a header is clicked

function renderItemSettings(container) {
  container.innerHTML = `
    <div class="controls-bar">
      <input type="text" id="opItemSearch" placeholder="Search items by name or alias to adjust reorder settings..." class="search-input" />
    </div>
    <div id="opSettingsList"></div>
  `
  let debounceTimer
  document.getElementById('opItemSearch').addEventListener('input', e => {
    clearTimeout(debounceTimer)
    const term = e.target.value.trim()
    const listEl = document.getElementById('opSettingsList')
    if (!term) { listEl.innerHTML = ''; return }
    debounceTimer = setTimeout(() => searchSettingsItems(term), 300)
  })
}

async function searchSettingsItems(term) {
  const listEl = document.getElementById('opSettingsList')
  if (!listEl) return
  listEl.innerHTML = '<div class="loading-state">Searching...</div>'

  // No .limit() here -- this used to cap at 25, silently hiding real matches
  // beyond that (confirmed live: 56 items match "lapp", only 25 ever showed).
  // The ilike filter itself already searches the full table server-side;
  // dropping the limit just lets it return everything it actually finds,
  // paginated client-side below instead of truncated before it arrives.
  const escaped = term.replace(/[%,]/g, '')
  const { data: items, error } = await supabaseBusy.from('items')
    .select('code, name, alias')
    .or(`name.ilike.%${escaped}%,alias.ilike.%${escaped}%`)
  if (!listEl.isConnected) return
  if (error) { listEl.innerHTML = `<div class="empty-state">Search failed: ${esc(error.message)}</div>`; return }
  if (!items || !items.length) { listEl.innerHTML = '<div class="empty-state">No items match.</div>'; return }

  const codes = items.map(i => i.code)
  const { data: settingsRows } = await supabaseBusy.from('reorder_settings').select('*').in('item_code', codes)
  const settingsByCode = {}
  ;(settingsRows || []).forEach(s => { settingsByCode[s.item_code] = s })

  // Comparators close over settingsByCode (min_order_qty/preferred_vendor
  // live there, not on the item rows themselves), so they're declared fresh
  // per search rather than as a static top-level map.
  const comparators = {
    name: (a, b, dir) => compareText(a.name, b.name, dir),
    min_order_qty: (a, b, dir) => compareNumber(settingsByCode[a.code]?.min_order_qty ?? 1, settingsByCode[b.code]?.min_order_qty ?? 1, dir),
    preferred_vendor: (a, b, dir) => compareText(settingsByCode[a.code]?.preferred_vendor, settingsByCode[b.code]?.preferred_vendor, dir),
  }

  // Local to this search -- a fresh call (new term) always starts back at
  // page 1, unlike sort (itemSettingsSort), which is worth carrying between
  // searches.
  const pageSize = 50
  let page = 1

  renderSettingsTable()

  // target_weeks_cover isn't editable here -- the Reorder Dashboard's own
  // "Plan for next X" control is the single source of truth for coverage
  // period now. The reorder_settings column and the view's
  // COALESCE(rs.target_weeks_cover, 3) fallback both stay as-is; this UI
  // just never reads or writes that field, so it silently keeps its
  // existing value (or the view's default of 3 for rows that never had one).
  function renderSettingsTable() {
    const sortedItems = applySort(items, itemSettingsSort, comparators)
    const total = sortedItems.length
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    page = Math.min(Math.max(page, 1), totalPages)
    const startIdx = (page - 1) * pageSize
    const pageItems = sortedItems.slice(startIdx, startIdx + pageSize)
    const rangeStart = total ? startIdx + 1 : 0
    const rangeEnd = Math.min(startIdx + pageSize, total)

    listEl.innerHTML = `
      <div class="op-table-wrap">
        <table class="op-table">
          <thead>
            <tr>
              ${sortableHeader(itemSettingsSort, 'name', 'Item')}
              ${sortableHeader(itemSettingsSort, 'min_order_qty', 'Min order qty', 'num')}
              ${sortableHeader(itemSettingsSort, 'preferred_vendor', 'Preferred vendor')}
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${pageItems.map(i => {
              const s = settingsByCode[i.code]
              return `
                <tr data-code="${i.code}">
                  <td><div class="item-name">${esc(i.name)}</div>${i.alias ? `<div class="item-sub">${esc(i.alias)}</div>` : ''}</td>
                  <td class="num"><input type="number" min="1" class="mini-input op-min-qty" value="${s?.min_order_qty ?? 1}" style="width:60px" /></td>
                  <td><input type="text" class="mini-input op-vendor" value="${esc(s?.preferred_vendor || '')}" placeholder="Vendor" style="width:140px" /></td>
                  <td><button type="button" class="btn-primary btn-small op-save-settings" data-code="${i.code}">Save</button></td>
                </tr>
              `
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="op-pagination">
        <span class="client-meta">Showing ${rangeStart}–${rangeEnd} of ${total} matching items</span>
        <div class="op-pagination-btns">
          <button type="button" class="btn-ghost btn-small" id="opSettingsPrev" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
          <button type="button" class="btn-ghost btn-small" id="opSettingsNext" ${page >= totalPages ? 'disabled' : ''}>Next →</button>
        </div>
      </div>
    `

    wireSortableHeaders(listEl, itemSettingsSort, renderSettingsTable)
    document.getElementById('opSettingsPrev')?.addEventListener('click', () => { page = Math.max(1, page - 1); renderSettingsTable() })
    document.getElementById('opSettingsNext')?.addEventListener('click', () => { page = Math.min(totalPages, page + 1); renderSettingsTable() })

    listEl.querySelectorAll('.op-save-settings').forEach(btn => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('tr')
        const item_code = Number(btn.dataset.code)
        const min_order_qty = Number(row.querySelector('.op-min-qty').value) || 1
        const preferred_vendor = row.querySelector('.op-vendor').value.trim() || null
        btn.disabled = true; btn.textContent = 'Saving...'
        const { error } = await supabaseBusy.from('reorder_settings')
          .upsert({ item_code, min_order_qty, preferred_vendor }, { onConflict: 'item_code' })
        if (!btn.isConnected) return
        btn.disabled = false
        btn.textContent = error ? 'Failed' : 'Saved ✓'
        setTimeout(() => { if (btn.isConnected) btn.textContent = 'Save' }, 1500)
      })
    })
  }
}

// ---- Screen C: Declutter / Dead Stock List ----

// Persists for the whole session (module scope, not re-created per mount)
// so switching to Item Settings and back doesn't lose your place.
const declutterState = {
  search: '',
  stockSource: 'all',
  brand: 'all',
  seasonal: 'all',
  sort: createSortState('stock_value', 'desc'),
  page: 1,
  pageSize: 50,
}

const DECLUTTER_STOCK_FILTERS = [
  ['all', 'All'],
  ['synced', 'Synced'],
  ['manual_import', 'Manual import'],
  ['needs_check', 'Needs check'],
  ['unpriced', 'No sale rate'],
]
const DECLUTTER_SEASONAL_FILTERS = [['all', 'All'], ['seasonal', 'Seasonal'], ['non_seasonal', 'Non-seasonal']]
// The sort <select> and the new clickable column headers drive the exact
// same declutterState.sort -- this just maps its 4 preset combinations to
// {column, dir} pairs so the dropdown can show/set them. Column-header
// clicks (Item/Stock/Sale rate/Purchase rate) reuse the same 'name' key the
// "Name A→Z" option already uses, plus new stock_qty/sale_rate/
// purchase_rate keys the dropdown doesn't expose directly.
const DECLUTTER_SORT_OPTIONS = [
  { value: 'stock_value_desc', label: 'Stock value high→low', column: 'stock_value', dir: 'desc' },
  { value: 'stock_value_asc', label: 'Stock value low→high', column: 'stock_value', dir: 'asc' },
  { value: 'weeks_tracked_desc', label: 'Weeks tracked', column: 'weeks_tracked', dir: 'desc' },
  { value: 'name_asc', label: 'Name A→Z', column: 'name', dir: 'asc' },
]
const DECLUTTER_COMPARATORS = {
  stock_value: compareStockValue,
  weeks_tracked: (a, b, dir) => compareNumber(a.weeks_tracked, b.weeks_tracked, dir),
  name: (a, b, dir) => compareText(a.name, b.name, dir),
  stock_qty: (a, b, dir) => compareNullableNumber(a.stock_qty, b.stock_qty, dir),
  sale_rate: (a, b, dir) => compareNumber(a.sale_rate, b.sale_rate, dir),
  purchase_rate: (a, b, dir) => compareNumber(a.purchase_rate, b.purchase_rate, dir),
}

function matchesStockStatus(stockSource, filterValue) {
  if (filterValue === 'all') return true
  if (filterValue === 'synced') return stockSource === 'daily_sum'
  if (filterValue === 'manual_import') return typeof stockSource === 'string' && stockSource.startsWith('busy_report_')
  if (filterValue === 'needs_check') return stockSource === 'needs_manual_check'
  if (filterValue === 'unpriced') return stockSource === 'unpriced'
  return true
}

function matchesDeclutterFilters(r, state) {
  if (state.brand !== 'all' && (r.brand || 'Unbranded') !== state.brand) return false
  if (!matchesStockStatus(r.stock_source, state.stockSource)) return false
  if (state.seasonal === 'seasonal' && r.is_seasonal !== true) return false
  if (state.seasonal === 'non_seasonal' && r.is_seasonal !== false) return false
  const term = state.search.trim().toLowerCase()
  if (term) {
    const hay = `${r.name || ''} ${r.alias || ''}`.toLowerCase()
    if (!hay.includes(term)) return false
  }
  return true
}

// declutter_candidates has no stock_value column -- computed on the fly.
// null stock_qty (needs_manual_check items) means "unknown", not zero, so
// those sort to the bottom regardless of direction instead of clustering at
// the "low" end and looking like confirmed dead stock.
function computeStockValue(r) {
  return r.stock_qty == null ? null : Number(r.stock_qty) * Number(r.purchase_rate || 0)
}

function compareStockValue(a, b, dir) {
  const av = computeStockValue(a)
  const bv = computeStockValue(b)
  if (av == null && bv == null) return 0
  if (av == null) return 1
  if (bv == null) return -1
  return dir === 'asc' ? av - bv : bv - av
}

async function renderDeclutter(container) {
  container.innerHTML = '<div class="loading-state">Loading declutter candidates...</div>'
  const rows = await fetchAllBusyRows('declutter_candidates')
  if (!container.isConnected) return

  if (!rows.length) {
    container.innerHTML = '<div class="empty-state">No declutter candidates right now.</div>'
    return
  }

  const brands = [...new Set(rows.map(r => r.brand || 'Unbranded'))].sort((a, b) => a.localeCompare(b))
  // Guards against a brand carried over in state from a previous session/day
  // that no longer appears in today's candidates -- would otherwise filter
  // to an empty, unexplained list.
  if (declutterState.brand !== 'all' && !brands.includes(declutterState.brand)) declutterState.brand = 'all'

  // Search/filter/sort controls live in this outer shell, set once per
  // mount -- only #opDeclutterBody below gets replaced on every interaction,
  // so the search input never loses focus/cursor mid-keystroke, and the
  // CSV/Copy buttons (also out here) stay the same elements across
  // re-renders while their behavior is kept in sync via .onclick
  // reassignment inside renderDeclutterBody, not addEventListener (which
  // would stack a new listener on every filter change).
  container.innerHTML = `
    <p class="client-meta">Items that haven't sold in ~26 weeks — review and cross-check against Busy before deleting anything there. This app never deletes items; all deletion happens in Busy's own UI.</p>
    <div class="controls-bar">
      <input type="text" id="opDeclutterSearch" class="search-input" placeholder="Search items by name or alias..." />
      <select id="opDeclutterBrand" class="filter-select">
        <option value="all">All brands</option>
        ${brands.map(b => `<option value="${esc(b)}" ${declutterState.brand === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}
      </select>
      <select id="opDeclutterStockSource" class="filter-select">
        ${DECLUTTER_STOCK_FILTERS.map(([v, l]) => `<option value="${v}" ${declutterState.stockSource === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
      <select id="opDeclutterSeasonal" class="filter-select">
        ${DECLUTTER_SEASONAL_FILTERS.map(([v, l]) => `<option value="${v}" ${declutterState.seasonal === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
      <select id="opDeclutterSort" class="filter-select">
        ${DECLUTTER_SORT_OPTIONS.map(o => `<option value="${o.value}" ${declutterState.sort.column === o.column && declutterState.sort.dir === o.dir ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
    </div>
    <div class="controls-bar" style="justify-content:flex-end">
      <button type="button" class="btn-ghost btn-small" id="opCopyBtn">📋 Copy to clipboard</button>
      <button type="button" class="btn-primary btn-small" id="opCsvBtn">⬇ Download CSV</button>
    </div>
    <div id="opDeclutterBody"></div>
  `

  const searchEl = document.getElementById('opDeclutterSearch')
  searchEl.value = declutterState.search
  searchEl.addEventListener('input', () => {
    declutterState.search = searchEl.value
    declutterState.page = 1
    renderDeclutterBody()
  })
  document.getElementById('opDeclutterBrand').addEventListener('change', e => {
    declutterState.brand = e.target.value
    declutterState.page = 1
    renderDeclutterBody()
  })
  document.getElementById('opDeclutterStockSource').addEventListener('change', e => {
    declutterState.stockSource = e.target.value
    declutterState.page = 1
    renderDeclutterBody()
  })
  document.getElementById('opDeclutterSeasonal').addEventListener('change', e => {
    declutterState.seasonal = e.target.value
    declutterState.page = 1
    renderDeclutterBody()
  })
  document.getElementById('opDeclutterSort').addEventListener('change', e => {
    const opt = DECLUTTER_SORT_OPTIONS.find(o => o.value === e.target.value)
    if (opt) { declutterState.sort.column = opt.column; declutterState.sort.dir = opt.dir }
    renderDeclutterBody()
  })

  renderDeclutterBody()

  function renderDeclutterBody() {
    const bodyEl = document.getElementById('opDeclutterBody')
    if (!bodyEl) return

    const filtered = applySort(rows.filter(r => matchesDeclutterFilters(r, declutterState)), declutterState.sort, DECLUTTER_COMPARATORS)

    const total = filtered.length
    const totalPages = Math.max(1, Math.ceil(total / declutterState.pageSize))
    declutterState.page = Math.min(Math.max(declutterState.page, 1), totalPages)
    const startIdx = (declutterState.page - 1) * declutterState.pageSize
    const pageRows = filtered.slice(startIdx, startIdx + declutterState.pageSize)
    const rangeStart = total ? startIdx + 1 : 0
    const rangeEnd = Math.min(startIdx + declutterState.pageSize, total)

    bodyEl.innerHTML = !total ? `<div class="empty-state">No items match these filters.</div>` : `
      <div class="op-table-wrap">
        <table class="op-table">
          <thead>
            <tr>
              ${sortableHeader(declutterState.sort, 'name', 'Item')}
              <th>Alias</th><th>Brand</th>
              ${sortableHeader(declutterState.sort, 'stock_qty', 'Stock', 'num')}
              ${sortableHeader(declutterState.sort, 'sale_rate', 'Sale rate', 'num')}
              ${sortableHeader(declutterState.sort, 'purchase_rate', 'Purchase rate', 'num')}
            </tr>
          </thead>
          <tbody>
            ${pageRows.map(r => `
              <tr>
                <td>${esc(r.name)} ${stockSourceBadge(r.stock_source, { includeUnpriced: true })}</td>
                <td>${esc(r.alias || '—')}</td>
                <td>${esc(r.brand || '—')}</td>
                <td class="num">${r.stock_qty ?? '—'}</td>
                <td class="num">${formatMoney(r.sale_rate)}</td>
                <td class="num">${formatMoney(r.purchase_rate)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="op-pagination">
        <span class="client-meta">Showing ${rangeStart}–${rangeEnd} of ${total} filtered items</span>
        <div class="op-pagination-btns">
          <button type="button" class="btn-ghost btn-small" id="opDeclutterPrev" ${declutterState.page <= 1 ? 'disabled' : ''}>← Prev</button>
          <button type="button" class="btn-ghost btn-small" id="opDeclutterNext" ${declutterState.page >= totalPages ? 'disabled' : ''}>Next →</button>
        </div>
      </div>
    `

    wireSortableHeaders(bodyEl, declutterState.sort, renderDeclutterBody)

    document.getElementById('opDeclutterPrev')?.addEventListener('click', () => {
      declutterState.page = Math.max(1, declutterState.page - 1)
      renderDeclutterBody()
    })
    document.getElementById('opDeclutterNext')?.addEventListener('click', () => {
      declutterState.page = Math.min(totalPages, declutterState.page + 1)
      renderDeclutterBody()
    })

    // CSV/Copy always reflect the full filtered set (every page), not just
    // what's currently on screen.
    const csvRows = [
      ['Item', 'Alias', 'Brand', 'Stock', 'Sale Rate', 'Purchase Rate', 'Stock Note'],
      ...filtered.map(r => [r.name, r.alias || '', r.brand || '', r.stock_qty ?? '', r.sale_rate ?? '', r.purchase_rate ?? '', stockSourceNote(r.stock_source, { includeUnpriced: true })])
    ]
    const csvText = csvRows.map(row => row.map(csvEscape).join(',')).join('\n')

    document.getElementById('opCsvBtn').onclick = () => {
      const blob = new Blob([csvText], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'declutter-candidates.csv'
      a.click()
      URL.revokeObjectURL(url)
    }
    document.getElementById('opCopyBtn').onclick = async () => {
      await navigator.clipboard.writeText(csvText)
      const btn = document.getElementById('opCopyBtn')
      btn.textContent = 'Copied ✓'
      setTimeout(() => { if (btn.isConnected) btn.textContent = '📋 Copy to clipboard' }, 1500)
    }
  }
}

function csvEscape(val) {
  const s = String(val ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
