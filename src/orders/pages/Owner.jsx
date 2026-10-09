import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { read, write } from '../lib/storage.js'
import { useAdminSession, SignIn, serverError, NO_CONNECTION, HqHead } from './Admin.jsx'
import { shortDate } from '../lib/tablet-logic.js'
import { formatCreated, formatExpected, shortSo } from '../lib/board-logic.js'
import * as O from '../lib/owner-logic.js'
import '../admin.css'

// /owner — for Shishir and Ruchir, on a phone or a desktop (admins only). Two tabs:
//   PARTIES WAITING  every order with a short item, in three bands:
//      RED    waiting (invoiced with lines pending, or parked before picking),
//             not every short item ordered yet;
//      AMBER  still in NEW or PICKING with short items ("IN NEW · 2 of 9 short"),
//             with WAIT FOR MATERIAL (NEW only, as on the tablet);
//      GREEN  waiting, every short item ordered (latest expected date) or stock in.
//      Clear a line / all, Pick anyway, Wait for material; tick orders for
//      CLEAR ALL PENDING on several at once.
//   ITEMS TO ORDER   by supplier: Mark ordered → "When will it arrive?" (2 / 4 / 7
//      days / pick a date); tick items for MARK N ORDERED with one date.
//   The 17:30 email sits under both.
//
// Every action asks first (CANCEL left, CONFIRM right). On CONFIRM every action
// button waits (spinner on CONFIRM) until the server answers; the rows change in
// place at once and never move while you work (owner-logic.js); a refusal puts
// them back and says why.
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const qty = q => (Number.isInteger(Number(q)) ? String(Number(q)) : String(Math.round(Number(q) * 1000) / 1000))
const TAB_KEY = 'jcmOrders.ownerTab'
const IDLE_REFRESH_MS = 20000 // the minute refresh waits until nobody has touched the page for this long
const arrivalText = (today, c) => formatExpected(c.date || O.addDays(today, Number(c.days))).replace('Exp. ', '')

export default function Owner() {
  const { session, signOut, onSignedIn } = useAdminSession()
  return (
    <div className="jo-admin">
      <HqHead title="Pending Material" sub="Parties waiting and items to order" />
      <main className="jo-main jo-main-owner">
        {session ? <OwnerPanels session={session} onExpired={signOut} /> : <SignIn onSignedIn={onSignedIn} />}
      </main>
    </div>
  )
}

