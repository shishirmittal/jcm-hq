import { supabase, getCurrentProfile } from './supabase.js'
import { esc } from './utils.js'
import { loadCatalog, clearCatalogCache } from './catalog.js'
import { isAdminProfile } from './permissions.js'

// Bulk edit of catalog_items: pick the columns, pick the item group, change
// what needs changing, save.
//
// What is NOT editable here is the point of the screen as much as what is.
// description, brand, model, category and sub_category are how the quotation
// form finds an item at all — the search matches on them and the brand/model
// pickers are built from them — so renaming one here would quietly take the
// item out of reach of the people quoting it. They are shown for context and
// nothing more.
//
// Old quotations are deliberately left alone. quotation_items holds its own
// copy of the price each line was quoted at, and that is the record of what
// was offered to a customer — a price change today must not reach backwards
// and rewrite what somebody was told last month.

// value: the catalog_items column. label: what the admin sees.
// kind decides the input and how a change is judged.
const COLUMNS = [
  { key: 'mrp', label: 'List Price', kind: 'number' },
  { key: 'cat_no', label: 'Cat No', kind: 'text' },
  { key: 'std_pack', label: 'Std Pack', kind: 'text' },
  { key: 'colour', label: 'Colour', kind: 'text' },
  { key: 'on_request', label: 'Price on request', kind: 'bool' },
]

const COLUMN_BY_KEY = new Map(COLUMNS.map(c => [c.key, c]))

// Supabase caps a select at 1000 rows, so a brand with more variants than
// that would silently come back cut in half — and a row missing from this
// table is a row the admin believes they have just checked.
const PAGE_SIZE = 1000

// Rows are written one at a time (each has its own values), a few at once so
// a large group does not take a visible age. Small on purpose: this is a
// shared database and nothing here is in a hurry.
const WRITE_CONCURRENCY = 8

