// Signify Cash Discount — the discount Signify owes JCM under its Cash Discount scheme
// (circular CD-CIRC-001, from 1 Aug 2026): invoice paid within 0–5 days → 1.5%,
// 6–10 days → 1.0%, later → nothing; payments go to the oldest open invoice first (FIFO)
// and only a fully cleared invoice earns the discount, on its GST-inclusive value.
//
// Pick a date range and the Signify accounts → one line per invoice: date, account, invoice
// no., amount, the payment that cleared it, days, CD % and CD amount, with totals — and
// "Download Excel" to send Signify the month's claim.
//
// Data: cd_ledger / cd_accounts / cd_settings (JCM-Busysql project), copied every 30 min from
// Busy by busy-sync/sync-cd-ledger.js on JCM-Server. Closed to the browser; everything goes
// through /api/purchases (actions cd-*, api/_cash-discount.js), admins only.
import * as XLSX from 'xlsx'
import { openSidebar } from './sidebar.js'
import { canSee } from './permissions.js'
import { esc } from './utils.js'
import { icon } from './icons.js'
import { hqAlert, hqConfirm } from './hq-dialog.js'
import { callPurchases as call } from './purchases.js'
import './cash-discount.css'

const TAB_ID = 'cash-discount'

// ---------- formatting ----------
const IST_MS = 5.5 * 3600 * 1000
const todayIST = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10)
function fmtDate(s) {
  if (!s) return ''
  const d = new Date(String(s).length === 10 ? `${s}T00:00:00+05:30` : s)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}
