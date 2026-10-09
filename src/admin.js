import { apiUrl } from './native.js'
import { supabase, getCurrentProfile } from './supabase.js'
import { esc } from './utils.js'
import { NAV_CONFIG } from './nav-config.js'
import { icon } from './icons.js'

// The tab list is generated from NAV_CONFIG, never a second hardcoded copy --
// add a tab to the nav and it shows up here to be granted, with no edit here.
// Laid out with the sidebar's own sections and icons so it reads as "the
// sidebar, as checkboxes" rather than an unrelated list of names.
function tabPermissionsHtml(checkedIds) {
  const checked = new Set(checkedIds || [])
  return `
    <div class="tabperm" id="uf_tabperm">
      <div class="tabperm-actions">
        <button type="button" class="btn-ghost btn-small" id="uf_tabAll">Select all</button>
        <button type="button" class="btn-ghost btn-small" id="uf_tabNone">Clear all</button>
      </div>
      ${NAV_CONFIG.map(section => `
        <div class="tabperm-section">
          <div class="tabperm-section-label">${esc(section.section)}</div>
          <div class="tabperm-grid">
            ${section.items.map(item => `
              <label class="tabperm-row${item.grantable === false ? ' ungrantable' : ''}"${item.grantable === false ? ' title="Admin only — cannot be granted individually"' : ''}>
                <input type="checkbox" value="${esc(item.id)}"${item.grantable === false ? ' disabled' : ''}${item.grantable !== false && checked.has(item.id) ? ' checked' : ''} />
                <span class="tabperm-icon">${icon(item.icon, 15)}</span>
                <span class="tabperm-label">${esc(item.label)}</span>
                ${item.grantable === false
                  ? '<span class="tabperm-warn" title="Admin only — cannot be granted individually" aria-label="Admin only — cannot be granted individually">🔒</span>'
                  : item.adminOnly ? '<span class="tabperm-warn" title="Sensitive — normally admin only" aria-label="Sensitive — normally admin only">⚠</span>' : ''}
              </label>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `
}

// Every call here hits /api/admin-users, which re-checks admin status
// server-side (profiles.is_admin) on every single request using the
// service-role key -- that's the real gate. The role === 'admin' check below
// is just a UX convenience so a non-admin sees an access-denied message
// instead of a page that silently fails; it uses the app's existing
// `role` convention (same as every other admin-only page/nav item) rather
// than is_admin specifically, since the two are kept in sync and every other
// client-side check in this codebase already reads `role`.
async function callAdminUsersApi(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { error: 'Not signed in' }
  try {
    const res = await fetch(apiUrl('/api/admin-users'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return { error: body.error || 'Something went wrong' }
    return { data: body }
  } catch {
    return { error: 'Could not reach the server, try again' }
  }
}

// Shared create/edit form -- same fields, same validation, same API call
// shape either way, just a different action and an id on the payload.
function showUserForm({ existing, onSaved }) {
  const isEdit = !!existing
  // An admin's row is not the source of truth for what they can see -- they
  // see everything regardless -- so the block is replaced by a note rather
  // than shown ticked, and nothing is written to allowed_tabs for them.
  const targetIsAdmin = !!existing?.is_admin

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal modal-user-form">
      <div class="modal-header">
        <h2>${isEdit ? 'Edit user' : 'Add user'}</h2>
        <button class="btn-ghost close-btn" style="padding:6px 10px">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="form-group">
          <label>Name *</label>
          <input type="text" id="uf_name" value="${esc(existing?.name || '')}" placeholder="Full name" />
        </div>
        <div class="form-group">
          <label>Email *</label>
          <input type="email" id="uf_email" value="${esc(existing?.email || '')}" placeholder="name@email.com" />
        </div>
        <div class="form-group">
          <label>PIN (4 digits) *</label>
          <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" id="uf_pin" value="${esc(existing?.pin || '')}" placeholder="1234" />
        </div>
        <label class="form-check">
          <input type="checkbox" id="uf_hide"${existing?.hide_from_roster ? ' checked' : ''} />
          <span>Hide from chat and task assignment</span>
        </label>
        <p class="form-check-hint">They can still file and pass on work — they just stop appearing as someone to pick.</p>
        <div class="form-group">
          <label>Tab access</label>
          ${targetIsAdmin
            ? '<p class="tabperm-admin-note">Admins have access to all tabs</p>'
            : tabPermissionsHtml(existing?.allowed_tabs)}
        </div>
        <p id="uf_err" class="error-msg"></p>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button class="btn-ghost close-btn">Cancel</button>
          <button class="btn-primary" id="uf_saveBtn">${isEdit ? 'Save changes' : 'Add user'}</button>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  setTimeout(() => document.getElementById('uf_name')?.focus(), 50)

  // No backdrop-click-to-close here (unlike the sidebar overlay) -- this is
  // a multi-field form, and an accidental click outside it shouldn't discard
  // whatever was just typed.
  const close = () => overlay.remove()
  overlay.querySelectorAll('.close-btn').forEach(b => b.addEventListener('click', close))

  document.getElementById('uf_pin').addEventListener('input', e => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4)
  })

  const tabInputs = () => overlay.querySelectorAll('#uf_tabperm input[type="checkbox"]')
  // Skips the disabled ones — Select all must not tick something the server
  // would refuse anyway.
  const setAllTabs = value => tabInputs().forEach(cb => { if (!cb.disabled) cb.checked = value })
  document.getElementById('uf_tabAll')?.addEventListener('click', () => setAllTabs(true))
  document.getElementById('uf_tabNone')?.addEventListener('click', () => setAllTabs(false))

  document.getElementById('uf_saveBtn').addEventListener('click', async () => {
    const btn = document.getElementById('uf_saveBtn')
    const errEl = document.getElementById('uf_err')
    errEl.textContent = ''

    const name = document.getElementById('uf_name').value.trim()
    const email = document.getElementById('uf_email').value.trim()
    const pin = document.getElementById('uf_pin').value.trim()

    if (!name) { errEl.textContent = 'Name is required'; return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = 'Enter a valid email address'; return }
    if (!/^\d{4}$/.test(pin)) { errEl.textContent = 'PIN must be exactly 4 digits'; return }

    // Never sent for an admin: the block is not rendered for them, and an
    // empty array here would quietly overwrite their row with a lockout that
    // would take effect the moment is_admin was ever cleared.
    const allowedTabs = targetIsAdmin
      ? null
      : [...tabInputs()].filter(cb => cb.checked && !cb.disabled).map(cb => cb.value)

    btn.disabled = true
    btn.textContent = 'Saving...'
    const hideFromRoster = document.getElementById('uf_hide').checked

    const payload = isEdit
      ? { action: 'update', id: existing.id, name, email, pin, hide_from_roster: hideFromRoster, ...(allowedTabs ? { allowed_tabs: allowedTabs } : {}) }
      : { action: 'create', name, email, pin, hide_from_roster: hideFromRoster, allowed_tabs: allowedTabs || [] }
    const result = await callAdminUsersApi(payload)
    if (!overlay.isConnected) return
    if (result.error) {
      errEl.textContent = result.error
      btn.disabled = false
      btn.textContent = isEdit ? 'Save changes' : 'Add user'
      return
    }
    close()
    onSaved({ emailChanged: result.data?.emailChanged, tabsSavedFor: allowedTabs ? name : null })
  })
}

export async function renderAdmin(container, onBack) {
  container.innerHTML = '<div class="loading-state">Loading...</div>'

  const myProfile = await getCurrentProfile()
  if (myProfile?.role !== 'admin') {
    container.innerHTML = '<div class="empty-state">You do not have access to this page.</div>'
    setTimeout(onBack, 1500)
    return
  }

  container.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <button class="btn-ghost" id="backBtn">← Back</button>
        <span class="logo-small">Manage users</span>
        <button class="btn-primary btn-small" id="addUserBtn">+ Add User</button>
      </header>
      <main class="app-main">
        <div id="userListWrap"><div class="loading-state">Loading users...</div></div>
      </main>
    </div>
  `

  document.getElementById('backBtn').addEventListener('click', onBack)
  document.getElementById('addUserBtn').addEventListener('click', () => {
    showUserForm({ onSaved: info => loadUsers(info) })
  })

  await loadUsers()

  // info: { emailChanged, tabsSavedFor } from the form, undefined on a plain
  // refresh.
  async function loadUsers(info) {
    const justChangedEmail = info?.emailChanged
    const tabsSavedFor = info?.tabsSavedFor
    const wrap = document.getElementById('userListWrap')
    if (!wrap) return
    wrap.innerHTML = '<div class="loading-state">Loading users...</div>'

    const result = await callAdminUsersApi({ action: 'list' })
    if (!wrap.isConnected) return
    if (result.error) {
      wrap.innerHTML = `<div class="empty-state">${esc(result.error)}</div>`
      return
    }

    const users = result.data.users || []
    wrap.innerHTML = `
      ${tabsSavedFor ? `<p class="admin-note">Tab access saved. Changes apply next time ${esc(tabsSavedFor)} reloads the app.</p>` : ''}
      ${justChangedEmail ? '<p class="admin-note">Email updated — the change took effect immediately, no confirmation step required on this account.</p>' : ''}
      <div class="user-list">
        ${users.map(u => `
          <div class="user-card" data-id="${u.id}">
            <div class="user-card-main">
              <div>
                <div class="user-name">
                  ${u.name ? esc(u.name) : '<em>Not set</em>'}${u.id === myProfile.id ? ' <em>(you)</em>' : ''}
                  ${u.is_admin ? '<span class="admin-badge">Admin</span>' : ''}
                </div>
                <div class="user-meta">${esc(u.email)}</div>
                <div class="user-meta">PIN: ${u.pin ? esc(u.pin) : '<em>Not set</em>'}</div>
              </div>
              <div class="user-card-controls">
                <button class="btn-ghost active-toggle ${u.active ? '' : 'inactive'}" data-id="${u.id}" data-active="${u.active}" ${u.id === myProfile.id ? 'disabled' : ''}>
                  ${u.active ? 'Active' : 'Deactivated'}
                </button>
                <button class="btn-ghost btn-small edit-user-btn" data-id="${u.id}">Edit</button>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `

    wrap.querySelectorAll('.edit-user-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const u = users.find(x => x.id === btn.dataset.id)
        if (u) showUserForm({ existing: u, onSaved: info => loadUsers(info) })
      })
    })

    // Unchanged from before -- deactivating/reactivating an account is a
    // separate concern from the Name/Email/PIN lifecycle this page was
    // rebuilt around, so it stays a direct profiles.active write rather than
    // routing through the new admin-users endpoint.
    wrap.querySelectorAll('.active-toggle').forEach(btn => {
      btn.addEventListener('click', async () => {
        const nextActive = !(btn.dataset.active === 'true')
        btn.disabled = true
        const { error } = await supabase.from('profiles').update({ active: nextActive }).eq('id', btn.dataset.id)
        if (error) { alert(error.message); btn.disabled = false; return }
        loadUsers()
      })
    })
  }
}
