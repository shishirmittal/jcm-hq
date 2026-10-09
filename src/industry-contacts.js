import { supabase, getCurrentProfile } from './supabase.js'
import { showMore } from './show-more.js'
import { esc, telHref, waHref, slug } from './utils.js'
import { openSidebar } from './sidebar.js'
import { renderProjectDetail } from './project-detail.js'

const TYPE_LABEL = { architect: 'Architect', electrician: 'Electrician' }
const ID_COLUMN = { architect: 'architect_id', electrician: 'electrician_id' }
const HASH_SEGMENT = { architect: 'architects', electrician: 'electricians' }

// Shared entry point for both #architects and #electricians (see main.js's
// route()) — a contactId routes straight to that one contact's referred-projects
// page, otherwise the searchable list. Kept as one parameterized file rather than
// two near-identical ones since architects and electricians are tracked
// identically apart from the label and which projects column links to them.
export async function renderIndustryContacts(container, contactType, contactId) {
  if (contactId) {
    await renderContactDetail(container, contactType, contactId)
  } else {
    await renderContactList(container, contactType)
  }
}

async function renderContactList(container, contactType) {
  const label = TYPE_LABEL[contactType]
  const idCol = ID_COLUMN[contactType]
  const hashSegment = HASH_SEGMENT[contactType]

  const profile = await getCurrentProfile()
  const isAdmin = profile?.role === 'admin'

  container.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn-ghost btn-hamburger" id="hamburgerBtn" aria-label="Menu">☰</button>
          <span class="logo-small">${esc(label)}s</span>
        </div>
        <button class="btn-primary btn-small" id="icAddBtn">+ Add ${esc(label)}</button>
      </header>
      <main class="app-main">
        <div class="controls-bar">
          <input type="text" id="icSearch" placeholder="Search name, phone, firm..." class="search-input" />
        </div>
        <div id="icList" class="project-list">
          <div class="loading-state">Loading ${label.toLowerCase()}s...</div>
        </div>
      </main>
    </div>
  `

  document.getElementById('hamburgerBtn').addEventListener('click', () => openSidebar({ isAdmin }))
  document.getElementById('icAddBtn').addEventListener('click', () => {
    showContactForm(contactType, () => renderContactList(container, contactType))
  })
  document.getElementById('icSearch').addEventListener('input', () => renderList())

  const [{ data: contacts }, { data: projectRefs }] = await Promise.all([
    supabase.from('industry_contacts').select('*').eq('contact_type', contactType).order('name'),
    supabase.from('projects').select(idCol)
  ])

  // How many leads each contact has sent JCM's way — counted client-side from
  // one cheap single-column fetch rather than a query per contact.
  const counts = {}
  ;(projectRefs || []).forEach(p => {
    const id = p[idCol]
    if (id) counts[id] = (counts[id] || 0) + 1
  })

  function renderList() {
    const search = document.getElementById('icSearch')?.value?.toLowerCase() || ''
    const list = document.getElementById('icList')
    if (!list) return

    let filtered = contacts || []
    if (search) {
      filtered = filtered.filter(c =>
        (c.name || '').toLowerCase().includes(search) ||
        (c.firm || '').toLowerCase().includes(search) ||
        (c.phone || '').toLowerCase().includes(search)
      )
    }

    if (!filtered.length) {
      list.innerHTML = `<div class="empty-state">No ${label.toLowerCase()}s yet. Click "+ Add ${esc(label)}" to get started.</div>`
      return
    }

    list.innerHTML = filtered.map(c => {
      const count = counts[c.id] || 0
      const metaParts = [c.firm, c.phone, c.city].filter(Boolean)
      return `
        <div class="project-card" data-id="${c.id}">
          <div class="project-card-body" style="padding-left:16px">
            <div class="project-card-main">
              <div>
                <div class="project-name">${esc(c.name)}</div>
                ${metaParts.length ? `<div class="project-meta">${metaParts.map(esc).join(' · ')}</div>` : ''}
              </div>
              <span class="status-badge status-new-lead">${count} project${count === 1 ? '' : 's'} referred</span>
            </div>
          </div>
        </div>
      `
    }).join('')

    list.querySelectorAll('.project-card').forEach(card => {
      card.addEventListener('click', () => { window.location.hash = `#${hashSegment}/${card.dataset.id}` })
    })
    showMore(list, '.project-card')
  }

  renderList()
}