const ui = {
  columns: new Set(['mrp']),
  brand: '',
  model: '',
  category: '',
  rows: [],      // { id, description, model, category, colour, ...columns }
  original: new Map(), // id -> { column: value } as loaded
  edited: new Map(),   // id -> { column: value } as typed
  loading: false,
  saving: false,
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

// One spelling of "this cell is empty", so a null out of Postgres and an
// empty input box are never mistaken for a change from one to the other.
function normalise(kind, value) {
  if (kind === 'bool') return value === true
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

// Blank is "leave this alone", not "set it to nothing". Clearing a field is
// not what this screen is for, and the cost of reading it the other way is
// that a tabbed-through row quietly wipes a Cat No that took somebody an
// afternoon to get right.
function isBlank(kind, value) {
  return kind !== 'bool' && normalise(kind, value) === ''
}

function currentValue(id, key) {
  const edits = ui.edited.get(id)
  if (edits && key in edits) return edits[key]
  return ui.original.get(id)?.[key]
}

// A cell counts as changed when it is non-blank and reads differently from
// what was loaded. mrp compares as a number so "2490" and "2490.00" are the
// same price rather than a change to be written.
function cellChanged(id, key) {
  const col = COLUMN_BY_KEY.get(key)
  if (!col) return false
  const before = ui.original.get(id)?.[key]
  const after = currentValue(id, key)
  if (isBlank(col.kind, after)) return false
  if (col.kind === 'bool') return normalise('bool', before) !== normalise('bool', after)
  if (col.kind === 'number') {
    const a = Number(normalise('number', before))
    const b = Number(normalise('number', after))
    if (Number.isNaN(b)) return false
    return a !== b
  }
  return normalise(col.kind, before) !== normalise(col.kind, after)
}

function changedKeysFor(id) {
  return [...ui.columns].filter(key => cellChanged(id, key))
}

function changedRows() {
  return ui.rows.filter(r => changedKeysFor(r.id).length > 0)
}

// mrp is the one column with a rule beyond "is it different": a price has to
// be a number and cannot be negative.
function invalidRows() {
  if (!ui.columns.has('mrp')) return []
  return ui.rows.filter(r => {
    const raw = currentValue(r.id, 'mrp')
    if (isBlank('number', raw)) return false
    const n = Number(normalise('number', raw))
    return Number.isNaN(n) || n < 0
  })
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

// The dropdowns read the cached catalog, which is already paged and already
// in memory for the quotation form. The table below does NOT: it asks the
// server directly, because the values it shows become the "original" that
// every change is judged against and a cached copy could be older than what
// is actually in the column.
async function loadGroups() {
  const catalog = await loadCatalog()
  return catalog
}

function distinct(rows, key) {
  return [...new Set(rows.map(r => r[key]).filter(v => v !== null && v !== undefined && String(v).trim() !== ''))]
    .sort((a, b) => String(a).localeCompare(String(b)))
}

async function fetchRows() {
  const selected = ['id', 'description', 'brand', 'model', 'category', 'colour', ...COLUMNS.map(c => c.key)]
  const columns = [...new Set(selected)].join(', ')

  const all = []
  let from = 0
  for (;;) {
    let q = supabase.from('catalog_items').select(columns)
    q = q.eq('brand', ui.brand)
    if (ui.model) q = q.eq('model', ui.model)
    if (ui.category) q = q.eq('category', ui.category)
    // Ordered so the pages line up. Without it Postgres is free to return
    // rows in a different order per request and a row can fall between two
    // pages — the table would then be quietly missing items the admin
    // believes they have just reviewed.
    const { data, error } = await q.order('id').range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    all.push(...(data || []))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

function adoptRows(rows) {
  ui.rows = rows
  ui.original = new Map()
  ui.edited = new Map()
  for (const row of rows) {
    const snapshot = {}
    for (const col of COLUMNS) snapshot[col.key] = row[col.key]
    ui.original.set(row.id, snapshot)
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderColumnChips() {
  return COLUMNS.map(col => `
    <label class="checkbox-chip">
      <input type="checkbox" data-col="${col.key}"${ui.columns.has(col.key) ? ' checked' : ''} />
      ${esc(col.label)}
    </label>
  `).join('')
}

function option(value, label, selected) {
  return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`
}

function renderGroupPickers(catalog) {
  const brands = distinct(catalog, 'brand')
  const forBrand = ui.brand ? catalog.filter(r => r.brand === ui.brand) : []
  const models = distinct(forBrand, 'model')
  const forModel = ui.model ? forBrand.filter(r => r.model === ui.model) : forBrand
  const categories = distinct(forModel, 'category')

  return `
    <div class="pu-pickers">
      <div class="form-group">
        <label for="puBrand">Brand <span class="pu-required">required</span></label>
        <select id="puBrand">
          ${option('', 'Select a brand…', !ui.brand)}
          ${brands.map(b => option(b, b, b === ui.brand)).join('')}
        </select>
      </div>
      <div class="form-group">
        <label for="puModel">Model <span class="pu-optional">optional</span></label>
        <select id="puModel"${ui.brand ? '' : ' disabled'}>
          ${option('', 'All models', !ui.model)}
          ${models.map(m => option(m, m, m === ui.model)).join('')}
        </select>
      </div>
      <div class="form-group">
        <label for="puCategory">Category <span class="pu-optional">optional</span></label>
        <select id="puCategory"${ui.brand ? '' : ' disabled'}>
          ${option('', 'All categories', !ui.category)}
          ${categories.map(c => option(c, c, c === ui.category)).join('')}
        </select>
      </div>
      <button class="btn-primary" id="puGoBtn"${ui.brand ? '' : ' disabled'}>Go</button>
    </div>
  `
}

function cellInput(row, key) {
  const col = COLUMN_BY_KEY.get(key)
  const value = currentValue(row.id, key)
  const changed = cellChanged(row.id, key) ? ' pu-changed' : ''
  if (col.kind === 'bool') {
    return `<label class="pu-bool${changed}">
      <input type="checkbox" data-id="${esc(row.id)}" data-col="${key}"${normalise('bool', value) ? ' checked' : ''} />
    </label>`
  }
  const type = col.kind === 'number' ? 'number' : 'text'
  const extra = col.kind === 'number' ? ' min="0" step="any" inputmode="decimal"' : ''
  return `<input class="pu-input${changed}" type="${type}"${extra}
    data-id="${esc(row.id)}" data-col="${key}" value="${esc(normalise(col.kind, value))}" />`
}

function renderTable() {
  if (ui.loading) return '<div class="loading-state">Loading items…</div>'
  if (!ui.rows.length) {
    return '<div class="empty-state">Pick a brand and press Go to load items.</div>'
  }

  const editable = COLUMNS.filter(c => ui.columns.has(c.key))
  // Colour earns a read-only column only when it is not already an editable
  // one — otherwise the same value would sit on the row twice.
  const showColour = !ui.columns.has('colour')

  const head = `
    <tr>
      <th>Item</th>
      <th>Model</th>
      <th>Category</th>
      ${showColour ? '<th>Colour</th>' : ''}
      ${editable.map(c => `<th>${esc(c.label)}</th>`).join('')}
    </tr>
  `

  const body = ui.rows.map(row => `
    <tr data-row="${esc(row.id)}">
      <td class="pu-desc">${esc(row.description || '—')}</td>
      <td class="pu-muted">${esc(row.model || '—')}</td>
      <td class="pu-muted">${esc(row.category || '—')}</td>
      ${showColour ? `<td class="pu-muted">${esc(row.colour || '—')}</td>` : ''}
      ${editable.map(c => `<td>${cellInput(row, c.key)}</td>`).join('')}
    </tr>
  `).join('')

  return `
    <div class="pu-table-wrap">
      <table class="pu-table">
        <thead>${head}</thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `
}

function renderFooter() {
  const changed = changedRows().length
  const invalid = invalidRows().length
  if (!ui.rows.length) return ''
  return `
    <div class="pu-footer">
      <div class="pu-count${changed ? ' pu-count-on' : ''}">
        ${changed} row${changed === 1 ? '' : 's'} changed
        ${invalid ? `<span class="pu-invalid">· ${invalid} with an invalid price</span>` : ''}
      </div>
      <div class="pu-footer-actions">
        <button class="btn-ghost" id="puResetBtn"${changed && !ui.saving ? '' : ' disabled'}>Reset</button>
        <button class="btn-primary" id="puSaveBtn"${changed && !invalid && !ui.saving ? '' : ' disabled'}>
          ${ui.saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

function patchFor(id) {
  const patch = {}
  for (const key of changedKeysFor(id)) {
    const col = COLUMN_BY_KEY.get(key)
    const raw = currentValue(id, key)
    if (col.kind === 'bool') patch[key] = normalise('bool', raw)
    else if (col.kind === 'number') patch[key] = Number(normalise('number', raw))
    else patch[key] = normalise(col.kind, raw)
  }
  return patch
}

async function save(status) {
  const targets = changedRows()
  if (!targets.length) return

  const columnsTouched = new Set()
  for (const row of targets) for (const key of changedKeysFor(row.id)) columnsTouched.add(key)

  const columnNames = [...columnsTouched].map(k => COLUMN_BY_KEY.get(k).label).join(', ')
  const ok = window.confirm(
    `Update ${targets.length} row${targets.length === 1 ? '' : 's'}?\n\n` +
    `Columns changing: ${columnNames}\n\n` +
    'Existing quotations keep the prices they were made with.'
  )
  if (!ok) return

  ui.saving = true
  paint()

  let written = 0
  try {
    for (let i = 0; i < targets.length; i += WRITE_CONCURRENCY) {
      const batch = targets.slice(i, i + WRITE_CONCURRENCY)
      // Errors are folded into the result rather than thrown, so one bad row
      // cannot leave its neighbours rejecting unhandled.
      const results = await Promise.all(batch.map(row =>
        supabase
          .from('catalog_items')
          .update(patchFor(row.id))
          .eq('id', row.id)
          // .select() is the only way to find out whether anything happened.
          // When the "Admins can update catalog" policy refuses a write,
          // Postgres does not raise — the statement simply matches no rows and
          // comes back a success. Counting what returns is what turns that
          // silence into something we can tell the admin about.
          .select('id')
          .then(({ data, error }) => ({ row, error, count: (data || []).length }))
      ))
      for (const r of results) {
        if (r.error) throw new Error(r.error.message)
        written += r.count
      }
    }
  } catch (err) {
    ui.saving = false
    paint()
    status(`Could not save: ${err.message}`, 'error')
    return
  }

  ui.saving = false

  if (written !== targets.length) {
    // Reload anyway: some rows may have gone through, and leaving the old
    // values on screen would misreport what is now in the table.
    await reload(status)
    status('Some rows were not saved. Check you are logged in as an admin.', 'error')
    return
  }

  // The quotation form reads catalog_items through a module-level cache, so
  // without this it would keep quoting the old prices until a full reload.
  clearCatalogCache()

  await reload(status)
  status(`${written} row${written === 1 ? '' : 's'} updated.`, 'ok')
}

async function reload(status) {
  ui.loading = true
  paint()
  try {
    adoptRows(await fetchRows())
  } catch (err) {
    ui.rows = []
    status(`Could not load items: ${err.message}`, 'error')
  }
  ui.loading = false
  paint()
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

let paint = () => {}

export async function renderPriceUpdate(container, onBack) {
  container.innerHTML = '<div class="loading-state">Loading…</div>'

  // ui lives at module scope, so a second visit would otherwise open on the
  // last visit's rows and unsaved edits. Resuming them would be worse than
  // losing them: the originals those edits are measured against were read
  // when the screen was last opened, and anything written to catalog_items in
  // between — by the nightly sync, or by another admin — would make every
  // comparison on screen a comparison against a value that is no longer in
  // the column.
  ui.columns = new Set(['mrp'])
  ui.brand = ''
  ui.model = ''
  ui.category = ''
  ui.rows = []
  ui.original = new Map()
  ui.edited = new Map()
  ui.loading = false
  ui.saving = false

  // The sidebar already hides this, and the RLS policy on catalog_items is
  // what actually stops a write — this is the third layer, so that a
  // non-admin who types the hash in gets told rather than shown a form whose
  // Save button would silently do nothing.
  const profile = await getCurrentProfile()
  if (!isAdminProfile(profile)) {
    container.innerHTML = '<div class="empty-state">You do not have access to this page.</div>'
    setTimeout(onBack, 1500)
    return
  }

  let catalog = []
  try {
    catalog = await loadGroups()
  } catch {
    container.innerHTML = '<div class="empty-state">Could not load the catalog.</div>'
    return
  }

  container.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <button class="btn-ghost" id="backBtn">← Back</button>
        <span class="logo-small">Price Update</span>
        <span></span>
      </header>
      <main class="app-main">
        <div class="pu-page">
          <div class="qf-card">
            <div class="qf-card-head"><h2>Columns to update</h2></div>
            <div class="qf-card-sub">Tick what you want to change. Everything else is left alone.</div>
            <div class="qf-card-body">
              <div class="checkbox-row" id="puColumns">${renderColumnChips()}</div>
            </div>
          </div>

          <div class="qf-card">
            <div class="qf-card-head"><h2>Item group</h2></div>
            <div class="qf-card-sub">Brand is required. Narrow it further with model and category if you want.</div>
            <div class="qf-card-body" id="puGroup">${renderGroupPickers(catalog)}</div>
          </div>

          <div class="qf-card">
            <div class="qf-card-head"><h2>Items</h2></div>
            <div class="qf-card-sub">
              Item, model and category are shown for context and cannot be edited —
              the quotation search depends on them.
            </div>
            <div class="qf-card-body">
              <div id="puStatus" class="pu-status" role="status"></div>
              <div id="puTable">${renderTable()}</div>
              <div id="puFooter">${renderFooter()}</div>
            </div>
          </div>
        </div>
      </main>
    </div>
  `

  const statusEl = document.getElementById('puStatus')
  function status(message, tone) {
    statusEl.className = `pu-status${tone ? ` pu-status-${tone}` : ''}`
    statusEl.textContent = message || ''
  }

  // Only the parts that change are repainted. Redrawing the pickers while a
  // select is open would close it under the admin's finger, and redrawing the
  // table on every keystroke would take the focus out of the box being typed
  // in — so paint() leaves both alone and the input handler updates the one
  // cell it touched.
  paint = () => {
    document.getElementById('puTable').innerHTML = renderTable()
    document.getElementById('puFooter').innerHTML = renderFooter()
  }

  function repaintGroup() {
    document.getElementById('puGroup').innerHTML = renderGroupPickers(catalog)
  }

  document.getElementById('backBtn').addEventListener('click', onBack)

  // --- columns ---
  document.getElementById('puColumns').addEventListener('change', e => {
    const key = e.target.dataset.col
    if (!key) return
    if (e.target.checked) ui.columns.add(key)
    else ui.columns.delete(key)
    if (ui.columns.size === 0) {
      // At least one column has to be ticked for the screen to mean anything.
      ui.columns.add(key)
      e.target.checked = true
      status('Keep at least one column ticked.', 'error')
      return
    }
    status('')
    // Unticking a column drops any edits made in it — they are no longer on
    // screen, and saving a change the admin can no longer see would be a
    // surprise with somebody's prices in it.
    for (const [, edits] of ui.edited) delete edits[key]
    paint()
  })

  // --- group pickers ---
  document.getElementById('puGroup').addEventListener('change', e => {
    if (e.target.id === 'puBrand') {
      ui.brand = e.target.value
      ui.model = ''
      ui.category = ''
      repaintGroup()
    } else if (e.target.id === 'puModel') {
      ui.model = e.target.value
      ui.category = ''
      repaintGroup()
    } else if (e.target.id === 'puCategory') {
      ui.category = e.target.value
    }
  })

  document.getElementById('puGroup').addEventListener('click', async e => {
    if (e.target.id !== 'puGoBtn') return
    if (!ui.brand) { status('Pick a brand first.', 'error'); return }
    status('')
    await reload(status)
  })

  // --- cell edits ---
  const tableHost = document.getElementById('puTable')

  function noteEdit(input) {
    const id = input.dataset.id
    const key = input.dataset.col
    if (!id || !key) return
    const col = COLUMN_BY_KEY.get(key)
    const value = col.kind === 'bool' ? input.checked : input.value
    if (!ui.edited.has(id)) ui.edited.set(id, {})
    ui.edited.get(id)[key] = value

    // The cell's own highlight, applied in place rather than by redrawing the
    // table, so the caret stays where the admin left it.
    const target = col.kind === 'bool' ? input.closest('.pu-bool') : input
    target.classList.toggle('pu-changed', cellChanged(id, key))
    document.getElementById('puFooter').innerHTML = renderFooter()
  }

  tableHost.addEventListener('input', e => {
    if (e.target.matches('.pu-input')) noteEdit(e.target)
  })
  tableHost.addEventListener('change', e => {
    if (e.target.matches('.pu-bool input')) noteEdit(e.target)
  })

  // --- save / reset ---
  document.getElementById('puFooter').addEventListener('click', async e => {
    if (e.target.id === 'puResetBtn') {
      ui.edited = new Map()
      status('')
      paint()
      return
    }
    if (e.target.id === 'puSaveBtn') {
      await save(status)
    }
  })
}
