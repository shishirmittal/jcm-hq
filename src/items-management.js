// Items Management -- Busy item group tree + inline price/group edits +
// .xlsx export, styled after Busy's own Chart of Items screen. See
// item_pending_edits' own doc comment in supabase-busy.js's project for the
// data-flow rationale: this page never writes to `items` or `item_group_map`
// directly (the anon key powering supabaseBusy has no UPDATE grant on either
// -- verified live, not just a style choice -- both are sync targets FROM
// Busy, not editable here). Every change routes through item_pending_edits;
// Busy only actually changes once the exported CSV is imported there by hand.
import { apiUrl } from './native.js'
import * as XLSX from 'xlsx'
import { supabaseBusy } from './supabase-busy.js'
import { supabase } from './supabase.js'
import { openSidebar } from './sidebar.js'
import { canSee } from './permissions.js'
import { esc } from './utils.js'
import { tokenMatch } from './catalog.js'

// Same shape as supabase-busy.js's fetchAllBusyRows, but takes a configure()
// callback so a .like()/.order() filter can be applied on every page of a
// paginated fetch -- a big top-level group (or the group table itself, ~261
// rows but items run into the thousands) can exceed PostgREST's per-request cap.
async function fetchAllBusyFiltered(table, columns, configure) {
  const pageSize = 1000
  let all = []
  let from = 0
  while (true) {
    let q = supabaseBusy.from(table).select(columns)
    if (configure) q = configure(q)
    const { data, error } = await q.range(from, from + pageSize - 1)
    if (error) throw error
    all = all.concat(data || [])
    if (!data || data.length < pageSize) break
    from += pageSize
  }
  return all
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export async function renderItemsManagement(container) {
  // Gated on the granted tab rather than on being an admin: Items Management can now
  // be ticked for one person in Manage Users without making them a full
  // admin, and this guard has to agree with the sidebar or the tab shows up
  // and then refuses to open.
  if (!canSee('items-management')) {
    container.innerHTML = '<div class="empty-state">You do not have access to this page.</div>'
    setTimeout(() => { window.location.hash = '' }, 1500)
    return
  }

  container.innerHTML = `
    <div class="im-page">
      <div class="im-topbar">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="im-hamburger" id="imHamburgerBtn" aria-label="Menu">☰</button>
          <h1 class="im-title">Items Management</h1>
        </div>
        <div class="im-topbar-actions">
          <span id="imChangedBadge" class="im-changed-badge">0 items changed</span>
          <button class="im-secondary-btn" id="imUndoBtn" disabled>Undo Last Change</button>
          <button class="im-secondary-btn im-discard-btn" id="imDiscardBtn" disabled>Discard Changes</button>
          <button class="im-export-btn" id="imExportBtn" disabled>Export for Busy</button>
          <button class="im-secondary-btn" id="imChatToggleBtn">Ask AI</button>
        </div>
      </div>
      <div class="im-layout">
        <div class="im-tree-panel">
          <div id="imLoadingState" class="im-loading-state">Loading groups…</div>
          <div id="imTreeRoot"></div>
        </div>
        <div class="im-items-panel">
          <div id="imPanelHeader" class="im-panel-header">Select a group on the left to view its items.</div>
          <div id="imEmptyState" class="im-empty-state">No group selected.</div>
          <table id="imItemsTable" class="im-items-table" style="display:none">
            <thead>
              <tr id="imTableHeadRow"></tr>
            </thead>
            <tbody id="imItemsTbody"></tbody>
          </table>
        </div>
        <div class="im-chat-panel" id="imChatPanel" hidden>
          <div class="im-chat-header">
            <span>Ask about your data</span>
            <button type="button" class="im-chat-close" id="imChatCloseBtn" aria-label="Close">×</button>
          </div>
          <div class="im-chat-messages" id="imChatMessages">
            <div class="im-chat-hint">Ask a question about items, sales, invoices, or dues -- answered live from JCM-Busysql. Read-only, nothing here can change your data.</div>
          </div>
          <form class="im-chat-input-row" id="imChatForm">
            <input type="text" id="imChatInput" placeholder="e.g. Top 5 items by sales last month" autocomplete="off" />
            <button type="submit" id="imChatSendBtn">Send</button>
          </form>
        </div>
      </div>
    </div>
  `

  document.getElementById('imHamburgerBtn').addEventListener('click', () => openSidebar())

  // ---- State (scoped to this render call) ----
  let allGroups = []
  let groupsById = new Map()
  let groupChildren = new Map()
  let pendingEdits = new Map() // item_code -> { new_group_code, new_price, remark1, remark2, remark3 }
  let currentGroupByCode = new Map() // item_code -> its REAL (unedited) parent_grp, for attributing tree badge counts
  let undoStack = [] // { item_code, field, previousValue, newValue }, one entry per committed edit
  let currentItems = null // last-loaded group's raw rows, kept around so a sort click can re-render without refetching
  let currentPriceByCode = null
  let currentFixedValueByCode = null // items.fixed_value -- read-only reference data, not part of pending edits
  const sortState = { column: 'name', dir: 'asc' } // default: alphabetical by Name
  let activeGroupCode = null // which group's in-flight load should actually reach the screen
  let groupsLoadFailed = false

  // Column widths are in pixels, kept in module state (not the DOM) so a drag
  // survives renderTableHead() rebuilding the row on every sort click, and
  // survives switching groups (loadItemsForGroup never touches this).
  const columnDefs = [
    { key: 'name', label: 'Name', sortable: true, width: 150 },
    { key: 'alias', label: 'Alias', width: 120 },
    { key: 'group', label: 'Group', width: 300 },
    { key: 'price', label: 'Sale Price', sortable: true, numeric: true, width: 90 },
    { key: 'fixedValue', label: 'Optional Field 2', numeric: true, width: 130 },
    { key: 'remark1', label: 'Remark 1', width: 150 },
    { key: 'remark2', label: 'Remark 2', width: 150 },
    { key: 'remark3', label: 'Remark 3', width: 140 },
  ]

  const treeRootEl = document.getElementById('imTreeRoot')
  const loadingStateEl = document.getElementById('imLoadingState')
  const panelHeaderEl = document.getElementById('imPanelHeader')
  const emptyStateEl = document.getElementById('imEmptyState')
  const itemsTableEl = document.getElementById('imItemsTable')
  const itemsTbodyEl = document.getElementById('imItemsTbody')
  const changedBadgeEl = document.getElementById('imChangedBadge')
  const undoBtnEl = document.getElementById('imUndoBtn')
  const discardBtnEl = document.getElementById('imDiscardBtn')
  const exportBtnEl = document.getElementById('imExportBtn')
  const chatToggleBtnEl = document.getElementById('imChatToggleBtn')
  const chatPanelEl = document.getElementById('imChatPanel')
  const chatCloseBtnEl = document.getElementById('imChatCloseBtn')
  const chatMessagesEl = document.getElementById('imChatMessages')
  const chatFormEl = document.getElementById('imChatForm')
  const chatInputEl = document.getElementById('imChatInput')
  const chatSendBtnEl = document.getElementById('imChatSendBtn')

  await loadGroups()
  await loadExistingPendingEdits()
  await backfillCurrentGroups([...pendingEdits.keys()])
  // If the user navigated away while those awaits were in flight, container's
  // innerHTML has already been replaced -- bail rather than touch a DOM that
  // isn't this render's anymore (same guard used in quotations.js for the
  // same race).
  if (!document.getElementById('imTreeRoot')) return
  renderTree()
  renderTableHead()
  updateTreeBadges()
  loadingStateEl.style.display = 'none'
  undoBtnEl.addEventListener('click', undoLastChange)
  discardBtnEl.addEventListener('click', discardAllChanges)
  exportBtnEl.addEventListener('click', exportForBusy)
  chatToggleBtnEl.addEventListener('click', () => { chatPanelEl.hidden = !chatPanelEl.hidden })
  chatCloseBtnEl.addEventListener('click', () => { chatPanelEl.hidden = true })
  chatFormEl.addEventListener('submit', e => { e.preventDefault(); sendChatMessage() })

  // ---- Load groups & build tree ----
  async function loadGroups() {
    try {
      allGroups = await fetchAllBusyFiltered(
        'item_groups', 'code, parent_grp, name, full_path, depth, top_level',
        q => q.order('full_path')
      )
    } catch (err) {
      groupsLoadFailed = true
      treeRootEl.innerHTML = `<div style="padding:12px;color:#c00;">Failed to load groups: ${esc(err.message)}</div>`
      return
    }

    groupsById = new Map(allGroups.map(g => [g.code, g]))
    groupChildren = new Map()
    for (const g of allGroups) {
      const key = g.parent_grp || 0
      if (!groupChildren.has(key)) groupChildren.set(key, [])
      groupChildren.get(key).push(g)
    }
    for (const list of groupChildren.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name))
    }
  }

  // Pull any not-yet-exported edits so re-opening the tool resumes a session.
  async function loadExistingPendingEdits() {
    const { data, error } = await supabaseBusy
      .from('item_pending_edits')
      .select('item_code, new_group_code, new_price, remark1, remark2, remark3')
      .eq('exported', false)
    if (error || !data) return
    for (const row of data) {
      pendingEdits.set(row.item_code, {
        new_group_code: row.new_group_code,
        new_price: row.new_price,
        remark1: row.remark1,
        remark2: row.remark2,
        remark3: row.remark3,
      })
    }
    updateChangedBadge()
  }

  // Tree badges attribute a pending edit to the item's REAL current group, not
  // any pending reassignment -- for edits resumed from a previous session on
  // groups not yet browsed this session, that mapping isn't known yet without
  // this lookup (loadItemsForGroup fills it in for free for groups you do visit).
  async function backfillCurrentGroups(codes) {
    const missing = codes.filter(c => !currentGroupByCode.has(c))
    for (const codeBatch of chunk(missing, 300)) {
      const { data, error } = await supabaseBusy.from('item_group_map').select('code, parent_grp').in('code', codeBatch)
      if (error) { console.error('Failed to load item groups for tree badges:', error.message); continue }
      for (const row of data || []) currentGroupByCode.set(row.code, row.parent_grp)
    }
  }

  function renderTree() {
    if (groupsLoadFailed) return // leave loadGroups()'s own error message on screen instead of overwriting it
    const roots = groupChildren.get(0) || []
    treeRootEl.innerHTML = ''
    if (!roots.length) {
      treeRootEl.innerHTML = '<div class="im-empty-state">No groups found.</div>'
      return
    }
    for (const root of roots) treeRootEl.appendChild(buildTreeNode(root, 0))
  }

  function buildTreeNode(group, depth) {
    const wrapper = document.createElement('div')
    wrapper.className = 'im-tree-node'

    const children = groupChildren.get(group.code) || []
    const hasChildren = children.length > 0

    const row = document.createElement('div')
    row.className = 'im-tree-row'
    row.style.paddingLeft = `${8 + depth * 18}px`
    row.dataset.code = group.code

    const toggle = document.createElement('span')
    toggle.className = 'im-tree-toggle'
    toggle.textContent = hasChildren ? '+' : ''
    row.appendChild(toggle)

    const label = document.createElement('span')
    label.className = 'im-tree-label'
    label.textContent = group.name
    row.appendChild(label)

    const badge = document.createElement('span')
    badge.className = 'im-tree-badge'
    badge.hidden = true
    row.appendChild(badge)

    const childContainer = document.createElement('div')
    childContainer.className = 'im-tree-children'

    if (hasChildren) {
      toggle.addEventListener('click', e => {
        e.stopPropagation()
        const expanded = childContainer.classList.toggle('expanded')
        toggle.textContent = expanded ? '−' : '+'
      })
      for (const child of children) childContainer.appendChild(buildTreeNode(child, depth + 1))
    }

    row.addEventListener('click', () => selectGroup(group, row))

    wrapper.appendChild(row)
    wrapper.appendChild(childContainer)
    return wrapper
  }

  function selectGroup(group, rowEl) {
    document.querySelectorAll('.im-tree-row.active').forEach(el => el.classList.remove('active'))
    rowEl.classList.add('active')
    loadItemsForGroup(group)
  }

  // ---- Load items for a selected group (rolls up to subgroups) ----
  // activeGroupCode (declared up top with the other state) tracks which
  // group's load is the one that should actually reach the screen --
  // clicking a second group before the first's fetch (or its follow-up price
  // fetch) resolves must not let the stale, slower call's render stomp the
  // one the user actually asked for last.
  async function loadItemsForGroup(group) {
    activeGroupCode = group.code
    panelHeaderEl.innerHTML = `Loading items in <strong>${esc(group.full_path)}</strong>…`
    emptyStateEl.style.display = 'none'
    itemsTableEl.style.display = 'none'

    let mapRows
    try {
      mapRows = await fetchAllBusyFiltered(
        'item_group_map', 'code, name, alias, parent_grp, group_path',
        q => q.like('group_path', `${group.full_path}%`).order('name')
      )
    } catch (err) {
      if (activeGroupCode !== group.code) return
      panelHeaderEl.textContent = `Failed to load items: ${err.message}`
      return
    }
    if (!document.getElementById('imPanelHeader') || activeGroupCode !== group.code) return
    for (const row of mapRows) currentGroupByCode.set(row.code, row.parent_grp)

    if (!mapRows.length) {
      panelHeaderEl.innerHTML = `<strong>${esc(group.full_path)}</strong> — 0 items`
      emptyStateEl.textContent = 'No items in this group.'
      emptyStateEl.style.display = 'block'
      return
    }

    const priceByCode = new Map()
    const fixedValueByCode = new Map()
    for (const codeBatch of chunk(mapRows.map(r => r.code), 300)) {
      const { data, error } = await supabaseBusy.from('items').select('code, sale_rate, fixed_value').in('code', codeBatch)
      if (error) {
        if (activeGroupCode !== group.code) return
        panelHeaderEl.textContent = `Failed to load prices: ${error.message}`
        return
      }
      for (const row of data || []) {
        priceByCode.set(row.code, row.sale_rate)
        fixedValueByCode.set(row.code, row.fixed_value)
      }
    }
    if (!document.getElementById('imPanelHeader') || activeGroupCode !== group.code) return

    panelHeaderEl.innerHTML = `<strong>${esc(group.full_path)}</strong> — ${mapRows.length} item${mapRows.length === 1 ? '' : 's'}`
    currentItems = mapRows
    currentPriceByCode = priceByCode
    currentFixedValueByCode = fixedValueByCode
    renderItemsTable(sortItems(mapRows, priceByCode), priceByCode, fixedValueByCode)
  }

  // ---- Column sorting (Name / Sale Price only; default alphabetical by Name) ----
  function toggleSort(column) {
    if (sortState.column === column) sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc'
    else { sortState.column = column; sortState.dir = 'asc' }
  }

  function effectivePrice(item, priceByCode) {
    return pendingEdits.get(item.code)?.new_price ?? priceByCode.get(item.code) ?? 0
  }

  function sortItems(items, priceByCode) {
    const dirMul = sortState.dir === 'asc' ? 1 : -1
    const sorted = [...items]
    if (sortState.column === 'price') {
      sorted.sort((a, b) => dirMul * (effectivePrice(a, priceByCode) - effectivePrice(b, priceByCode)))
    } else {
      sorted.sort((a, b) => dirMul * a.name.localeCompare(b.name))
    }
    return sorted
  }

  // columnDefs (widths dragged into it) lives up top with the other state.
  function renderTableHead() {
    const headRow = document.getElementById('imTableHeadRow')
    headRow.innerHTML = ''
    for (const col of columnDefs) {
      const th = document.createElement('th')
      th.style.width = `${col.width}px`
      if (col.numeric) th.classList.add('im-num')

      let label = col.label
      if (col.sortable) {
        const active = sortState.column === col.key
        if (active) th.classList.add('active')
        th.classList.add('im-sortable-th')
        if (active) label += sortState.dir === 'asc' ? ' ↑' : ' ↓'
        th.addEventListener('click', e => {
          if (e.target.closest('.im-col-resizer')) return
          toggleSort(col.key)
          renderTableHead()
          if (currentItems) renderItemsTable(sortItems(currentItems, currentPriceByCode), currentPriceByCode, currentFixedValueByCode)
        })
      }
      th.appendChild(document.createTextNode(label))
      th.appendChild(buildColumnResizer(col, th))
      headRow.appendChild(th)
    }
  }

  // Drag handle on a header cell's right edge. Widths live in columnDefs (not
  // the DOM), so they persist across the header rebuilds that sorting triggers.
  function buildColumnResizer(col, th) {
    const resizer = document.createElement('span')
    resizer.className = 'im-col-resizer'
    resizer.addEventListener('mousedown', e => {
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const startWidth = th.offsetWidth
      document.body.classList.add('im-col-resizing')
      function onMove(ev) {
        col.width = Math.max(40, startWidth + (ev.clientX - startX))
        th.style.width = `${col.width}px`
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.classList.remove('im-col-resizing')
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })
    return resizer
  }

  function renderItemsTable(items, priceByCode, fixedValueByCode) {
    itemsTbodyEl.innerHTML = ''
    itemsTableEl.style.display = 'table'

    for (const item of items) {
      const currentPrice = priceByCode.get(item.code) ?? 0
      const existingEdit = pendingEdits.get(item.code)

      const tr = document.createElement('tr')
      tr.dataset.code = item.code
      if (existingEdit) tr.classList.add('im-changed')

      const nameTd = document.createElement('td')
      nameTd.className = 'im-name'
      nameTd.textContent = item.name
      nameTd.title = item.name
      tr.appendChild(nameTd)

      const aliasTd = document.createElement('td')
      aliasTd.className = 'im-alias'
      aliasTd.textContent = item.alias || ''
      aliasTd.title = item.alias || ''
      tr.appendChild(aliasTd)

      const priceInput = document.createElement('input')
      priceInput.type = 'number'
      priceInput.step = '0.01'
      priceInput.className = 'im-price-input'
      priceInput.value = existingEdit?.new_price ?? currentPrice
      priceInput.addEventListener('change', () => {
        handleEdit(item, tr, { new_price: Number(priceInput.value) })
      })

      const remark1Input = document.createElement('input')
      remark1Input.type = 'text'
      remark1Input.className = 'im-remarks-input'
      remark1Input.value = existingEdit?.remark1 ?? ''
      remark1Input.addEventListener('change', () => handleEdit(item, tr, { remark1: remark1Input.value }))

      const remark2Input = document.createElement('input')
      remark2Input.type = 'text'
      remark2Input.className = 'im-remarks-input'
      remark2Input.value = existingEdit?.remark2 ?? ''
      remark2Input.addEventListener('change', () => handleEdit(item, tr, { remark2: remark2Input.value }))

      const remark3Input = document.createElement('input')
      remark3Input.type = 'text'
      remark3Input.className = 'im-remarks-input'
      remark3Input.value = existingEdit?.remark3 ?? ''
      remark3Input.addEventListener('change', () => handleEdit(item, tr, { remark3: remark3Input.value }))

      // Enter commits the current cell (via the same 'change' handler, fired
      // naturally when focus moves off it) and steps to the next editable
      // cell to the right: Group -> Sale Price -> Remark 1 -> 2 -> 3. Remark 3
      // has nowhere further to go, so it just blurs to commit.
      priceInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); remark1Input.focus() } })
      remark1Input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); remark2Input.focus() } })
      remark2Input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); remark3Input.focus() } })
      remark3Input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); remark3Input.blur() } })

      const groupTd = document.createElement('td')
      const currentGroupCode = existingEdit?.new_group_code ?? item.parent_grp
      groupTd.appendChild(buildGroupPicker(item, tr, currentGroupCode, () => priceInput.focus()))
      tr.appendChild(groupTd)

      const priceTd = document.createElement('td')
      priceTd.className = 'im-num'
      priceTd.appendChild(priceInput)
      tr.appendChild(priceTd)

      // Read-only Busy-synced reference field -- never edited here, so no
      // input and no place in the Enter-key commit chain above.
      const fixedValueTd = document.createElement('td')
      fixedValueTd.className = 'im-num'
      const fixedValue = fixedValueByCode.get(item.code)
      fixedValueTd.textContent = fixedValue ?? '—'
      tr.appendChild(fixedValueTd)

      const remark1Td = document.createElement('td')
      remark1Td.appendChild(remark1Input)
      tr.appendChild(remark1Td)

      const remark2Td = document.createElement('td')
      remark2Td.appendChild(remark2Input)
      tr.appendChild(remark2Td)

      const remark3Td = document.createElement('td')
      remark3Td.appendChild(remark3Input)
      tr.appendChild(remark3Td)

      itemsTbodyEl.appendChild(tr)
    }
  }

  // Searchable group picker: a plain <select> with all 261 groups listed by
  // full path is painful to scroll/scan, so this reuses the type-to-filter
  // pattern already established for item/client search elsewhere in the CRM
  // (quotation-form.js's item-search-wrap), sized down for a dense table cell.
  function buildGroupPicker(item, tr, currentGroupCode, onCommitNext) {
    const wrap = document.createElement('div')
    wrap.className = 'im-group-picker'

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'im-group-input'
    input.autocomplete = 'off'
    const currentGroup = groupsById.get(currentGroupCode)
    input.value = currentGroup ? currentGroup.full_path : ''
    input.title = input.value // full path on hover -- the column is too narrow to show deep paths in full
    input.dataset.selectedCode = currentGroupCode ?? ''

    const suggestBox = document.createElement('div')
    suggestBox.className = 'im-group-suggestions'
    suggestBox.hidden = true

    wrap.appendChild(input)
    wrap.appendChild(suggestBox)

    let suggestions = []
    let highlighted = -1

    function closeSuggestions() {
      suggestBox.hidden = true
      suggestBox.innerHTML = ''
      suggestions = []
      highlighted = -1
    }

    function renderSuggestions() {
      if (!suggestions.length) { suggestBox.hidden = true; suggestBox.innerHTML = ''; return }
      suggestBox.innerHTML = suggestions.map((g, i) =>
        `<div class="im-suggestion-item${i === highlighted ? ' highlighted' : ''}" data-i="${i}">${esc(g.full_path)}</div>`
      ).join('')
      suggestBox.hidden = false
      suggestBox.querySelectorAll('.im-suggestion-item').forEach(el => {
        // mousedown (not click) fires before the input's blur handler, so a
        // pick registers before blur snaps the input's text back to whatever
        // was actually selected.
        el.addEventListener('mousedown', e => {
          e.preventDefault()
          pick(Number(el.dataset.i))
        })
      })
    }

    function pick(i) {
      const g = suggestions[i]
      if (!g) return
      input.value = g.full_path
      input.title = g.full_path
      input.dataset.selectedCode = g.code
      closeSuggestions()
      handleEdit(item, tr, { new_group_code: g.code })
    }

    input.addEventListener('focus', () => input.select())
    input.addEventListener('input', () => {
      const term = input.value
      suggestions = (term.trim() ? allGroups.filter(g => tokenMatch(g.full_path, term)) : allGroups).slice(0, 50)
      highlighted = -1
      renderSuggestions()
    })
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); highlighted = Math.min(highlighted + 1, suggestions.length - 1); renderSuggestions() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlighted = Math.max(highlighted - 1, 0); renderSuggestions() }
      else if (e.key === 'Enter') {
        e.preventDefault()
        if (highlighted >= 0) pick(highlighted)
        onCommitNext && onCommitNext()
      }
      else if (e.key === 'Escape') { closeSuggestions(); input.blur() }
    })
    input.addEventListener('blur', () => {
      setTimeout(() => {
        closeSuggestions()
        // Free text that was never actually picked snaps back to whatever
        // group is really selected, rather than leaving a misleading label.
        const selected = groupsById.get(Number(input.dataset.selectedCode))
        input.value = selected ? selected.full_path : ''
        input.title = input.value
      }, 120)
    })

    return wrap
  }

  // ---- Edit tracking ----
  // Every call changes exactly one field (new_price, new_group_code, or one
  // of remark1/2/3) -- that one-field-per-call contract is what lets Undo
  // revert a single field without guessing which one just changed.
  async function handleEdit(item, rowEl, changes) {
    const existing = pendingEdits.get(item.code) || {}
    const [field, newValue] = Object.entries(changes)[0]
    undoStack.push({ item_code: item.code, field, previousValue: existing[field] ?? null, newValue })
    updateUndoButtonState()

    const merged = { ...existing, ...changes }
    pendingEdits.set(item.code, merged)
    rowEl.classList.add('im-changed')
    updateChangedBadge()
    updateTreeBadges()

    // Persist immediately so a refresh mid-session doesn't lose work. This is
    // the ONLY table this tool ever writes to -- items/item_group_map stay
    // read-only from here (the pendingEdits map above, consulted by
    // renderItemsTable, is what makes an edit show up "live" if you browse
    // away and back, not a write-back to the source tables).
    const { error } = await supabaseBusy.from('item_pending_edits').upsert({
      item_code: item.code,
      new_group_code: merged.new_group_code ?? null,
      new_price: merged.new_price ?? null,
      remark1: merged.remark1 ?? null,
      remark2: merged.remark2 ?? null,
      remark3: merged.remark3 ?? null,
      edited_at: new Date().toISOString(),
      exported: false,
    })
    if (error) console.error('Failed to save pending edit:', error.message)
  }

  function updateChangedBadge() {
    const count = pendingEdits.size
    changedBadgeEl.textContent = `${count} item${count === 1 ? '' : 's'} changed`
    changedBadgeEl.classList.toggle('visible', count > 0)
    exportBtnEl.disabled = count === 0
    discardBtnEl.disabled = count === 0
  }

  function updateUndoButtonState() {
    undoBtnEl.disabled = undoStack.length === 0
  }

  // ---- Tree badges: count of pending edits under each group, by the item's
  // REAL current group (item_group_map's parent_grp), not any pending
  // reassignment -- bubbled up through parent_grp so an ancestor node shows
  // the total across all its descendants. ----
  function computeGroupCounts() {
    const direct = new Map() // immediate parent_grp -> count of pending items directly in it
    for (const code of pendingEdits.keys()) {
      const parentGrp = currentGroupByCode.get(code)
      if (parentGrp == null) continue
      direct.set(parentGrp, (direct.get(parentGrp) || 0) + 1)
    }
    const counts = new Map()
    for (const [groupCode, n] of direct) {
      let cur = groupsById.get(groupCode)
      let guard = 0
      while (cur && guard++ < 50) {
        counts.set(cur.code, (counts.get(cur.code) || 0) + n)
        if (!cur.parent_grp) break
        cur = groupsById.get(cur.parent_grp)
      }
    }
    return counts
  }

  function updateTreeBadges() {
    const counts = computeGroupCounts()
    treeRootEl.querySelectorAll('.im-tree-row[data-code]').forEach(row => {
      const badge = row.querySelector('.im-tree-badge')
      if (!badge) return
      const n = counts.get(Number(row.dataset.code)) || 0
      badge.textContent = n > 99 ? '99+' : String(n)
      badge.hidden = n === 0
    })
  }

  // ---- Discard / Undo ----
  // Both only ever UPDATE/upsert item_pending_edits (nulling fields back out)
  // -- never DELETE a row. A fully-reverted item is left as an all-null row
  // rather than removed; Export already treats null fields as "no change"
  // (falls back to the item's real name/group/price, blank remarks), so what
  // you see here always matches what a subsequent export actually contains.
  async function discardAllChanges() {
    const count = pendingEdits.size
    if (count === 0) return
    if (!confirm(`Discard all ${count} pending change${count === 1 ? '' : 's'}?`)) return

    const { error } = await supabaseBusy.from('item_pending_edits').update({
      new_group_code: null,
      new_price: null,
      remark1: null,
      remark2: null,
      remark3: null,
      edited_at: new Date().toISOString(),
    }).eq('exported', false)
    if (error) { alert(`Failed to discard changes: ${error.message}`); return }

    pendingEdits.clear()
    undoStack = []
    updateChangedBadge()
    updateUndoButtonState()
    updateTreeBadges()
    if (currentItems) renderItemsTable(sortItems(currentItems, currentPriceByCode), currentPriceByCode, currentFixedValueByCode)
  }

  async function undoLastChange() {
    const entry = undoStack.pop()
    if (!entry) return
    updateUndoButtonState()

    const { item_code, field, previousValue } = entry
    const existing = pendingEdits.get(item_code) || {}
    const reverted = { ...existing, [field]: previousValue }
    const stillHasChanges = Object.values(reverted).some(v => v !== null && v !== undefined)

    if (stillHasChanges) pendingEdits.set(item_code, reverted)
    else pendingEdits.delete(item_code) // no fields left changed -- drop it from local state, but leave the DB row as an all-null no-op rather than deleting it

    const { error } = await supabaseBusy.from('item_pending_edits').upsert({
      item_code,
      new_group_code: reverted.new_group_code ?? null,
      new_price: reverted.new_price ?? null,
      remark1: reverted.remark1 ?? null,
      remark2: reverted.remark2 ?? null,
      remark3: reverted.remark3 ?? null,
      edited_at: new Date().toISOString(),
      exported: false,
    })
    if (error) console.error('Failed to undo edit:', error.message)

    updateChangedBadge()
    updateTreeBadges()
    if (currentItems) renderItemsTable(sortItems(currentItems, currentPriceByCode), currentPriceByCode, currentFixedValueByCode)
  }

  // ---- Export (.xlsx -- Busy's bulk importer expects that format, not CSV) ----
  async function exportForBusy() {
    const { data: edits, error } = await supabaseBusy
      .from('item_pending_edits')
      .select('item_code, new_group_code, new_price, remark1, remark2, remark3')
      .eq('exported', false)

    if (error || !edits || edits.length === 0) {
      alert('Nothing to export.')
      return
    }

    const codes = edits.map(e => e.item_code)
    const itemByCode = new Map()
    const mapByCode = new Map()
    for (const codeBatch of chunk(codes, 300)) {
      const [{ data: items }, { data: maps }] = await Promise.all([
        supabaseBusy.from('items').select('code, name, alias, sale_rate').in('code', codeBatch),
        supabaseBusy.from('item_group_map').select('code, parent_grp').in('code', codeBatch),
      ])
      for (const r of items || []) itemByCode.set(r.code, r)
      for (const r of maps || []) mapByCode.set(r.code, r)
    }

    const rows = [['Item Name', 'Item Alias', 'Item Group', 'Sales Price', 'Remark 1', 'Remark 2', 'Remark 3']]
    for (const edit of edits) {
      const item = itemByCode.get(edit.item_code)
      if (!item) continue
      const effectiveGroupCode = edit.new_group_code ?? mapByCode.get(edit.item_code)?.parent_grp
      const group = groupsById.get(effectiveGroupCode)
      const effectivePrice = edit.new_price ?? item.sale_rate
      rows.push([item.name, item.alias || '', group ? group.name : '', effectivePrice, edit.remark1 || '', edit.remark2 || '', edit.remark3 || ''])
    }

    const worksheet = XLSX.utils.aoa_to_sheet(rows)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Items')
    XLSX.writeFile(workbook, `items-bulk-update-${new Date().toISOString().slice(0, 10)}.xlsx`)

    await supabaseBusy.from('item_pending_edits').update({ exported: true }).in('item_code', codes)

    pendingEdits.clear()
    undoStack = []
    updateChangedBadge()
    updateUndoButtonState()
    updateTreeBadges()
    document.querySelectorAll('#imItemsTbody tr.im-changed').forEach(tr => tr.classList.remove('im-changed'))
  }

  // ---- AI chat -- natural-language Q&A over live JCM-Busysql data via
  // api/db-chat.js. Read-only end to end: the serverless function validates
  // Claude's generated SQL is a single SELECT before it ever runs, and the
  // DB-side function it calls enforces the same thing again. This tool never
  // sends a write of any kind through this path. ----
  function appendChatMessage(role, text) {
    const el = document.createElement('div')
    el.className = `im-chat-msg im-chat-msg-${role}`
    el.textContent = text
    chatMessagesEl.appendChild(el)
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight
    return el
  }

  async function sendChatMessage() {
    const question = chatInputEl.value.trim()
    if (!question) return

    appendChatMessage('user', question)
    chatInputEl.value = ''
    chatInputEl.disabled = true
    chatSendBtnEl.disabled = true
    const pendingEl = appendChatMessage('assistant', 'Thinking…')
    pendingEl.classList.add('im-chat-pending')

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const resp = await fetch(apiUrl('/api/db-chat'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token || ''}`,
        },
        body: JSON.stringify({ question }),
      })
      const body = await resp.json().catch(() => ({}))
      pendingEl.remove()

      if (!resp.ok) {
        appendChatMessage('error', body.error || 'Something went wrong. Try again.')
        return
      }

      const answerEl = appendChatMessage('assistant', body.answer || 'No answer.')
      if (body.sql) {
        const details = document.createElement('details')
        details.className = 'im-chat-sql'
        const summary = document.createElement('summary')
        summary.textContent = 'SQL used'
        const code = document.createElement('code')
        code.textContent = body.sql
        details.appendChild(summary)
        details.appendChild(code)
        answerEl.appendChild(details)
      }
    } catch (err) {
      pendingEl.remove()
      appendChatMessage('error', `Something went wrong: ${err.message}`)
    } finally {
      chatInputEl.disabled = false
      chatSendBtnEl.disabled = false
      chatInputEl.focus()
    }
  }
}