function OwnerPanels({ session, onExpired }) {
  const call = useCallback(async (path, opts = {}) => {
    const r = await api(path, { ...opts, admin: session.token })
    if (r.status === 401) onExpired()
    return r
  }, [session.token, onExpired])
  const [data, setData] = useState(null)
  const dataRef = useRef(null)
  dataRef.current = data
  const [error, setError] = useState('')
  const [msg, setMsg] = useState(null)
  const [tab, setTab] = useState(() => (read('localStorage', TAB_KEY) === 'items' ? 'items' : 'parties'))
  const [selParties, setSelParties] = useState(() => new Set())
  const [selItems, setSelItems] = useState(() => new Set())
  const [ask, setAsk] = useState(null)        // the confirmation open now
  const [whenFor, setWhenFor] = useState(null) // bulk MARK ORDERED: choosing the date first
  const [running, setRunning] = useState(false) // saving: every action button waits
  const runningRef = useRef(false)
  runningRef.current = running || !!ask || !!whenFor

  // Full reload: the server's order, rows that left the list dropped.
  const load = useCallback(async () => {
    setError('')
    try {
      const r = await call('/api/admin/owner')
      if (!r.ok) { if (r.status !== 401) setError(serverError(r)); return }
      setData(r.data)
      const pids = new Set(r.data.parties.map(p => p.id)), iids = new Set(r.data.items.flatMap(g => g.items.map(i => i.id)))
      setSelParties(s => new Set([...s].filter(id => pids.has(id))))
      setSelItems(s => new Set([...s].filter(id => iids.has(id))))
    } catch { setError(NO_CONNECTION) }
  }, [call])
  useEffect(() => { load() }, [load])
  // Kept fresh like the TV and the tablet — but only when nobody is in the middle of
  // something (no confirmation open, nothing ticked, untouched for 20 s), so the
  // list never re-sorts under a finger.
  const lastTouch = useRef(Date.now())
  const ticked = selParties.size + selItems.size
  useEffect(() => {
    const touch = () => { lastTouch.current = Date.now() }
    window.addEventListener('pointerdown', touch)
    const refresh = () => {
      if (document.visibilityState === 'hidden' || runningRef.current || ticked) return
      if (Date.now() - lastTouch.current < IDLE_REFRESH_MS) return
      load()
    }
    const t = setInterval(refresh, 60000)
    document.addEventListener('visibilitychange', refresh)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('pointerdown', touch) }
  }, [load, ticked])

  const switchTab = t => { write('localStorage', TAB_KEY, t); setTab(t); setMsg(null); load() }

  // A confirmed action: rows change in place at once, then the server's lists are
  // put on screen without moving anything. Refused: back as it was, reason shown.
  const run = async ({ body, optimistic, ok, after }) => {
    setRunning(true); setMsg(null)
    const before = dataRef.current
    if (optimistic && before) setData(optimistic(before))
    try {
      const r = await call('/api/admin/owner', { method: 'POST', body })
      if (r.ok) {
        if (r.data.overview) setData(d => O.mergeStable(d, r.data.overview)); else load()
        setMsg({ ok: ok(r.data) })
        setAsk(null)
        if (after) after()
        return true
      }
      setData(before)
      if (r.status !== 401) setAsk(a => a && { ...a, error: `Not saved — ${serverError(r)}` })
    } catch {
      setData(before)
      setAsk(a => a && { ...a, error: `Not saved — ${NO_CONNECTION}` })
    } finally { setRunning(false) }
    return false
  }

  // ---- the actions (each opens a confirmation first)
  const askClear = (p, lines) => setAsk({
    name: p.name, line: `Clear ${plural(lines.length, 'pending item', 'pending items')} for ${p.name}? Busy's sales order does not change.`,
    list: lines.map(l => `${l.item} — short ${qty(l.short)} of ${qty(l.ordered)}`), confirmLabel: 'CLEAR', danger: true,
    exec: () => run({
      body: { op: 'clear', orderId: p.id, lineNos: lines.map(l => l.lineNo) },
      optimistic: d => O.clearLines(d, p.id, lines.map(l => l.lineNo)),
      ok: d => `${p.name}: ${plural(d.cleared, 'pending item', 'pending items')} cleared.${d.closed ? ' Nothing else was pending, so the order is closed.' : ''} They are under “Export cleared lines” on the logs page.`,
    }),
  })
  const askPickAnyway = p => setAsk({
    name: p.name, line: `Send ${p.name} (${shortSo(p.soNo)}) back to NEW now, to pick and send what is in stock? The short items stay pending.`,
    confirmLabel: 'PICK ANYWAY',
    exec: () => run({ body: { op: 'pick_anyway', orderId: p.id }, optimistic: d => O.pickAnyway(d, p.id), ok: () => `${p.name} (${shortSo(p.soNo)}) is back in NEW — the tablet shows "Pick anyway".` }),
  })
  const askWait = p => setAsk({
    name: p.name, line: `Move ${p.name} (${shortSo(p.soNo)}) to Waiting for material? It leaves the NEW list so nobody picks it, and comes back by itself when the stock or the expected date arrives.`,
    list: p.pending.filter(l => !l.gone && l.status !== 'in_stock').map(l => `${l.item} — short ${qty(l.short)} of ${qty(l.ordered)}`), confirmLabel: 'WAIT FOR MATERIAL',
    exec: () => run({ body: { op: 'wait', orderId: p.id }, optimistic: d => O.waitForMaterial(d, p.id), ok: () => `${p.name} (${shortSo(p.soNo)}) is waiting for material.` }),
  })
  const askOrdered = (it, c) => setAsk({
    name: it.item, line: `${it.orderedAt ? 'Change the expected date of' : 'Mark'} ${it.item} ${it.orderedAt ? 'to' : 'as ordered, arriving'} ${arrivalText(data.today, c)}?`,
    confirmLabel: it.orderedAt ? 'CHANGE DATE' : 'MARK ORDERED',
    exec: () => run({
      body: { op: 'ordered', id: it.id, ...c }, optimistic: d => O.markOrdered(d, it.id, c).data,
      ok: d => { const green = (d.parties || []).filter(p => p.status === 'green').map(p => p.name); return `${it.item}: ordered, expected ${shortDate(d.expectedDate)}.${green.length ? ` Now fully ordered: ${green.join(', ')}.` : ''}` },
    }),
  })
  const askUndo = it => setAsk({
    name: it.item, line: `Mark ${it.item} as NOT ordered again (undo)?`, confirmLabel: 'UNDO',
    exec: () => run({ body: { op: 'unordered', id: it.id }, optimistic: d => O.unmarkOrdered(d, it.id), ok: () => `${it.item}: back to not ordered.` }),
  })
  // Bulk: MARK N ORDERED — one date for every ticked item, then the confirmation.
  const askOrderedMany = c => {
    const items = O.liveItems(data).filter(i => selItems.has(i.id))
    setWhenFor(null)
    setAsk({
      name: plural(items.length, 'item', 'items'), line: `Mark ${plural(items.length, 'item', 'items')} as ordered, arriving ${arrivalText(data.today, c)}?`,
      list: items.map(i => `${i.item} — short ${qty(i.short)}`), confirmLabel: `MARK ${items.length} ORDERED`,
      exec: () => run({
        body: { op: 'ordered_many', ids: items.map(i => i.id), ...c }, optimistic: d => O.markOrdered(d, items.map(i => i.id), c).data,
        ok: d => `${plural(d.count, 'item', 'items')} marked ordered, expected ${shortDate(d.expectedDate)}.${d.skipped ? ` ${d.skipped} had left the list.` : ''}`,
        after: () => setSelItems(new Set()),
      }),
    })
  }
  // Bulk: CLEAR ALL PENDING on the ticked orders — red button, tapped twice.
  const askClearMany = () => {
    const ps = O.liveParties(data).filter(p => selParties.has(p.id)).map(p => ({ p, lines: O.clearableLines(p) })).filter(x => x.lines.length)
    const total = ps.reduce((s, x) => s + x.lines.length, 0)
    setAsk({
      name: plural(ps.length, 'order', 'orders'), line: `Clear all pending on ${plural(ps.length, 'order', 'orders')} — ${plural(total, 'line', 'lines')} in all? Busy's sales orders do not change.`,
      list: ps.map(x => `${x.p.name} (${shortSo(x.p.soNo)}) — ${plural(x.lines.length, 'line', 'lines')}`),
      confirmLabel: `CLEAR ${ps.length} ${ps.length === 1 ? 'ORDER' : 'ORDERS'}`, danger: true, double: true,
      exec: () => run({
        body: { op: 'clear_many', orders: ps.map(x => ({ orderId: x.p.id, lineNos: x.lines.map(l => l.lineNo) })) },
        optimistic: d => O.clearMany(d, ps.map(x => ({ orderId: x.p.id, lineNos: x.lines.map(l => l.lineNo) }))),
        ok: d => `${plural(d.cleared, 'line', 'lines')} cleared on ${plural(d.orders, 'order', 'orders')}.${d.closed ? ` ${plural(d.closed, 'order', 'orders')} closed (nothing else pending).` : ''}${d.failed?.length ? ` ${d.failed.length} could not be cleared (changed meanwhile).` : ''}`,
        after: () => setSelParties(new Set()),
      }),
    })
  }

  if (error) return <section className="jo-card"><div className="jo-error">{error} <button className="jo-link" onClick={load}>Try again</button></div></section>
  if (!data) return <section className="jo-card"><p className="jo-p">Loading…</p></section>
  const parties = O.liveParties(data), items = O.liveItems(data)
  const band = k => parties.filter(p => p.status === k)
  const toOrder = items.filter(i => !i.orderedAt).length
  const toggle = (set, setter, ids, on) => setter(() => { const s = new Set(set); for (const id of ids) on ? s.add(id) : s.delete(id); return s })
  const allOn = (set, ids) => ids.length > 0 && ids.every(id => set.has(id))

  return (
    <>
      <div className="jo-tabs" role="tablist">
        {[['parties', 'Parties waiting', parties.length], ['items', 'Items to order', items.length]].map(([k, l, n]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`jo-tab${tab === k ? ' jo-tab-on' : ''}`} onClick={() => tab !== k && switchTab(k)}>
            {l}<span className="jo-tab-count">{n}</span>
          </button>
        ))}
      </div>
      {msg?.ok && <div className="jo-ok">{msg.ok}</div>}
      {msg?.error && <div className="jo-error">{msg.error}</div>}

      {tab === 'parties' && (
        <section className="jo-card">
          <p className="jo-p">{parties.length ? `${plural(parties.length, 'order', 'orders')} with short items — ${band('red').length} waiting, not fully ordered (red) · ${band('amber').length} still in NEW or picking (amber) · ${band('green').length} ordered or stock in (green). Tap a party for the full order.` : 'No order is short of material.'}</p>
          {parties.length > 0 && (
            <div className="jo-selbar-top">
              <Check label={`Select all (${parties.length})`} on={allOn(selParties, parties.map(p => p.id))} onChange={on => toggle(selParties, setSelParties, parties.map(p => p.id), on)} />
              {[['red', 'Red'], ['amber', 'Amber'], ['green', 'Green']].map(([k, l]) => band(k).length > 0 && (
                <Check key={k} label={`${l} (${band(k).length})`} on={allOn(selParties, band(k).map(p => p.id))} onChange={on => toggle(selParties, setSelParties, band(k).map(p => p.id), on)} />
              ))}
            </div>
          )}
          <div className="jo-parties">
            {data.parties.map(p => <PartyRow key={p.id} p={p} call={call} busy={running}
              selected={selParties.has(p.id)} onSelect={on => toggle(selParties, setSelParties, [p.id], on)}
              onClear={lines => askClear(p, lines)} onPickAnyway={() => askPickAnyway(p)} onWait={() => askWait(p)} />)}
          </div>
        </section>
      )}

      {tab === 'items' && (
        <section className="jo-card">
          <p className="jo-p">{items.length ? `${plural(toOrder, 'item', 'items')} not ordered yet. What open orders need beyond the stock in Busy, by supplier. An item leaves this list by itself when Busy shows the stock.` : 'Nothing to order — stock covers every open order.'}</p>
          {items.length > 0 && (
            <div className="jo-selbar-top">
              <Check label={`Select all (${items.length})`} on={allOn(selItems, items.map(i => i.id))} onChange={on => toggle(selItems, setSelItems, items.map(i => i.id), on)} />
            </div>
          )}
          {data.items.map(g => {
            const ids = g.items.filter(i => !i.gone).map(i => i.id)
            return (
              <div className="jo-mat" key={g.supplier}>
                <div className="jo-mat-head">
                  <Check label={<span className="jo-strong">{g.supplier}</span>} on={allOn(selItems, ids)} disabled={!ids.length} onChange={on => toggle(selItems, setSelItems, ids, on)} />
                  <span className="jo-hint">{plural(ids.length, 'item', 'items')}</span>
                </div>
                {g.items.map(it => <ItemRow key={it.id} it={it} today={data.today} busy={running}
                  selected={selItems.has(it.id)} onSelect={on => toggle(selItems, setSelItems, [it.id], on)}
                  onOrdered={c => askOrdered(it, c)} onUndo={() => askUndo(it)} />)}
              </div>
            )
          })}
        </section>
      )}

      <DailyEmail call={call} busy={running} onAsk={setAsk} setRunning={setRunning} />

      {/* The bulk bar: fixed at the bottom, over the page — nothing above it moves. */}
      {tab === 'items' && selItems.size > 0 && (
        <div className="jo-bulkbar">
          <span className="jo-strong">{plural(selItems.size, 'item', 'items')} ticked</span>
          <button className="jo-link" disabled={running} onClick={() => setSelItems(new Set())}>Untick all</button>
          <div className="jo-spacer" />
          <button className="jo-btn jo-btn-big" disabled={running} onClick={() => setWhenFor({ n: selItems.size })}>MARK {selItems.size} ORDERED</button>
        </div>
      )}
      {tab === 'parties' && selParties.size > 0 && (
        <div className="jo-bulkbar">
          <span className="jo-strong">{plural(selParties.size, 'order', 'orders')} ticked</span>
          <button className="jo-link" disabled={running} onClick={() => setSelParties(new Set())}>Untick all</button>
          <div className="jo-spacer" />
          <button className="jo-btn jo-btn-danger jo-btn-big" disabled={running} onClick={askClearMany}>CLEAR ALL PENDING ({plural(selParties.size, 'order', 'orders')})</button>
        </div>
      )}

      {whenFor && (
        <div className="jo-modal-back" onClick={() => setWhenFor(null)}>
          <div className="jo-modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
            <div className="jo-modal-title">Mark {plural(whenFor.n, 'item', 'items')} ordered</div>
            <WhenChoices today={data.today} onChoose={askOrderedMany} onCancel={() => setWhenFor(null)} />
          </div>
        </div>
      )}
      {ask && <Confirm ask={ask} running={running} onCancel={() => !running && setAsk(null)} />}
    </>
  )
}

