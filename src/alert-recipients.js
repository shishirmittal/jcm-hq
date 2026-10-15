// Who gets a staff alert on WhatsApp (2026-10-15): tick HQ people (from Manage Users — only people with a
// WhatsApp number can be ticked) + extra numbers of people who are not HQ staff (name + mobile).
// Used by WhatsApp → Invoice alerts (item groups) and Email Purchase Summary → Brands & mails.
// Classes ar-* (whatsapp.css is not loaded on every page, so the styles live in alert-recipients.css).
import { esc } from './utils.js'
import './alert-recipients.css'

const digits = s => String(s || '').replace(/\D/g, '')
const ten = s => { const d = digits(s); return d.length >= 10 ? d.slice(-10) : d }
const validMobile = s => /^[6-9]\d{9}$/.test(ten(s))

// Short line for a list row: "Shishir, Ruchir · +1 number".
export function recipientsText(profileIds, numbers, people) {
  const names = (profileIds || []).map(id => people.find(p => p.id === id)?.name).filter(Boolean)
  const extra = (numbers || []).length
  if (!names.length && !extra) return 'Nobody yet'
  return [names.join(', '), extra ? `+${extra} other number${extra === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
}

// Opens the picker. extraTop = optional HTML shown above the people (e.g. the item-group select).
// onSave({ profile_ids, extra_numbers, root }) must throw on failure (message shown in the sheet).
export function pickRecipients({ title, subtitle = '', people, profileIds = [], numbers = [], extraTop = '', onReady = null, onSave, onRemove = null }) {
  return new Promise(resolve => {
    const ov = document.createElement('div')
    ov.className = 'modal-overlay'
    const picked = new Set(profileIds)
    const rows = (numbers.length ? numbers : []).map(n => ({ name: n.name || '', number: ten(n.number) }))
    ov.innerHTML = `
      <div class="modal ar-modal" role="dialog" aria-modal="true">
        <div class="modal-header"><div><h2>${esc(title)}</h2>${subtitle ? `<div class="ar-sub">${esc(subtitle)}</div>` : ''}</div><button type="button" class="btn-ghost btn-small" data-ar-close aria-label="Close">✕</button></div>
        ${extraTop}
        <h4 class="ar-h">HQ people</h4>
        <div class="ar-people">${people.map(p => `
          <label class="ar-person ${p.whatsapp ? '' : 'is-off'}">
            <input type="checkbox" value="${esc(p.id)}" ${picked.has(p.id) ? 'checked' : ''} ${p.whatsapp ? '' : 'disabled'}>
            <span><b>${esc(p.name)}</b>${p.admin ? ' <small class="ar-tag">Admin</small>' : ''}<br><small>${p.whatsapp ? esc(p.whatsapp) : 'No WhatsApp number — add it in Manage Users'}</small></span>
          </label>`).join('')}</div>
        <h4 class="ar-h">Other numbers <small>(not HQ staff — e.g. the brand's installation or warranty person)</small></h4>
        <div class="ar-nums" data-ar-nums></div>
        <button type="button" class="btn-ghost btn-small" data-ar-add>+ Add a number</button>
        <p class="cu-error" data-ar-err hidden></p>
        <div class="ar-actions">
          ${onRemove ? '<button type="button" class="btn-ghost btn-small ar-remove" data-ar-remove>Delete this rule</button>' : '<span></span>'}
          <span><button type="button" class="btn-ghost btn-small" data-ar-close>Cancel</button> <button type="button" class="btn-primary btn-small" data-ar-save>Save</button></span>
        </div>
      </div>`
    document.body.appendChild(ov)
    const q = s => ov.querySelector(s)
    const drawNums = () => {
      q('[data-ar-nums]').innerHTML = rows.map((r, i) => `
        <div class="ar-num">
          <input placeholder="Name (e.g. Rocky Francis, Faber)" value="${esc(r.name)}" data-n-name="${i}" maxlength="60">
          <input placeholder="10-digit mobile" inputmode="numeric" value="${esc(r.number)}" data-n-num="${i}" maxlength="14">
          <button type="button" class="btn-ghost btn-small" data-n-del="${i}" aria-label="Remove">✕</button>
        </div>`).join('') || '<div class="ar-sub">None.</div>'
    }
    drawNums()
    const done = v => { ov.remove(); resolve(v) }
    ov.addEventListener('input', e => {
      const t = e.target
      if (t.dataset.nName != null) rows[+t.dataset.nName].name = t.value
      if (t.dataset.nNum != null) rows[+t.dataset.nNum].number = t.value
    })
    ov.addEventListener('click', async e => {
      if (e.target === ov || e.target.closest('[data-ar-close]')) return done(null)
      if (e.target.closest('[data-ar-add]')) { rows.push({ name: '', number: '' }); drawNums(); ov.querySelectorAll('[data-n-name]')[rows.length - 1]?.focus(); return }
      const del = e.target.closest('[data-n-del]')
      if (del) { rows.splice(+del.dataset.nDel, 1); drawNums(); return }
      const err = q('[data-ar-err]')
      if (e.target.closest('[data-ar-remove]')) {
        try { await onRemove(); done({ removed: true }) } catch (x) { err.textContent = x.message; err.hidden = false }
        return
      }
      if (e.target.closest('[data-ar-save]')) {
        const filled = rows.filter(r => digits(r.number) || r.name.trim())
        const bad = filled.find(r => !validMobile(r.number))
        if (bad) { err.textContent = `"${bad.number || bad.name}" is not a 10-digit mobile number.`; err.hidden = false; return }
        const out = { profile_ids: [...ov.querySelectorAll('.ar-people input:checked')].map(x => x.value), extra_numbers: filled.map(r => ({ name: r.name.trim(), number: ten(r.number) })), root: ov }
        const b = q('[data-ar-save]'); b.disabled = true; b.textContent = 'Saving…'; err.hidden = true
        try { await onSave(out); done(out) } catch (x) { err.textContent = x.message; err.hidden = false; b.disabled = false; b.textContent = 'Save' }
      }
    })
    onReady?.(ov)
  })
}
