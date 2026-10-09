import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { useAdminSession, SignIn, serverError, NO_CONNECTION, HqHead } from './Admin.jsx'
import { formatElapsed, formatCreated, shortInv } from '../lib/board-logic.js'
import { shortDate, rupees } from '../lib/tablet-logic.js'
import '../admin.css'
import '../logs.css'

// /logs — "JCM Orders - Admin Logs.dc.html": Order log and Staff summary, admins only.
const PAGE = 12
const ROLE_COLOR = { Picker: '#2E7D5B', Supervisor: '#2F5FA3', Dispatch: '#12213B' }
const istDay = (offsetDays = 0) => new Date(Date.now() + 330 * 60000 + offsetDays * 86400000).toISOString().slice(0, 10)
const mins = m => (m === null || m === undefined ? '—' : formatElapsed(m * 60000))

export default function Logs() {
  const { session, signOut, onSignedIn } = useAdminSession()
  return (
    <div className="jo-admin lg">
      <HqHead title="Order Log" sub="Every order, who handled it, how long each stage took" />
      {session ? <LogsBody session={session} onExpired={signOut} /> : <main className="jo-main"><SignIn onSignedIn={onSignedIn} /></main>}
    </div>
  )
}

function LogsBody({ session, onExpired }) {
  const [tab, setTab] = useState('orders')
  const [from, setFrom] = useState(istDay(-6))
  const [to, setTo] = useState(istDay(0))
  const [staff, setStaff] = useState('')
  const [customer, setCustomer] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const qs = new URLSearchParams({ from, to, ...(staff ? { staff } : {}), ...(customer.trim() ? { customer: customer.trim() } : {}) })
      const r = await api(`/api/admin/logs?${qs}`, { admin: session.token })
      if (r.status === 401) { onExpired(); return }
      if (r.ok) { setData(r.data); setPage(0) } else setError(serverError(r))
    } catch { setError(NO_CONNECTION) }
    setLoading(false)
  }, [from, to, staff, customer, session.token, onExpired])
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [load])

  // Staff names for the filter: everyone seen in this range (kept while filtering by one person).
  const [knownStaff, setKnownStaff] = useState([])
  useEffect(() => {
    if (!data) return
    setKnownStaff(prev => {
      const map = new Map(prev.map(s => [s.id, s]))
      for (const s of data.staffList) map.set(s.id, s)
      return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
    })
  }, [data])

  const exportExcel = async () => {
    if (!data) return
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const orders = data.rows.map(r => ({
        Customer: r.customer, City: r.city, 'SO date': r.soDate, 'SO no.': r.soNo, Invoice: r.invoiceNo,
        'Picked by': r.pickedBy, 'Checked by': r.checkedBy, 'Checked at': r.checkedAt ? formatCreated(r.checkedAt) : '',
        'Packed by': r.packedBy, 'Dispatched by': r.dispatchedBy, 'Dispatched at': r.dispatchedAt ? formatCreated(r.dispatchedAt) : '',
        'Unassigned (min)': r.times.unassigned, 'Picking (min)': r.times.picking, 'Checking (min)': r.times.checking, 'Ready (min)': r.times.ready,
        'Pick to dispatch (min)': r.pickToDispatch, Boxes: r.boxes, Labels: r.labels, 'LR photo': r.lrPhoto ? 'Yes' : '', 'Invoice value': r.value, 'Pending lines': r.pendingLines, 'Cleared lines': r.clearedLines || 0, 'Entered waiting via': r.waitingVia || '', Stage: r.stage,
      }))
      const people = data.summary.map(s => ({
        Person: s.name, Role: s.role, Orders: s.orders, 'Invoice value': s.value,
        'Avg own-stage time (min)': s.avgMinutes, 'Total own-stage time (min)': s.totalMinutes, 'Avg pick to dispatch (min)': s.avgPickToDispatch,
        Boxes: s.boxes, 'Top category': s.topCategory,
      }))
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(orders), 'Order log')
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(people), 'Staff summary')
      XLSX.writeFile(wb, `JCM-Orders-logs_${from}_to_${to}.xlsx`)
    } catch (e) {
      setError(`Could not make the Excel file: ${e.message}`)
    }
    setExporting(false)
  }

  // EXPORT CLEARED LINES: every pending line cleared in the portal between FROM and TO
  // (by the day it was cleared), to tidy the sales orders in Busy in one sitting.
  const [exportingCleared, setExportingCleared] = useState(false)
  const exportCleared = async () => {
    setExportingCleared(true); setError('')
    try {
      const r = await api(`/api/admin/logs?${new URLSearchParams({ cleared: '1', from, to })}`, { admin: session.token })
      if (r.status === 401) { onExpired(); return }
      if (!r.ok) { setError(serverError(r)); return }
      if (!r.data.rows.length) { setError(`No lines were cleared between ${shortDate(from)} and ${shortDate(to)}.`); return }
      const XLSX = await import('xlsx')
      const sheet = r.data.rows.map(x => ({
        Party: x.party, City: x.city, 'SO no.': x.soNo, 'SO date': x.soDate, Line: x.lineNo, Item: x.item,
        'Qty cleared': x.qty, Ordered: x.ordered, Invoiced: x.invoiced, 'Cleared by': x.clearedBy, 'Cleared on': formatCreated(x.clearedAt),
      }))
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet), 'Cleared lines')
      XLSX.writeFile(wb, `JCM-Orders-cleared-lines_${from}_to_${to}.xlsx`)
    } catch (e) {
      setError(`Could not make the Excel file: ${e.message || 'no connection'}`)
    } finally { setExportingCleared(false) }
  }

  // The LR photo taken at dispatch: a short-lived link from the server, shown over the page.
  const [photo, setPhoto] = useState(null) // { name, url?, error? }
  const openPhoto = async r => {
    setPhoto({ name: r.customer })
    try {
      const x = await api(`/api/admin/logs?photo=${encodeURIComponent(r.id)}`, { admin: session.token })
      if (x.status === 401) { onExpired(); return }
      setPhoto(x.ok ? { name: r.customer, url: x.data.url } : { name: r.customer, error: serverError(x) })
    } catch { setPhoto({ name: r.customer, error: NO_CONNECTION }) }
  }

  const rows = data?.rows || []
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE)
  const maxOrders = useMemo(() => Math.max(1, ...(data?.summary || []).map(s => s.orders)), [data])

  return (
    <div className="lg-frame">
      {photo && (
        <div className="lg-photo-back" onClick={() => setPhoto(null)}>
          <div className="lg-photo-box" onClick={e => e.stopPropagation()}>
            <div className="lg-photo-head"><span className="jo-strong">LR photo · {photo.name}</span><div className="jo-spacer" />
              {photo.url && <a className="jo-link" href={photo.url} target="_blank" rel="noreferrer">Open full size</a>}
              <button className="jo-link" onClick={() => setPhoto(null)}>Close</button></div>
            {photo.error ? <div className="jo-error">{photo.error}</div> : photo.url ? <img className="lg-photo" src={photo.url} alt={`LR photo for ${photo.name}`} /> : <p className="jo-p">Loading…</p>}
          </div>
        </div>
      )}
      <div className="lg-tabs">
        <button className={`lg-tab${tab === 'orders' ? ' lg-tab-on' : ''}`} onClick={() => setTab('orders')}>Order log</button>
        <button className={`lg-tab${tab === 'staff' ? ' lg-tab-on' : ''}`} onClick={() => setTab('staff')}>Staff summary</button>
      </div>
      <div className="lg-filters">
        <label className="jo-label">FROM<input id="lg-from" name="from" type="date" className="jo-input" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label>
        <label className="jo-label">TO<input id="lg-to" name="to" type="date" className="jo-input" value={to} min={from} onChange={e => setTo(e.target.value)} /></label>
        {tab === 'orders' && <>
          <label className="jo-label">STAFF
            <select id="lg-staff" name="staff" className="jo-input" value={staff} onChange={e => setStaff(e.target.value)}>
              <option value="">Everyone</option>
              {knownStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="jo-label">CUSTOMER<input id="lg-customer" name="customer" className="jo-input" placeholder="All customers" value={customer} onChange={e => setCustomer(e.target.value)} /></label>
        </>}
        <div className="jo-spacer" />
        {data && tab === 'orders' && <span className="lg-total">{data.totals.orders} {data.totals.orders === 1 ? 'order' : 'orders'} · {rupees(data.totals.value)}</span>}
        <button className={`jo-btn${tab === 'staff' ? ' jo-btn-outline' : ''}`} disabled={!data || exporting} onClick={exportExcel}>{exporting ? 'Preparing…' : 'Export to Excel'}</button>
        <button className="jo-btn jo-btn-outline" disabled={exportingCleared} onClick={exportCleared}
          title="Every pending line cleared in the portal between FROM and TO (by the day it was cleared)">{exportingCleared ? 'Preparing…' : 'Export cleared lines'}</button>
      </div>
      {error && <div className="lg-pad"><div className="jo-error">{error}</div></div>}
      {!data && !error && <div className="lg-pad"><p className="jo-p">{loading ? 'Loading…' : ''}</p></div>}

      {data && tab === 'orders' && (
        <div className="lg-pad">
          <div className="lg-table">
            <div className="lg-tr lg-th">
              <span>CUSTOMER</span><span>SO NO.</span><span>INVOICE</span><span>PICKED BY</span><span>CHECKED BY</span><span>DISPATCHED BY</span>
              <span className="lg-r" title="Time from SO created to someone tapping I'm picking this">UNASSIGNED</span><span className="lg-r">PICKING</span><span className="lg-r">CHECKING</span><span className="lg-r">READY</span>
              <span className="lg-r">BOXES</span><span className="lg-r">VALUE</span><span className="lg-r">PENDING</span>
              <span title="How the order entered waiting for material">WAITING VIA</span>
            </div>
            {shown.map(r => (
              <div className="lg-tr" key={r.id}>
                <div className="lg-two"><span className="jo-strong">{r.customer}</span><span className="lg-small">{[r.city, shortDate(r.soDate)].filter(Boolean).join(' · ')}</span></div>
                <span>{r.soNo.replace(/^SO\/\d{4}\//, 'SO ')}</span>
                <span className="lg-ellipsis" title={r.invoiceNo}>{r.invoiceNo ? shortInv(r.invoiceNo) : '—'}</span>
                <span>{r.pickedBy || '—'}</span>
                <div className="lg-two"><span>{r.checkedBy || '—'}</span><span className="lg-small">{r.checkedAt ? formatCreated(r.checkedAt).replace(' · ', ' ') : ''}</span></div>
                <div className="lg-two"><span>{r.dispatchedBy || '—'}</span><span className="lg-small">{r.dispatchedAt ? formatCreated(r.dispatchedAt).replace(' · ', ' ') : ''}</span>
                  {r.lrPhoto && <button className="jo-link lg-photo-link" onClick={() => openPhoto(r)}>LR photo</button>}</div>
                <span className={`lg-r${r.over.unassigned ? ' lg-red' : ''}`}>{mins(r.times.unassigned)}</span>
                <span className={`lg-r${r.over.picking ? ' lg-red' : ''}`}>{mins(r.times.picking)}</span>
                <span className={`lg-r${r.over.checking ? ' lg-red' : ''}`}>{mins(r.times.checking)}</span>
                <span className={`lg-r${r.over.ready ? ' lg-red' : ''}`}>{mins(r.times.ready)}</span>
                <div className="lg-two lg-r"><span>{r.boxes ?? '—'}</span>{r.labels === 'Skipped' && <span className="lg-small">labels skipped</span>}</div>
                <span className="lg-r jo-strong">{r.value === null ? '—' : rupees(r.value)}</span>
                <div className="lg-two lg-r"><span className={r.pendingLines ? 'lg-amber' : 'lg-grey'}>{r.pendingLines ? `${r.pendingLines} ${r.pendingLines === 1 ? 'line' : 'lines'}` : '—'}</span>
                  {r.clearedLines > 0 && <span className="lg-small">{r.clearedLines} cleared</span>}</div>
                <span className={r.waitingVia ? 'lg-small lg-via' : 'lg-grey'}>{r.waitingVia || '—'}</span>
              </div>
            ))}
            {!rows.length && <div className="lg-empty">No orders in this range.</div>}
            <div className="lg-foot">
              <span>Showing {shown.length} of {rows.length} · Unassigned = time from SO created until someone started picking · times over the limit in red</span>
              <span className="lg-pager">
                <button className="jo-link" disabled={page === 0} onClick={() => setPage(p => p - 1)}>‹ Previous</button>
                Page {page + 1} of {pages}
                <button className="jo-link" disabled={page + 1 >= pages} onClick={() => setPage(p => p + 1)}>Next ›</button>
              </span>
            </div>
          </div>
        </div>
      )}

      {data && tab === 'staff' && (
        <div className="lg-pad lg-staff">
          <div className="jo-card lg-bars">
            <span className="lg-bars-title">Orders per person</span>
            {data.summary.map(s => (
              <div className="lg-bar-row" key={s.id}>
                <span className="jo-strong lg-ellipsis">{s.name}</span>
                <span className="lg-bar-track"><span className="lg-bar" style={{ width: `${Math.round((s.orders / maxOrders) * 100)}%`, background: ROLE_COLOR[s.role] }} /></span>
                <span className="lg-r jo-strong">{s.orders}</span>
              </div>
            ))}
            {!data.summary.length && <p className="jo-p">Nobody handled an order in this range.</p>}
            <div className="lg-legend">{Object.entries(ROLE_COLOR).map(([k, c]) => <span key={k}><i style={{ background: c }} />{k === 'Picker' ? 'Picking' : k === 'Supervisor' ? 'Checking' : 'Dispatch'}</span>)}</div>
          </div>
          <div className="lg-table">
            <div className="lg-tr lg-tr-s lg-th"><span>PERSON</span><span className="lg-r">ORDERS</span><span className="lg-r">INVOICE VALUE</span><span className="lg-r" title="Average time in their own stage">AVG TIME</span><span className="lg-r">TOTAL TIME</span><span className="lg-r">BOXES</span><span>TOP CATEGORY</span></div>
            {data.summary.map(s => (
              <div className="lg-tr lg-tr-s" key={s.id}>
                <div className="lg-two"><span className="jo-strong">{s.name}</span><span className="lg-small">{s.role}</span></div>
                <span className="lg-r jo-strong">{s.orders}</span>
                <span className="lg-r">{rupees(s.value)}</span>
                <span className="lg-r">{mins(s.avgMinutes)}</span>
                <span className="lg-r">{mins(s.totalMinutes)}</span>
                <span className="lg-r">{s.boxes || '—'}</span>
                <span className="lg-ellipsis">{s.topCategory}</span>
              </div>
            ))}
            <div className="lg-foot"><span>Times are each person’s own stage: picking for pickers, checking for supervisors, ready-to-dispatched for dispatch. The Excel file also has pick-to-dispatch.</span></div>
          </div>
        </div>
      )}
    </div>
  )
}
