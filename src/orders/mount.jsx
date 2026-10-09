import { Component } from 'react'
import { createRoot } from 'react-dom/client'
import Admin, { setHqName } from './pages/Admin.jsx'
import Owner from './pages/Owner.jsx'
import Logs from './pages/Logs.jsx'
import Floor from './pages/Floor.jsx'
import './hq-orders.css'

// The JCM Orders admin screens (from shishirmittal/jcm-orders) as React
// islands inside HQ, the same way Control Centre is mounted: main.js's route()
// replaces #app's innerHTML without telling React, so the root is unmounted
// explicitly before any other page draws.

// If anything goes wrong while drawing a page, say so instead of leaving a
// blank screen — the same SafetyNet as orders.jcmretails.com.
class SafetyNet extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) { console.error('JCM HQ orders page error:', error, info?.componentStack) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ maxWidth: 560, background: '#FFFFFF', border: '1px solid #E2DCCD', borderLeft: '6px solid #C2452D', borderRadius: 8, padding: 24, fontFamily: "'Roboto Condensed', Arial, sans-serif", color: '#0C111B' }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#12213B', marginBottom: 8 }}>This page hit a problem</div>
          <div style={{ fontSize: 16, lineHeight: 1.5, color: '#2C3240', marginBottom: 12 }}>Reload the page. If it keeps happening, send Claude a photo of this message.</div>
          <div style={{ fontSize: 13, color: '#5A606C', fontFamily: 'Consolas, monospace', wordBreak: 'break-word', marginBottom: 16 }}>{String(this.state.error?.message || this.state.error)}</div>
          <button onClick={() => location.reload()} style={{ height: 44, padding: '0 20px', border: 0, borderRadius: 6, background: '#12213B', color: '#FFFFFF', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Reload</button>
        </div>
      </div>
    )
  }
}

const PAGES = { warehouse: Admin, material: Owner, 'order-log': Logs, 'floor-orders': Floor }

let root = null

export function unmountOrdersPage() {
  root?.unmount()
  root = null
}

export function renderOrdersPage(container, which, profile) {
  unmountOrdersPage()
  setHqName(profile?.name || '')
  const Page = PAGES[which]
  container.innerHTML = ''
  const host = document.createElement('div')
  host.className = 'jo-hq'
  container.appendChild(host)
  root = createRoot(host)
  root.render(<SafetyNet><Page /></SafetyNet>)
}
