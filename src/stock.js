import { icon } from './icons.js'
import { esc } from './utils.js'
import { supabaseBusy } from './supabase-busy.js'
import { tokenMatch } from './catalog.js'
import { openSidebar } from './sidebar.js'

// Stock lookup. Reads the JCM-Busysql project directly, the same way Order
// Planning and Items Management already do — the publishable key is in the
// bundle for those two screens regardless, so routing this through a Vercel
// function would add a hop without closing anything.
//
// Deliberately read-only: nothing on this screen writes, and the refresh
// button re-runs the search rather than touching Busy.

const LIMIT = 30
const DEBOUNCE_MS = 250
// Past this, the freshness line stops being reassuring and starts being a
// warning. From the handover.
const STALE_MINUTES = 30

let ui = null
let mountToken = 0

export function unmountStock() {
  mountToken++
  if (ui?.debounce) clearTimeout(ui.debounce)
  if (ui?.ticker) clearInterval(ui.ticker)
  ui = null
}

export async function renderStock(container) {
  unmountStock()
  const token = ++mountToken
  ui = { query: '', inStockOnly: false, rows: [], loading: false, error: null, syncedAt: null, seq: 0, debounce: null, ticker: null }

  container.innerHTML = `
    <div class="app-layout">
      <header class="app-header stock-header">
        <div class="stock-head-row">
          <button class="btn-ghost btn-hamburger" id="hamburgerBtn" aria-label="Menu">☰</button>
          <span class="logo-small">Stock</span>
          <button type="button" class="stock-refresh" id="stockRefresh" aria-label="Refresh">${icon('clock', 17)}</button>
        </div>
        <div class="stock-search-wrap">
          ${icon('box', 16)}
          <input type="search" class="stock-search" id="stockSearch" autocomplete="off"
                 enterkeyhint="search" placeholder="Search by name or item code" />
        </div>
        <div class="stock-filters">
          <button type="button" class="stock-filter" id="stockInStockOnly" aria-pressed="false">
            <span class="stock-filter-check">${icon('check', 14)}</span>
            <span>Available stock</span>
          </button>
        </div>
      </header>
      <main class="app-main stock-main">
        <div class="stock-freshness" id="stockFreshness"></div>
        <div class="stock-results" id="stockResults"></div>
      </main>
    </div>
  `

  container.querySelector('#hamburgerBtn').addEventListener('click', () => openSidebar())

  const input = container.querySelector('#stockSearch')
  input.addEventListener('input', () => {
    ui.query = input.value
    clearTimeout(ui.debounce)
    // Typing is not a decision until it pauses; without this every keystroke
    // on a 9,600-item table is its own round trip.
    ui.debounce = setTimeout(() => runSearch(token), DEBOUNCE_MS)
  })

  container.querySelector('#stockRefresh').addEventListener('click', () => {
    loadFreshness(token)
    runSearch(token, { force: true })
  })

  const inStockBtn = container.querySelector('#stockInStockOnly')
  inStockBtn.addEventListener('click', () => {
    ui.inStockOnly = !ui.inStockOnly
    inStockBtn.setAttribute('aria-pressed', String(ui.inStockOnly))
    // Re-asks the server rather than hiding rows already on screen. The search
    // returns at most LIMIT items, so filtering here would leave five results
    // showing out of thirty fetched while in-stock items that never made the
    // first thirty stayed invisible — the toggle would read as "find fewer"
    // instead of "show only what we have". Asking again spends the whole
    // limit on items that are actually in stock.
    clearTimeout(ui.debounce)
    runSearch(token)
  })

  renderResults()
  loadFreshness(token)
  // The line says "4 min ago", so it has to be able to become "5 min ago"
  // without the screen being touched.
  ui.ticker = setInterval(() => renderFreshness(), 30000)
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

async function loadFreshness(token) {
  // The stock job's own log row is the honest answer. Before that job is
  // scheduled there are no such rows, so fall back to the nightly — which is
  // genuinely when stock last moved, and will correctly read as stale.
  let at = null
  const live = await supabaseBusy.from('sync_log').select('run_at, status')
    .eq('job', 'stock-live').eq('status', 'success')
    .order('run_at', { ascending: false }).limit(1)
  if (!live.error && live.data?.length) at = live.data[0].run_at
  if (!at) {
    const any = await supabaseBusy.from('sync_log').select('run_at, status')
      .eq('status', 'success').order('run_at', { ascending: false }).limit(1)
    if (!any.error && any.data?.length) at = any.data[0].run_at
  }
  if (token !== mountToken || !ui) return
  ui.syncedAt = at
  renderFreshness()
}

function renderFreshness() {
  const el = document.getElementById('stockFreshness')
  if (!el || !ui) return
  if (!ui.syncedAt) { el.innerHTML = ''; return }
  const mins = Math.max(0, Math.round((Date.now() - new Date(ui.syncedAt).getTime()) / 60000))
  const stale = mins > STALE_MINUTES
  const ago = mins < 1 ? 'just now'
    : mins < 60 ? `${mins} min ago`
    : mins < 1440 ? `${Math.round(mins / 60)} hr ago`
    : `${Math.round(mins / 1440)} days ago`
  el.innerHTML = `
    <span class="stock-dot ${stale ? 'stale' : 'fresh'}"></span>
    <span>Stock updated ${esc(ago)}${stale ? ' · may be out of date' : ''}</span>
  `
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function runSearch(token, { force = false } = {}) {
  if (!ui) return
  const term = ui.query.trim()
  if (!term) { ui.rows = []; ui.error = null; ui.loading = false; renderResults(); return }

  // Every later response is only interesting if it is the latest one. A slow
  // request for "ren" must not land after a fast one for "renesa" and replace
  // the better answer with a staler one.
  const seq = ++ui.seq
  ui.loading = true
  ui.error = null
  renderResults()

  const words = term.toLowerCase().split(/\s+/).filter(Boolean)
  // Chained .or() calls are ANDed together by PostgREST, so this is "every
  // word appears, in the name or the code" — the same rule tokenMatch()
  // applies, pushed down to the server so 9,600 rows are not shipped to a
  // phone. tokenMatch then re-checks the result below, because the server
  // tests name and alias separately while tokenMatch tests them joined: a
  // search for "renesa 1200" where "renesa" is in the name and "1200" only
  // in the code passes both, but one for a word split across the two fields
  // should not sneak through on a substring.
  let q = supabaseBusy.from('items')
    .select('code, name, alias, mrp, sale_rate, stock_qty, stock_source')
  for (const w of words) {
    const safe = w.replace(/[%,()]/g, '')
    if (!safe) continue
    q = q.or(`name.ilike.%${safe}%,alias.ilike.%${safe}%`)
  }
  // "Available stock": strictly more than none. gt() also drops rows with no
  // figure at all, because in SQL NULL > 0 is not true — which is the wanted
  // answer here, since an item Busy could not place is not stock anyone can
  // sell. Negatives go for the same reason.
  if (ui.inStockOnly) q = q.gt('stock_qty', 0)
  const { data, error } = await q.limit(LIMIT)

  if (token !== mountToken || !ui || seq !== ui.seq) return
  if (error) { ui.loading = false; ui.error = error.message; renderResults(); return }

  // item_velocity was fetched here to derive a low-stock threshold. With the
  // threshold gone, so is the second round trip — a search is one query again.
  ui.rows = (data || []).filter(r => tokenMatch(`${r.name || ''} ${r.alias || ''}`, term))
  ui.loading = false
  renderResults()
}

// ---------------------------------------------------------------------------
// The stock box
// ---------------------------------------------------------------------------
// Two states, because Busy only supports two. There is no reorder_level column
// anywhere in the data — reorder_settings holds target_weeks_cover and
// min_order_qty for 25 of 9,610 items, and neither is a level — so a "low"
// band could only ever have been invented here, and an invented threshold on a
// stock screen is worse than no threshold at all.
//
// Negative is shown as the real figure, in red, never flattened to nil: it
// means Busy's running balance for this godown has gone below nothing (loose
// wire, mostly, where the drum is received under one code and issued under
// another) and hiding it would hide a real problem.
function stockState(row) {
  const qty = Number(row.stock_qty)
  if (!Number.isFinite(qty)) return { kind: 'unknown', label: 'Not known', value: '—' }
  if (qty < 0) return { kind: 'negative', label: 'Negative', value: qty.toLocaleString('en-IN') }
  if (qty === 0) return { kind: 'nil', label: 'Nil', value: '0' }
  return { kind: 'in', label: 'In stock', value: qty.toLocaleString('en-IN') }
}

// Busy gives an item two identifiers and staff use both: the alias is what is
// written on the rack and said out loud ("FG0853"), the code is the numeric
// key Busy itself keys on and what the sync logs report ("63673"). Showing
// only the alias meant anything raised against a code — a sync log line, a
// question from the office — had to be translated by hand, so both are shown.
//
// The code is labelled and the alias is not, because the alias is the one
// being recognised on sight; an unlabelled number next to it would just be
// one more thing to tell apart. Items with no alias, and the odd item whose
// alias Busy has set to the code itself, would otherwise read "63673 · Code
// 63673" — they show the labelled code alone.
function codeLine(row) {
  const code = row.code === null || row.code === undefined ? '' : String(row.code).trim()
  const alias = (row.alias || '').trim()
  const labelled = code ? `Code ${code}` : ''
  if (!alias || alias === code) return labelled || alias
  return labelled ? `${alias} · ${labelled}` : alias
}

function money(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return null
  return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

function renderResults() {
  const el = document.getElementById('stockResults')
  if (!el || !ui) return

  if (ui.error) {
    el.innerHTML = `<div class="stock-empty">Could not reach the stock data.<br><span class="stock-empty-sub">${esc(ui.error)}</span></div>`
    return
  }
  if (ui.loading) {
    el.innerHTML = Array.from({ length: 4 }, () => '<div class="stock-card stock-skeleton"></div>').join('')
    return
  }
  if (!ui.query.trim()) {
    el.innerHTML = `<div class="stock-empty">Search for an item by name or code.<br><span class="stock-empty-sub">Every word has to match, in any order.</span></div>`
    return
  }
  if (!ui.rows.length) {
    // With the filter on, "no items match" would be the wrong thing to say —
    // there may be plenty of matches and simply none of them in stock. Naming
    // the filter is what tells the two apart.
    el.innerHTML = ui.inStockOnly
      ? `<div class="stock-empty">Nothing in stock matches “${esc(ui.query.trim())}”.<br><span class="stock-empty-sub">Turn off Available stock to see out-of-stock items too.</span></div>`
      : `<div class="stock-empty">No items match “${esc(ui.query.trim())}”.</div>`
    return
  }

  el.innerHTML = ui.rows.map(row => {
    const st = stockState(row)
    const mrp = money(row.mrp)
    const sale = money(row.sale_rate)
    return `
      <article class="stock-card">
        <div class="stock-card-main">
          <div class="stock-name">${esc(row.name || 'Unnamed item')}</div>
          <div class="stock-code">${esc(codeLine(row))}</div>
          <div class="stock-prices">
            ${mrp ? `<span class="stock-price"><span class="stock-price-label">MRP</span>${esc(mrp)}</span>` : ''}
            ${sale ? `<span class="stock-price stock-price-sale"><span class="stock-price-label">Sale</span>${esc(sale)}</span>` : ''}
            ${!mrp && !sale ? '<span class="stock-price stock-price-none">No rate set</span>' : ''}
          </div>
        </div>
        <div class="stock-box stock-box-${st.kind}">
          <span class="stock-box-qty">${esc(st.value)}</span>
          <span class="stock-box-label">${esc(st.label)}</span>
        </div>
      </article>
    `
  }).join('')
}
