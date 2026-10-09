import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { formatClock, shortSo } from '../lib/board-logic.js'
import { shrinkPhoto } from '../lib/photo.js'
import * as T from '../lib/tablet-logic.js'
import '../tablet.css'

// JCM HQ's Orders tab: the staff tablet from jcm-orders (src/pages/Tablet.jsx),
// always in its phone layout, for people signed in to HQ. No name tiles, PIN or
// 60-second lock here — HQ's own sign-in says who it is, and the server
// (/api/orders?h=floor) allows only the jobs ticked for them under Warehouse &
// Devices → Tablet staff. Everything after sign-in — job cards, stage lists,
// the order screen, confirmations, boxes and labels, LR photo, wait for
// material, pending material — is the tablet's own code.
const IDLE_SECONDS = 60
const CAMERA_HOLD_MS = 5 * 60000 // no lock while the camera app is open
const REFRESH_MS = 15000

const clockLine = d => `${formatClock(d)} · ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' }).format(d).replace(',', '')}`

const isPhone = () => window.innerWidth < 760 || window.innerHeight > window.innerWidth
function usePhone() {
  const [phone, setPhone] = useState(isPhone)
  useEffect(() => {
    const on = () => setPhone(isPhone())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return phone
}

export default function Floor() {
  const [screen, setScreen] = useState('loading')
  const [session, setSession] = useState(null)     // { profile } — who HQ says this is
  const [orders, setOrders] = useState([])
  const [materialCount, setMaterialCount] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [card, setCard] = useState(null)           // which stage card is open
  const [openId, setOpenId] = useState(null)
  const [notice, setNotice] = useState(null)       // { error } or { ok }
  const [labelJob, setLabelJob] = useState(null)   // { id, error } of the print job just queued; null = REPRINT LABELS
  const [photo, setPhoto] = useState(null)         // LR photo (data URL) waiting for SEND
  const [now, setNow] = useState(Date.now())

  // ---------------------------------------------------------------- calls
  // admin: true makes api.js send the HQ sign-in; /api/tablet maps to /api/orders?h=floor.
  const call = useCallback((path, opts = {}) => api(path, { ...opts, admin: true }), [])

  // A refused sign-in (expired, or the Orders tab taken away): say so instead of a blank screen.
  const lock = useCallback(() => {
    setSession(null); setOpenId(null); setCard(null); setOrders([]); setPhoto(null)
    setScreen('denied')
  }, [])

  // Taps change the screen at once (optimistic); the 15-second refresh must not
  // put back an older list while a tap is still being saved.
  const ordersRef = useRef(orders)
  ordersRef.current = orders
  const moves = useRef({ inFlight: 0, seq: 0 })
  const freshAt = useRef(0)
  const takeHome = useCallback(d => {
    if (!d || !Array.isArray(d.orders)) return
    setOrders(d.orders); setMaterialCount(d.materialCount ?? null); setLoadError(''); freshAt.current = Date.now()
    if (d.me) setSession(s => s || { profile: d.me })
  }, [])

  const loadOrders = useCallback(async () => {
    const seq = moves.current.seq
    try {
      const r = await call('/api/tablet?op=orders', { staff: true })
      if (r.status === 401) { lock(); return }
      if (moves.current.inFlight || moves.current.seq !== seq) return // a tap happened meanwhile: its answer wins
      if (r.ok) { takeHome(r.data); setScreen(s => (s === 'loading' ? 'home' : s)) }
      else setLoadError(r.data.error || `The orders could not be loaded (code ${r.status}).`)
    } catch { setLoadError('No connection to the server — showing the last list. It retries by itself.') }
  }, [call, lock, takeHome])

  useEffect(() => {
    loadOrders()
    const t = setInterval(loadOrders, REFRESH_MS)
    return () => clearInterval(t)
  }, [loadOrders])
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])

  const signedIn = !!session
  const lastTouch = useRef(Date.now())
  const holdUntil = useRef(0)

  // ---------------------------------------------------------------- LR photo
  // UPLOAD LR → TAKE PHOTO (camera) or FROM GALLERY (the phone's photos / files).
  // Either way the picture is shrunk in the browser (1600 px, JPEG 0.8 — photo.js)
  // before it is sent, so full-size gallery photos go quickly on mobile data.
  const camera = useRef(null)
  const gallery = useRef(null)
  const [photoFrom, setPhotoFrom] = useState('camera')
  const openPicker = from => {
    setNotice(null)
    setPhotoFrom(from)
    holdUntil.current = Date.now() + CAMERA_HOLD_MS // no lock while the camera / gallery is open
    const input = from === 'gallery' ? gallery.current : camera.current
    if (input) { input.value = ''; input.click() }
  }
  const onPhoto = async e => {
    const file = e.target.files && e.target.files[0]
    holdUntil.current = 0; lastTouch.current = Date.now()
    if (!file) return
    try { setPhoto(await shrinkPhoto(file)); setScreen('photo') } catch (err) { setNotice({ error: err.message || 'The photo could not be read. Try again.' }) }
  }

  const order = orders.find(o => o.id === openId) || null
  const me = session?.profile
  const toList = () => { setOpenId(null); setPhoto(null); setLabelJob(null); setScreen(card ? 'list' : 'home') }

  // Every move answers with the fresh lists (no second call). Optimistic moves
  // change the screen first; if the server refuses, the screen goes back and says why.
  const doMove = async (op, extra = {}, { optimistic = false } = {}) => {
    const id = openId
    const before = ordersRef.current
    moves.current.inFlight++; moves.current.seq++
    if (optimistic) setOrders(T.applyMove(before, id, op, me, extra))
    else setNotice(null)
    const undo = message => { if (optimistic) setOrders(before); setNotice({ error: optimistic ? `Not saved — ${message}` : message }) }
    try {
      const r = await call('/api/tablet', { method: 'POST', body: { op, id, ...extra }, staff: true })
      if (r.status === 401) { lock(); return false }
      if (!r.ok) { undo(r.data.error || `the server said no (code ${r.status}). Try again.`); return false }
      takeHome(r.data)
      return r.data
    } catch {
      undo(optimistic ? 'no connection to the server. Try again.' : 'No connection to the server. Nothing was saved — try again.')
      return false
    } finally { moves.current.inFlight-- }
  }
  const dispatched = r => {
    const wa = r.whatsapp === 'sent' ? 'WhatsApp sent to the customer.' : r.whatsapp === 'failed' ? 'The WhatsApp could not be sent — it is noted on the order.' : 'No WhatsApp sent (switched off, or no mobile number).'
    setNotice({ ok: `${order ? order.name : 'Order'} dispatched. ${wa}` })
    toList()
  }

  // Every action that saves asks first (Confirm): the party name large, what will
  // happen in one line, CANCEL on the left and CONFIRM on the right, far apart.
  // CONFIRM waits for the server — spinner, both buttons off — and only then the
  // screen moves on; refused: the order goes back and the reason shows on the sheet.
  const [ask, setAsk] = useState(null)
  const askFor = a => { setNotice(null); setAsk({ back: 'order', ...a }); setScreen('ask') }
  const nm = order ? order.name : ''
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
  const confirmPick = () => askFor({
    line: `Start picking ${nm}? It moves to PICKING with your name on it.`, confirmLabel: "YES, I'M PICKING",
    exec: async () => { if (await doMove('pick', {}, { optimistic: true })) setScreen('order') },
  })
  const confirmCheck = () => askFor({
    line: `Mark ${nm} as checked against invoice ${order?.invoiceNo || ''}?`.replace(' ?', '?'), confirmLabel: 'YES, CHECKED',
    exec: async () => {
      if (!(await doMove('check', {}, { optimistic: true }))) return
      // Someone who only checks does not see checked orders: back to the list.
      if (T.can(me, 'ready')) setScreen('order'); else { setNotice({ ok: `${nm} checked against the invoice.` }); toList() }
    },
  })
  const confirmWait = () => askFor({
    line: `Move ${nm} to Waiting for material? It leaves the NEW list so nobody picks it, and comes back by itself when the stock or the expected date arrives.`,
    confirmLabel: 'YES, WAIT', extra: <ShortItems call={call} order={order} />,
    exec: async () => {
      if (!(await doMove('wait', {}, { optimistic: true }))) return
      setNotice({ ok: `${nm} (${shortSo(order.soNo)}) is waiting for material.` })
      toList()
    },
  })
  const confirmReady = (boxes, labels) => askFor({
    back: 'boxes',
    line: labels === 'skip' ? `Mark ${nm} ready for dispatch with ${plural(boxes, 'box', 'boxes')}, WITHOUT labels?` : `Mark ${nm} ready for dispatch with ${plural(boxes, 'box', 'boxes')} and print ${plural(boxes, 'label', 'labels')}?`,
    confirmLabel: labels === 'skip' ? 'YES, NO LABELS' : `YES, PRINT ${boxes}`,
    exec: async () => {
      const r = await doMove('ready', { boxes, labels }, { optimistic: true })
      if (!r) return
      if (labels === 'skip') { setNotice({ ok: `Ready for dispatch — ${plural(boxes, 'box', 'boxes')}, labels skipped. Tap REPRINT LABELS if you need them later.` }); setScreen('order') }
      else { setLabelJob({ id: r.labelJob || null, error: r.labelError || '' }); setScreen('labels') }
    },
  })
  const confirmDispatchNoPhoto = () => askFor({
    line: `Mark ${nm} as dispatched, WITHOUT an LR photo (self-pickup)?`, confirmLabel: 'YES, DISPATCHED', tone: 'green',
    extra: <DispatchFacts call={call} order={order} />,
    exec: async () => { const r = await doMove('dispatch'); if (r) dispatched(r) },
  })
  const confirmMaterial = (it, days) => askFor({
    back: 'material', name: it.item, line: `Mark ${it.item} as ordered, arriving in ${days} days?`, confirmLabel: 'YES, ORDERED',
    exec: async () => {
      try {
        const r = await call('/api/tablet', { method: 'POST', body: { op: 'material_ordered', id: it.id, days }, staff: true })
        if (r.status === 401) { lock(); return }
        if (r.ok) { setNotice({ ok: `${it.item}: ordered, arriving in ${days} days.` }); setScreen('material') }
        else setNotice({ error: `Not saved — ${r.data.error || `the server said no (code ${r.status}).`}` })
      } catch { setNotice({ error: 'Not saved — no connection to the server. Try again.' }) }
    },
  })

  const shell = (children, showRole) => (
    <Shell me={me} showRole={showRole}>{children}</Shell>
  )

  return (
    <div className="tb-stage tb-hq">
      <div className="tb tb-phone">
        {screen === 'loading' && <div className="tb-center"><p className="tb-p">{loadError || 'Loading your orders…'}</p></div>}
        {screen === 'denied' && (
          <div className="tb-center">
            <div className="tb-h2">No access</div>
            <p className="tb-p">The Orders tab did not open for you. Your sign-in may have expired, or an admin has not given you this tab in Manage Users.</p>
            <button className="tb-btn-outline" onClick={() => location.reload()}>Reload</button>
          </div>
        )}
        {signedIn && screen === 'home' && shell(
          <Home me={me} orders={orders} materialCount={materialCount} now={now} error={loadError} notice={notice}
            onCard={key => { setNotice(null); if (key === 'material') setScreen('material'); else { setCard(key); setScreen('list') } }} />)}
        {signedIn && screen === 'list' && card && shell(
          <StageList me={me} cardKey={card} orders={orders} now={now} error={loadError} notice={notice}
            onBack={() => { setNotice(null); setCard(null); setScreen('home') }}
            onOpen={id => { setNotice(null); setOpenId(id); setScreen('order') }} />)}
        {signedIn && screen === 'order' && shell(
          <OrderScreen order={order} me={me} now={now} notice={notice} call={call}
            onBack={() => { setNotice(null); toList() }}
            onWait={confirmWait}
            onReprint={() => { setNotice(null); setScreen('reprint') }}
            onWithoutPhoto={confirmDispatchNoPhoto}
            onAction={a => {
              if (a.op === 'boxes') { setNotice(null); setScreen('boxes'); return }
              if (a.op === 'photo') { setNotice(null); setScreen('lrsource'); return }
              if (a.op === 'pick') confirmPick()
              if (a.op === 'check') confirmCheck()
            }} />, true)}
        {signedIn && screen === 'material' && shell(<Material call={call} notice={notice} onBack={() => { setNotice(null); setScreen('home') }} onAskOrdered={confirmMaterial} />, true)}
        {signedIn && screen === 'boxes' && order && shell(
          <Boxes order={order} notice={notice} onBack={() => setScreen('order')} onConfirm={confirmReady} />, true)}
        {signedIn && screen === 'labels' && order && (
          <LabelsSheet key={labelJob?.id || 'not-sent'} order={order} me={me} call={call} labelJob={labelJob} onDone={toList}
            onReprint={() => { setNotice(null); setScreen('reprint') }} />
        )}
        {signedIn && screen === 'reprint' && order && (
          <ReprintSheet order={order} me={me} call={call} onCancel={() => setScreen('order')}
            onSent={job => { setLabelJob(job); setScreen('labels') }} />
        )}
        {signedIn && screen === 'ask' && ask && (
          <Confirm me={me} name={ask.name || (order ? order.name : '')} line={ask.line} confirmLabel={ask.confirmLabel} tone={ask.tone} extra={ask.extra}
            error={notice?.error} onCancel={() => { setNotice(null); setScreen(ask.back) }} exec={ask.exec} />
        )}
        {signedIn && screen === 'lrsource' && order && (
          <LrSourceSheet order={order} me={me} notice={notice} onPick={openPicker} onCancel={() => { setNotice(null); setScreen('order') }} />
        )}
        {signedIn && screen === 'photo' && order && photo && (
          <PhotoSheet order={order} me={me} call={call} photo={photo} notice={notice} from={photoFrom}
            onRetake={() => openPicker(photoFrom)} onBack={() => { setPhoto(null); setNotice(null); setScreen('order') }}
            onSend={async () => { const r = await doMove('dispatch', { photo }); if (r) dispatched(r) }} />
        )}
        {/* UPLOAD LR: the phone camera (TAKE PHOTO, RETAKE) and the gallery / files (FROM GALLERY, CHOOSE AGAIN). */}
        {signedIn && <input ref={camera} type="file" accept="image/*" capture="environment" className="tb-camera" onChange={onPhoto} tabIndex={-1} aria-hidden="true" />}
        {signedIn && <input ref={gallery} type="file" accept="image/*" className="tb-camera tb-gallery" onChange={onPhoto} tabIndex={-1} aria-hidden="true" />}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ screens

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Clear', '0', '⌫']
function Keypad({ onKey, className }) {
  return (
    <div className={className}>
      {KEYS.map(k => (
        <button key={k} className={`tb-key${k.length > 1 ? ' tb-key-fn' : ''}`} onClick={() => onKey(k)}>{k}</button>
      ))}
    </div>
  )
}

function Shell({ me, showRole, children }) {
  return (
    <div className="tb-screen">
      <div className="tb-head">
        <span className="tb-head-ini">{me.initials}</span>
        <span className="tb-head-name">{T.firstName(me.name)}</span>
        {showRole && T.roleLabel(me.role) && <span className="tb-head-role">{T.roleLabel(me.role)}</span>}
        <div className="tb-spacer" />
        <span className="tb-head-lock">{clockLine(new Date())}</span>
      </div>
      {children}
    </div>
  )
}

// Home: one big card per job ticked for this person, with how many orders wait there.
function Home({ me, orders, materialCount, now, error, notice, onCard }) {
  const cards = T.homeCards(orders, me, materialCount, now)
  return (
    <div className="tb-cards-wrap">
      {error && <div className="tb-error">{error}</div>}
      {notice?.error && <div className="tb-error">{notice.error}</div>}
      {notice?.ok && <div className="tb-ok">{notice.ok}</div>}
      {!cards.length && <p className="tb-p tb-empty">No jobs are ticked for you yet. An admin sets them on the admin page under “Tablet staff”.</p>}
      <div className={`tb-cards tb-cards-${Math.min(cards.length, 5)}`}>
        {cards.map(c => (
          <button key={c.key} className="tb-card" data-card={c.key} style={{ borderTopColor: c.color }} onClick={() => onCard(c.key)}>
            <span className="tb-card-title">{c.title}</span>
            <span className="tb-card-count" style={{ color: c.count ? c.color : '#8A8F99' }}>{c.count ?? '—'}</span>
            <span className="tb-card-sub">{c.sub}</span>
            <span className="tb-card-oldest">{c.oldest ? `oldest ${c.oldest}` : c.key === 'material' ? '' : 'nothing waiting'}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// One stage's orders: party name first, oldest first, with a search box.
function StageList({ me, cardKey, orders, now, error, notice, onBack, onOpen }) {
  const [q, setQ] = useState('')
  const c = T.CARDS.find(x => x.key === cardKey)
  const all = T.cardOrders(orders, cardKey, me)
  const list = T.searchOrders(all, q)
  return (
    <>
      <div className="tb-list-top">
        <button className="tb-btn-outline" onClick={onBack}>‹  All jobs</button>
        <span className="tb-list-title" style={{ color: c.color }}>{c.title}</span>
        <span className="tb-list-count">{all.length} · oldest first</span>
      </div>
      <div className="tb-search-row">
        <input id="tb-search" name="search" className="tb-search" type="search" placeholder="Search party name" value={q}
          onChange={e => setQ(e.target.value)} autoComplete="off" />
        {q && <button className="tb-btn-outline tb-search-clear" onClick={() => setQ('')}>Clear</button>}
      </div>
      <div className="tb-home-list">
        {error && <div className="tb-error">{error}</div>}
        {notice?.error && <div className="tb-error">{notice.error}</div>}
        {notice?.ok && !notice.error && <div className="tb-ok">{notice.ok}</div>}
        {list.map(o => {
          const b = T.badge(o)
          return (
            <button key={o.id} className="tb-ocard" style={{ borderLeftColor: T.STAGE_COLOR[o.stage] }} onClick={() => onOpen(o.id)}>
              <div className="tb-ocard-main">
                <span className="tb-ocard-name">{o.name}</span>
                {o.city && <span className="tb-ocard-city">{o.city}</span>}
                <span className="tb-ocard-meta">{T.meta(o)}{o.stage === 'picking' && o.picker ? ` · ${T.firstName(o.picker)}` : ''}</span>
                {T.arrived(o) && <span className={`tb-arrived${T.arrivedRed(o) ? ' tb-arrived-red' : ''}`}>{T.arrived(o)}</span>}
              </div>
              <div className="tb-ocard-side">
                <span className="tb-badge" style={{ background: b.bg, color: b.fg }}>{b.label}</span>
                <span className="tb-ocard-timer">{T.timer(o, now)}</span>
              </div>
              <span className="tb-chev">›</span>
            </button>
          )
        })}
        {!all.length && <p className="tb-p tb-empty">Nothing here right now. New orders appear by themselves.</p>}
        {all.length > 0 && !list.length && <p className="tb-p tb-empty">No party matches “{q}”.</p>}
      </div>
    </>
  )
}

function OrderScreen({ order, me, now, notice, call, onBack, onAction, onReprint, onWithoutPhoto, onWait }) {
  const [busy, setBusy] = useState(false)
  const [detail, detailError] = useDetail(call, order?.id || '', order ? `${order.stage}|${order.stageSince}` : '')
  if (!order) {
    return (
      <div className="tb-order-gone">
        <button className="tb-btn-outline" onClick={onBack}>‹  Back</button>
        {notice?.ok ? <div className="tb-ok">{notice.ok}</div> : <>
          <div className="tb-h2">This order is no longer open</div>
          <p className="tb-p">It may have been moved on by someone else, or changed in Busy.</p>
        </>}
      </div>
    )
  }
  const b = T.badge(order)
  const a = T.action(order, me)
  const second = T.secondary(order, me)
  return (
    <>
      <div className="tb-order-top">
        <button className="tb-btn-outline" onClick={onBack}>‹  Back</button>
        {order.stage === 'in_bay' && <button className="tb-btn-outline" onClick={onReprint}>REPRINT LABELS</button>}
        <div className="tb-spacer" />
        <div className="tb-steps">
          {T.steps(order.stage).map(st => (
            <span key={st.label} className="tb-step" style={{ borderColor: st.bd, background: st.bg, color: st.fg }}>{st.label}</span>
          ))}
        </div>
      </div>
      <div className="tb-order-body">
        <div className="tb-order-card">
          <span className="tb-order-name">{order.name}</span>
          {order.city && <span className="tb-order-city">{order.city}</span>}
          <span className="tb-order-meta">{T.meta(order, true)}</span>
          {/* "12 lines · 2 short": always in view; tap to see the item list below. */}
          {detail && detail.id === order.id && detail.stockSummary && (
            <button className={`tb-stockline${detail.stockSummary.short ? ' tb-stockline-short' : ''}`}
              onClick={() => document.getElementById('tb-items')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              {T.stockLine(detail.stockSummary)}<span className="tb-stockline-see">See items ↓</span>
            </button>
          )}
          {T.arrived(order) && <span className={`tb-arrived${T.arrivedRed(order) ? ' tb-arrived-red' : ''}`}>{T.arrived(order)}</span>}
          <div className="tb-order-row">
            <span className="tb-badge tb-badge-lg" style={{ background: b.bg, color: b.fg }}>{b.label}</span>
            <span className="tb-order-who">{T.who(order)}</span>
            <div className="tb-spacer" />
            <span className="tb-order-in">in this stage</span>
            <span className="tb-order-timer">{T.timer(order, now)}</span>
          </div>
        </div>
        <p className="tb-helper">{T.helper(order)}</p>
        {notice?.error && <div className="tb-error">{notice.error}</div>}
        {notice?.ok && <div className="tb-ok">{notice.ok}</div>}
        <ItemList detail={detail && detail.id === order.id ? detail : null} error={detailError} />
      </div>
      <div className={`tb-bottom${a.op === 'photo' ? ' tb-bottom-two' : second ? ' tb-bottom-stack' : ''}`}>
        <button className={`tb-big tb-big-${a.kind}`} disabled={a.kind === 'off' || busy}
          onClick={async () => { setBusy(true); try { await onAction(a) } finally { setBusy(false) } }}>
          {busy && a.op !== 'photo' ? 'SAVING…' : a.label}
        </button>
        {/* Self-pickup: no LR to photograph. */}
        {a.op === 'photo' && <button className="tb-big tb-big-skip tb-big-small" onClick={onWithoutPhoto}>Dispatch without photo</button>}
        {/* Material not there: park the order until it arrives. */}
        {second && <button className="tb-big tb-big-skip tb-big-small tb-big-wait" disabled={busy} onClick={onWait}>{second.label}</button>}
      </div>
    </>
  )
}

// The order's items with Busy's stock: "12 lines · 2 short", then one row per
// line: green In stock, red Short: 3 of 5, grey Cleared (in the portal) / Billed.
function ItemList({ detail, error }) {
  if (error) return <div className="tb-error">{error}</div>
  if (!detail) return <div className="tb-items"><div className="tb-items-head"><span>Items</span><span>loading…</span></div></div>
  const sum = detail.stockSummary
  return (
    <div className="tb-items" id="tb-items">
      <div className="tb-items-head">
        <span>Items</span>
        <span className={sum && sum.short ? 'tb-items-short' : ''}>{T.stockLine(sum)}</span>
      </div>
      {(detail.lines || []).map(l => {
        const m = T.stockMarker(l)
        return (
          <div className={`tb-item${l.stock === 'cleared' ? ' tb-item-cleared' : ''}`} key={l.lineNo}>
            <div className="tb-item-main">
              <span className="tb-item-name">{l.item || 'Item'}</span>
              <span className="tb-item-code">Code {l.itemCode}</span>
            </div>
            <span className="tb-item-qty">{T.qtyText(l.ordered)}</span>
            <span className={`tb-mark tb-mark-${m.kind}`}>{m.text}{m.note && <small>{m.note}</small>}</span>
          </div>
        )
      })}
      {!(detail.lines || []).length && <p className="tb-p">No item lines on this order.</p>}
    </div>
  )
}

// The one confirmation sheet for every action that saves. CANCEL bottom-left,
// CONFIRM bottom-right with a wide gap, so one is never hit for the other.
// CONFIRM shows a spinner and both stay off until the server answers.
function Confirm({ me, name, line, confirmLabel = 'CONFIRM', tone = 'dark', extra, error, onCancel, exec }) {
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const go = async () => {
    if (busy) return
    setBusy(true)
    try { await exec() } finally { if (alive.current) setBusy(false) }
  }
  return (
    <div className="tb-sheetwrap">
      <div className="tb-sheethead"><span className="tb-head-ini">{me.initials}</span><span className="tb-head-name">{T.firstName(me.name)}</span></div>
      <div className="tb-spacer" />
      <div className="tb-sheet tb-sheet-confirm">
        <div className="tb-confirm-name">{name}</div>
        <div className="tb-confirm-line">{line}</div>
        {extra}
        {error && <div className="tb-error">{error}</div>}
        <div className="tb-confirm-btns">
          <button className="tb-sheet-btn" disabled={busy} onClick={onCancel}>CANCEL</button>
          <button className={`tb-sheet-btn tb-sheet-btn-${tone}`} disabled={busy} onClick={go}>{busy ? <><span className="tb-spin" aria-hidden="true" />SAVING…</> : confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

// WAIT FOR MATERIAL's confirmation: what Busy is short of.
function ShortItems({ call, order }) {
  const [detail, error] = useDetail(call, order.id)
  if (error) return <div className="tb-error">{error}</div>
  if (!detail) return <p className="tb-p">Loading the items…</p>
  const short = (detail.lines || []).filter(l => l.stock === 'short')
  return (
    <div className="tb-sheet-note">
      {short.length
        ? <>Short in Busy: {short.map((l, i) => <span key={l.lineNo}>{i ? ', ' : ''}<strong>{l.item || 'Item'}</strong> ({T.stockMarker(l).text.replace('Short: ', 'short ')})</span>)}.</>
        : <>Busy shows stock for every line ({T.stockLine(detail.stockSummary)}), so it will come back to NEW at the next sync, within 3 minutes.</>}
    </div>
  )
}

// REPRINT LABELS: which boxes? Large toggles "1 of 7" … "7 of 7", and All.
// Only the chosen ones print, each still "n of 7"; the history notes which.
function ReprintSheet({ order, me, call, onCancel, onSent }) {
  const all = order.boxes || 0
  const nums = Array.from({ length: all }, (_, i) => i + 1)
  const [sel, setSel] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const everything = all > 0 && sel.size === all
  const flip = b => setSel(s => { const x = new Set(s); if (x.has(b)) x.delete(b); else x.add(b); return x })
  const send = async () => {
    setBusy(true); setError('')
    const boxNumbers = everything ? null : [...sel].sort((a, b) => a - b)
    try {
      const r = await call('/api/tablet', { method: 'POST', body: { op: 'print_labels', id: order.id, reprint: true, ...(boxNumbers ? { boxNumbers } : {}) }, staff: true })
      if (r.ok) { onSent({ id: r.data.jobId, error: '', boxNumbers }); return }
      setError(r.data.error || `Could not send the labels (code ${r.status}).`)
    } catch { setError('No connection to the server — nothing was sent. Try again.') }
    setBusy(false)
  }
  return (
    <div className="tb-sheetwrap">
      <div className="tb-sheethead"><span className="tb-head-ini">{me.initials}</span><span className="tb-head-name">{T.firstName(me.name)}</span></div>
      <div className="tb-spacer" />
      <div className="tb-sheet tb-sheet-confirm">
        <div className="tb-confirm-name">{order.name}</div>
        <div className="tb-confirm-line">Reprint which labels? Tap the boxes (each prints “n of {all}”).</div>
        <div className="tb-reprint-grid">
          <button className={`tb-reprint-box tb-reprint-all${everything ? ' tb-reprint-on' : ''}`} aria-pressed={everything} disabled={busy}
            onClick={() => setSel(everything ? new Set() : new Set(nums))}>All</button>
          {nums.map(b => (
            <button key={b} className={`tb-reprint-box${sel.has(b) ? ' tb-reprint-on' : ''}`} aria-pressed={sel.has(b)} disabled={busy} onClick={() => flip(b)}>
              <b>{b}</b><span>of {all}</span>
            </button>
          ))}
        </div>
        {!all && <div className="tb-error">This order has no box count yet.</div>}
        {error && <div className="tb-error">{error}</div>}
        <div className="tb-confirm-btns">
          <button className="tb-sheet-btn" disabled={busy} onClick={onCancel}>CANCEL</button>
          <button className="tb-sheet-btn tb-sheet-btn-dark" disabled={busy || !sel.size} onClick={send}>
            {busy ? <><span className="tb-spin" aria-hidden="true" />SENDING…</> : sel.size ? `PRINT ${sel.size} ${sel.size === 1 ? 'LABEL' : 'LABELS'}` : 'CHOOSE BOXES'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Boxes({ order, notice, onBack, onConfirm }) {
  const [n, setN] = useState('')
  const [busy, setBusy] = useState(false)
  const onKey = k => {
    if (k === 'Clear') return setN('')
    if (k === '⌫') return setN(v => v.slice(0, -1))
    setN(v => (v === '0' || v === '' ? k : v + k).slice(0, 2).replace(/^0+/, ''))
  }
  const boxes = Number(n) || 0
  return (
    <>
      <div className="tb-boxes">
        <div className="tb-boxes-left">
          <button className="tb-btn-outline" onClick={onBack}>‹  Back</button>
          <div className="tb-boxes-title">How many boxes?</div>
          <div className="tb-boxes-sub">{order.name}{order.city ? ` · ${order.city}` : ''}</div>
          <div className="tb-boxes-num">{n || '–'}</div>
          <div className="tb-boxes-hint">One label prints for each box.</div>
          {notice?.error && <div className="tb-error">{notice.error}</div>}
        </div>
        <Keypad onKey={onKey} className="tb-boxes-pad" />
      </div>
      {/* PRINT LABELS or SKIP LABELS — both save the boxes and make the order Ready for dispatch. */}
      <div className="tb-bottom tb-bottom-two">
        <button className="tb-big tb-big-confirm" disabled={!boxes || busy}
          onClick={async () => { setBusy(true); try { await onConfirm(boxes, 'print') } finally { setBusy(false) } }}>
          {busy ? 'SAVING…' : boxes ? `PRINT ${boxes} ${boxes === 1 ? 'LABEL' : 'LABELS'}` : 'ENTER THE NUMBER OF BOXES'}
        </button>
        <button className="tb-big tb-big-skip" disabled={!boxes || busy}
          onClick={async () => { setBusy(true); try { await onConfirm(boxes, 'skip') } finally { setBusy(false) } }}>
          SKIP LABELS
        </button>
      </div>
    </>
  )
}

// Labels go to the TVS network label printer: the server queues a job, the
// print agent on JCM-Server prints one label per box (or the boxes chosen for a
// reprint). This sheet follows the job: Printing… → "4 labels printed", or the
// printer's problem — REPRINT opens the box grid again.
const JOB_POLL_MS = 1500
const JOB_GIVE_UP_MS = 3 * 60000
function LabelsSheet({ order, me, call, labelJob, onDone, onReprint }) {
  const jobId = labelJob?.id || null
  const [job, setJob] = useState(null)              // { state, error, slow, boxes, boxNumbers }
  const [error, setError] = useState(labelJob?.error || (jobId ? '' : 'The labels were not sent to the printer.'))
  const started = useRef(Date.now())
  useEffect(() => {
    if (!jobId) return
    let alive = true, timer
    const poll = async () => {
      try {
        const r = await call(`/api/tablet?op=label_job&id=${jobId}`, { staff: true })
        if (!alive) return
        if (r.ok) {
          setJob(r.data.job)
          if (r.data.job.state === 'printed' || r.data.job.state === 'failed') return
        } else setError(r.data.error || `Could not check the printer (code ${r.status}).`)
      } catch { /* try again */ }
      if (Date.now() - started.current < JOB_GIVE_UP_MS) timer = setTimeout(poll, JOB_POLL_MS)
      else if (alive) setError('The printer has not answered for 3 minutes. Check that JCM-Server and the label printer are on, then tap REPRINT.')
    }
    poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [call, jobId])
  const all = job?.boxes || order?.boxes || 0
  const nums = job?.boxNumbers || labelJob?.boxNumbers || Array.from({ length: all }, (_, i) => i + 1)
  const n = `${nums.length} ${nums.length === 1 ? 'label' : 'labels'}`
  const state = error ? 'error' : job?.state === 'failed' ? 'failed' : job?.state === 'printed' ? 'printed' : 'printing'
  return (
    <div className="tb-sheetwrap">
      <div className="tb-sheethead"><span className="tb-head-ini">{me.initials}</span><span className="tb-head-name">{T.firstName(me.name)}</span></div>
      <div className="tb-spacer" />
      <div className="tb-sheet tb-sheet-gold">
        {state === 'printed' && <div className="tb-sheet-status tb-sheet-status-green"><span className="tb-sheet-dot tb-sheet-dot-green" />{n.toUpperCase()} PRINTED</div>}
        {state === 'printing' && <div className="tb-sheet-status tb-sheet-status-amber"><span className="tb-sheet-dot tb-sheet-dot-amber" />PRINTING…</div>}
        {(state === 'failed' || state === 'error') && <div className="tb-sheet-status tb-sheet-status-red"><span className="tb-sheet-dot tb-sheet-dot-red" />LABELS NOT PRINTED</div>}
        <div className="tb-sheet-title">{state === 'printed' ? `${n} printed — stick ${nums.length === 1 ? 'it on its box' : 'one on each box'}` : state === 'printing' ? `Printing ${n}…` : 'The labels did not print'}</div>
        <div className="tb-sheet-sub">{order ? `${order.name}${order.city ? `, ${order.city}` : ''}` : ''}{nums.length < all ? ` · ${nums.length === 1 ? 'box' : 'boxes'} ${nums.join(', ')} of ${all}` : ''}</div>
        {state === 'printing' && job?.slow && <div className="tb-sheet-note">Still waiting for the print agent on JCM-Server. If nothing prints in a minute, check that JCM-Server is on.</div>}
        {state === 'failed' && <div className="tb-error">{job.error || 'The printer reported a problem.'}</div>}
        {state === 'error' && <div className="tb-error">{error}</div>}
        <div className="tb-minis">
          {nums.slice(0, 8).map(b => (
            <div key={b} className="tb-mini"><span>BOX</span><b>{b}</b><span>OF {all}</span></div>
          ))}
        </div>
        <div className="tb-sheet-btns">
          <button className="tb-sheet-btn" disabled={state === 'printing'} onClick={onReprint}>REPRINT</button>
          <button className="tb-sheet-btn tb-sheet-btn-dark" onClick={onDone}>DONE</button>
        </div>
      </div>
    </div>
  )
}

// The order's lines (with Busy's stock for each) and WhatsApp number, for the
// order screen's item list and the dispatch sheets. A new version (the order
// moved on) loads it again.
function useDetail(call, id, version = '') {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!id) return
    let alive = true
    setError('')
    call(`/api/tablet?op=order&id=${encodeURIComponent(id)}`, { staff: true })
      .then(r => { if (!alive) return; if (r.ok) setDetail(r.data.order); else if (r.status !== 401) setError(r.data.error || `Could not load the order (code ${r.status}).`) })
      .catch(() => alive && setError('No connection to the server — the item list could not be loaded.'))
    return () => { alive = false }
  }, [call, id, version])
  return [detail, error]
}

function whatsappNote(detail, photo) {
  if (!detail.whatsapp?.live) return 'WhatsApp to the customer is not switched on yet — nothing will be sent.'
  if (!detail.whatsapp.to) return 'There is no valid mobile number on this order, so no WhatsApp will be sent.'
  return <>WhatsApp goes to <strong>{detail.whatsapp.to}</strong>{photo ? ' with this LR photo,' : ''} the boxes, items, pending items{detail.invoiceNo ? <> and invoice <strong>{detail.invoiceNo}</strong></> : null}.</>
}

// DISPATCH WITHOUT PHOTO's confirmation: boxes, items, pending, total, WhatsApp.
function DispatchFacts({ call, order }) {
  const [detail, error] = useDetail(call, order.id)
  if (error) return <div className="tb-error">{error}</div>
  if (!detail) return <p className="tb-p">Loading…</p>
  const f = T.dispatchFacts(detail)
  return (
    <>
      <div className="tb-facts">
        <div className="tb-fact"><span>Boxes</span><b>{f.boxes}</b><span>Packed</span></div>
        <div className="tb-fact"><span>Items</span><b>{f.sentLines} {f.sentLines === 1 ? 'line' : 'lines'}</b><span>{f.pieces} pieces</span></div>
        <div className="tb-fact"><span>Pending</span><b className={f.pendingLines ? 'tb-amber' : ''}>{f.pendingLines} {f.pendingLines === 1 ? 'line' : 'lines'}</b><span>{f.pendingLines ? 'Follow later' : 'Nothing pending'}</span></div>
        <div className="tb-fact"><span>Total amount</span><b>{T.rupees(f.total)}</b><span>Incl. GST</span></div>
      </div>
      <div className="tb-sheet-note">
        {f.pendingLines > 0 && <>Pending, will follow later: {f.pendingList.map((t, i) => <span key={i}>{i ? ', ' : ''}<strong>{t}</strong></span>)}.<br /></>}
        {whatsappNote(detail, false)}
      </div>
    </>
  )
}

// UPLOAD LR: where the LR photo comes from — two large buttons.
function LrSourceSheet({ order, me, notice, onPick, onCancel }) {
  return (
    <div className="tb-sheetwrap">
      <div className="tb-sheethead"><span className="tb-head-ini">{me.initials}</span><span className="tb-head-name">{T.firstName(me.name)}</span></div>
      <div className="tb-spacer" />
      <div className="tb-sheet tb-sheet-confirm">
        <div className="tb-confirm-name">{order.name}</div>
        <div className="tb-confirm-line">Upload the LR / transport receipt: take a photo now, or choose one already on this phone.</div>
        <div className="tb-lr-choice">
          <button className="tb-big tb-big-primary" onClick={() => onPick('camera')}>TAKE PHOTO</button>
          <button className="tb-big tb-big-skip" onClick={() => onPick('gallery')}>FROM GALLERY</button>
        </div>
        {notice?.error && <div className="tb-error">{notice.error}</div>}
        <div className="tb-confirm-btns">
          <button className="tb-sheet-btn" onClick={onCancel}>CANCEL</button>
        </div>
      </div>
    </div>
  )
}

// The LR photo just taken or chosen — this is UPLOAD LR's confirmation: the photo,
// the facts, CANCEL (left) and SEND (right); RETAKE / CHOOSE AGAIN up top. SEND
// saves the photo, marks the order dispatched and sends the WhatsApp with the photo.
function PhotoSheet({ order, me, call, photo, notice, from, onRetake, onBack, onSend }) {
  const [detail, error] = useDetail(call, order.id)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const f = detail ? T.dispatchFacts(detail) : null
  return (
    <div className="tb-sheetwrap">
      <div className="tb-sheethead"><span className="tb-head-ini">{me.initials}</span><span className="tb-head-name">{T.firstName(me.name)}</span>
        <div className="tb-spacer" /><button className="tb-head-switch" onClick={onRetake} disabled={busy}>{from === 'gallery' ? 'CHOOSE AGAIN' : 'RETAKE'}</button></div>
      <div className="tb-sheet tb-sheet-confirm tb-photo-sheet">
        <div className="tb-confirm-name">{order.name}{order.city ? `, ${order.city}` : ''}</div>
        <div className="tb-confirm-line">Upload LR and mark {order.name} dispatched?</div>
        <div className="tb-photo-frame"><img src={photo} alt="LR photo" className="tb-photo" /></div>
        {error && <div className="tb-error">{error}</div>}
        {f && (
          <div className="tb-sheet-note">
            <strong>{f.boxes}</strong> {f.boxes === 1 ? 'box' : 'boxes'} · {f.sentLines} {f.sentLines === 1 ? 'line' : 'lines'} ({f.pieces} pcs)
            {f.pendingLines > 0 && <> · <span className="tb-amber">{f.pendingLines} pending</span></>} · {T.rupees(f.total)}<br />
            {whatsappNote(detail, true)}
          </div>
        )}
        {notice?.error && <div className="tb-error">{notice.error}</div>}
        <div className="tb-confirm-btns">
          <button className="tb-sheet-btn" disabled={busy} onClick={onBack}>CANCEL</button>
          <button className="tb-sheet-btn tb-sheet-btn-green" disabled={busy}
            onClick={async () => { setBusy(true); try { await onSend() } finally { if (alive.current) setBusy(false) } }}>{busy ? <><span className="tb-spin" aria-hidden="true" />SENDING…</> : 'SEND'}</button>
        </div>
      </div>
    </div>
  )
}

// 2m — pending material (Pending material job): items to order, by supplier.
// MARK ORDERED asks "When will it arrive?" (2 / 4 / 7 days); the row then shows
// "Ordered 6 Oct · expected 10 Oct" until Busy shows the stock, then goes.
// The same list, with "pick a date" and CLEAR, is on /owner.
function Material({ call, notice, onBack, onAskOrdered }) {
  const [groups, setGroups] = useState(null)
  const [error, setError] = useState('')
  const [asking, setAsking] = useState(null) // item id waiting for "when will it arrive?"
  const load = useCallback(async () => {
    setError('')
    try {
      const r = await call('/api/tablet?op=material', { staff: true })
      if (r.ok) setGroups(r.data.items)
      else setError(r.data.error || `The server did not answer properly (code ${r.status}).`)
    } catch { setError('No connection to the server.') }
  }, [call])
  useEffect(() => { load() }, [load])
  return (
    <>
      <div className="tb-mat-top">
        <button className="tb-btn-outline" onClick={onBack}>‹  All jobs</button>
        <span className="tb-mat-title">Pending material</span>
        <span className="tb-mat-sub">Items open orders need beyond the stock in Busy</span>
      </div>
      <div className="tb-mat-list">
        {notice?.ok && <div className="tb-ok">{notice.ok}</div>}
        {error && <div className="tb-error">{error}</div>}
        {!groups && !error && <p className="tb-p">Loading…</p>}
        {groups && !groups.length && <p className="tb-p">Nothing to order — stock covers every open order.</p>}
        {groups && groups.map(g => (
          <div className="tb-mat-group" key={g.supplier}>
            <div className="tb-mat-ghead"><span className="tb-mat-gname">{g.supplier}</span><span className="tb-mat-gcount">{g.items.length} {g.items.length === 1 ? 'item' : 'items'}</span></div>
            {g.items.map(it => (
              <div className={`tb-mat-row${it.orderedAt ? (it.late ? ' tb-mat-row-amber' : '') : ' tb-mat-row-red'}`} key={it.id}>
                <span className="tb-mat-item">{it.item}</span>
                <span className="tb-mat-qty">short {it.short}</span>
                <span className="tb-mat-for">{(it.orders.length ? it.orders.map(o => o.name) : it.forParties).join(', ')}</span>
                <span className={`tb-mat-status${it.orderedAt ? (it.late ? ' tb-mat-status-amber' : ' tb-mat-status-ok') : ''}`}>
                  {it.orderedAt ? `Ordered ${T.shortDate(it.orderedAt)} · expected ${T.shortDate(it.expectedDate)}${it.late ? ' — late' : ''}` : 'Not ordered'}
                </span>
                {asking === it.id
                  ? <span className="tb-mat-when">
                      {[2, 4, 7].map(n => <button key={n} className="tb-btn-outline" onClick={() => { setAsking(null); onAskOrdered(it, n) }}>{n} days</button>)}
                      <button className="tb-link" onClick={() => setAsking(null)}>Cancel</button>
                    </span>
                  : it.orderedAt
                    ? <button className="tb-btn-outline tb-mat-btn" onClick={() => setAsking(it.id)}>Change date</button>
                    : <button className="tb-big-primary tb-mat-btn" onClick={() => setAsking(it.id)}>MARK ORDERED</button>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}
