import { supabase } from './supabase.js'
import { esc } from './utils.js'
import logoUrl from './assets/jcm-logo.png'

export function renderProfileForm(container, { profile, title, subtitle, onDone, onCancel }) {
  container.innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <div class="login-logo">
          <img src="${logoUrl}" alt="JCM Retails" class="logo-img" />
          <h1>${esc(title)}</h1>
          <p>${esc(subtitle)}</p>
        </div>
        <div class="form-group">
          <label>Name *</label>
          <input type="text" id="pf_name" placeholder="Your full name" value="${esc(profile?.name || '')}" />
        </div>
        <div class="form-group" style="margin-top:10px">
          <label>Mobile number</label>
          <input type="text" id="pf_phone" placeholder="98xxxxxxxx" value="${esc(profile?.phone || '')}" />
        </div>
        <div class="form-group" style="margin-top:10px">
          <label>City</label>
          <input type="text" id="pf_city" placeholder="Indore" value="${esc(profile?.city || '')}" />
        </div>
        <button class="btn-primary" id="pf_saveBtn" style="width:100%;margin-top:16px">Save</button>
        ${onCancel ? '<button class="btn-ghost" id="pf_cancelBtn" style="width:100%;margin-top:8px">Cancel</button>' : ''}
        <p id="pf_err" class="error-msg" style="margin-top:8px"></p>
      </div>
    </div>
  `

  setTimeout(() => document.getElementById('pf_name')?.focus(), 50)

  async function save() {
    const name = document.getElementById('pf_name').value.trim()
    const errEl = document.getElementById('pf_err')
    if (!name) { errEl.textContent = 'Name is required'; return }

    const btn = document.getElementById('pf_saveBtn')
    btn.disabled = true; btn.textContent = 'Saving...'

    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('profiles').update({
      name,
      phone: document.getElementById('pf_phone').value.trim(),
      city: document.getElementById('pf_city').value.trim()
    }).eq('id', user.id)

    if (error) {
      errEl.textContent = error.message
      btn.disabled = false; btn.textContent = 'Save'
      return
    }
    onDone()
  }

  document.getElementById('pf_saveBtn').addEventListener('click', save)
  document.getElementById('pf_cancelBtn')?.addEventListener('click', onCancel)
  container.querySelectorAll('#pf_name, #pf_phone, #pf_city').forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') save() })
  })
}
