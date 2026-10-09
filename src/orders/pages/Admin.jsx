import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { getDeviceToken, setDeviceToken } from '../lib/storage.js'
import { openSidebar } from '../../sidebar.js'
import { formatCreated } from '../lib/board-logic.js'
import { shortDate } from '../lib/tablet-logic.js'
import '../admin.css'
import TvDisplay from './TvDisplay.jsx'

const LIMITS = [
  ['new', 'New', 'from the order arriving until someone taps I’m picking this'],
  ['picking', 'Picking', 'until Busy makes the invoice'],
  ['invoiced', 'Invoiced', 'until a supervisor checks it'],
  ['checked', 'Checked', 'until it is packed and in the dispatch bay'],
  ['in_bay', 'Ready for Dispatch', 'until it leaves the gate'],
]
// Any failed call shows a message on the page; nothing fails silently.
export const serverError = r => r.data.error || `The server did not answer properly (code ${r.status}). Try again in a minute.`
export const NO_CONNECTION = 'No connection to the server. Check the internet and try again.'

const asHours = m => (m >= 60 ? ` = ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : '')

// JCM HQ: no separate orders sign-in. The person is already signed in to HQ;
// api.js sends that sign-in with every call and the server checks it (admin,
// or this page ticked for them in Manage Users). "Session" here only carries
// the name for the header; a 401 swaps the page for the no-access card below.
let hqName = ''
export function setHqName(name) { hqName = name || '' }

export function useAdminSession() {
  const [session, setSession] = useState(() => ({ token: 'hq', name: hqName }))
  const signOut = useCallback(() => setSession(null), [])
  const onSignedIn = useCallback(() => setSession({ token: 'hq', name: hqName }), [])
  return { session, signOut, onSignedIn }
}

// The page header inside HQ: the sidebar replaces the old JCM Orders header
// links; on a phone the ☰ opens the same drawer as every other HQ page.
export function HqHead({ title, sub }) {
  return (
    <header className="jo-head jo-hqhead">
      <button type="button" className="jo-hamb" onClick={() => openSidebar()} aria-label="Menu">☰</button>
      <span className="jo-title">{title}</span>
      {sub && <span className="jo-sub">{sub}</span>}
      <div className="jo-spacer" />
    </header>
  )
}

export default function Admin() {
  const { session, signOut, onSignedIn } = useAdminSession()

  return (
    <div className="jo-admin">
      <HqHead title="Warehouse & Devices" sub="Screens, tablet staff, time limits, carton labels" />
      <main className="jo-main">
        {session ? <Panels session={session} onExpired={signOut} /> : <SignIn onSignedIn={onSignedIn} />}
      </main>
    </div>
  )
}

export function SignIn({ onSignedIn }) {
  return (
    <div className="jo-card jo-signin">
      <h1 className="jo-h1">No access</h1>
      <p className="jo-p">This page did not open for you. Either your sign-in has expired, or this page has not been given to you in Manage Users.</p>
      <div className="jo-row">
        <button className="jo-btn" onClick={onSignedIn}>Try again</button>
        <button className="jo-btn jo-btn-outline" onClick={() => location.reload()}>Reload</button>
      </div>
    </div>
  )
}

// Registering a screen stores its key in THIS browser for the site it runs on.
// The TV board and tablets still run on orders.jcmretails.com, so a key made
// here would land in the wrong place. Until the board moves (board.jcmretails.com),
// new screens are registered there; switching screens off works here.
function RegisterElsewhere() {
  return (
    <section className="jo-card">
      <h2 className="jo-h2">Register a new screen</h2>
      <p className="jo-p">For now, register a new TV or tablet on that screen itself by opening <b>orders.jcmretails.com/admin</b>. All registered screens show below, and you can switch any of them off or on from here.</p>
    </section>
  )
}

function Panels({ session, onExpired }) {
  const call = useCallback(async (path, opts = {}) => {
    const r = await api(path, { ...opts, admin: session.token })
    if (r.status === 401) onExpired()
    return r
  }, [session.token, onExpired])
  const [devices, setDevices] = useState(null)
  const [devicesError, setDevicesError] = useState('')
  const refresh = useCallback(async () => {
    setDevicesError('')
    try {
      const r = await call('/api/admin/devices')
      if (r.ok) setDevices(r.data.devices)
      else if (r.status !== 401) setDevicesError(serverError(r))
    } catch {
      setDevicesError(NO_CONNECTION)
    }
  }, [call])
  useEffect(() => { refresh() }, [refresh])

  return (
    <>
      <RegisterElsewhere />
      <Devices devices={devices} loadError={devicesError} call={call} onChanged={refresh} />
      <TvDisplay call={call} />
      <TabletStaff call={call} />
      <Limits call={call} />
      <CartonLabel call={call} />
      <CloseOld call={call} />
    </>
  )
}

// Carton label: English only, or English + Hindi (party name and city in
// Devanagari), and the Hindi spellings — made by Google's transliteration
// ("needs review" until checked) and corrected here. Stored once, reused on every label.
function CartonLabel({ call }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('review')
  const [q, setQ] = useState('')
  const load = useCallback(async () => {
    setError('')
    try {
      const r = await call('/api/admin/hindi')
      if (r.ok) setData(r.data); else if (r.status !== 401) setError(serverError(r))
    } catch { setError(NO_CONNECTION) }
  }, [call])
  useEffect(() => { load() }, [load])

  const post = async (body, ok, optimistic) => {
    setMsg(null)
    const before = data
    if (optimistic) setData(d => optimistic(d))
    try {
      const r = await call('/api/admin/hindi', { method: 'POST', body })
      if (!r.ok) { setData(before); if (r.status !== 401) setMsg({ error: `Not saved — ${serverError(r)}` }); return null }
      if (ok) setMsg({ ok: ok(r.data) })
      return r.data
    } catch { setData(before); setMsg({ error: `Not saved — ${NO_CONNECTION}` }); return null }
  }
  const setRow = (key, change) => d => ({ ...d, rows: d.rows.map(x => (x.key === key ? { ...x, ...change } : x)) })
  const generate = async () => {
    setBusy(true)
    const d = await post({ op: 'generate' }, x => `Made ${x.made} Hindi ${x.made === 1 ? 'spelling' : 'spellings'}${x.failed ? ` (${x.failed} could not be made — try again later)` : ''}. Check them below.`)
    if (d) setData(old => ({ ...old, rows: d.rows, missing: d.missing }))
    setBusy(false)
  }

  if (error) return <section className="jo-card"><h2 className="jo-h2">Carton label</h2><div className="jo-error">{error} <button className="jo-link" onClick={load}>Try again</button></div></section>
  if (!data) return <section className="jo-card"><h2 className="jo-h2">Carton label</h2><p className="jo-p">Loading…</p></section>
  const review = data.rows.filter(r => r.needsReview).length
  const needle = q.trim().toLowerCase()
  const shown = data.rows.filter(r => (filter === 'all' || r.needsReview) && (!needle || r.english.toLowerCase().includes(needle) || r.hindi.includes(q.trim())))
  return (
    <section className="jo-card">
      <h2 className="jo-h2">Carton label</h2>
      <p className="jo-p">Language on the 4 × 6 labels. With Hindi, the party name and the city are also printed in Devanagari, under the English (the address stays English).</p>
      <div className="jo-row">
        {[['en_hi', 'English + Hindi'], ['en', 'English only']].map(([v, l]) => (
          <button key={v} className={`jo-btn${data.language === v ? '' : ' jo-btn-outline'}`} aria-pressed={data.language === v}
            onClick={() => data.language !== v && post({ op: 'language', language: v }, () => `Labels now print in ${l}.`, d => ({ ...d, language: v }))}>{l}</button>
        ))}
      </div>

      <h3 className="jo-h3">Hindi names</h3>
      {!data.ready ? <p className="jo-p">Not set up yet: run <b>supabase/phase10-label-hindi.sql</b> in Supabase. Until then labels print in English.</p> : <>
        <p className="jo-p">
          {data.rows.length} stored · <b>{review} need review</b>{data.missing.length ? <> · {data.missing.length} not made yet</> : null}.
          {' '}New names are made by themselves the first time their labels print; “needs review” means a computer spelt it — correct it if needed, or tap “Looks right”.
        </p>
        {data.missing.length > 0 && (
          <div className="jo-row">
            <button className="jo-btn jo-btn-outline" disabled={busy} onClick={generate}>{busy ? 'Making…' : `Make the missing ones now${data.missing.length > 40 ? ' (40 at a time)' : ''}`}</button>
            <span className="jo-hint">{data.missing.slice(0, 4).map(m => m.english).join(', ')}{data.missing.length > 4 ? ' …' : ''}</span>
          </div>
        )}
        <div className="jo-row jo-hi-tools">
          {[['review', `Needs review (${review})`], ['all', `All (${data.rows.length})`]].map(([v, l]) => (
            <button key={v} className={`jo-btn jo-btn-small${filter === v ? '' : ' jo-btn-outline'}`} onClick={() => setFilter(v)}>{l}</button>
          ))}
          <input id="jo-hi-search" name="hindiSearch" className="jo-input jo-hi-search" placeholder="Search a name" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className="jo-hi-list">
          {shown.map(r => <HindiRow key={r.key} r={r}
            onSave={hindi => post({ op: 'save', key: r.key, hindi }, () => `${r.english}: saved.`, setRow(r.key, { hindi, needsReview: false, source: 'manual' }))}
            onAccept={() => post({ op: 'accept', key: r.key }, null, setRow(r.key, { needsReview: false }))} />)}
          {!shown.length && <p className="jo-p">{filter === 'review' ? 'Nothing needs review.' : 'No Hindi names yet.'}</p>}
        </div>
      </>}
      {msg?.ok && <div className="jo-ok">{msg.ok}</div>}
      {msg?.error && <div className="jo-error">{msg.error}</div>}
    </section>
  )
}

function HindiRow({ r, onSave, onAccept }) {
  const [text, setText] = useState(r.hindi)
  useEffect(() => { setText(r.hindi) }, [r.hindi])
  const changed = text.trim() !== r.hindi
  return (
    <div className={`jo-hi-row${r.needsReview ? ' jo-hi-review' : ''}`}>
      <div className="jo-hi-en"><span className="jo-strong">{r.english}</span><span className="jo-hint">{r.kind === 'city' ? 'City' : 'Party'}{r.source === 'manual' ? ' · typed' : ' · made by computer'}</span></div>
      <input className="jo-input jo-hi-input" lang="hi" aria-label={`Hindi for ${r.english}`} value={text} onChange={e => setText(e.target.value)} />
      <span className={`jo-hi-state${r.needsReview ? ' jo-hi-state-review' : ''}`}>{r.needsReview ? 'needs review' : 'checked'}</span>
      <span className="jo-row">
        {changed && <button className="jo-btn jo-btn-small" onClick={() => onSave(text.trim())}>Save</button>}
        {!changed && r.needsReview && <button className="jo-btn jo-btn-small jo-btn-outline" onClick={onAccept}>Looks right</button>}
      </span>
    </div>
  )
}

function ThisScreen({ call, onRegistered }) {
  const [hasKey, setHasKey] = useState(() => !!getDeviceToken())
  const [name, setName] = useState('Warehouse TV')
  const [kind, setKind] = useState('tv')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const register = async e => {
    e.preventDefault()
    setBusy(true); setMsg(null)
    try {
      const r = await call('/api/admin/devices', { method: 'POST', body: { name, kind } })
      if (!r.ok) setMsg({ error: serverError(r) })
      else if (!setDeviceToken(r.data.token)) setMsg({ error: 'This browser will not save the key (private window or blocked storage). Use a normal window.' })
      else { setHasKey(true); setMsg({ ok: `Registered as “${r.data.device.name}”.` }); onRegistered() }
    } catch {
      setMsg({ error: NO_CONNECTION })
    }
    setBusy(false)
  }
  return (
    <section className="jo-card">
      <h2 className="jo-h2">This screen</h2>
      <p className="jo-p">
        {hasKey
          ? 'This browser already has a screen key. Registering again gives it a new one (switch the old entry off below).'
          : 'This browser is not registered yet. Register it to let it open the TV board.'}
      </p>
      <form className="jo-row" onSubmit={register}>
        <label className="jo-label">NAME<input id="jo-screen-name" name="screenName" className="jo-input" value={name} maxLength={60} onChange={e => setName(e.target.value)} /></label>
        <label className="jo-label">TYPE
          <select id="jo-screen-type" name="screenType" className="jo-input" value={kind} onChange={e => setKind(e.target.value)}>
            <option value="tv">TV board</option>
            <option value="tablet">Staff tablet</option>
          </select>
        </label>
        <button className="jo-btn" disabled={busy || !name.trim()}>{busy ? 'Registering…' : 'Register this screen'}</button>
        {hasKey && <a className="jo-btn jo-btn-outline" href="/board">Open the TV board</a>}
      </form>
      {msg?.ok && <div className="jo-ok">{msg.ok} <a href="/board">Open the TV board ›</a></div>}
      {msg?.error && <div className="jo-error">{msg.error}</div>}
    </section>
  )
}

function Devices({ devices, loadError, call, onChanged }) {
  const [error, setError] = useState('')
  const toggle = async d => {
    setError('')
    try {
      const r = await call('/api/admin/devices', { method: 'PATCH', body: { id: d.id, active: !d.active } })
      if (!r.ok) setError(serverError(r))
    } catch { setError(NO_CONNECTION) }
    onChanged()
  }
  return (
    <section className="jo-card">
      <h2 className="jo-h2">Registered screens</h2>
      {loadError ? <div className="jo-error">{loadError} <button className="jo-link" onClick={onChanged}>Try again</button></div> : !devices ? <p className="jo-p">Loading…</p> : !devices.length ? <p className="jo-p">None yet.</p> : (
        <div className="jo-table">
          <div className="jo-tr jo-th"><span>NAME</span><span>TYPE</span><span>REGISTERED</span><span>LAST SEEN</span><span>STATUS</span><span /></div>
          {devices.map(d => (
            <div className="jo-tr" key={d.id}>
              <span className="jo-strong">{d.name}</span>
              <span>{d.kind === 'tv' ? 'TV board' : 'Staff tablet'}</span>
              <span>{formatCreated(d.created_at)}</span>
              <span>{d.last_seen_at ? formatCreated(d.last_seen_at) : 'Never'}</span>
              <span className={d.active ? 'jo-on' : 'jo-off'}>{d.active ? 'On' : 'Switched off'}</span>
              <button className="jo-link" onClick={() => toggle(d)}>{d.active ? 'Switch off' : 'Switch on'}</button>
            </div>
          ))}
        </div>
      )}
      {error && <div className="jo-error">{error}</div>}
    </section>
  )
}

function Limits({ call }) {
  const [values, setValues] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const load = useCallback(async () => {
    setLoadError('')
    try {
      const r = await call('/api/admin/settings')
      if (r.ok) setValues(Object.fromEntries(Object.entries(r.data.thresholds).map(([k, v]) => [k, String(v)])))
      else if (r.status !== 401) setLoadError(serverError(r))
    } catch {
      setLoadError(NO_CONNECTION)
    }
  }, [call])
  useEffect(() => { load() }, [load])
  const save = async e => {
    e.preventDefault()
    setBusy(true); setMsg(null)
    try {
      const thresholds = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)]))
      const r = await call('/api/admin/settings', { method: 'POST', body: { thresholds } })
      setMsg(r.ok ? { ok: 'Saved. The TV board uses the new limits within 15 seconds.' } : { error: serverError(r) })
    } catch { setMsg({ error: NO_CONNECTION }) }
    setBusy(false)
  }
  return (
    <section className="jo-card">
      <h2 className="jo-h2">Stage time limits</h2>
      <p className="jo-p">How long an order may stay in each stage before its card gets a red edge and red timer on the TV board. In minutes.</p>
      {loadError ? <div className="jo-error">{loadError} <button className="jo-link" onClick={load}>Try again</button></div> : !values ? <p className="jo-p">Loading…</p> : (
        <form onSubmit={save}>
          <div className="jo-limits">
            {LIMITS.map(([k, label, hint]) => (
              <label className="jo-limit" key={k}>
                <span className="jo-strong">{label}</span>
                <span className="jo-hint">{hint}</span>
                <span className="jo-limit-input">
                  <input id={`jo-limit-${k}`} name={k} className="jo-input" inputMode="numeric" value={values[k]} onChange={e => setValues(v => ({ ...v, [k]: e.target.value.replace(/\D/g, '') }))} />
                  <span className="jo-hint">min{asHours(Number(values[k]) || 0)}</span>
                </span>
              </label>
            ))}
          </div>
          <button className="jo-btn" disabled={busy}>{busy ? 'Saving…' : 'Save time limits'}</button>
          {msg?.ok && <div className="jo-ok">{msg.ok}</div>}
          {msg?.error && <div className="jo-error">{msg.error}</div>}
        </form>
      )}
    </section>
  )
}

// Who appears on the tablet's "Tap your name" screen, and which jobs (home
// cards) each person gets. Staff sign in with their CRM PIN. Admins get every job.
const JOBS = [['pick', 'Pick'], ['check', 'Check'], ['ready', 'Ready for dispatch'], ['dispatch', 'Dispatch'], ['material', 'Pending material']]
function TabletStaff({ call }) {
  const [people, setPeople] = useState(null)
  const [staff, setStaff] = useState(new Set())
  const [access, setAccess] = useState({})
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const load = useCallback(async () => {
    setLoadError('')
    try {
      const r = await call('/api/admin/settings')
      if (r.ok) {
        setPeople(r.data.people)
        setStaff(new Set(r.data.tabletStaff.staff))
        setAccess(r.data.tabletStaff.access || {})
      } else if (r.status !== 401) setLoadError(serverError(r))
    } catch { setLoadError(NO_CONNECTION) }
  }, [call])
  useEffect(() => { load() }, [load])
  const flipStaff = id => {
    const n = new Set(staff)
    if (n.has(id)) n.delete(id)
    else { n.add(id); if (!access[id]) setAccess(a => ({ ...a, [id]: ['pick'] })) } // someone new starts with Pick
    setStaff(n)
  }
  const flipJob = (id, job) => setAccess(a => {
    const now = a[id] || []
    return { ...a, [id]: now.includes(job) ? now.filter(j => j !== job) : [...now, job] }
  })
  const save = async () => {
    setBusy(true); setMsg(null)
    try {
      const body = { tabletStaff: { staff: [...staff], access: Object.fromEntries([...staff].map(id => [id, access[id] || []])) } }
      const r = await call('/api/admin/settings', { method: 'POST', body })
      setMsg(r.ok ? { ok: 'Saved. The tablet shows the new list the next time it goes back to “Tap your name”.' } : { error: serverError(r) })
    } catch { setMsg({ error: NO_CONNECTION }) }
    setBusy(false)
  }
  return (
    <section className="jo-card">
      <h2 className="jo-h2">Tablet staff</h2>
      <p className="jo-p">Tick who appears on the tablet (and phones), then the jobs each person does. A person sees only the cards for their ticked jobs; the server refuses anything else. They sign in with their CRM PIN. Admins get every job.</p>
      {loadError ? <div className="jo-error">{loadError} <button className="jo-link" onClick={load}>Try again</button></div> : !people ? <p className="jo-p">Loading…</p> : (
        <>
          <div className="jo-table">
            <div className="jo-tr jo-tr-staff jo-th"><span>NAME</span><span>ON TABLET</span>{JOBS.map(([k, l]) => <span key={k}>{l.toUpperCase()}</span>)}</div>
            {people.map(p => (
              <div className="jo-tr jo-tr-staff" key={p.id}>
                <div className="jo-two"><span className="jo-strong">{p.name}</span><span className="jo-hint">{p.email}</span></div>
                <label className="jo-check"><input type="checkbox" id={`jo-on-${p.id}`} name={`on-${p.id}`} checked={staff.has(p.id)} onChange={() => flipStaff(p.id)} /> On tablet</label>
                {p.isAdmin
                  ? <span className="jo-hint jo-span-jobs">Admin — every job</span>
                  : JOBS.map(([k, l]) => (
                    <label className="jo-check" key={k} title={l}>
                      <input type="checkbox" id={`jo-${k}-${p.id}`} name={`${k}-${p.id}`} disabled={!staff.has(p.id)} checked={staff.has(p.id) && (access[p.id] || []).includes(k)} onChange={() => flipJob(p.id, k)} />
                      <span className="jo-check-label">{l}</span>
                    </label>
                  ))}
              </div>
            ))}
          </div>
          <button className="jo-btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save tablet staff'}</button>
          {msg?.ok && <div className="jo-ok">{msg.ok}</div>}
          {msg?.error && <div className="jo-error">{msg.error}</div>}
        </>
      )}
    </section>
  )
}

// "Close orders older than N days": check first (shows the count), then confirm.
// Closed orders are marked dispatched with a history note, and the sync never reopens them.
function CloseOld({ call }) {
  const [days, setDays] = useState('30')
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const send = async confirm => {
    setBusy(true); setMsg(null)
    try {
      const r = await call('/api/admin/settings', { method: 'POST', body: { closeOld: { days: Number(days), confirm } } })
      if (!r.ok) setMsg({ error: serverError(r) })
      else if (confirm) { setPreview(null); setMsg({ ok: `Closed ${r.data.closed} ${r.data.closed === 1 ? 'order' : 'orders'}. They leave the TV board within 15 seconds.` }) }
      else setPreview(r.data)
    } catch { setMsg({ error: NO_CONNECTION }) }
    setBusy(false)
  }
  return (
    <section className="jo-card">
      <h2 className="jo-h2">Close old orders</h2>
      <p className="jo-p">Closes every open order with an order date more than this many days ago. They are marked dispatched with a history note, leave the board, and are never reopened by the sync. Nothing is deleted.</p>
      <div className="jo-row">
        <label className="jo-label">OLDER THAN (DAYS)
          <input id="jo-close-days" name="closeDays" className="jo-input" inputMode="numeric" value={days}
            onChange={e => { setDays(e.target.value.replace(/\D/g, '')); setPreview(null) }} />
        </label>
        <button className="jo-btn jo-btn-outline" disabled={busy || !Number(days)} onClick={() => send(false)}>Check how many</button>
      </div>
      {preview && (
        <div className="jo-confirm">
          {preview.count === 0
            ? <p className="jo-p">No open orders are dated before {shortDate(preview.cutoff)}. Nothing to close.</p>
            : <>
                <p className="jo-p"><b>{preview.count} open {preview.count === 1 ? 'order' : 'orders'}</b> dated before {shortDate(preview.cutoff)} will be closed, for example: {preview.sample.map(o => `${o.name} (${o.soNo}, ${shortDate(o.soDate)})`).join(', ')}{preview.count > preview.sample.length ? ' …' : ''}</p>
                <div className="jo-row">
                  <button className="jo-btn jo-btn-danger" disabled={busy} onClick={() => send(true)}>{busy ? 'Closing…' : `Yes, close ${preview.count} ${preview.count === 1 ? 'order' : 'orders'}`}</button>
                  <button className="jo-btn jo-btn-outline" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
                </div>
              </>}
        </div>
      )}
      {msg?.ok && <div className="jo-ok">{msg.ok}</div>}
      {msg?.error && <div className="jo-error">{msg.error}</div>}
    </section>
  )
}
