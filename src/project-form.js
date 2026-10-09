import { supabase } from './supabase.js'
import { esc, PRODUCT_STAGES, PROJECT_STATUSES } from './utils.js'
import { uploadPhotos, deletePhoto } from './photos.js'
import { insertContact } from './industry-contacts.js'

// Search-existing-or-create-new combobox for the Architect/Electrician fields —
// same interaction as the app's other type-to-search dropdowns, plus an always-
// available "+ Add as new" row so a brand-new referrer never needs a separate
// screen. Typing resets the selection to null (nothing chosen) until the user
// explicitly picks an existing contact or creates one; clearing the field and
// leaving it empty is how an already-linked contact gets unlinked on save.
function setupContactCombobox({ input, suggestBox, contactType, contacts, initial }) {
  let selectedId = initial?.id || null
  let suggestions = []
  let highlighted = -1

  function close() {
    suggestBox.hidden = true
    suggestBox.innerHTML = ''
    suggestions = []
    highlighted = -1
  }

  function totalRows() {
    return suggestions.length + (input.value.trim() ? 1 : 0)
  }

  function render() {
    const term = input.value.trim()
    const rows = suggestions.map((c, i) =>
      `<div class="suggestion-item ${i === highlighted ? 'highlighted' : ''}" data-i="${i}">
        ${esc(c.name)}${c.firm ? `<div class="sheet-item-sub">${esc(c.firm)}</div>` : ''}
      </div>`
    )
    if (term) {
      const createIdx = suggestions.length
      rows.push(`<div class="suggestion-item ${highlighted === createIdx ? 'highlighted' : ''}" data-i="${createIdx}">+ Add "${esc(term)}" as new ${contactType}</div>`)
    }
    if (!rows.length) { close(); return }
    suggestBox.hidden = false
    suggestBox.innerHTML = rows.join('')
    suggestBox.querySelectorAll('.suggestion-item').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault()
        pick(Number(el.dataset.i))
      })
    })
  }

  function updateHighlight() {
    suggestBox.querySelectorAll('.suggestion-item').forEach((el, i) => {
      el.classList.toggle('highlighted', i === highlighted)
    })
    if (highlighted >= 0) suggestBox.children[highlighted]?.scrollIntoView({ block: 'nearest' })
  }

  async function pick(i) {
    if (i === suggestions.length) {
      const term = input.value.trim()
      if (!term) return
      const { data, error } = await insertContact(contactType, term)
      if (error) return
      contacts.push(data)
      selectedId = data.id
      input.value = data.name
    } else {
      const c = suggestions[i]
      selectedId = c.id
      input.value = c.name
    }
    close()
  }

  input.addEventListener('input', () => {
    selectedId = null
    const term = input.value.trim().toLowerCase()
    suggestions = term
      ? contacts.filter(c => `${c.name} ${c.firm || ''}`.toLowerCase().includes(term)).slice(0, 8)
      : []
    highlighted = -1
    render()
  })
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); highlighted = Math.min(highlighted + 1, totalRows() - 1); updateHighlight() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlighted = Math.max(highlighted - 1, 0); updateHighlight() }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlighted >= 0) pick(highlighted)
    } else if (e.key === 'Escape') close()
  })
  input.addEventListener('blur', () => setTimeout(close, 150))

  return { getId: () => selectedId }
}

export function renderProjectForm(projectId, onDone) {
  const projectPromise = projectId
    ? supabase.from('projects').select('*').eq('id', projectId).single()
    : Promise.resolve({ data: null })
  const photosPromise = projectId
    ? supabase.from('project_photos').select('*').eq('project_id', projectId).order('created_at', { ascending: false })
    : Promise.resolve({ data: [] })
  const contactsPromise = supabase.from('industry_contacts').select('*').order('name')

  Promise.all([projectPromise, photosPromise, contactsPromise]).then(([{ data: project }, { data: photos }, { data: contacts }]) => {
    const architects = (contacts || []).filter(c => c.contact_type === 'architect')
    const electricians = (contacts || []).filter(c => c.contact_type === 'electrician')
    showForm(project, photos || [], architects, electricians, onDone)
  })
}