function fmtWhen(s) {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
}
function ago(s) {
  if (!s) return 'never'
  const mins = Math.round((Date.now() - new Date(s).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const h = Math.round(mins / 60)
  return h < 48 ? `${h} hr ago` : fmtDate(s)
}
const money = n => {
  const v = Math.round(Number(n || 0) * 100) / 100
  return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
const pct = p => `${Number(p || 0)}%`
const monthRange = (offset) => { // offset 0 = this month, -1 = last month (IST)
  const t = new Date(Date.now() + IST_MS)
  const y = t.getUTCFullYear(), m = t.getUTCMonth() + offset
  const first = new Date(Date.UTC(y, m, 1)), last = new Date(Date.UTC(y, m + 1, 0))
  return [first.toISOString().slice(0, 10), last.toISOString().slice(0, 10)]
}
const monthName = (from) => new Date(`${from}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })

// ---------- page ----------
export async function renderCashDiscount(container) {
  if (!canSee(TAB_ID)) {
    container.innerHTML = '<div class="empty-state">You do not have access to this page.</div>'
    setTimeout(() => { window.location.hash = '' }, 1500)
    return
  }
  const [lmFrom, lmTo] = monthRange(-1)
  const state = { range: 'lastmonth', from: lmFrom, to: lmTo, codes: null, data: null, loading: false, seq: 0, drawer: null }

  container.innerHTML = `
    <div class="app-layout pur-page cd-page">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="cdHamburgerBtn" aria-label="Menu">☰</button>
          <span class="logo-small pur-title">${icon('percent', 18)} Signify Cash Discount</span>
        </div>
        <div class="pur-header-actions">
          <button class="btn-ghost btn-small" id="cdExcelBtn">${icon('file', 14)} Download Excel</button>
          <button class="btn-ghost btn-small" id="cdSettingsBtn">${icon('pencil', 14)} Settings</button>
          <button class="btn-ghost btn-small" id="cdRefreshBtn">${icon('refresh', 14)} Refresh</button>
        </div>
      </header>
      <main class="app-main">
        <div class="pur-toolbar">
          <div class="pur-chips" id="cdChips">
            <button class="pur-chip" data-range="lastmonth">Last month</button>
            <button class="pur-chip" data-range="thismonth">This month</button>
            <button class="pur-chip" data-range="scheme">Since the scheme began</button>
          </div>
          <label class="pur-date"><span>Invoices from</span><input type="date" id="cdFrom" min="2026-04-01" /></label>
          <label class="pur-date"><span>to</span><input type="date" id="cdTo" min="2026-04-01" /></label>
          <button class="btn-ghost btn-small cd-accbtn" id="cdAccountsBtn">${icon('building', 14)} <span id="cdAccountsLabel">Accounts</span></button>
          <div class="pur-chips" id="cdModeChips" title="How each payment is matched to bills">
            <button class="pur-chip" data-mode="amount">Our way — payment matched to its bills</button>
            <button class="pur-chip" data-mode="fifo">Signify's rule — oldest bill first</button>
          </div>
          <label class="cd-notes-switch" title="Signify's credit notes (and debit notes / returns) clear the oldest bills in the FIFO, the way Signify applies them on its side. Off = only bank payments clear bills."><input type="checkbox" id="cdNotesSwitch" /> <span>Credit notes clear bills too</span></label>
        </div>
        <div class="pur-tiles cd-tiles" id="cdTiles"></div>
        <section class="cd-send" id="cdSend" hidden>
          <div class="cd-send-head">
            <div>
              <h3>${icon('send', 16)} Send this claim to Signify</h3>
              <p class="pur-hint">Check the lines below first. The email goes with the Excel attached and a summary in the body, signed as set in Settings. A copy always goes to <b id="cdCc"></b>.</p>
            </div>
            <button class="btn-primary cd-send-btn" id="cdSendBtn">${icon('send', 15)} Send email</button>
          </div>
          <div class="cd-send-body">
            <div class="cd-emails-wrap">
              <div class="cd-emails-label">Goes to</div>
              <div class="cd-emails" id="cdEmails"></div>
              <div class="cd-addrow"><input type="email" id="cdNewEmail" placeholder="add an email address, e.g. finance@signify.com" /><button class="btn-ghost btn-small" id="cdAddEmail">${icon('plus', 13)} Add</button></div>
            </div>
            <label class="cd-msg">Add a line to the mail (optional)<textarea id="cdMessage" rows="2" placeholder="e.g. Invoice 1234 paid on 5 Sept by NEFT, credited same day — please check."></textarea></label>
            <div class="cd-lastsent" id="cdLastSent"></div>
          </div>
        </section>
        <div class="pur-listbar">
          <span class="pur-sync" id="cdSync"></span>
          <span class="cd-note">Days = Busy payment date − invoice date. Signify counts the day the money reached <em>its</em> bank.</span>
        </div>
        <div id="cdList"></div>
      </main>
      <div class="pur-drawer-backdrop" id="cdDrawerBackdrop" hidden></div>
      <aside class="pur-drawer" id="cdDrawer" hidden>
        <div class="pur-drawer-head"><h3 id="cdDrawerTitle" style="margin:0"></h3><button class="btn-ghost btn-small" id="cdDrawerClose">Close</button></div>
        <div id="cdDrawerBody"></div>
      </aside>
    </div>`

  const $ = id => container.querySelector(`#${id}`)
  $('cdHamburgerBtn').addEventListener('click', openSidebar)
  $('cdRefreshBtn').addEventListener('click', () => load())
  $('cdExcelBtn').addEventListener('click', downloadExcel)
  $('cdSettingsBtn').addEventListener('click', () => openDrawer('settings'))
  $('cdAccountsBtn').addEventListener('click', () => openDrawer('accounts'))
  $('cdDrawerClose').addEventListener('click', closeDrawer)
  $('cdDrawerBackdrop').addEventListener('click', closeDrawer)
  $('cdChips').addEventListener('click', e => { const b = e.target.closest('[data-range]'); if (b) setRange(b.dataset.range) })
  $('cdFrom').addEventListener('change', () => { state.range = null; state.from = $('cdFrom').value; load() })
  $('cdTo').addEventListener('change', () => { state.range = null; state.to = $('cdTo').value; load() })
  $('cdAddEmail').addEventListener('click', addEmail)
  $('cdNewEmail').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addEmail() } })
  $('cdEmails').addEventListener('click', e => { const b = e.target.closest('[data-remove]'); if (b) saveEmails(state.data.settings.email_to.filter(x => x !== b.dataset.remove)) })
  $('cdSendBtn').addEventListener('click', sendClaim)
  $('cdModeChips').addEventListener('click', async e => {
    const b = e.target.closest('[data-mode]'); if (!b) return
    try { await call({ action: 'cd-settings-save', match_mode: b.dataset.mode }); load() } catch (err) { hqAlert(err.message) }
  })
  $('cdNotesSwitch').addEventListener('change', async () => {
    try { await call({ action: 'cd-settings-save', count_notes: $('cdNotesSwitch').checked }); load() } catch (err) { hqAlert(err.message) }
  })

  // ---------- email ----------
  async function addEmail() {
    const v = $('cdNewEmail').value.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { hqAlert('That does not look like an email address.'); return }
    await saveEmails([...(state.data.settings.email_to || []), v])
    $('cdNewEmail').value = ''
  }
  async function saveEmails(list) {
    try {
      const r = await call({ action: 'cd-emails-save', email_to: list })
      state.data.settings.email_to = r.email_to
      paintSend()
    } catch (err) { hqAlert(err.message) }
  }
  async function paintSend() {
    const d = state.data, s = d.settings
    $('cdSend').hidden = false
    $('cdCc').textContent = s.email_cc || 'jc.mittal@hotmail.com'
    const list = s.email_to || []
    $('cdEmails').innerHTML = list.length
      ? list.map(e => `<span class="cd-email">${esc(e)}<button class="cd-email-x" data-remove="${esc(e)}" title="Remove">${icon('x', 12)}</button></span>`).join('')
      : '<span class="cd-noemail">No email address yet — add the Signify finance address below.</span>'
    $('cdSendBtn').disabled = !list.length || !d.totals.invoices
    if (!d.email?.ready) $('cdLastSent').innerHTML = `<span class="pur-flag pur-flag-bad">Email is not set up in Vercel yet (RESEND_API_KEY) — the button will not send until it is.</span>`
    try {
      const log = await call({ action: 'cd-email-log' })
      const last = log.rows?.[0]
      if (last) {
        const ok = last.status === 'sent'
        $('cdLastSent').innerHTML = `<span class="pur-flag pur-flag-${ok ? 'ok' : 'bad'}">${ok ? 'Last sent' : 'Last attempt failed'}</span> ${esc(fmtWhen(last.sent_at))}${last.sent_by ? ` by ${esc(last.sent_by)}` : ''} — ${esc(fmtDate(last.from_date))} to ${esc(fmtDate(last.to_date))}, ${money(last.total_cd)} on ${last.invoices} invoices, to ${esc((last.to_emails || []).join(', '))}${ok ? '' : ` · ${esc(last.detail || '')}`}`
      } else if (d.email?.ready) $('cdLastSent').textContent = 'Not sent to Signify yet.'
    } catch { /* log is optional */ }
  }
  async function sendClaim() {
    const d = state.data, s = d.settings
    const ok = await hqConfirm(`Send the Cash Discount claim for ${fmtDate(d.from)} – ${fmtDate(d.to)} (${money(d.totals.cd)} on ${d.totals.invoices} invoices) to ${(s.email_to || []).join(', ')} with a copy to ${s.email_cc}?`, { okText: 'Send email' })
    if (!ok) return
    $('cdSendBtn').disabled = true; $('cdSendBtn').textContent = 'Sending…'
    try {
      const r = await call({ action: 'cd-send', from: state.from, to: state.to, codes: state.codes, message: $('cdMessage').value })
      hqAlert(`Sent to ${r.to.join(', ')} (copy to ${r.cc.join(', ')}).`)
      $('cdMessage').value = ''
    } catch (err) { hqAlert(err.message) }
    $('cdSendBtn').innerHTML = `${icon('send', 15)} Send email`
    paintSend()
  }

  function setRange(range) {
    state.range = range
    if (range === 'lastmonth') [state.from, state.to] = monthRange(-1)
    else if (range === 'thismonth') [state.from, state.to] = monthRange(0)
    else if (range === 'scheme') { state.from = state.data?.settings?.scheme_from || '2026-08-01'; state.to = todayIST() }
    load()
  }
  function paintFilters() {
    container.querySelectorAll('#cdChips .pur-chip').forEach(b => b.classList.toggle('active', b.dataset.range === state.range))
    $('cdFrom').value = state.from
    $('cdTo').value = state.to
    const d = state.data
    if (d) {
      $('cdNotesSwitch').checked = d.settings.count_notes === true
      container.querySelectorAll('#cdModeChips .pur-chip').forEach(b => b.classList.toggle('active', b.dataset.mode === (d.settings.match_mode || 'amount')))
      const total = d.accounts.length, chosen = d.result.length
      $('cdAccountsLabel').textContent = `${chosen} of ${total} account${total === 1 ? '' : 's'}`
    }
  }

  async function load() {
    const seq = ++state.seq
    paintFilters()
    $('cdList').innerHTML = '<div class="loading-state">Working out the discount…</div>'
    try {
      const data = await call({ action: 'cd-summary', from: state.from, to: state.to, codes: state.codes })
      if (seq !== state.seq) return
      state.data = data
      paintFilters(); paintTiles(); paintList(); paintSend()
    } catch (err) {
      if (seq !== state.seq) return
      $('cdList').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`
      $('cdTiles').innerHTML = ''
    }
  }

  function paintTiles() {
    const d = state.data, t = d.totals
    const tiles = [
      { value: String(t.invoices), label: 'Signify invoices' },
      { value: money(t.amount), label: 'Invoice total (incl. GST)' },
      { value: money(t.cd), label: 'Cash discount to claim', wide: true },
      { value: `${t.slab_a} · ${t.slab_b} · ${t.none}`, label: 'Slab A · Slab B · paid late' },
      { value: String(t.unpaid), label: 'Not fully paid yet' },
    ]
    $('cdTiles').innerHTML = tiles.map(x => `<div class="pur-tile${x.wide ? ' is-value' : ''}"><div class="pur-tile-value">${esc(x.value)}</div><div class="pur-tile-label">${esc(x.label)}</div></div>`).join('')
    $('cdSync').innerHTML = d.lastSyncAt
      ? `${icon('clock', 13)} Signify ledger copied from Busy ${esc(ago(d.lastSyncAt))} (${esc(fmtWhen(d.lastSyncAt))}) · every 30 min`
      : `${icon('clock', 13)} <b>The Signify ledger has not been copied from Busy yet</b> — start sync-cd-ledger.js on JCM-Server (busy-sync/README-cd-ledger.md).`
  }

  function statusTone(r) {
    if (r.slab === 'A') return 'ok'
    if (r.slab === 'B') return 'b'
    if (!r.settled && r.kind === 'purchase' && r.date >= (state.data.settings.scheme_from || '')) return 'quiet'
    return 'bad'
  }

  function paintList() {
    const d = state.data
    if (!d.result.length) { $('cdList').innerHTML = '<div class="empty-state">No Signify account chosen. Open "Accounts" and tick the ones you want.</div>'; return }
    const parts = []
    for (const pool of d.pools) {
      // Only accounts with invoices in the chosen dates; a pool with none is skipped altogether.
      const members = d.result.filter(a => a.pool === pool.id && a.rows.length)
      if (!members.length) continue
      const multi = pool.members.length > 1
      const hubOpen = pool.openings.find(o => o.code === pool.hub_code)
      const openingWhy = `${money(Math.abs(pool.opening))} ${pool.opening < 0 ? 'advance' : 'payable'} on ${esc(fmtDate(pool.opening_date))} (Busy ledger: 31 Mar ${hubOpen?.source === 'typed' ? 'typed ' : hubOpen?.source === 'none' ? '₹0 — nothing found; ' : ''}${money(hubOpen?.opening || 0)} + entries up to the scheme start)`
      parts.push(`
        <div class="cd-pool">
          <div class="cd-pool-head">
            <div>
              <div class="cd-pool-title">${multi ? `Paid through <strong>${esc(pool.hub_name)}</strong> — ${members.length} of ${pool.members.length} accounts had bills this period` : `<strong>${esc(pool.hub_name)}</strong> — paid on its own account`}</div>
              <div class="pur-bill-meta">${multi ? 'Bills of these accounts are moved into the paying account by journal in Busy, so FIFO runs on all of them as one. ' : ''}Opening: ${openingWhy} · balance now ${money(Math.abs(pool.totals.closing))} ${pool.totals.closing < 0 ? 'advance with Signify' : 'payable'} · ${pool.open_bills} bill${pool.open_bills === 1 ? '' : 's'} still open (${money(pool.open_amount)})${pool.ignored.length ? ` · ${pool.ignored.length} credit note${pool.ignored.length === 1 ? '' : 's'} / return${pool.ignored.length === 1 ? '' : 's'} not counted (switch above)` : ''}${pool.advances?.length ? ` · <b>advance not yet matched to a bill: ${esc(pool.advances.map(a => `${a.no || 'payment'} ${fmtDate(a.date)} ${money(a.remaining)}`).join(', '))}</b>` : ''}${pool.unmatched?.length ? ` · <b>${pool.unmatched.length} amount${pool.unmatched.length === 1 ? '' : 's'} moved in that match no bill</b> (${esc(pool.unmatched.map(u => money(u.amount)).join(', '))})` : ''}</div>
            </div>
            <div class="pur-bill-side"><div class="pur-amount">${money(pool.cd)}</div><small class="cd-sub">CD on ${pool.invoices} invoice${pool.invoices === 1 ? '' : 's'}</small></div>
          </div>
          ${members.map(a => accountCard(a, multi)).join('')}
        </div>`)
    }
    if (!parts.length) { $('cdList').innerHTML = `<div class="empty-state">No Signify invoices between ${esc(fmtDate(d.from))} and ${esc(fmtDate(d.to))} on the chosen accounts.</div>`; return }
    const t = d.totals
    parts.push(`
      <section class="pur-bill cd-grand">
        <div class="pur-bill-head"><div class="pur-bill-main"><div class="pur-party">All accounts — ${esc(fmtDate(d.from))} to ${esc(fmtDate(d.to))}</div>
        <div class="pur-bill-meta">${t.invoices} invoices · ${money(t.amount)} · Slab A ${t.slab_a} (${money(t.slab_a_cd)}) · Slab B ${t.slab_b} (${money(t.slab_b_cd)}) · paid late ${t.none} · not fully paid ${t.unpaid}</div></div>
        <div class="pur-bill-side"><div class="pur-amount cd-grand-amt">${money(t.cd)}</div><small class="cd-sub">total cash discount</small></div></div>
      </section>`)
    $('cdList').innerHTML = `<div class="pur-list">${parts.join('')}</div>`
  }

  function accountCard(a, pooled) {
    const d = state.data
    const rows = a.rows
    const purchases = rows.filter(r => r.kind === 'purchase')
    const subAmt = purchases.reduce((s, r) => s + r.amount, 0), subCd = rows.reduce((s, r) => s + r.cd, 0)
    const body = rows.length ? rows.map(r => `
      <tr class="cd-row cd-${statusTone(r)}">
        <td>${esc(fmtDate(r.date))}${r.moved_on && r.moved_on !== r.date ? `<br><small title="Moved to the paying account on this day">moved ${esc(fmtDate(r.moved_on))}</small>` : ''}</td>
        <td>${esc(r.vch_no || '—')}${r.kind !== 'purchase' ? ` <small>${esc(r.type_name || '')}</small>` : ''}</td>
        <td class="pur-r">${money(r.amount)}</td>
        <td>${r.pay_date ? esc(fmtDate(r.pay_date)) : '<span class="cd-dash">—</span>'}</td>
        <td>${r.pay_no ? esc(r.pay_no) : ''}${r.pay_kind === 'note' ? ' <small>note</small>' : ''}${r.pay_exact ? ' <small title="This payment was made for exactly this bill (or this bill with others)">exact</small>' : ''}${r.pay_account ? ` <small title="Paid from this account">via ${esc(r.pay_account.replace(/^Signify Innovations? India(?: Ltd)?\s*/i, ''))}</small>` : ''}${r.parts > 1 ? ` <small title="This invoice was cleared by ${r.parts} payments; the last one decides the days">${r.parts} parts</small>` : ''}</td>
        <td class="pur-r">${r.pay_amount != null ? money(r.pay_amount) : ''}</td>
        <td class="pur-r">${r.days != null ? r.days : ''}</td>
        <td class="pur-r">${r.pct ? pct(r.pct) : '0%'}</td>
        <td class="pur-r cd-cd">${r.cd ? money(r.cd) : '—'}</td>
        <td><span class="pur-flag pur-flag-${statusTone(r)}">${esc(r.status)}</span></td>
      </tr>`).join('') : `<tr><td colspan="10" class="pur-noitems">No Signify invoices on this account between ${esc(fmtDate(d.from))} and ${esc(fmtDate(d.to))}.</td></tr>`
    return `
      <section class="pur-bill cd-account${pooled ? ' is-pooled' : ''}">
        <div class="pur-bill-head cd-acchead">
          <div class="pur-bill-main">
            <div class="pur-party">${esc(a.party_name)} <small class="cd-code">Busy ${esc(a.party_code)}</small></div>
            <div class="pur-bill-meta">${a.entries} entries this year${!pooled ? ` · opening 1 Apr ${a.opening_source === 'typed' ? 'typed ' : a.opening_source === 'busy' ? 'Busy 31 Mar ' : ''}${money(a.opening)}` : ''}</div>
          </div>
          <div class="pur-bill-side"><div class="pur-amount">${money(subCd)}</div><small class="cd-sub">CD on ${purchases.length} invoice${purchases.length === 1 ? '' : 's'}</small></div>
        </div>
        <div class="pur-items">
          <table class="pur-table cd-table">
            <thead><tr><th>Date</th><th>Invoice no.</th><th class="pur-r">Amount</th><th>Payment date</th><th>Payment no.</th><th class="pur-r">Payment amount</th><th class="pur-r">Days</th><th class="pur-r">CD %</th><th class="pur-r">CD amount</th><th>Status</th></tr></thead>
            <tbody>${body}</tbody>
            <tfoot><tr class="pur-total"><td></td><td>Total — ${esc(a.party_name)}</td><td class="pur-r">${money(subAmt)}</td><td colspan="5"></td><td class="pur-r">${money(subCd)}</td><td></td></tr></tfoot>
          </table>
        </div>
      </section>`
  }

  // ---------- Excel ----------
  function downloadExcel() {
    const d = state.data
    if (!d) return
    const wb = XLSX.utils.book_new()
    const title = `Signify Cash Discount claim — ${d.from === monthRange(-1)[0] && d.to === monthRange(-1)[1] ? monthName(d.from) : `${fmtDate(d.from)} to ${fmtDate(d.to)}`}`
    const lines = []
    for (const a of d.result.filter(x => x.rows.length)) {
      for (const r of a.rows) lines.push({ Account: a.party_name, 'Invoice date': fmtDate(r.date), 'Invoice no.': r.vch_no || '', 'Invoice amount (incl. GST)': r.amount, 'Payment date': r.pay_date ? fmtDate(r.pay_date) : '', 'Payment no.': r.pay_no || '', 'Payment amount': r.pay_amount ?? '', 'Paid from': r.pay_account || '', Days: r.days ?? '', 'CD %': r.pct, 'CD amount': r.cd, Status: r.status })
      const purchases = a.rows.filter(r => r.kind === 'purchase')
      lines.push({ Account: `Total — ${a.party_name}`, 'Invoice date': '', 'Invoice no.': `${purchases.length} invoices`, 'Invoice amount (incl. GST)': Math.round(purchases.reduce((s, r) => s + r.amount, 0) * 100) / 100, 'Payment date': '', 'Payment no.': '', 'Payment amount': '', Days: '', 'CD %': '', 'CD amount': Math.round(a.rows.reduce((s, r) => s + r.cd, 0) * 100) / 100, Status: '' })
      lines.push({})
    }
    const t = d.totals
    lines.push({ Account: 'GRAND TOTAL', 'Invoice date': '', 'Invoice no.': `${t.invoices} invoices`, 'Invoice amount (incl. GST)': t.amount, 'Payment date': '', 'Payment no.': '', 'Payment amount': '', Days: '', 'CD %': '', 'CD amount': t.cd, Status: `Slab A ${t.slab_a} · Slab B ${t.slab_b} · late ${t.none} · unpaid ${t.unpaid}` })
    const ws = XLSX.utils.json_to_sheet([])
    XLSX.utils.sheet_add_aoa(ws, [[title], [`J.C. Mittal & Sons, Ratlam — as per Signify circular CD-CIRC-001 (Slab A 0–5 days 1.5%, Slab B 6–10 days 1.0%, FIFO, GST-inclusive; credit notes ${d.settings.count_notes ? 'clear bills' : 'not counted'})`], [`Figures from Busy as of ${d.lastSyncAt ? fmtWhen(d.lastSyncAt) : '—'}`], []], { origin: 'A1' })
    XLSX.utils.sheet_add_json(ws, lines, { origin: 'A5' })
    ws['!cols'] = [{ wch: 44 }, { wch: 13 }, { wch: 20 }, { wch: 22 }, { wch: 13 }, { wch: 20 }, { wch: 16 }, { wch: 30 }, { wch: 6 }, { wch: 6 }, { wch: 14 }, { wch: 34 }]
    XLSX.utils.book_append_sheet(wb, ws, 'CD claim')
    const summary = d.result.filter(x => x.rows.length).map(a => ({ Account: a.party_name, 'Busy code': a.party_code, Invoices: a.rows.filter(r => r.kind === 'purchase').length, 'Invoice total': Math.round(a.rows.filter(r => r.kind === 'purchase').reduce((s, r) => s + r.amount, 0) * 100) / 100, 'CD amount': Math.round(a.rows.reduce((s, r) => s + r.cd, 0) * 100) / 100, 'Paid through': d.pools.find(p => p.id === a.pool)?.hub_name || '' }))
    const ws2 = XLSX.utils.json_to_sheet(summary)
    ws2['!cols'] = [{ wch: 44 }, { wch: 10 }, { wch: 9 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }]
    XLSX.utils.book_append_sheet(wb, ws2, 'Summary')
    XLSX.writeFile(wb, `Signify_CD_${d.from}_to_${d.to}.xlsx`)
  }

  // ---------- drawers ----------
  function closeDrawer() { state.drawer = null; $('cdDrawer').hidden = true; $('cdDrawerBackdrop').hidden = true }
  function openDrawer(kind) {
    if (!state.data) return
    state.drawer = kind
    $('cdDrawer').hidden = false; $('cdDrawerBackdrop').hidden = false
    $('cdDrawerTitle').textContent = kind === 'settings' ? 'Settings' : 'Signify accounts'
    if (kind === 'settings') paintSettings(); else paintAccounts()
  }

  function paintAccounts() {
    const d = state.data
    const chosen = new Set(d.result.map(a => a.party_code))
    const entries = new Map(d.result.map(a => [a.party_code, a]))
    $('cdDrawerBody').innerHTML = `
      <p class="pur-hint">Every Busy account with "${esc(d.settings.name_match)}" in its name and not "${esc(d.settings.name_exclude)}". Untick an account to leave it out of the claim. ${d.accounts.length} found.</p>
      <div class="cd-accrow"><button class="pur-link" id="cdTickAll">Tick all</button><button class="pur-link" id="cdUntickAll">Untick all</button></div>
      <div class="pur-people">
        ${d.accounts.map(a => `
          <label class="pur-person cd-person">
            <span><strong>${esc(a.party_name)}</strong><br><small>Busy ${esc(a.party_code)}${entries.has(a.party_code) ? ` · ${entries.get(a.party_code).entries} entries this year` : ''}${a.included === false ? ' · <b>left out</b>' : ''}</small></span>
            <input type="checkbox" data-code="${esc(a.party_code)}" ${chosen.has(a.party_code) ? 'checked' : ''} />
          </label>`).join('') || '<p class="pur-hint">No accounts yet — they appear once the Signify ledger is copied from Busy.</p>'}
      </div>
      <p class="pur-hint" style="margin-top:10px">Ticks here only change what is shown now. To leave an account out permanently, untick it in Settings.</p>
      <button class="btn-primary btn-small" id="cdApplyAccounts" style="margin-top:8px">Show these accounts</button>`
    $('cdTickAll').addEventListener('click', () => $('cdDrawerBody').querySelectorAll('input[data-code]').forEach(i => { i.checked = true }))
    $('cdUntickAll').addEventListener('click', () => $('cdDrawerBody').querySelectorAll('input[data-code]').forEach(i => { i.checked = false }))
    $('cdApplyAccounts').addEventListener('click', () => {
      state.codes = [...$('cdDrawerBody').querySelectorAll('input[data-code]:checked')].map(i => i.dataset.code)
      closeDrawer(); load()
    })
  }

  function paintSettings() {
    const d = state.data, s = d.settings
    $('cdDrawerBody').innerHTML = `
      <h4 class="pur-drawer-sub">Scheme</h4>
      <div class="cd-grid">
        <label>Scheme starts (invoices from)<input type="date" id="cdSchemeFrom" value="${esc(s.scheme_from || '')}" /></label>
        <label>Slab A — paid within (days)<input type="number" id="cdADays" value="${esc(String(s.slab_a_days ?? 5))}" min="0" /></label>
        <label>Slab A — discount %<input type="number" id="cdAPct" value="${esc(String(s.slab_a_pct ?? 1.5))}" step="0.01" min="0" /></label>
        <label>Slab B — paid within (days)<input type="number" id="cdBDays" value="${esc(String(s.slab_b_days ?? 10))}" min="0" /></label>
        <label>Slab B — discount %<input type="number" id="cdBPct" value="${esc(String(s.slab_b_pct ?? 1.0))}" step="0.01" min="0" /></label>
      </div>
      <label class="pur-switch"><input type="checkbox" id="cdCountNotes" ${s.count_notes ? 'checked' : ''}/> <span><strong>Count debit notes as payments</strong><br><small>Returns and Signify's own credit entries then clear old invoices in the FIFO, the way Signify does on its side. Off = only payment vouchers clear invoices.</small></span></label>
      <h4 class="pur-drawer-sub">How payments are matched</h4>
      <p class="pur-hint">"Our way" (toolbar) matches each NEFT to the bills it was made for — the amount is the proof — and only falls back to oldest-first when no exact set of bills fits. "Signify's rule" is strict FIFO. Credit notes and returns are only counted when the switch is on.</p>
      <label class="pur-switch"><input type="radio" name="cdMode" value="auto" ${(s.fifo_mode || 'auto') !== 'per_account' ? 'checked' : ''}/> <span><strong>Accounts paid together, as one</strong><br><small>Bills moved by journal into another Signify account (TR / MP) and paid from there are matched across all those accounts in date order. Recommended — this is how the books are kept.</small></span></label>
      <label class="pur-switch"><input type="radio" name="cdMode" value="per_account" ${s.fifo_mode === 'per_account' ? 'checked' : ''}/> <span><strong>Each account on its own</strong><br><small>Only that account's own payments clear its bills.</small></span></label>
      <h4 class="pur-drawer-sub">Which accounts</h4>
      <div class="cd-grid">
        <label>Name has (words, comma-separated)<input type="text" id="cdMatch" value="${esc(s.name_match || '')}" /></label>
        <label>but not<input type="text" id="cdExclude" value="${esc(s.name_exclude || '')}" /></label>
      </div>
      <p class="pur-hint">The account list is refreshed at the next Busy copy (every 30 min).</p>
      <h4 class="pur-drawer-sub">Email signature</h4>
      <textarea id="cdSignature" rows="2" class="cd-sig">${esc(s.email_signature || 'Partner\nDilip Mittal')}</textarea>
      <p class="pur-hint">Every claim email is copied to ${esc(s.email_cc || 'jc.mittal@hotmail.com')}.</p>
      <button class="btn-primary btn-small" id="cdSaveSettings">Save settings</button>
      <h4 class="pur-drawer-sub">Opening balance at 1 April</h4>
      <p class="pur-hint">Needed so payments clear last year's bills first. Taken from Busy's 31 March figure; type a figure (₹ we owed Signify, minus if Signify owed us) to override. Blank = Busy's figure.</p>
      <div class="cd-openings">
        ${d.accounts.map(a => {
          const r = d.result.find(x => x.party_code === a.party_code)
          return `<div class="cd-opening" data-code="${esc(a.party_code)}">
            <label class="cd-inc" title="Untick to leave this account out of the claim"><input type="checkbox" data-inc ${a.included !== false ? 'checked' : ''}/> <strong>${esc(a.party_name)}</strong></label>
            <small>${r ? (r.opening_source === 'busy' ? `Busy 31 Mar: ${money(r.opening)}` : r.opening_source === 'typed' ? `typed: ${money(r.opening)}` : 'nothing found in Busy (₹0)') : ''}</small>
            <div class="cd-openrow"><input type="number" step="0.01" data-open placeholder="override ₹" value="${a.opening_balance != null ? esc(String(a.opening_balance)) : ''}" /><input type="text" data-note placeholder="note" value="${esc(a.opening_note || '')}" /><button class="btn-ghost btn-small" data-save>Save</button></div>
          </div>`
        }).join('')}
      </div>`
    $('cdSaveSettings').addEventListener('click', async () => {
      try {
        await call({ action: 'cd-settings-save', scheme_from: $('cdSchemeFrom').value, slab_a_days: $('cdADays').value, slab_a_pct: $('cdAPct').value, slab_b_days: $('cdBDays').value, slab_b_pct: $('cdBPct').value, count_notes: $('cdCountNotes').checked, fifo_mode: $('cdDrawerBody').querySelector('input[name=cdMode]:checked')?.value, name_match: $('cdMatch').value, name_exclude: $('cdExclude').value, email_signature: $('cdSignature').value })
        closeDrawer(); load()
      } catch (err) { hqAlert(err.message) }
    })
    $('cdDrawerBody').querySelectorAll('.cd-opening').forEach(box => {
      box.querySelector('[data-save]').addEventListener('click', async () => {
        try {
          await call({ action: 'cd-account-save', party_code: box.dataset.code, included: box.querySelector('[data-inc]').checked, opening_balance: box.querySelector('[data-open]').value, opening_note: box.querySelector('[data-note]').value })
          box.querySelector('[data-save]').textContent = 'Saved'
          state.codes = null
          load()
        } catch (err) { hqAlert(err.message) }
      })
    })
  }

  await load()
}
