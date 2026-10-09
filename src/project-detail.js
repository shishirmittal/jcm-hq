import { supabase } from './supabase.js'
import { renderProjectForm } from './project-form.js'
import { esc, slug, telHref, waHref, PROJECT_STATUSES, PRODUCT_STAGES, todayISO, formatDate } from './utils.js'
import { uploadPhotos, deletePhoto } from './photos.js'
import { renderQuotationForm } from './quotation-form.js'
import { renderQuotationView } from './quotation-view.js'

function stagePillClass(stage) {
  return 'stage-pill-' + String(stage).toLowerCase()
}

function stagePills(stages, extraClass) {
  if (!stages || !stages.length) return ''
  return `<div class="stage-tags">${stages.map(s =>
    `<span class="stage-pill ${extraClass||''} ${stagePillClass(s)}">${esc(s)}</span>`
  ).join('')}</div>`
}

export async function renderProjectDetail(container, projectId, onBack) {
  container.innerHTML = '<div class="loading-state">Loading...</div>'

  const [{ data: p }, { data: notes }, { data: photos }, { data: quotations }, { data: meetings }] = await Promise.all([
    // Aliased architect_contact/electrician_contact, not architect/electrician —
    // projects.architect is itself a real (legacy) text column, so embedding
    // under that same name would collide.
    supabase.from('projects').select('*, architect_contact:industry_contacts!architect_id(id, name), electrician_contact:industry_contacts!electrician_id(id, name)').eq('id', projectId).single(),
    supabase.from('notes').select('*').eq('project_id', projectId).order('created_at', { ascending: false }),
    supabase.from('project_photos').select('*').eq('project_id', projectId).order('created_at', { ascending: false }),
    supabase.from('quotations').select('*').eq('project_id', projectId).order('created_at', { ascending: false }),
    supabase.from('meetings').select('*').eq('project_id', projectId).order('meeting_date', { ascending: false }).order('meeting_time', { ascending: false })
  ])

  if (!p) { container.innerHTML = '<div class="empty-state">Project not found.</div>'; return }

  const phone = p.whatsapp || p.phone
  const cityLabel = p.city || p.location || ''
  const metaParts = []
  if (cityLabel) metaParts.push(esc(cityLabel))
  // p.architect is the old free-text field, kept for projects created before
  // industry_contacts existed — new projects link a real contact via
  // architect_id/electrician_id instead, shown as a link to that contact's page.
  if (!p.architect_id && p.architect) metaParts.push(`Architect: ${esc(p.architect)}`)

  const referralLinks = []
  if (p.architect_contact) referralLinks.push(`Architect: <a href="#architects/${p.architect_contact.id}">${esc(p.architect_contact.name)}</a>`)
  if (p.electrician_contact) referralLinks.push(`Electrician: <a href="#electricians/${p.electrician_contact.id}">${esc(p.electrician_contact.name)}</a>`)

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
                <h1 class="client-name">${esc(p.client_name)}</h1>
                ${metaParts.length ? `<p class="client-meta">${metaParts.join(' · ')}</p>` : ''}
                ${referralLinks.length ? `<p class="client-meta">${referralLinks.join(' · ')}</p>` : ''}
              </div>
              <select id="statusSelect" class="status-badge-select status-${slug(p.status)}">
                ${PROJECT_STATUSES.map(s => `<option value="${esc(s)}" ${s===p.status?'selected':''}>${esc(s)}</option>`).join('')}
              </select>
            </div>
            ${phone ? `
              <div class="pill-btn-row">
                <a class="pill-btn pill-call" href="${telHref(phone)}">📞 Call ${esc(phone)}</a>
                <a class="pill-btn pill-whatsapp" href="${waHref(phone)}" target="_blank" rel="noopener">💬 WhatsApp</a>
              </div>
            ` : ''}
          </div>

          <div class="detail-card">
            <div style="display:flex;justify-content:flex-end">
              <button class="btn-ghost btn-small" id="editDetailsBtn">Edit</button>
            </div>
            ${p.address ? `<p class="detail-address">📍 ${esc(p.address)}</p>` : ''}
            ${stagePills(p.product_stages)}
            <div class="progress-bar-track">
              <div class="progress-bar-fill" style="width:${Math.round((p.product_stages||[]).length / PRODUCT_STAGES.length * 100)}%"></div>
            </div>
            <p class="progress-bar-label">${(p.product_stages||[]).length} of ${PRODUCT_STAGES.length} stages</p>
            ${p.description ? `<p class="detail-notes-text">${esc(p.description)}</p>` : ''}
            ${!p.address && !(p.product_stages||[]).length && !p.description ? '<p class="empty-notes">No additional details yet.</p>' : ''}
          </div>

          <div class="detail-card">
            <div class="card-top-row">
              <h3>Quotations</h3>
              <button class="btn-primary btn-small" id="newQuotationBtn">+ New quotation</button>
            </div>

            <div class="history-list">
              ${(quotations || []).length === 0 ? '<p class="empty-notes">No quotations yet.</p>' : (quotations || []).map(q => `
                <div class="history-item quotation-history-item" data-id="${q.id}">
                  <div class="history-item-main">
                    <span>${esc(q.quote_no || 'Draft')}</span>
                    <span>${new Date(q.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                  </div>
                  ${q.brand || q.model ? `<p class="history-notes">${esc(q.brand || '')}${q.brand && q.model ? ' — ' : ''}${esc(q.model || '')}</p>` : ''}
                </div>
              `).join('')}
            </div>
          </div>

          <div class="detail-card">
            <div class="card-top-row">
              <h3>Meetings</h3>
              <button class="btn-ghost btn-small" id="m_toggleBtn">+ Schedule</button>
            </div>

            <div class="history-list">
              ${(meetings||[]).length === 0 ? '<p class="empty-notes">No meetings yet.</p>' : (meetings||[]).map(m => `
                <div class="history-item">
                  <div class="history-item-main">
                    <span>${formatDate(m.meeting_date)}${m.meeting_time ? ' · '+esc(m.meeting_time.slice(0,5)) : ''}</span>
                  </div>
                  ${m.notes ? `<p class="history-notes">${esc(m.notes)}</p>` : ''}
                </div>
              `).join('')}
            </div>

            <div class="inline-form" id="m_form" hidden>
              <div style="display:flex;gap:10px;flex-wrap:wrap">
                <div class="form-group" style="flex:1;min-width:140px">
                  <label>Meeting date</label>
                  <input type="date" id="m_date" value="${todayISO()}" />
                </div>
                <div class="form-group" style="flex:1;min-width:120px">
                  <label>Meeting time</label>
                  <input type="time" id="m_time" />
                </div>
              </div>
              <div class="form-group">
                <label>Notes</label>
                <textarea id="m_notes" rows="2" style="resize:vertical;padding:8px;border:1px solid #e2e8f0;border-radius:8px;font-family:inherit;font-size:14px;width:100%" placeholder="Agenda, discussion points..."></textarea>
              </div>
              <p id="m_err" class="error-msg"></p>
              <div style="display:flex;justify-content:flex-end;gap:8px">
                <button class="btn-ghost" id="m_cancelBtn">Cancel</button>
                <button class="btn-primary" id="m_saveBtn">Save & Add to Google Calendar</button>
              </div>
            </div>
          </div>

          <div class="detail-card">
            <h3>Notes</h3>
            <div id="notesList">
              ${(notes||[]).length === 0
                ? '<p class="empty-notes">No notes yet.</p>'
                : (notes||[]).map(n => `
                    <div class="note-item">
                      <p class="note-text">${esc(n.content)}</p>
                      <p class="note-date">${new Date(n.created_at).toLocaleString('en-IN')}</p>
                    </div>`).join('')
              }
            </div>
            <div class="add-note">
              <input type="text" id="noteInput" placeholder="Called, quoted, site visit done..." />
              <button class="btn-primary" id="addNoteBtn">Add</button>
            </div>
          </div>

          <div class="detail-card">
            <div style="display:flex;justify-content:flex-end">
              <label class="btn-ghost btn-small btn-upload">
                + Add Photos
                <input type="file" id="photoInput" accept="image/*" multiple hidden />
              </label>
            </div>
            <p id="photoUploadStatus" class="photo-upload-status"></p>
            <div id="photoGrid" class="photo-grid-3col">
              ${renderPhotoGrid(photos)}
            </div>
          </div>

        </div>
      </main>
    </div>
  `

  document.getElementById('backBtn').addEventListener('click', onBack)
  document.getElementById('editBtn').addEventListener('click', () => {
    renderProjectForm(projectId, () => renderProjectDetail(container, projectId, onBack))
  })
  document.getElementById('editDetailsBtn').addEventListener('click', () => {
    renderProjectForm(projectId, () => renderProjectDetail(container, projectId, onBack))
  })
  document.getElementById('deleteBtn').addEventListener('click', async () => {
    if (!confirm('Delete this project?')) return
    const paths = (photos||[]).map(ph => ph.path)
    if (paths.length) await supabase.storage.from('project-photos').remove(paths)
    await supabase.from('projects').delete().eq('id', projectId)
    onBack()
  })

  document.getElementById('statusSelect').addEventListener('change', async e => {
    await supabase.from('projects').update({ status: e.target.value }).eq('id', projectId)
    renderProjectDetail(container, projectId, onBack)
  })

  document.getElementById('newQuotationBtn').addEventListener('click', () => {
    renderQuotationForm(container, {
      client_name: p.client_name,
      phone: p.whatsapp || p.phone,
      city: p.city || p.location,
      address: p.address,
      project_id: p.id
    }, () => renderProjectDetail(container, projectId, onBack))
  })
  container.querySelectorAll('.quotation-history-item').forEach(el => {
    el.addEventListener('click', () => {
      renderQuotationView(container, el.dataset.id, () => renderProjectDetail(container, projectId, onBack))
    })
  })

  const mForm = document.getElementById('m_form')
  document.getElementById('m_toggleBtn').addEventListener('click', () => {
    mForm.hidden = !mForm.hidden
    if (!mForm.hidden) document.getElementById('m_date')?.focus()
  })
  document.getElementById('m_cancelBtn').addEventListener('click', () => { mForm.hidden = true })

  document.getElementById('m_saveBtn').addEventListener('click', async () => {
    const dateVal = document.getElementById('m_date').value
    const timeVal = document.getElementById('m_time').value
    const notes = document.getElementById('m_notes').value.trim()
    const errEl = document.getElementById('m_err')
    if (!dateVal || !timeVal) { errEl.textContent = 'Meeting date and time are required'; return }

    const btn = document.getElementById('m_saveBtn')
    btn.disabled = true; btn.textContent = 'Saving...'

    const { error } = await supabase.from('meetings').insert([{
      project_id: projectId,
      meeting_date: dateVal,
      meeting_time: timeVal,
      notes
    }])

    if (error) {
      errEl.textContent = error.message
      btn.disabled = false; btn.textContent = 'Save & Add to Google Calendar'
      return
    }

    window.open(googleCalendarUrl(p.client_name, dateVal, timeVal, notes, p.address), '_blank', 'noopener')
    renderProjectDetail(container, projectId, onBack)
  })

  async function addNote() {
    const input = document.getElementById('noteInput')
    const text = input.value.trim()
    if (!text) return
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('notes').insert([{ project_id: projectId, content: text, created_by: user.id }])
    input.value = ''
    renderProjectDetail(container, projectId, onBack)
  }

  document.getElementById('addNoteBtn').addEventListener('click', addNote)
  document.getElementById('noteInput').addEventListener('keydown', e => { if (e.key === 'Enter') addNote() })

  document.getElementById('photoInput').addEventListener('change', async e => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    await uploadPhotos(projectId, files)
    renderProjectDetail(container, projectId, onBack)
  })

  container.querySelectorAll('.photo-thumb').forEach(el => {
    el.addEventListener('click', () => openLightbox(el.dataset.url))
  })

  container.querySelectorAll('.photo-delete').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      if (!confirm('Delete this photo?')) return
      const photo = photos.find(ph => ph.id === btn.dataset.id)
      if (!photo) return
      await deletePhoto(photo)
      renderProjectDetail(container, projectId, onBack)
    })
  })
}

function renderPhotoGrid(photos) {
  if (!photos || photos.length === 0) return '<p class="empty-notes">No photos yet.</p>'
  return photos.map(ph => `
    <div class="photo-thumb" data-url="${esc(ph.url)}">
      <img src="${esc(ph.url)}" alt="" />
      <button class="photo-delete" data-id="${ph.id}" title="Delete photo">✕</button>
    </div>
  `).join('')
}

function gcalStamp(dateVal, timeVal) {
  return `${dateVal.replace(/-/g,'')}T${timeVal.replace(':','')}00`
}

function googleCalendarUrl(clientName, dateVal, timeVal, notes, address) {
  const [y, m, d] = dateVal.split('-').map(Number)
  const [hh, mm] = timeVal.split(':').map(Number)
  const start = new Date(y, m - 1, d, hh, mm)
  const end = new Date(start.getTime() + 60 * 60 * 1000) // default 1-hour meeting
  const pad = n => String(n).padStart(2, '0')
  const endDate = `${end.getFullYear()}-${pad(end.getMonth()+1)}-${pad(end.getDate())}`
  const endTime = `${pad(end.getHours())}:${pad(end.getMinutes())}`

  const params = new URLSearchParams({
    action: 'EDIT',
    text: `Meeting with ${clientName || ''}`,
    dates: `${gcalStamp(dateVal, timeVal)}/${gcalStamp(endDate, endTime)}`,
    details: notes || '',
    location: address || ''
  })
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

function openLightbox(url) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay lightbox-overlay'
  overlay.innerHTML = `<img class="lightbox-img" src="${esc(url)}" alt="" />`
  overlay.addEventListener('click', () => overlay.remove())
  document.body.appendChild(overlay)
}
