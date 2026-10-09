import { useEffect, useState } from 'react'
import { api } from './lib/api.js'

// "Busy 4:19 pm" — when the Busy → orders sync on JCM-Server last finished.
// It runs every 3 minutes; amber after 10 minutes, like the TV's BUSY SYNC marker.
const LATE_MS = 10 * 60 * 1000

function when(iso) {
  const d = new Date(iso)
  const opt = { timeZone: 'Asia/Kolkata' }
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', ...opt })
  const today = new Date().toLocaleDateString('en-IN', opt) === d.toLocaleDateString('en-IN', opt)
  return today ? time : `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', ...opt })}, ${time}`
}

export default function SyncChip() {
  const [at, setAt] = useState(null)
  const [, tick] = useState(0)
  useEffect(() => {
    let alive = true
    const load = () => api('/api/admin/sync', { admin: true }).then(r => { if (alive && r.ok) setAt(r.data.lastSync || null) })
    load()
    const a = setInterval(load, 60000)
    const b = setInterval(() => tick(n => n + 1), 30000)
    return () => { alive = false; clearInterval(a); clearInterval(b) }
  }, [])
  if (!at) return null
  const late = Date.now() - Date.parse(at) > LATE_MS
  return <span className={`hq-sync${late ? ' is-late' : ''}`} title="Last Busy orders sync">Busy {when(at)}</span>
}
