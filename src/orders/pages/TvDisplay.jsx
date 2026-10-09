import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { buildColumns, formatClock, formatDay, layoutFor, syncMarker, displaySettings, DISPLAY_DEFAULTS } from '../lib/board-logic.js'
import { formatCreated } from '../lib/board-logic.js'
import { serverError, NO_CONNECTION } from './Admin.jsx'
import '../board.css'

// Warehouse & Devices → TV display. The v2 design's "Admin → TV display" tab
// ("TV board v2 design/README.md", screenshot 2d), which the orders site never
// got: layout preset, cards per column, text size, scroll speed, late-order
// style, SO / invoice numbers. The admin edits a draft, the live preview shows
// the draft on today's real orders, and "Send to TV" saves it — every TV picks
// it up on its next 15-second refresh. Reset puts the defaults in the draft
// (nothing is saved until Send to TV).
const PRESETS = [['Large', 3], ['Medium', 5], ['Compact', 7]]
const TEXT = [['90%', 0.9], ['100%', 1], ['115%', 1.15], ['130%', 1.3]]
const SPEEDS = [['Slow', 'slow'], ['Normal', 'normal'], ['Fast', 'fast']]
const LATE = [['Red timer', 'timer'], ['Red timer + edge', 'edge']]
const PREVIEW_REFRESH_MS = 15000

const kindName = n => (n <= 3 ? 'Large' : n <= 5 ? 'Medium' : 'Compact')
const same = (a, b) => JSON.stringify(displaySettings(a)) === JSON.stringify(displaySettings(b))
const describe = d => `${kindName(d.cardsPerColumn)} · ${d.cardsPerColumn} per column · ${Math.round(d.textScale * 100)}% text`

