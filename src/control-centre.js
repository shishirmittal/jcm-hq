import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import { getCurrentProfile } from './supabase.js'
import { canSee, isAdminProfile } from './permissions.js'
import ControlCentreApp from './control-centre-app.jsx'

// Control Centre is the app's one React island (recharts made hand-rolled
// SVG charts not worth it) inside an otherwise vanilla-JS app — route()
// replaces #app's innerHTML on every navigation without telling React, so
// the root has to be unmounted explicitly before that happens or it's left
// pointing at a detached DOM node.
let root = null

export function unmountControlCentre() {
  root?.unmount()
  root = null
}

export async function renderControlCentre(container) {
  const profile = await getCurrentProfile()

  // Gated on the granted tab rather than on being an admin: Control Centre can now
  // be ticked for one person in Manage Users without making them a full
  // admin, and this guard has to agree with the sidebar or the tab shows up
  // and then refuses to open.
  if (!canSee('control')) {
    container.innerHTML = '<div class="empty-state">You do not have access to this page.</div>'
    setTimeout(() => { window.location.hash = '' }, 1500)
    return
  }

  container.innerHTML = ''
  root = createRoot(container)
  root.render(createElement(ControlCentreApp, { isAdmin: isAdminProfile(profile) }))
}