// The one confirmation for every action: the name large, what will happen in one
// line, CANCEL on the left and CONFIRM on the right, well apart. CONFIRM shows a
// spinner and both wait until the server answers. A "double" confirmation (bulk
// clear) needs a second tap on the red button.
function Confirm({ ask, running, onCancel }) {
  const [armed, setArmed] = useState(false)
  const go = () => { if (ask.double && !armed) { setArmed(true); return } ask.exec() }
  return (
    <div className="jo-modal-back" onClick={onCancel}>
      <div className="jo-modal jo-confirm-modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <div className="jo-confirm-name">{ask.name}</div>
        <p className="jo-confirm-line">{ask.line}</p>
        {ask.list?.length > 0 && <ul className="jo-modal-list">{ask.list.slice(0, 12).map((t, i) => <li key={i}>{t}</li>)}{ask.list.length > 12 && <li>… and {ask.list.length - 12} more</li>}</ul>}
        {ask.error && <div className="jo-error">{ask.error}</div>}
        <div className="jo-confirm-btns">
          <button className="jo-btn jo-btn-outline jo-btn-big" disabled={running} onClick={onCancel}>CANCEL</button>
          <button className={`jo-btn jo-btn-big${ask.danger ? ' jo-btn-danger' : ''}${armed ? ' jo-btn-armed' : ''}`} disabled={running} onClick={go}>
            {running ? <><span className="jo-spin" aria-hidden="true" />SAVING…</> : armed ? `TAP AGAIN TO ${ask.confirmLabel || 'CONFIRM'}` : ask.confirmLabel || 'CONFIRM'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Check({ label, on, onChange, disabled }) {
  return (
    <label className={`jo-check${disabled ? ' jo-check-off' : ''}`} onClick={e => e.stopPropagation()}>
      <input type="checkbox" checked={!!on} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

const STATUS_TEXT = { ordered: it => `Ordered · exp. ${shortDate(it.expectedDate)}`, not_ordered: () => 'Not ordered', in_stock: () => 'In stock' }

// "IN NEW · 2 of 9 short" / "PICKING · 2 of 9 short" on the amber band.
const floorLabel = p => `${p.stage === 'picking' ? 'PICKING' : 'IN NEW'} · ${p.shortLines} of ${p.openLines} short`

function PartyRow({ p, call, busy, selected, onSelect, onClear, onPickAnyway, onWait }) {
  const live = p.pending.filter(l => !l.gone)
  const short = live.filter(l => l.status !== 'in_stock')
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    let alive = true
    setError('')
    call(`/api/admin/owner?order=${encodeURIComponent(p.id)}`)
      .then(r => { if (!alive) return; if (r.ok) setDetail(r.data.order); else if (r.status !== 401) setError(serverError(r)) })
      .catch(() => alive && setError(NO_CONNECTION))
    return () => { alive = false }
  }, [open, call, p.id, live.length])
  const gone = !!p.gone
  // Gone rows keep every button's space (hidden), so nothing below moves.
  const hide = gone ? { visibility: 'hidden' } : undefined
  return (
    <div className={`jo-party jo-party-${p.status}${gone ? ' jo-party-gone' : ''}${selected ? ' jo-party-picked' : ''}`}>
      <div className="jo-party-top">
        <Check label="" on={selected && !gone} disabled={gone} onChange={onSelect} />
        <button className="jo-party-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
          <span className="jo-party-name">{p.name}{p.city ? <span className="jo-hint"> · {p.city}</span> : null}</span>
          <span className="jo-hint">{shortSo(p.soNo)} · ordered {shortDate(p.soDate)}{p.invoiceNo ? ` · inv ${p.invoiceNo}` : ' · not billed yet'}</span>
          {p.floor
            ? <span className="jo-hint jo-party-via">{p.stage === 'picking' ? 'Being picked' : 'Not picked yet'} · {short.some(l => l.status === 'not_ordered') ? 'not every short item ordered' : 'short items ordered'}</span>
            : <span className="jo-hint jo-party-via">Waiting since {shortDate(p.waitingSince)}{p.viaText ? ` · ${p.viaText}` : ''}{p.waitingBy ? ` — ${p.waitingBy}` : ''}</span>}
          <span className={`jo-party-state jo-party-state-${gone ? 'gone' : p.status}`}>
            {gone ? p.gone.toUpperCase() : p.status === 'amber' ? floorLabel(p) : p.status === 'red' ? 'NOT ALL ORDERED' : p.expectedDate ? `EXPECTED ${shortDate(p.expectedDate).toUpperCase()}${p.overdue ? ' — LATE' : ''}` : 'STOCK IN'}
          </span>
          <span className="jo-chev">{open ? '▾' : '▸'}</span>
        </button>
      </div>
      <div className="jo-party-lines">
        {p.pending.map(l => (
          <div className={`jo-pline${l.gone ? ' jo-pline-gone' : ''}`} key={l.lineNo}>
            <span className="jo-strong">{l.item}</span>
            <span>short {qty(l.short)} of {qty(l.ordered)}</span>
            <span className={`jo-pline-state jo-pline-${l.status}`}>{l.gone ? l.gone : STATUS_TEXT[l.status](l)}</span>
            <button className="jo-btn jo-btn-outline jo-btn-small" style={l.gone || gone ? { visibility: 'hidden' } : undefined} disabled={busy} onClick={() => onClear([l])}>Clear</button>
          </div>
        ))}
        <div className="jo-row jo-party-acts" style={hide}>
          {p.canWait && <button className="jo-btn jo-btn-small" disabled={busy} onClick={onWait} title="As on the tablet: off the NEW list until the material arrives">Wait for material</button>}
          {p.canPickAnyway && <button className="jo-btn jo-btn-small" disabled={busy} onClick={onPickAnyway} title="Back to NEW now: send what is in stock">Pick anyway</button>}
          {/* On an order still in NEW / PICKING, "all" means the short items: the rest is being picked. */}
          {p.floor
            ? short.length > 1 && <button className="jo-btn jo-btn-outline jo-btn-small jo-clear-all" disabled={busy} onClick={() => onClear(short)}>Clear all short</button>
            : live.length > 1 && <button className="jo-btn jo-btn-outline jo-btn-small jo-clear-all" disabled={busy} onClick={() => onClear(live)}>Clear all pending</button>}
        </div>
      </div>
      {open && (
        <div className="jo-party-detail">
          {error && <div className="jo-error">{error}</div>}
          {!detail && !error && <p className="jo-p">Loading…</p>}
          {detail && <OrderDetail o={detail} />}
        </div>
      )}
    </div>
  )
}

const EVENT_TEXT = {
  new: 'Sales Order seen in Busy', pick: 'Picking started', invoiced: 'Invoiced', partial: 'Partial invoice', checked: 'Checked against invoice',
  in_bay: 'Ready for dispatch', dispatched: 'Dispatched', label_printed: 'Labels printed', whatsapp_sent: 'WhatsApp', grown: 'Back to NEW',
  closed: 'Closed', lines_cleared: 'Pending lines cleared', material_ordered: 'Material ordered', expected_set: 'Expected date set (old)',
  waiting: 'Waiting for material',
}
const VIA = { partial_invoice: 'partial invoice', button: 'Wait for material button', all_short: 'system · all lines short' }
const GROWN = { stock: 'stock arrived', date: 'expected date reached', manual: 'pick anyway' }
function eventNote(e) {
  const p = e.payload || {}
  if (e.event === 'lines_cleared') return (p.lines || []).map(l => `${l.item} × ${qty(l.qty)}`).join(', ')
  if (e.event === 'material_ordered') return `${p.item} — expected ${shortDate(p.expected_date)}`
  if (e.event === 'invoiced' && p.invoice_vch_no) return p.invoice_vch_no
  if (e.event === 'whatsapp_sent') return p.status === 'sent' ? 'sent' : `not sent${p.reason ? ` — ${p.reason}` : ''}`
  if (e.event === 'waiting') return `${VIA[p.via] || p.via || ''}${p.source === 'owner' ? ' (owner page)' : p.source === 'tablet' ? ' (tablet)' : ''}`
  if (e.event === 'grown') return GROWN[p.reason] || p.note || p.reason || ''
  if (e.event === 'closed') return p.note || p.reason || ''
  if (e.event === 'in_bay' && p.boxes) return plural(p.boxes, 'box', 'boxes')
  if (e.event === 'label_printed') return Array.isArray(p.box_numbers) && p.box_numbers.length ? `reprint: ${p.box_numbers.length === 1 ? 'box' : 'boxes'} ${p.box_numbers.join(', ')} of ${p.boxes}` : p.reprint ? `reprint: all ${p.boxes}` : plural(p.boxes || 0, 'label', 'labels')
  return ''
}

function OrderDetail({ o }) {
  return (
    <>
      <div className="jo-table">
        <div className="jo-tr jo-tr-lines jo-th"><span>ITEM</span><span>ORDERED</span><span>BILLED</span><span>SHORT</span></div>
        {o.lines.map(l => (
          <div className={`jo-tr jo-tr-lines${l.cleared ? ' jo-tr-cleared' : ''}`} key={l.lineNo}>
            <span>{l.item}{l.cleared && <span className="jo-hint"> — cleared {qty(l.cleared.qty)} on {shortDate(l.cleared.at)}</span>}</span>
            <span>{qty(l.ordered)}</span><span>{qty(l.invoiced)}</span><span className={l.short ? 'jo-strong' : 'jo-hint'}>{l.short ? qty(l.short) : '—'}</span>
          </div>
        ))}
      </div>
      <div className="jo-history">
        {o.history.map((e, i) => (
          <div key={i} className="jo-hint"><b>{formatCreated(e.at)}</b> · {EVENT_TEXT[e.event] || e.event}{e.who ? ` — ${e.who}` : ''}{eventNote(e) ? ` · ${eventNote(e)}` : ''}</div>
        ))}
      </div>
    </>
  )
}

function ItemRow({ it, today, busy, selected, onSelect, onOrdered, onUndo }) {
  const [asking, setAsking] = useState(false)
  const who = it.orders.length ? it.orders : it.forParties.map(name => ({ name }))
  const gone = !!it.gone
  return (
    <div className={`jo-item${it.orderedAt ? (it.late ? ' jo-item-late' : ' jo-item-ordered') : ''}${gone ? ' jo-item-gone' : ''}${selected ? ' jo-item-picked' : ''}`}>
      <Check label="" on={selected && !gone} disabled={gone} onChange={onSelect} />
      <div className="jo-item-main">
        <span className="jo-strong">{it.item}</span>
        <span>short {qty(it.short)}</span>
        <span className="jo-hint">{who.map(w => `${w.name}${w.soDate ? ` (${shortDate(w.soDate)})` : ''}`).join(', ') || '—'}</span>
      </div>
      <div className="jo-item-act">
        {gone && <span className="jo-hint">{it.gone}</span>}
        {!gone && it.orderedAt && !asking && <span className={it.late ? 'jo-late' : 'jo-item-when'}>Ordered {shortDate(it.orderedAt)} · expected {shortDate(it.expectedDate)}{it.late ? ' — late' : ''}</span>}
        {!gone && (asking
          ? <WhenChoices today={today} onChoose={c => { setAsking(false); onOrdered(c) }} onCancel={() => setAsking(false)} />
          : it.orderedAt
            ? <span className="jo-row"><button className="jo-link" disabled={busy} onClick={() => setAsking(true)}>Change date</button><button className="jo-link" disabled={busy} onClick={onUndo}>Undo</button></span>
            : <button className="jo-btn" disabled={busy} onClick={() => setAsking(true)}>Mark ordered</button>)}
      </div>
    </div>
  )
}

function WhenChoices({ onChoose, onCancel, today }) {
  const [picking, setPicking] = useState(false)
  const [date, setDate] = useState('')
  return (
    <div className="jo-when">
      <span className="jo-strong">When will it arrive?</span>
      <div className="jo-choices jo-choices-small">
        {[2, 4, 7].map(n => <button key={n} className="jo-btn jo-btn-outline" onClick={() => onChoose({ days: n })}>{n} days</button>)}
        {!picking
          ? <button className="jo-btn jo-btn-outline" onClick={() => setPicking(true)}>Pick a date</button>
          : <span className="jo-pick">
              <input type="date" className="jo-input" min={today} value={date} onChange={e => setDate(e.target.value)} aria-label="Expected date" />
              <button className="jo-btn" disabled={!date} onClick={() => onChoose({ date })}>Next</button>
            </span>}
        <button className="jo-link" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function DailyEmail({ call, busy, onAsk, setRunning }) {
  const [info, setInfo] = useState(null)
  const [show, setShow] = useState(false)
  const [msg, setMsg] = useState(null)
  const load = useCallback(async () => {
    try {
      const r = await call('/api/cron/daily-email?preview=1')
      if (r.ok) setInfo(r.data); else if (r.status !== 401) setMsg({ error: serverError(r) })
    } catch { setMsg({ error: NO_CONNECTION }) }
  }, [call])
  useEffect(() => { load() }, [load])
  const askSend = () => onAsk({
    name: 'Daily email', line: info?.ready ? `Send today's email now to ${info.to.join(', ')}?` : 'Try sending today’s email now? (It is not set up yet, so it will say why.)', confirmLabel: 'SEND NOW',
    exec: async () => {
      setRunning(true); setMsg(null)
      try {
        const r = await call('/api/cron/daily-email', { method: 'POST' })
        setMsg(!r.ok ? { error: serverError(r) } : r.data.status === 'sent' ? { ok: `Sent ${r.data.detail}.` } : { error: `Not sent: ${r.data.detail}` })
      } catch { setMsg({ error: NO_CONNECTION }) }
      setRunning(false); onAsk(null); load()
    },
  })
  return (
    <section className="jo-card">
      <h2 className="jo-h2">Daily email at 17:30</h2>
      {!info ? <p className="jo-p">Loading…</p> : (
        <>
          <p className="jo-p">{info.ready ? `Goes to ${info.to.join(', ')} every day around 17:30.` : `Not set up yet: ${info.reason}. Nothing is sent until then.`}</p>
          <p className="jo-p"><b>Subject today:</b> {info.subject}</p>
          <div className="jo-row">
            <button className="jo-btn jo-btn-outline" onClick={() => setShow(v => !v)}>{show ? 'Hide preview' : 'Preview today’s email'}</button>
            <button className="jo-btn" disabled={busy} onClick={askSend}>Send it now</button>
          </div>
          {show && <iframe className="jo-email" title="Email preview" srcDoc={info.html} />}
          {info.lastRuns?.length > 0 && (
            <div className="jo-runs">
              {info.lastRuns.map((r, i) => <div key={i} className="jo-hint">{new Date(r.sent_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} · {r.status === 'sent' ? 'Sent' : r.status === 'failed' ? 'Failed' : 'Not sent'}{r.detail ? ` — ${r.detail}` : ''}</div>)}
            </div>
          )}
        </>
      )}
      {msg?.ok && <div className="jo-ok">{msg.ok}</div>}
      {msg?.error && <div className="jo-error">{msg.error}</div>}
    </section>
  )
}