async function renderContactDetail(container, contactType, contactId) {
  const label = TYPE_LABEL[contactType]
  const idCol = ID_COLUMN[contactType]
  const hashSegment = HASH_SEGMENT[contactType]

  container.innerHTML = '<div class="loading-state">Loading...</div>'

  const [{ data: contact }, { data: projects }] = await Promise.all([
    supabase.from('industry_contacts').select('*').eq('id', contactId).maybeSingle(),
    supabase.from('projects').select('*, project_photos(url, path, created_at)').eq(idCol, contactId).order('created_at', { ascending: false })
  ])

  if (!contact) { container.innerHTML = `<div class="empty-state">${esc(label)} not found.</div>`; return }

  const metaParts = [contact.firm, contact.city].filter(Boolean)

  container.innerHTML = `
    <div class="app-layout">
      <header class="app-header">
        <button class="btn-ghost" id="backBtn">← Back</button>
        <div style="display:flex;gap:8px">
          <button class="btn-ghost" id="editBtn">Edit</button>
          <button class="btn-danger" id="deleteBtn">Delete</button>
        </div>
      </header>
      <main class="app-main">
        <div class="detail-page">
          <div class="detail-card">
            <div class="card-top-row">
              <div>
                <h1 class="client-name">${esc(contact.name)}</h1>
                ${metaParts.length ? `<p class="client-meta">${metaParts.map(esc).join(' · ')}</p>` : ''}
              </div>
            </div>
            ${contact.phone ? `
              <div class="pill-btn-row">
                <a class="pill-btn pill-call" href="${telHref(contact.phone)}">📞 Call ${esc(contact.phone)}</a>
                <a class="pill-btn pill-whatsapp" href="${waHref(contact.phone)}" target="_blank" rel="noopener">💬 WhatsApp</a>
              </div>
            ` : ''}
          </div>

          <div class="detail-card">
            <h3>Projects referred</h3>
            <div class="project-list" id="icProjectList" style="margin-top:10px">
              ${(projects || []).length === 0 ? '<p class="empty-notes">No projects referred yet.</p>' : (projects || []).map(p => {
                const thumb = (p.project_photos || [])[0]?.url
                const cityLabel = p.city || p.location || ''
                return `
                  <div class="project-card" data-id="${p.id}">
                    ${thumb ? `<img class="project-thumb" src="${esc(thumb)}" alt="" />` : ''}
                    <div class="project-card-body">
                      <div class="project-card-main">
                        <div>
                          <div class="project-name">${esc(p.client_name)}</div>
                          ${cityLabel ? `<div class="project-meta">${esc(cityLabel)}</div>` : ''}
                        </div>
                        <span class="status-badge status-${slug(p.status)}">${esc(p.status)}</span>
                      </div>
                    </div>
                  </div>
                `
              }).join('')}
            </div>
          </div>
        </div>
      </main>
    </div>
  `

  document.getElementById('backBtn').addEventListener('click', () => { window.location.hash = `#${hashSegment}` })
  document.getElementById('editBtn').addEventListener('click', () => {
    showContactForm(contactType, () => renderContactDetail(container, contactType, contactId), contact)
  })
  document.getElementById('deleteBtn').addEventListener('click', async () => {
    if (!confirm(`Delete ${contact.name}? Projects that reference them will keep their history but show no ${label.toLowerCase()}.`)) return
    await supabase.from('industry_contacts').delete().eq('id', contactId)
    window.location.hash = `#${hashSegment}`
  })

  container.querySelectorAll('#icProjectList .project-card').forEach(card => {
    card.addEventListener('click', () => {
      renderProjectDetail(container, card.dataset.id, () => renderContactDetail(container, contactType, contactId))
    })
  })
}

// Used by project-form.js's Architect/Electrician combobox to inline-create a
// contact from just a typed name, with everything else left blank/editable later.
export async function insertContact(contactType, name) {
  const { data: { user } } = await supabase.auth.getUser()
  return supabase.from('industry_contacts').insert([{ name, contact_type: contactType, created_by: user.id }]).select().single()
}

// Simple add/edit modal — same overlay pattern as project-form.js, just much
// smaller (no photos, no stages): Name is the only required field.
function showContactForm(contactType, onDone, existing) {
  const label = TYPE_LABEL[contactType]
  const isEdit = !!existing

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>${isEdit ? `Edit ${esc(label)}` : `New ${esc(label)}`}</h2>
        <button class="btn-ghost close-btn" style="padding:6px 10px">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="form-group">
          <label>Name *</label>
          <input type="text" id="ic_name" value="${esc(existing?.name || '')}" placeholder="Full name" />
        </div>
        <div class="form-group">
          <label>Firm</label>
          <input type="text" id="ic_firm" value="${esc(existing?.firm || '')}" placeholder="Firm / company name" />
        </div>
        <div style="display:flex;gap:10px">
          <div class="form-group" style="flex:1">
            <label>Phone</label>
            <input type="text" id="ic_phone" value="${esc(existing?.phone || '')}" placeholder="Phone number" />
          </div>
          <div class="form-group" style="flex:1">
            <label>City</label>
            <input type="text" id="ic_city" value="${esc(existing?.city || '')}" placeholder="City" />
          </div>
        </div>
        <p id="ic_err" class="error-msg"></p>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button class="btn-ghost close-btn">Cancel</button>
          <button class="btn-primary" id="ic_saveBtn">${isEdit ? 'Update' : `Save ${esc(label)}`}</button>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  setTimeout(() => document.getElementById('ic_name')?.focus(), 50)

  const close = () => overlay.remove()
  overlay.querySelectorAll('.close-btn').forEach(b => b.addEventListener('click', close))
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })

  document.getElementById('ic_saveBtn').addEventListener('click', async () => {
    const name = document.getElementById('ic_name').value.trim()
    const errEl = document.getElementById('ic_err')
    if (!name) { errEl.textContent = 'Name is required'; return }

    const btn = document.getElementById('ic_saveBtn')
    btn.disabled = true; btn.textContent = 'Saving...'

    const { data: { user } } = await supabase.auth.getUser()
    const payload = {
      name,
      firm: document.getElementById('ic_firm').value.trim() || null,
      phone: document.getElementById('ic_phone').value.trim() || null,
      city: document.getElementById('ic_city').value.trim() || null,
      contact_type: contactType
    }

    const { error } = isEdit
      ? await supabase.from('industry_contacts').update(payload).eq('id', existing.id)
      : await supabase.from('industry_contacts').insert([{ ...payload, created_by: user.id }])

    if (error) {
      errEl.textContent = error.message
      btn.disabled = false; btn.textContent = isEdit ? 'Update' : `Save ${label}`
      return
    }
    close()
    onDone()
  })
}