export default function TvDisplay({ call }) {
  const [saved, setSaved] = useState(null)       // { value, updatedAt } as the TV has it
  const [draft, setDraft] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')

  useEffect(() => {
    (async () => {
      try {
        const r = await call('/api/admin/settings')
        if (!r.ok) { if (r.status !== 401) setError(serverError(r)); return }
        const tv = r.data.tvDisplay
        setSaved(tv)
        setDraft(displaySettings(tv?.value))
      } catch { setError(NO_CONNECTION) }
    })()
  }, [call])

  const set = patch => { setDraft(d => ({ ...d, ...patch })); setDone('') }

  const send = async () => {
    setBusy(true); setError(''); setDone('')
    try {
      const r = await call('/api/admin/settings', { method: 'POST', body: { tvDisplay: draft } })
      if (r.ok) { setSaved(r.data.tvDisplay); setDraft(displaySettings(r.data.tvDisplay.value)); setDone('Sent — the TV changes within 15 seconds.') }
      else if (r.status !== 401) setError(serverError(r))
    } catch { setError(NO_CONNECTION) }
    setBusy(false)
  }

  if (!draft) {
    return (
      <section className="jo-card">
        <h2 className="jo-h2">TV display</h2>
        {error ? <div className="jo-error">{error}</div> : <p className="jo-p">Loading…</p>}
      </section>
    )
  }

  const showing = displaySettings(saved?.value)
  const changed = !same(draft, saved?.value)
  const preset = PRESETS.find(p => p[1] === draft.cardsPerColumn)

  return (
    <section className="jo-card">
      <h2 className="jo-h2">TV display</h2>
      <p className="jo-p">How the warehouse TV looks. Change it here, check the preview, then press Send to TV.</p>

      <div className="jo-tv-grid">
        <div className="jo-tv-group">
          <span className="jo-tv-label">Layout</span>
          <div className="jo-tv-choices jo-tv-3">
            {PRESETS.map(([name, n]) => (
              <button key={name} className={`jo-tv-choice jo-tv-preset${preset?.[1] === n ? ' on' : ''}`} onClick={() => set({ cardsPerColumn: n })}>
                <b>{name}</b><span>{n} per column</span>
              </button>
            ))}
          </div>
        </div>

        <div className="jo-tv-group">
          <span className="jo-tv-label">Cards per column</span>
          <div className="jo-tv-stepper">
            <button className="jo-tv-step" disabled={draft.cardsPerColumn <= 3} onClick={() => set({ cardsPerColumn: draft.cardsPerColumn - 1 })} aria-label="Fewer cards">−</button>
            <span className="jo-tv-count">{draft.cardsPerColumn}</span>
            <button className="jo-tv-step" disabled={draft.cardsPerColumn >= 7} onClick={() => set({ cardsPerColumn: draft.cardsPerColumn + 1 })} aria-label="More cards">+</button>
            <span className="jo-tv-hint">3 to 7. Columns with more orders scroll.</span>
          </div>
        </div>

        <div className="jo-tv-group">
          <span className="jo-tv-label">Text size</span>
          <div className="jo-tv-choices jo-tv-4">
            {TEXT.map(([label, v]) => (
              <button key={label} className={`jo-tv-choice${Math.abs(draft.textScale - v) < 0.001 ? ' on' : ''}`} onClick={() => set({ textScale: v })}>{label}</button>
            ))}
          </div>
        </div>

        <div className="jo-tv-group">
          <span className="jo-tv-label">Scroll speed</span>
          <div className="jo-tv-choices jo-tv-3">
            {SPEEDS.map(([label, v]) => (
              <button key={v} className={`jo-tv-choice${draft.scrollSpeed === v ? ' on' : ''}`} onClick={() => set({ scrollSpeed: v })}>{label}</button>
            ))}
          </div>
        </div>

        <div className="jo-tv-group">
          <span className="jo-tv-label">Late orders</span>
          <div className="jo-tv-choices jo-tv-2">
            {LATE.map(([label, v]) => (
              <button key={v} className={`jo-tv-choice${draft.lateStyle === v ? ' on' : ''}`} onClick={() => set({ lateStyle: v })}>{label}</button>
            ))}
          </div>
        </div>

        <div className="jo-tv-group">
          <span className="jo-tv-label">SO and invoice numbers</span>
          <button className={`jo-tv-switchrow${draft.showRefs ? ' on' : ''}`} role="switch" aria-checked={draft.showRefs} onClick={() => set({ showRefs: !draft.showRefs })}>
            <span><b>Show SO and invoice numbers</b><br /><small>Turn off for a cleaner card</small></span>
            <span className="jo-tv-switch"><span /></span>
          </button>
        </div>
      </div>

      <div className="jo-row jo-tv-actions">
        <button className="jo-btn jo-btn-big" disabled={busy || !changed} onClick={send}>{busy ? 'Sending…' : 'Send to TV'}</button>
        <button className="jo-btn jo-btn-outline" disabled={busy || same(draft, DISPLAY_DEFAULTS)} onClick={() => set(displaySettings(DISPLAY_DEFAULTS))}>Reset</button>
        {changed && <span className="jo-tv-draftnote">Not sent yet — the TV still shows the old look.</span>}
        {done && <span className="jo-ok">{done}</span>}
      </div>
      {error && <div className="jo-error">{error}</div>}
      <div className="jo-tv-showing">
        <span className="jo-tv-label">TV is showing</span>
        {describe(showing)} · {showing.scrollSpeed} scroll{saved?.updatedAt ? ` · applied ${formatCreated(saved.updatedAt)}` : ' · default look (never changed)'}
      </div>

      <TvPreview call={call} draft={draft} />
    </section>
  )
}