function showForm(project, existingPhotos, architects, electricians, onDone) {
  const isEdit = !!project
  let photos = existingPhotos.slice()
  let stagedFiles = [] // { file, url } — staged client-side until a new project has an id

  const initialArchitect = project?.architect_id ? architects.find(a => a.id === project.architect_id) : null
  const initialElectrician = project?.electrician_id ? electricians.find(e => e.id === project.electrician_id) : null

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>${isEdit ? 'Edit project' : 'New project'}</h2>
        <button class="btn-ghost close-btn" style="padding:6px 10px">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="form-group">
          <label>Client Name *</label>
          <input type="text" id="f_name" value="${esc(project?.client_name||'')}" placeholder="Client Name" />
        </div>
        <div style="display:flex;gap:10px">
          <div class="form-group" style="flex:1">
            <label>WhatsApp Number</label>
            <input type="text" id="f_whatsapp" value="${esc(project?.whatsapp||'')}" placeholder="WhatsApp Number" />
          </div>
          <div class="form-group" style="flex:1">
            <label>City</label>
            <input type="text" id="f_city" value="${esc(project?.location||'')}" placeholder="City" />
          </div>
        </div>
        <div class="form-group">
          <label>Address</label>
          <input type="text" id="f_address" value="${esc(project?.address||'')}" placeholder="Full address" />
        </div>
        <div style="display:flex;gap:10px">
          <div class="form-group" style="flex:1">
            <label>Architect</label>
            <div class="item-search-wrap">
              <input type="text" id="f_architect" value="${esc(initialArchitect?.name || '')}" placeholder="Search or add architect..." autocomplete="off" />
              <div class="item-suggestions" id="f_architectSuggestions" hidden></div>
            </div>
          </div>
          <div class="form-group" style="flex:1">
            <label>Electrician</label>
            <div class="item-search-wrap">
              <input type="text" id="f_electrician" value="${esc(initialElectrician?.name || '')}" placeholder="Search or add electrician..." autocomplete="off" />
              <div class="item-suggestions" id="f_electricianSuggestions" hidden></div>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label>Product Stage</label>
          <div class="checkbox-row">
            ${PRODUCT_STAGES.map(s => `
              <label class="checkbox-chip">
                <input type="checkbox" class="f_stage" value="${esc(s)}" ${(project?.product_stages||[]).includes(s) ? 'checked' : ''} />
                ${esc(s)}
              </label>
            `).join('')}
          </div>
        </div>
        <div class="form-group">
          <label>Status</label>
          <select id="f_status">
            ${PROJECT_STATUSES.map(s => `<option ${(project?.status||PROJECT_STATUSES[0])===s?'selected':''}>${esc(s)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Notes/Remarks</label>
          <textarea id="f_notes" rows="3" style="resize:vertical;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-family:inherit;font-size:14px;width:100%" placeholder="Notes or remarks">${esc(project?.description||'')}</textarea>
        </div>
        <div class="form-group">
          <div class="photos-section-header">
            <label style="margin:0">Photos</label>
            <label class="btn-ghost btn-upload">
              + Add photos
              <input type="file" id="f_photoInput" accept="image/*" multiple hidden />
            </label>
          </div>
          <p id="f_photoStatus" class="photo-upload-status"></p>
          <div id="f_photoGrid" class="photo-grid"></div>
        </div>
        <p id="formErr" style="color:#991b1b;font-size:12px;min-height:16px"></p>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button class="btn-ghost close-btn">Cancel</button>
          <button class="btn-primary" id="saveBtn">${isEdit ? 'Update' : 'Save project'}</button>
        </div>
      </div>
    </div>
  `

  document.body.appendChild(overlay)
  setTimeout(() => document.getElementById('f_name')?.focus(), 50)
  renderPhotoGrid()

  const close = () => {
    stagedFiles.forEach(s => URL.revokeObjectURL(s.url))
    overlay.remove()
    onDone()
  }
  overlay.querySelectorAll('.close-btn').forEach(b => b.addEventListener('click', close))
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })

  const architectCombo = setupContactCombobox({
    input: document.getElementById('f_architect'),
    suggestBox: document.getElementById('f_architectSuggestions'),
    contactType: 'architect',
    contacts: architects,
    initial: initialArchitect
  })
  const electricianCombo = setupContactCombobox({
    input: document.getElementById('f_electrician'),
    suggestBox: document.getElementById('f_electricianSuggestions'),
    contactType: 'electrician',
    contacts: electricians,
    initial: initialElectrician
  })

  function renderPhotoGrid() {
    const grid = document.getElementById('f_photoGrid')
    if (!grid) return

    const savedHtml = photos.map(ph => `
      <div class="photo-thumb">
        <img src="${esc(ph.url)}" alt="" />
        <button type="button" class="photo-delete" data-id="${ph.id}" title="Delete photo">✕</button>
      </div>
    `).join('')
    const stagedHtml = stagedFiles.map((s, i) => `
      <div class="photo-thumb">
        <img src="${s.url}" alt="" />
        <button type="button" class="photo-delete" data-staged="${i}" title="Remove photo">✕</button>
      </div>
    `).join('')

    grid.innerHTML = (savedHtml + stagedHtml) || '<p class="empty-notes">No photos yet.</p>'

    grid.querySelectorAll('.photo-delete[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true
        const photo = photos.find(ph => ph.id === btn.dataset.id)
        if (photo) {
          await deletePhoto(photo)
          photos = photos.filter(ph => ph.id !== photo.id)
        }
        renderPhotoGrid()
      })
    })
    grid.querySelectorAll('.photo-delete[data-staged]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.staged)
        URL.revokeObjectURL(stagedFiles[idx].url)
        stagedFiles.splice(idx, 1)
        renderPhotoGrid()
      })
    })
  }

  document.getElementById('f_photoInput').addEventListener('change', async e => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return

    if (isEdit) {
      const statusEl = document.getElementById('f_photoStatus')
      await uploadPhotos(project.id, files, (i, total) => { if (statusEl) statusEl.textContent = `Uploading ${i} of ${total}...` })
      if (statusEl) statusEl.textContent = ''
      const { data } = await supabase.from('project_photos').select('*').eq('project_id', project.id).order('created_at', { ascending: false })
      photos = data || []
    } else {
      files.forEach(file => stagedFiles.push({ file, url: URL.createObjectURL(file) }))
    }
    renderPhotoGrid()
  })

  document.getElementById('saveBtn').addEventListener('click', async () => {
    const name = document.getElementById('f_name').value.trim()
    if (!name) { document.getElementById('formErr').textContent = 'Client name is required'; return }

    const btn = document.getElementById('saveBtn')
    btn.disabled = true; btn.textContent = 'Saving...'

    const stages = Array.from(document.querySelectorAll('.f_stage:checked')).map(cb => cb.value)

    const { data: { user } } = await supabase.auth.getUser()
    const payload = {
      client_name: name,
      whatsapp: document.getElementById('f_whatsapp').value.trim(),
      location: document.getElementById('f_city').value.trim(),
      address: document.getElementById('f_address').value.trim(),
      architect_id: architectCombo.getId(),
      electrician_id: electricianCombo.getId(),
      product_stages: stages,
      status: document.getElementById('f_status').value,
      description: document.getElementById('f_notes').value.trim(),
      created_by: user.id
    }

    if (isEdit) {
      const { error } = await supabase.from('projects').update(payload).eq('id', project.id)
      if (error) {
        document.getElementById('formErr').textContent = error.message
        btn.disabled = false; btn.textContent = 'Update'
        return
      }
      close()
    } else {
      const { data: inserted, error } = await supabase.from('projects').insert([payload]).select().single()
      if (error) {
        document.getElementById('formErr').textContent = error.message
        btn.disabled = false; btn.textContent = 'Save project'
        return
      }
      if (stagedFiles.length) {
        const statusEl = document.getElementById('f_photoStatus')
        if (statusEl) statusEl.textContent = 'Uploading photos...'
        await uploadPhotos(inserted.id, stagedFiles.map(s => s.file))
      }
      close()
    }
  })
}