// The board as the TV draws it (same parts as jcm-orders src/pages/Board.jsx),
// drawn from today's real orders with the DRAFT settings, scaled to fit the page.
function TvPreview({ call, draft }) {
  const box = useRef(null)
  const [scale, setScale] = useState(0.4)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(() => Date.now())
  const [skew, setSkew] = useState(0)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setScale(el.clientWidth / 1920)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const load = useCallback(async () => {
    try {
      const r = await call('/api/admin/board')
      if (r.ok) { setData(r.data); setSkew(Date.parse(r.data.now) - Date.now()); setError('') }
      else if (r.status !== 401) setError(serverError(r))
    } catch { setError(NO_CONNECTION) }
  }, [call])

  useEffect(() => {
    load()
    const t = setInterval(load, PREVIEW_REFRESH_MS)
    const c = setInterval(() => setTick(Date.now()), 10000)
    return () => { clearInterval(t); clearInterval(c) }
  }, [load])

  const now = tick + skew
  const lay = useMemo(() => layoutFor(draft), [draft])
  const columns = useMemo(() => (data ? buildColumns(data.cards, data.thresholds, now, lay) : []), [data, now, lay])
  const sync = data ? syncMarker(data.lastSyncAt, now) : null
  const c = data?.counters

  return (
    <div className="jo-tv-preview">
      <div className="jo-tv-preview-head">
        <span className="jo-tv-label">Live preview · {kindName(draft.cardsPerColumn)}</span>
        <span className="jo-tv-hint">Today’s real orders · 1920 × 1080 shown at {Math.round(scale * 100)}%</span>
      </div>
      <div className="jo-tv-frame" ref={box} style={{ height: Math.round(1080 * scale) }}>
        <div className="tv" style={{ transform: `scale(${scale})` }}>
          <header className="tv-head">
            <img src="/jcm-logo.png" alt="JCM Retails" className="tv-logo" />
            <div className="tv-clock">
              <span className="tv-time">{formatClock(new Date(now))}</span>
              <span className="tv-date">{formatDay(new Date(now))}</span>
            </div>
            <div className="tv-spacer" />
            {c && [[c.open, 'Open'], [c.dispatchedToday, 'Dispatched today'], [c.waiting, 'Waiting']].map(([n, l]) => (
              <div className="tv-counter" key={l}><span className="tv-counter-n">{n}</span><span className="tv-counter-l">{l}</span></div>
            ))}
            {sync && (
              <div className={`tv-sync${sync.stale ? ' tv-sync-stale' : ''}`}>
                <span className="tv-sync-label"><span className="tv-sync-dot" />BUSY SYNC</span>
                <span className="tv-sync-text">{sync.text}</span>
              </div>
            )}
          </header>
          {!data && (
            <div className="tv-message"><div className="tv-message-small">{error ? <b>{error}</b> : 'Loading orders…'}</div></div>
          )}
          {data && (
            <div className="tv-grid">
              {columns.map(col => (
                <div className="tv-col" key={col.key}>
                  <div className="tv-col-head" style={{ borderTopColor: col.color }}>
                    <div className="tv-col-row"><span className="tv-col-title">{col.title}</span><span className="tv-col-count">{col.count}</span></div>
                    <span className="tv-col-loc">{col.loc || ' '}</span>
                  </div>
                  <div className="tv-list" style={{ WebkitMaskImage: col.mask, maskImage: col.mask }}>
                    {col.empty && <div className="tv-empty">No orders</div>}
                    <div className="tv-list-inner" style={{ gap: lay.gap, '--cycle': col.cycle, animation: col.animation }}>
                      {col.items.map(it => it.marker ? (
                        <div className="tv-marker" key={it.key}>
                          <span className="tv-marker-line" /><span className="tv-marker-text">TOP OF LIST · {col.count}</span><span className="tv-marker-line" />
                        </div>
                      ) : <Card key={it.key} it={it} lay={lay} />)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// One card, exactly as jcm-orders src/pages/Board.jsx draws it.
function Card({ it, lay }) {
  const { fs, kind } = lay
  const style = { height: lay.cardHeight, background: it.bg, border: it.border, borderLeft: it.edge }
  if (kind === 'large') {
    return (
      <div className="tv-card tv-card-large" style={style}>
        {lay.showRefs && <div className="tv-card-refs" style={{ fontSize: fs.small }}><span>{it.soRef}</span><span>{it.invRef}</span></div>}
        <div className="tv-card-name" style={{ fontSize: fs.name }}>{it.name}</div>
        <div className="tv-card-fill" />
        <div className="tv-card-row tv-card-spread">
          <span className="tv-card-lines" style={{ fontSize: fs.mid }}>{it.lines}</span>
          <span className="tv-card-tag" style={{ fontSize: fs.small, color: it.tagColor }}>{it.tag}</span>
        </div>
        <div className="tv-card-row tv-card-spread tv-card-foot" style={{ fontSize: fs.small }}>
          <span className="tv-card-created">{it.created}</span>
          <span className="tv-card-timer" style={{ color: it.timerColor }}>{it.timer}</span>
        </div>
      </div>
    )
  }
  return (
    <div className={`tv-card tv-card-${kind}`} style={style}>
      <div className="tv-card-name" style={{ fontSize: fs.name }}>{it.name}</div>
      <div className="tv-card-row">
        <span className="tv-card-lines" style={{ fontSize: kind === 'compact' ? fs.small : fs.mid }}>{it.lines}</span>
        <span className="tv-card-tag" style={{ fontSize: fs.small, color: it.tagColor }}>{it.tag}</span>
        <span className="tv-card-timer" style={{ fontSize: fs.mid, color: it.timerColor }}>{it.timer}</span>
      </div>
      <div className="tv-card-row tv-card-meta" style={{ fontSize: fs.small }}>
        <span>{it.created}</span><span>{it.ref}</span>
      </div>
    </div>
  )
}
